/**
 * Message router — AI-first.
 *
 * Every human message is understood by ONE model call (`deps.decide`). There is
 * no keyword matching, no trigger phrase, no step machine: the model reads the
 * person's submission draft + the knowledge base and returns a Decision (reply +
 * actions + optional generated options), which `applyDecision` executes.
 *
 * The only non-model paths are deterministic and language-free:
 *   - webhook dedupe on wa_message_id (idempotency);
 *   - unsupported media/audio/sticker → a short apology (nothing to understand);
 *   - the destructive GDPR confirm button tap → the irreversible delete is gated
 *     behind a prior armed request, so a single message can never erase data.
 *
 * The webhook always 200s (see webhook/+server.ts); the sender records every
 * outbound and degrades to a no-op when WA is disabled.
 */

import type { Decider } from './ai/decide.ts';
import type { Store, PersonRow } from './db/store.ts';
import type { Env } from './types.ts';
import type { OutMessage } from './messages.ts';
import { parseWebhook, type ParsedInbound } from './wa/parse.ts';
import type { WebhookEnvelope, StatusUpdate } from './wa/wire.ts';
import { Sender, type SentMessage } from './wa/sender.ts';
import { loadDecisionState } from './survey/state.ts';
import {
	applyDecision,
	performErasure,
	cancelErasure,
	GDPR_DONE,
	GDPR_KEPT,
	GDPR_YES,
	GDPR_NO
} from './survey/apply.ts';
import { SURVEY_ID, GDPR_FLOW, parseCollected, deriveMissing } from './survey/spec.ts';
import { missingFieldNudge } from './ai/decide.ts';
import { nowIso } from './time.ts';

const UNSUPPORTED = 'Ho sento, només sé llegir text 😅';

export interface RouterDeps {
	env: Env;
	store: Store;
	decide: Decider;
	sender: Sender;
}

export function makeDeps(env: Env, store: Store, decide: Decider): RouterDeps {
	return { env, store, decide, sender: new Sender(env, store) };
}

/** Process a whole webhook envelope; returns all outbound messages produced. */
export async function handleWebhook(
	envelope: WebhookEnvelope,
	deps: RouterDeps
): Promise<SentMessage[]> {
	const parsed = parseWebhook(envelope);
	for (const status of parsed.statuses) await handleStatus(status, deps);
	const out: SentMessage[] = [];
	for (const inbound of parsed.messages) out.push(...(await handleMessage(inbound, deps)));
	return out;
}

// --- Delivery-status webhooks --------------------------------------------

async function handleStatus(status: StatusUpdate, deps: RouterDeps): Promise<void> {
	const errorJson =
		status.errors && status.errors.length > 0 ? JSON.stringify(status.errors) : null;
	await deps.store.updateOutboundStatus(status.id, status.status, errorJson, nowIso());
	if (status.status === 'failed' && status.errors) {
		console.error('WA status failed', { id: status.id, errors: status.errors });
	}
}

// --- Inbound messages -----------------------------------------------------

async function handleMessage(inbound: ParsedInbound, deps: RouterDeps): Promise<SentMessage[]> {
	const { store } = deps;
	const now = nowIso();
	const person = await store.upsertPerson(inbound.waId, inbound.profileName ?? null, now);

	// Dedupe webhook retries / out-of-order deliveries (atomic on wa_message_id).
	const fresh = await store.insertInboundMessage({
		waMessageId: inbound.message.waMessageId,
		personId: person.id,
		msgType: inbound.message.msgType,
		bodyJson: JSON.stringify(inbound.message.raw),
		createdAt: now
	});
	if (!fresh) return [];

	const input = inbound.message.input;

	// Media / audio / sticker: nothing to understand — apologize (+ nudge if mid-survey).
	if (input.kind === 'unsupported') return handleUnsupported(person, deps);

	// The one deterministic interactive: the destructive erasure confirmation.
	if (input.kind === 'button' && (input.id === GDPR_YES || input.id === GDPR_NO)) {
		const handled = await handleGdprTap(person, input.id, deps);
		if (handled) return handled;
		// Stale tap with nothing armed → fall through and let the model handle it.
	}

	// Everything a human says (typed text OR a tapped option's title) → the model.
	const userMessage = input.kind === 'text' ? input.text : input.title;
	const tapped = input.kind !== 'text';
	const state = await loadDecisionState(person, userMessage, tapped, {
		store,
		env: deps.env
	});
	const { decision, meta } = await deps.decide.decide(state);
	return applyDecision(state, decision, meta, person, deps);
}

// --- Deterministic fast-paths --------------------------------------------

async function handleUnsupported(person: PersonRow, deps: RouterDeps): Promise<SentMessage[]> {
	const messages: OutMessage[] = [{ kind: 'text', body: UNSUPPORTED }];
	const survey = await deps.store.getLatestFlowInstance(person.id, SURVEY_ID);
	if (survey?.status === 'active') {
		const missing = deriveMissing(parseCollected(survey.data_json), person.display_name);
		if (missing[0]) messages.push({ kind: 'text', body: missingFieldNudge(missing[0]) });
	}
	return deps.sender.send(person, messages, { flowInstanceId: survey?.id ?? null });
}

/** Returns the sent messages when an erasure was armed, or null for a stale tap. */
async function handleGdprTap(
	person: PersonRow,
	id: string,
	deps: RouterDeps
): Promise<SentMessage[] | null> {
	const gdpr = await deps.store.getLatestFlowInstance(person.id, GDPR_FLOW);
	if (gdpr?.status !== 'active') return null;
	const now = nowIso();
	return id === GDPR_YES
		? performErasure(person, gdpr.id, deps, GDPR_DONE, now)
		: cancelErasure(person, gdpr.id, deps, GDPR_KEPT, now);
}
