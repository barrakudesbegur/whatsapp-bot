/**
 * Executes a validated `Decision` against D1 and sends Kudi's reply.
 *
 * Code is the authority here: it applies the whitelisted actions (already
 * validated by parseDecision), derives survey completion itself (the model never
 * completes), and turns the model's `reply` (+ optional generated options) into
 * a WhatsApp message — validating every interactive against WhatsApp limits and
 * falling back to plain text if the model's options don't fit.
 *
 * Data deletion is intentionally NOT possible from the chat: Kudi points people
 * to hola@barrakudesbegur.org (see decide-prompt.ts) and an admin honors the
 * request from the admin panel (data.remote.ts → Store.anonymizePerson).
 */

import { validateOutMessage, LIMITS, type OutMessage } from '../messages.ts';
import type { Store, FlowStatusRow } from '../db/store.ts';
import type { Sender, SentMessage } from '../wa/sender.ts';
import { fallbackDecision } from '../ai/decide.ts';
import type { AiMeta, Control, Decision, DecisionState } from '../ai/decide.ts';
import {
	SURVEY_ID,
	toDataJson,
	deriveStatus,
	parseCollected,
	type SurveyCollected
} from './spec.ts';
import { nowIso } from '../time.ts';

export interface ApplyDeps {
	store: Store;
	sender: Sender;
}

/** Apply a decision's actions, then send Kudi's reply. Returns what was sent. */
export async function applyDecision(
	state: DecisionState,
	decision: Decision,
	meta: AiMeta | null,
	person: { id: number; wa_id: string },
	deps: ApplyDeps
): Promise<SentMessage[]> {
	const now = nowIso();
	const { store, sender } = deps;

	// Accumulate only the fields THIS turn changed (not the whole draft): persistSurvey
	// merges them onto the freshest stored data, so a field this turn didn't touch is
	// never overwritten with a stale snapshot value (concurrent-tap safety).
	const changes: Partial<SurveyCollected> = {};
	let resetSurvey = false;
	let surveyTouched = false;

	for (const action of decision.actions) {
		switch (action.type) {
			case 'set_display_name':
				// Only trust a name the person could actually have said (observed
				// live: the model invented «Marc» out of nowhere and saved it).
				if (nameIsGrounded(action.name, state)) {
					await store.setDisplayName(person.id, clamp(action.name.trim(), 40), now);
				}
				break;
			case 'start_survey':
				surveyTouched = true;
				break;
			case 'restart_survey':
				// Reset all answers; a later action in the same turn re-applies over it.
				resetSurvey = true;
				delete changes.signup;
				delete changes.availability;
				delete changes.availabilityRaw;
				surveyTouched = true;
				break;
			case 'record_signup':
				changes.signup = action.choice;
				surveyTouched = true;
				break;
			case 'record_availability': {
				if (action.bucket === 'custom') {
					const note = action.note?.trim();
					// «custom» with no note is meaningless: it would COMPLETE the survey
					// with an uninterpretable bucket the model then never re-asks. Skip it
					// so deriveMissing keeps asking for a real availability.
					if (!note) break;
					changes.availability = 'custom';
					changes.availabilityRaw = note;
				} else {
					changes.availability = action.bucket;
					changes.availabilityRaw = null;
				}
				surveyTouched = true;
				break;
			}
			case 'decline_survey':
				changes.signup = 'res';
				surveyTouched = true;
				break;
		}
	}

	// Persist the changes (code derives completion; the model never completes).
	let surveyInstanceId = state.survey.instanceId;
	if (surveyTouched) {
		surveyInstanceId = await persistSurvey(store, person.id, changes, resetSurvey, now);
	}

	// Never leave the person with silence after the typing indicator: if every
	// bubble got dropped (e.g. a caption-less image whose URL isn't in the KB, so
	// buildReplyMessages returns []), substitute the deterministic, non-mutating
	// apology so every inbound turn yields at least one outbound message.
	let messages = buildReplyMessages(decision, state.kb);
	if (messages.length === 0) messages = buildReplyMessages(fallbackDecision(state), state.kb);
	return sender.send(person, messages, {
		flowInstanceId: surveyInstanceId,
		aiMeta: meta
	});
}

// --- Internals ------------------------------------------------------------

/**
 * Diacritic- and case-insensitive fold for grounding. The prompt tells Kudi to
 * write proper Catalan, so it canonicalizes accents the person omitted («merce»
 * → «Mercè»); comparing raw would drop that as ungrounded and Kudi would re-ask
 * forever (a wasted ~3,700-token turn each time). We store the model's accented
 * spelling but ground it against the folded user text.
 */
function fold(s: string): string {
	return s
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.trim()
		.toLowerCase();
}

/**
 * A model-proposed display name is only trusted when the person could actually
 * have said it: it appears (accent/case-insensitive) in the current message or a
 * recent user turn, matches the WhatsApp profile name, or is the explicit
 * «Anònim» fallback the prompt allows. Anything else is a hallucination and is
 * dropped — the name stays unset and the model keeps asking for it.
 */
function nameIsGrounded(name: string, state: DecisionState): boolean {
	const n = fold(name);
	if (!n) return false;
	if (n === 'anonim') return true; // «Anònim» and «Anonim» both fold to this
	const profile = state.person.profileName ? fold(state.person.profileName) : '';
	if (profile && profile.includes(n)) return true;
	const userTexts = [
		state.userMessage,
		...state.transcript.filter((t) => t.role === 'user').map((t) => t.text)
	];
	return userTexts.some((t) => fold(t).includes(n));
}

const EMPTY_COLLECTED: SurveyCollected = {
	signup: null,
	availability: null,
	availabilityRaw: null
};

function mergeCollected(base: SurveyCollected, changes: Partial<SurveyCollected>): SurveyCollected {
	const merged = { ...base, ...changes };
	if (merged.availability !== 'custom') merged.availabilityRaw = null;
	return merged;
}

/** deriveStatus mapped to a persistable FlowStatusRow ('none' → 'active'). */
function statusOf(c: SurveyCollected): FlowStatusRow {
	const s = deriveStatus(c);
	return s === 'none' ? 'active' : s;
}

/**
 * Persist THIS turn's survey changes against the freshest instance, with an
 * optimistic CAS retry. We re-read the latest instance (not the seconds-old
 * snapshot taken at state-load, before the model call), merge only what changed,
 * and compare-and-swap on data_json — so two fast taps on different fields can't
 * clobber each other. Code owns completion; the model never sets status.
 */
async function persistSurvey(
	store: Store,
	personId: number,
	changes: Partial<SurveyCollected>,
	reset: boolean,
	now: string
): Promise<number> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const latest = await store.getLatestFlowInstance(personId, SURVEY_ID);
		if (latest) {
			const base = reset ? EMPTY_COLLECTED : parseCollected(latest.data_json);
			const merged = mergeCollected(base, changes);
			const status = statusOf(merged);
			const done = status === 'completed' || status === 'declined';
			const ok = await store.casUpdateFlowInstance(latest.id, latest.data_json, {
				status,
				step: null,
				dataJson: toDataJson(merged),
				updatedAt: now,
				completedAt: done ? now : null
			});
			if (ok) return latest.id;
			continue; // a concurrent turn changed data_json → re-read + retry
		}
		// First touch → create. If a concurrent create won (partial-unique-index
		// violation), createFlowInstance throws → loop finds the winner and updates it.
		const merged = mergeCollected(EMPTY_COLLECTED, changes);
		const status = statusOf(merged);
		const dataJson = toDataJson(merged);
		try {
			const row = await store.createFlowInstance({
				personId,
				flowType: SURVEY_ID,
				status,
				step: null,
				dataJson,
				createdAt: now
			});
			// createFlowInstance leaves completed_at null; stamp it for a terminal status.
			if (status === 'completed' || status === 'declined') {
				await store.casUpdateFlowInstance(row.id, dataJson, {
					status,
					step: null,
					dataJson,
					updatedAt: now,
					completedAt: now
				});
			}
			return row.id;
		} catch {
			// Lost the create race → next iteration updates the winner.
		}
	}
	// Extreme contention (5 CAS misses in a row) — return the current instance id.
	return (await store.getLatestFlowInstance(personId, SURVEY_ID))?.id ?? 0;
}

/**
 * Turn a decision into WhatsApp messages: one message per bubble, in order.
 * A bubble with a valid `image` becomes an image message (text → caption) —
 * but ONLY when the URL appears verbatim in the KB, so a hallucinated URL can
 * never be sent (it degrades to plain text, or is dropped if there is no
 * text). A bubble with a valid `control` becomes an interactive (buttons/
 * list); an invalid control degrades that bubble to plain text.
 */
export function buildReplyMessages(decision: Decision, kb: string): OutMessage[] {
	// Exact set of https URLs present in the KB. Gating images on an EXACT match
	// (not a substring `kb.includes`) closes the hole where a truncated/prefix URL
	// — e.g. the poster URL minus its «.jpg» — is a substring of a real KB URL and
	// would be sent as a broken (404) image. parseImage already rejects URLs with
	// whitespace, so a model image URL is a single clean token that matches here.
	const kbUrls = new Set(kb.match(/https:\/\/\S+/g) ?? []);
	return decision.replies
		.map((bubble): OutMessage | null => {
			const body = clamp(stripEmDash(bubble.text), LIMITS.BODY_MAX);
			if (bubble.image && kbUrls.has(bubble.image)) {
				const msg: OutMessage = {
					kind: 'image',
					link: bubble.image,
					...(body ? { caption: body } : {})
				};
				if (validateOutMessage(msg).length === 0) return msg;
			}
			if (!body) return null;
			if (!bubble.control) return { kind: 'text', body };
			return buildControlMessage(body, bubble.control) ?? { kind: 'text', body };
		})
		.filter((m): m is OutMessage => m !== null);
}

function buildControlMessage(body: string, control: Control): OutMessage | null {
	if (control.kind === 'buttons') {
		const buttons = control.options
			.slice(0, LIMITS.MAX_BUTTONS)
			.map((o, i) => ({ id: `opt_${i}`, title: clamp(o.title.trim(), LIMITS.BUTTON_TITLE_MAX) }))
			.filter((b) => b.title.length > 0);
		if (buttons.length === 0) return null;
		const msg: OutMessage = { kind: 'buttons', body, buttons };
		return validateOutMessage(msg).length === 0 ? msg : null;
	}
	const rows = control.options
		.slice(0, LIMITS.MAX_LIST_ROWS)
		.map((o, i) => ({
			id: `opt_${i}`,
			title: clamp(o.title.trim(), LIMITS.ROW_TITLE_MAX),
			...(o.description ? { description: clamp(o.description, LIMITS.ROW_DESC_MAX) } : {})
		}))
		.filter((r) => r.title.length > 0);
	if (rows.length === 0) return null;
	const msg: OutMessage = {
		kind: 'list',
		body,
		button: clamp(control.label, LIMITS.LIST_BUTTON_MAX) || 'Tria',
		rows
	};
	return validateOutMessage(msg).length === 0 ? msg : null;
}

function clamp(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) : s;
}

/**
 * Kudi never writes em dashes (owner rule: not used in Catalan). The prompt
 * forbids them, but models slip — normalize any that get through to a comma,
 * and collapse the double punctuation that can leave behind.
 */
export function stripEmDash(s: string): string {
	return s
		.replace(/\s*—\s*/g, ', ')
		.replace(/\s+–\s+/g, ', ')
		.replace(/([,.;:!?])\s*,\s?/g, '$1 ')
		.replace(/^[,\s]+/, '')
		.replace(/[,\s]+$/, '');
}
