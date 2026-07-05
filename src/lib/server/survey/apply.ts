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
import type { AiMeta, Control, Decision, DecisionState } from '../ai/decide.ts';
import { SURVEY_ID, toDataJson, deriveStatus, type SurveyCollected } from './spec.ts';
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

	let draft: SurveyCollected = { ...state.survey.collected };
	let surveyTouched = false;
	let declined = false;

	for (const action of decision.actions) {
		switch (action.type) {
			case 'set_display_name':
				await store.setDisplayName(person.id, clamp(action.name.trim(), 40), now);
				break;
			case 'start_survey':
				surveyTouched = true;
				break;
			case 'restart_survey':
				draft = { signup: null, availability: null, availabilityRaw: null };
				surveyTouched = true;
				break;
			case 'record_signup':
				draft.signup = action.choice;
				surveyTouched = true;
				break;
			case 'record_availability':
				draft.availability = action.bucket;
				draft.availabilityRaw = action.bucket === 'custom' ? (action.note ?? '') : null;
				surveyTouched = true;
				break;
			case 'decline_survey':
				draft.signup = 'res';
				declined = true;
				surveyTouched = true;
				break;
		}
	}

	// Persist the survey draft (code derives completion; the model never completes).
	let surveyInstanceId = state.survey.instanceId;
	if (surveyTouched) {
		const status = declined ? 'declined' : deriveStatus(draft);
		surveyInstanceId = await persistSurvey(
			store,
			person.id,
			state.survey.instanceId,
			draft,
			status === 'none' ? 'active' : status,
			now
		);
	}

	return sender.send(person, buildReplyMessages(decision), {
		flowInstanceId: surveyInstanceId,
		aiMeta: meta
	});
}

// --- Internals ------------------------------------------------------------

async function persistSurvey(
	store: Store,
	personId: number,
	instanceId: number | null,
	draft: SurveyCollected,
	status: FlowStatusRow,
	now: string
): Promise<number> {
	const done = status === 'completed' || status === 'declined';
	const dataJson = toDataJson(draft);
	if (instanceId != null) {
		await store.updateFlowInstance(instanceId, {
			status,
			step: null,
			dataJson,
			updatedAt: now,
			completedAt: done ? now : null
		});
		return instanceId;
	}
	const row = await store.createFlowInstance({
		personId,
		flowType: SURVEY_ID,
		status,
		step: null,
		dataJson,
		createdAt: now
	});
	if (done) {
		await store.updateFlowInstance(row.id, {
			status,
			step: null,
			dataJson,
			updatedAt: now,
			completedAt: now
		});
	}
	return row.id;
}

/**
 * Turn a decision into WhatsApp messages: one message per bubble, in order.
 * A bubble with a valid `control` becomes an interactive (buttons/list); an
 * invalid control degrades that bubble to plain text.
 */
export function buildReplyMessages(decision: Decision): OutMessage[] {
	return decision.replies.map((bubble): OutMessage => {
		const body = clamp(bubble.text, LIMITS.BODY_MAX);
		if (!bubble.control) return { kind: 'text', body };
		return buildControlMessage(body, bubble.control) ?? { kind: 'text', body };
	});
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
