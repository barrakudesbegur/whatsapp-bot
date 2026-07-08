/**
 * Assembles the `DecisionState` handed to the model each turn: what Kudi knows
 * about this person and their submission draft, the knowledge base, and a short
 * transcript. Reads only — never mutates.
 */

import type { Store, MessageRow } from '../db/store.ts';
import type { Env } from '../types.ts';
import type { DecisionState } from '../ai/decide.ts';
import { buildKbBlock } from '../ai/prompt.ts';
import { STATIC_KB } from '../kb/static.ts';
import { fetchEventsSection } from '../kb/events.ts';
import { SURVEY_ID, parseCollected, deriveMissing, type SurveyStatus } from './spec.ts';
import { nowIso } from '../time.ts';

export interface StateDeps {
	store: Store;
	env: Env;
}

export async function loadDecisionState(
	person: { id: number; display_name: string | null; profile_name: string | null },
	userMessage: string,
	tapped: boolean,
	deps: StateDeps
): Promise<DecisionState> {
	const { store, env } = deps;

	const [surveyRow, kbEntries, campaigns, courseStatus, courseNote, events, messages] =
		await Promise.all([
			// NOT fail-soft: this feeds the survey WRITE path. A transient null would
			// make applyDecision create a DUPLICATE 'active' instance and orphan the
			// person's progress. Better to drop this one turn (the decider never runs,
			// the webhook still 200s) and let their next message retry once D1 recovers.
			store.getLatestFlowInstance(person.id, SURVEY_ID),
			// Fail-soft: a transient D1 blip on any of these degradable READS must not
			// reject the whole turn — that would silently drop the message (the webhook
			// 200s and Meta never re-delivers), bypassing the decider's fallback ladder
			// entirely. Degrade to a safe default and still answer.
			store.listKbEntries(true).catch((err) => {
				console.error('listKbEntries failed → static KB only', err);
				return [];
			}),
			store.listCampaigns(true).catch((err) => {
				console.error('listCampaigns failed → no campaign steering', err);
				return [];
			}),
			store.getSetting('course_status').catch(() => null),
			store.getSetting('course_status_note').catch(() => null),
			fetchEventsSection(env),
			store.listMessagesForPerson(person.id).catch((err) => {
				console.error('listMessagesForPerson failed → empty transcript', err);
				return [];
			})
		]);

	const collected = parseCollected(surveyRow?.data_json);
	const status: SurveyStatus = !surveyRow
		? 'none'
		: surveyRow.status === 'completed'
			? 'completed'
			: surveyRow.status === 'declined'
				? 'declined'
				: 'active';

	const kb = buildKbBlock({
		staticKb: STATIC_KB,
		dynamicEntries: kbEntries.map((e) => ({ title: e.title, content: e.content_md })),
		courseStatus: courseStatus ?? 'exploring',
		courseStatusNote: courseNote ?? '',
		eventsSection: events
	});

	return {
		now: nowIso(),
		person: {
			displayName: person.display_name,
			profileName: person.profile_name,
			isAnonymous: person.display_name === 'Anònim'
		},
		survey: { status, collected, instanceId: surveyRow?.id ?? null },
		missing: deriveMissing(collected, person.display_name),
		campaigns: campaigns.map((c) => ({ slug: c.slug, title: c.title, pitch: c.pitch_md })),
		course: { status: courseStatus ?? 'exploring', note: courseNote ?? '' },
		kb,
		transcript: buildTranscript(messages, userMessage),
		userMessage,
		tapped,
		// Route this person's turns to the same Workers AI instance so the stable
		// system prefix stays warm in the prefix cache. Internal id, not the phone
		// number — opaque and non-PII.
		sessionKey: `p${person.id}`
	};
}

/** Last few turns as {role,text}; drops a trailing turn that duplicates the current inbound. */
function buildTranscript(
	messages: MessageRow[],
	currentInbound: string
): { role: 'user' | 'kudi'; text: string }[] {
	const lines = messages
		.map((r): { role: 'user' | 'kudi'; text: string } | null => {
			const text = messageText(r);
			return text ? { role: r.direction === 'in' ? 'user' : 'kudi', text } : null;
		})
		.filter((l): l is { role: 'user' | 'kudi'; text: string } => l !== null);
	const last = lines[lines.length - 1];
	if (last && last.role === 'user' && last.text === currentInbound) lines.pop();
	return lines.slice(-6);
}

/** Human-readable text of a stored message row (inbound raw / outbound payload). */
export function messageText(row: MessageRow): string | null {
	try {
		const body = JSON.parse(row.body_json) as {
			text?: { body?: unknown };
			image?: { caption?: unknown };
			interactive?: {
				body?: { text?: unknown };
				button_reply?: { title?: unknown };
				list_reply?: { title?: unknown };
			};
		};
		if (typeof body.text?.body === 'string') return body.text.body;
		// Outbound poster: represent it in the transcript by its caption.
		if (typeof body.image?.caption === 'string') return body.image.caption;
		const i = body.interactive;
		for (const candidate of [i?.button_reply?.title, i?.list_reply?.title, i?.body?.text]) {
			if (typeof candidate === 'string') return candidate;
		}
		return null;
	} catch {
		return null;
	}
}
