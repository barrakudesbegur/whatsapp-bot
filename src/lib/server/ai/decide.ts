/**
 * The decision contract — the heart of the AI-first bot.
 *
 * Every inbound free-text message (and every tapped option) is understood by ONE
 * model call that returns a `Decision`: an in-voice Catalan `reply`, a whitelist
 * of `actions` the code executes against D1, and optional interactive `control`
 * (buttons/list) the model generates to make answering easy.
 *
 * The model only ever PROPOSES. This module is where code stays the authority:
 *  - `DECISION_JSON_SCHEMA` is sent as Workers AI `response_format` (best effort).
 *  - `extractJson` recovers JSON even when a model wraps it in prose/fences.
 *  - `parseDecision` validates with valibot and DROPS anything off-whitelist, so a
 *    hallucinated/injected action can never take effect.
 *  - `fallbackDecision` is the deterministic, NEVER-mutating reply used when the
 *    model errors or returns garbage (graceful degradation).
 *
 * `Decider` is the seam: `WorkersAiDecider` in production, `ScriptedDecider` in
 * tests — so every conversation branch is exercised deterministically.
 */

import * as v from 'valibot';

/** Per-message model telemetry, recorded on the outbound row (was ai/provider.ts). */
export interface AiMeta {
	model: string;
	latencyMs: number;
	tokens?: number;
}

// --- Survey vocabulary (kept in sync with survey/spec.ts) -----------------

export const SIGNUP_CHOICES = ['grup', 'avisam', 'res'] as const;
export type SignupChoice = (typeof SIGNUP_CHOICES)[number];

export const AVAILABILITY_BUCKETS = [
	'dissabtes',
	'diumenges',
	'entre-setmana',
	'depen',
	'igual',
	'custom'
] as const;
export type AvailabilityBucket = (typeof AVAILABILITY_BUCKETS)[number];

// --- Actions the model may propose (code executes) ------------------------

export type Action =
	| { type: 'set_display_name'; name: string }
	| { type: 'record_signup'; choice: SignupChoice }
	| { type: 'record_availability'; bucket: AvailabilityBucket; note?: string }
	| { type: 'start_survey' }
	| { type: 'restart_survey' }
	| { type: 'decline_survey' };
// Data deletion is deliberately NOT a chat capability: people who want their
// data erased are told to email hola@barrakudesbegur.org (see decide-prompt.ts);
// an admin honors it manually (Store.anonymizePerson).

export type ActionType = Action['type'];

// --- Interactive options the model generates (code assigns ids + validates) --

export type Control =
	| { kind: 'buttons'; options: ControlOption[] }
	| { kind: 'list'; label: string; options: ControlOption[] };

export interface ControlOption {
	title: string;
	description?: string;
}

/** One WhatsApp bubble: short text, optionally with tappable options attached. */
export interface Bubble {
	text: string;
	/** Tappable options for this bubble (absent = plain text). */
	control?: Control;
}

export interface Decision {
	/**
	 * Kudi's in-voice reply as 1–10 SHORT WhatsApp bubbles, sent in order
	 * (usually 1–3). Any bubble may carry a `control`; people may tap options in
	 * any order — even later, or while another message is being processed — and
	 * each tap simply flows back through decide() against the state of that
	 * moment, so nothing depends on taps being "current".
	 */
	replies: Bubble[];
	/** Side effects to apply, in order. Empty for pure chat / KB answers. */
	actions: Action[];
}

// --- State handed to the model each turn ----------------------------------

export interface DecisionState {
	now: string;
	person: { displayName: string | null; profileName: string | null; isAnonymous: boolean };
	survey: {
		status: 'none' | 'active' | 'completed' | 'declined';
		collected: {
			signup: SignupChoice | null;
			availability: string | null;
			availabilityRaw: string | null;
		};
		instanceId: number | null;
	};
	/** Fields still worth asking for, in ask order. Derived, handed to the model as data. */
	missing: ('name' | 'signup' | 'availability')[];
	/** Active campaigns (0..N, highest priority first) Kudi gently steers toward. */
	campaigns: { slug: string; title: string; pitch: string }[];
	course: { status: string; note: string };
	/** Assembled knowledge block (static KB + active entries + live events). */
	kb: string;
	/** Last few turns as {role,text} for context. */
	transcript: { role: 'user' | 'kudi'; text: string }[];
	/** The current inbound text (a tapped option's title when `tapped`). */
	userMessage: string;
	/** True when `userMessage` came from tapping an option rather than typing. */
	tapped: boolean;
}

export interface DecideOutput {
	decision: Decision;
	meta: AiMeta;
}

/** The single understanding seam: WorkersAiDecider (prod) / ScriptedDecider (tests). */
export interface Decider {
	decide(state: DecisionState): Promise<DecideOutput>;
}

// --- The JSON schema sent to the model as response_format -----------------
// Flat action objects (only `type` required, per-type fields optional) — strict
// conditional-requireds are unreliable on mid-size models. Code validates for real.

export const DECISION_JSON_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['replies', 'actions'],
	properties: {
		replies: {
			type: 'array',
			minItems: 1,
			maxItems: 10,
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['text'],
				properties: {
					text: { type: 'string', maxLength: 1024 },
					control: {
						type: 'object',
						additionalProperties: false,
						required: ['kind'],
						properties: {
							kind: { type: 'string', enum: ['none', 'buttons', 'list'] },
							label: { type: 'string', maxLength: 20 },
							options: {
								type: 'array',
								maxItems: 10,
								items: {
									type: 'object',
									additionalProperties: false,
									required: ['title'],
									properties: {
										title: { type: 'string', maxLength: 24 },
										description: { type: 'string', maxLength: 72 }
									}
								}
							}
						}
					}
				}
			}
		},
		actions: {
			type: 'array',
			maxItems: 4,
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['type'],
				properties: {
					type: {
						type: 'string',
						enum: [
							'set_display_name',
							'record_signup',
							'record_availability',
							'start_survey',
							'restart_survey',
							'decline_survey'
						]
					},
					name: { type: 'string', maxLength: 40 },
					choice: { type: 'string', enum: [...SIGNUP_CHOICES] },
					bucket: { type: 'string', enum: [...AVAILABILITY_BUCKETS] },
					note: { type: 'string', maxLength: 280 }
				}
			}
		}
	}
} as const;

// --- Validation (what code trusts) ----------------------------------------

const NAME_MAX = 40;
const NOTE_MAX = 280;
const REPLY_MAX = 1024;

const ActionSchema = v.variant('type', [
	v.object({
		type: v.literal('set_display_name'),
		name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(NAME_MAX))
	}),
	v.object({ type: v.literal('record_signup'), choice: v.picklist(SIGNUP_CHOICES) }),
	v.object({
		type: v.literal('record_availability'),
		bucket: v.picklist(AVAILABILITY_BUCKETS),
		note: v.optional(v.pipe(v.string(), v.maxLength(NOTE_MAX)))
	}),
	v.object({ type: v.literal('start_survey') }),
	v.object({ type: v.literal('restart_survey') }),
	v.object({ type: v.literal('decline_survey') })
]);

/**
 * Parse a raw model response into a trusted `Decision`, or null when unusable
 * (caller substitutes `fallbackDecision`). Every action is validated
 * individually; one bad action is dropped without discarding the good ones.
 */
export function parseDecision(raw: string): Decision | null {
	const obj = extractJson(raw);
	if (!obj || typeof obj !== 'object') return null;
	const o = obj as Record<string, unknown>;

	// Bubbles: [{text, control?}]. Tolerates plain strings in the array, a legacy
	// single `reply` string, and a legacy top-level `control` (→ last bubble).
	const rawReplies = Array.isArray(o.replies)
		? o.replies
		: typeof o.reply === 'string'
			? [o.reply]
			: [];
	const replies = rawReplies
		.map((r): Bubble | null => {
			if (typeof r === 'string') {
				const text = r.trim().slice(0, REPLY_MAX);
				return text ? { text } : null;
			}
			if (r && typeof r === 'object') {
				const b = r as Record<string, unknown>;
				const text = typeof b.text === 'string' ? b.text.trim().slice(0, REPLY_MAX) : '';
				if (!text) return null;
				const control = parseControl(b.control);
				return control ? { text, control } : { text };
			}
			return null;
		})
		.filter((b): b is Bubble => b !== null)
		.slice(0, 10);
	if (replies.length === 0) return null;

	const legacyControl = parseControl(o.control);
	const last = replies[replies.length - 1];
	if (legacyControl && last && !last.control) last.control = legacyControl;

	const actions: Action[] = [];
	if (Array.isArray(o.actions)) {
		for (const candidate of o.actions) {
			const res = v.safeParse(ActionSchema, candidate);
			if (res.success) actions.push(res.output as Action);
		}
	}

	return { replies, actions };
}

function parseControl(raw: unknown): Control | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const c = raw as Record<string, unknown>;
	if (c.kind !== 'buttons' && c.kind !== 'list') return undefined;
	const options = Array.isArray(c.options)
		? c.options
				.map((o): ControlOption | null => {
					if (!o || typeof o !== 'object') return null;
					const title =
						typeof (o as Record<string, unknown>).title === 'string'
							? ((o as Record<string, unknown>).title as string).trim()
							: '';
					if (!title) return null;
					const descRaw = (o as Record<string, unknown>).description;
					const description =
						typeof descRaw === 'string' && descRaw.trim() ? descRaw.trim() : undefined;
					return description ? { title, description } : { title };
				})
				.filter((o): o is ControlOption => o !== null)
		: [];
	if (options.length === 0) return undefined;
	if (c.kind === 'buttons') return { kind: 'buttons', options };
	const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim() : 'Tria';
	return { kind: 'list', label, options };
}

/**
 * Extract a JSON object from a model response. Tolerates ```json fences and
 * surrounding prose by brace-matching (string-aware) from the first `{` to its
 * partner — so nested arrays/objects (e.g. a populated `actions[]`) parse whole.
 */
export function extractJson(raw: string): unknown {
	if (typeof raw !== 'string') return null;
	let s = raw.trim();
	// Strip a leading ```json / ``` fence and a trailing ``` if present.
	const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fence?.[1]) s = fence[1].trim();

	try {
		return JSON.parse(s);
	} catch {
		/* fall through to brace matching */
	}

	const start = s.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{' || ch === '[') depth++;
		else if (ch === '}' || ch === ']') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(s.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/** Short deterministic re-ask for a missing survey field (fallback + media path). */
export function missingFieldNudge(field: 'name' | 'signup' | 'availability'): string {
	switch (field) {
		case 'name':
			return 'Per cert, com vols que et digui?';
		case 'signup':
			return 'Quan sapiguem si es fa el curs, què vols que faci: t’apunto al grup, t’aviso, o res?';
		case 'availability':
			return 'I quan et va bé, els caps de setmana?';
	}
}

/**
 * Deterministic reply used when the model is unavailable or returns garbage.
 * NEVER carries actions — a degraded turn can never mutate state, least of all
 * erase data. Nudges the first missing survey field when a survey is in flight.
 */
export function fallbackDecision(state: DecisionState): Decision {
	const name = state.person.displayName?.trim();
	const hi = name && name !== 'Anònim' ? `Ei, ${name}! ` : 'Ei! ';
	let reply =
		`${hi}Ara mateix m'he encallat i no t'he pogut respondre bé 😅 ` +
		'Pots tornar-m’ho a dir? Si és urgent, escriu-nos a Instagram @barrakudesbegur 🧡';
	const next = state.missing[0];
	if (state.survey.status === 'active' && next) reply += ` ${missingFieldNudge(next)}`;
	return { replies: [{ text: reply }], actions: [] };
}
