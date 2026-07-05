/**
 * Executes a validated `Decision` against D1 and sends Kudi's reply.
 *
 * Code is the authority here: it applies the whitelisted actions (already
 * validated by parseDecision), derives survey completion itself (the model never
 * completes), gates data erasure so a single message can't delete, and turns the
 * model's `reply` (+ optional generated options) into a WhatsApp message —
 * validating every interactive against WhatsApp limits and falling back to plain
 * text if the model's options don't fit.
 */

import { validateOutMessage, LIMITS, type OutMessage } from '../messages.ts';
import type { Store, FlowStatusRow } from '../db/store.ts';
import type { Sender, SentMessage } from '../wa/sender.ts';
import type { AiMeta, Control, Decision, DecisionState } from '../ai/decide.ts';
import { mayDelete } from '../ai/decide.ts';
import { SURVEY_ID, GDPR_FLOW, toDataJson, deriveStatus, type SurveyCollected } from './spec.ts';
import { nowIso } from '../time.ts';

export interface ApplyDeps {
	store: Store;
	sender: Sender;
}

// Deterministic copy for the terminal erasure taps (safety path only). Kudi's
// conversational surface is model-generated; these two lines are the sole canned
// strings, justified by the irreversibility of the delete.
export const GDPR_DONE =
	'Fet! He esborrat les teves dades 🧹 Si algun dia vols tornar, escriu-me i comencem de nou.';
export const GDPR_KEPT = 'Tranquil, no esborro res 😊 Segueix tot igual.';

const GDPR_YES = 'gdpr_yes';
const GDPR_NO = 'gdpr_no';

/** The one deterministic interactive: the destructive-erasure confirmation. */
export function gdprConfirmMessage(body: string): OutMessage {
	return {
		kind: 'buttons',
		body: clamp(body, LIMITS.BODY_MAX) || 'Segur que vols esborrar les teves dades?',
		buttons: [
			{ id: GDPR_YES, title: 'Sí, esborra-ho' },
			{ id: GDPR_NO, title: 'No, cancel·la' }
		]
	};
}
export { GDPR_YES, GDPR_NO };

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
	let initiateErasure = false;
	let confirmErasure = false;
	let cancelErase = false;

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
			case 'initiate_erasure':
				initiateErasure = true;
				break;
			case 'confirm_erasure':
				confirmErasure = true;
				break;
			case 'cancel_erasure':
				cancelErase = true;
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

	// Erasure paths (terminal / gated) take priority over a normal reply.
	if (confirmErasure && mayDelete(state, { decision })) {
		return performErasure(person, state.erasureInstanceId, deps, decision.reply, now, meta);
	}
	if (cancelErase && state.erasurePending) {
		return cancelErasure(person, state.erasureInstanceId, deps, decision.reply, now, meta);
	}
	if (initiateErasure) {
		const gdprId = await armErasure(store, person.id, state.erasureInstanceId, now);
		return sender.send(person, [gdprConfirmMessage(decision.reply)], {
			flowInstanceId: gdprId,
			aiMeta: meta
		});
	}

	return sender.send(person, [buildReplyMessage(decision)], {
		flowInstanceId: surveyInstanceId,
		aiMeta: meta
	});
}

// --- Erasure helpers (shared with the router's GDPR tap fast-path) ---------

/** Arm (or re-arm) a data-erasure request — creates the pending row, no delete. */
export async function armErasure(
	store: Store,
	personId: number,
	existingId: number | null,
	now: string
): Promise<number> {
	if (existingId != null) {
		await store.updateFlowInstance(existingId, {
			status: 'active',
			step: null,
			dataJson: '{}',
			updatedAt: now,
			completedAt: null
		});
		return existingId;
	}
	const row = await store.createFlowInstance({
		personId,
		flowType: GDPR_FLOW,
		status: 'active',
		step: null,
		dataJson: '{}',
		createdAt: now
	});
	return row.id;
}

/** Send the goodbye, then scrub the person + delete their messages. Irreversible. */
export async function performErasure(
	person: { id: number; wa_id: string },
	gdprInstanceId: number | null,
	deps: ApplyDeps,
	goodbye: string,
	now: string,
	meta: AiMeta | null = null
): Promise<SentMessage[]> {
	if (gdprInstanceId != null) {
		await deps.store.updateFlowInstance(gdprInstanceId, {
			status: 'completed',
			step: null,
			dataJson: '{}',
			updatedAt: now,
			completedAt: now
		});
	}
	const sent = await deps.sender.send(person, [{ kind: 'text', body: goodbye }], {
		flowInstanceId: gdprInstanceId,
		aiMeta: meta
	});
	await deps.store.anonymizePerson(person.id, now);
	return sent;
}

/** Disarm a pending erasure and reassure. */
export async function cancelErasure(
	person: { id: number; wa_id: string },
	gdprInstanceId: number | null,
	deps: ApplyDeps,
	reply: string,
	now: string,
	meta: AiMeta | null = null
): Promise<SentMessage[]> {
	if (gdprInstanceId != null) {
		await deps.store.updateFlowInstance(gdprInstanceId, {
			status: 'declined',
			step: null,
			dataJson: '{}',
			updatedAt: now,
			completedAt: null
		});
	}
	return deps.sender.send(person, [{ kind: 'text', body: reply }], {
		flowInstanceId: gdprInstanceId,
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

/** Turn a decision into one WhatsApp message: model options if valid, else text. */
export function buildReplyMessage(decision: Decision): OutMessage {
	const body = clamp(decision.reply, LIMITS.BODY_MAX);
	if (!decision.control) return { kind: 'text', body };
	const interactive = buildControlMessage(body, decision.control);
	return interactive ?? { kind: 'text', body };
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
