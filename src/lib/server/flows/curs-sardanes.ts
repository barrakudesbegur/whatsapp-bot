/**
 * The `curs-sardanes` survey flow (PLAN 4.4).
 *
 * Pure state machine. Copy is the plan's draft Catalan, VERBATIM (owner polishes
 * before launch). Steps:
 *   name          K1 — intro + "com vols que et digui?"
 *   action        K2 info + K3 three buttons (grup / avisam / res)
 *   availability  K4 list of 5 rows (+ free-text invitation)
 *   confirm_restart  returning-completed person: Sí / No
 *
 * Final data_json shape (PLAN 4.4):
 *   { action: "grup"|"avisam"|"res",
 *     availability: "dissabtes"|"diumenges"|"entre-setmana"|"depen"|"igual"|"custom",
 *     availability_raw?: "<text when custom>" }
 */

import type { OutMessage } from '../messages.ts';
import { normalizeText } from '../normalize.ts';
import type { FlowContext, FlowInput, FlowModule, FlowResult } from './types.ts';

export const STEP = {
	NAME: 'name',
	ACTION: 'action',
	AVAILABILITY: 'availability',
	CONFIRM_RESTART: 'confirm_restart'
} as const;

export const ACTION_IDS = ['grup', 'avisam', 'res'] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export const AVAILABILITY_IDS = [
	'dissabtes',
	'diumenges',
	'entre-setmana',
	'depen',
	'igual'
] as const;
export type AvailabilityId = (typeof AVAILABILITY_IDS)[number];

// --- Copy ----------------------------------------------------------------

const K1_INTRO =
	"Ei! 👋 Sóc en Kudi — el nino taronja del logo dels Barrakudes (sí, tinc nom!). Ara t'explico això del curs, però primer de tot: com vols que et digui?";

function k2Info(name: string | null): string {
	const hi = name ? `Genial, ${name}! 🧡` : 'Genial! 🧡';
	return (
		`${hi} Doncs mira: als Barrakudes ens ronda pel cap muntar un curs per ` +
		'aprendre a ballar sardanes. De moment és només una idea — abans de ' +
		"llançar-nos-hi volem saber si hi ha prou gent que s'hi apuntaria. Seria " +
		'un curs de debò: unes quantes sessions repartides durant uns mesos, els ' +
		'caps de setmana (que és quan tothom és a Begur 😉). Si tira endavant, ' +
		'muntarem un grup de WhatsApp per organitzar-ho. I potser et torno a ' +
		'escriure per demanar-te algun detall o opinió.'
	);
}

const K3_ACTION: OutMessage = {
	kind: 'buttons',
	body: 'Què vols que faci quan sapiguem si es fa?',
	buttons: [
		{ id: 'grup', title: 'Afegeix-me al grup' },
		{ id: 'avisam', title: "Només avisa'm" },
		{ id: 'res', title: 'Res, gràcies' }
	]
};

const K3_DECLINED =
	"Cap problema! 😊 Si canvies d'idea, escriu-me i seguim on ho hem deixat. I si tens preguntes dels Barrakudes, dispara!";

const K4_AVAILABILITY: OutMessage = {
	kind: 'list',
	body:
		'Última pregunteta i et deixo en pau 😄 Quan et sol anar bé? Si cap opció ' +
		"t'encaixa, escriu-m'ho amb les teves paraules i ho apunto!",
	button: 'Quan em va bé',
	rows: [
		{ id: 'dissabtes', title: 'Dissabtes' },
		{ id: 'diumenges', title: 'Diumenges' },
		{ id: 'entre-setmana', title: 'Entre setmana' },
		{ id: 'depen', title: 'Depèn del cap de setmana' },
		{ id: 'igual', title: "M'és igual, tot em va bé" }
	]
};

function k5Close(name: string | null, action: ActionId): string {
	const hi = name ? `Doncs ja està, ${name}! 🎉` : 'Doncs ja està! 🎉';
	const variant =
		action === 'grup'
			? "Quan el curs sigui una realitat, t'envio la invitació al grup per aquí."
			: "Quan sapiguem si es fa, t'escric per aquí.";
	return (
		`${hi} ${variant} Mentrestant, si tens cap pregunta — del curs, dels ` +
		'Barrakudes, del que sigui — pregunta-me-la! 🧡'
	);
}

const RETURNING_PROMPT: OutMessage = {
	kind: 'buttons',
	body: 'Ja et tenia apuntat! 😄 Vols canviar alguna resposta?',
	buttons: [
		{ id: 'yes', title: 'Sí' },
		{ id: 'no', title: 'No' }
	]
};

const RETURNING_KEEP =
	'Perfecte, ho deixem tal com estava! 😊 Si tens qualsevol pregunta, aquí em tens 🧡';

const RETURNING_RESTART_LEAD = 'Som-hi, refem-ho! 😄';

// --- Helpers -------------------------------------------------------------

function greetName(ctx: FlowContext): string | null {
	const dn = typeof ctx.displayName === 'string' ? ctx.displayName.trim() : '';
	if (dn) return dn;
	const pn = typeof ctx.profileName === 'string' ? ctx.profileName.trim() : '';
	return pn ? (pn.split(/\s+/)[0] ?? null) : null;
}

/**
 * Extract a display name from free text, stripping common Catalan lead-ins
 * ("em dic ...", "diguem ...", "sóc ..."). Returns null when the text looks
 * like a question rather than a name (router then runs the AI fallback).
 */
const NAME_LEAD_INS = new Set([
	'hola',
	'ei',
	'bones',
	'bon',
	'dia',
	'em',
	'dic',
	'me',
	'diguem',
	'diguem-me',
	"digue'm",
	'digue’m',
	'digues-me',
	'dis-me',
	'digueu-me',
	'diguis',
	'soc',
	'sóc',
	'jo',
	'el',
	'la',
	'en',
	'na',
	'meu',
	'nom',
	'es',
	'és',
	'que',
	'et',
	'pots',
	'cridar'
]);

export function parseName(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (!/[a-zà-ÿ]/i.test(trimmed)) return null; // no letters at all → not a name
	// Looks like a question (multi-word + '?') → unclear, let the AI answer it.
	if (/[?¿]/.test(trimmed) && trimmed.split(/\s+/).length >= 3) return null;

	// Drop leading Catalan lead-ins ("em dic ...", "sóc en ...", "la Marina").
	const tokens = trimmed.split(/\s+/);
	let i = 0;
	while (
		i < tokens.length &&
		NAME_LEAD_INS.has((tokens[i] ?? '').toLowerCase().replace(/[.,!]+$/, ''))
	) {
		i++;
	}
	const rest = tokens
		.slice(i)
		.join(' ')
		.replace(/[.,!]+$/, '')
		.trim();
	const candidate = (rest || trimmed).slice(0, 40).trim();
	return candidate || null;
}

/** Scripted parse of free-text availability → canonical id, or null. */
export function parseAvailability(text: string): AvailabilityId | null {
	const n = normalizeText(text);
	if (!n) return null;
	if (/\bdissabte/.test(n)) return 'dissabtes';
	if (/\bdiumenge/.test(n)) return 'diumenges';
	if (/entre\s+setmana|feiners?|laborables?/.test(n)) return 'entre-setmana';
	if (/\bdepen/.test(n)) return 'depen';
	if (/\bigual\b|qualsevol|tot\s+em\s+va|m\s*es\s+igual|tant\s+me\s+fa/.test(n)) return 'igual';
	return null;
}

/** Loose keyword parse of a typed (not tapped) action answer → button id. */
function parseActionText(text: string): ActionId | null {
	const n = normalizeText(text);
	if (!n) return null;
	if (/\bgrup\b|apunta|afegeix|afegir|sumar?|inscri/.test(n)) return 'grup';
	if (/avis/.test(n)) return 'avisam';
	if (/\bres\b|gracies|no\s+vull|deixa|passo|res\s+de\s+res/.test(n)) return 'res';
	return null;
}

// --- Result builders -----------------------------------------------------

function startResult(): FlowResult {
	return {
		messages: [{ kind: 'text', body: K1_INTRO }],
		patch: { status: 'active', step: STEP.NAME, data: {} }
	};
}

function toActionQuestion(name: string | null): OutMessage[] {
	return [{ kind: 'text', body: k2Info(name) }, K3_ACTION];
}

// --- The module ----------------------------------------------------------

export const cursSardanesFlow: FlowModule = {
	type: 'curs-sardanes',
	trigger: "explica'm això del curs de sardanes",

	start(): FlowResult {
		return startResult();
	},

	onReturningCompleted(): FlowResult {
		return {
			messages: [RETURNING_PROMPT],
			// Keep status 'completed'; a transient step drives the Sí/No reply, routed
			// via context.id (not the active-flow check).
			patch: { step: STEP.CONFIRM_RESTART }
		};
	},

	pending(ctx, step): OutMessage[] {
		switch (step) {
			case STEP.NAME:
				return [{ kind: 'text', body: K1_INTRO }];
			case STEP.ACTION:
				return [K3_ACTION];
			case STEP.AVAILABILITY:
				return [K4_AVAILABILITY];
			case STEP.CONFIRM_RESTART:
				return [RETURNING_PROMPT];
			default:
				return [];
		}
	},

	onStep(ctx, step, input): FlowResult {
		switch (step) {
			case STEP.NAME:
				return onName(ctx, input);
			case STEP.ACTION:
				return onAction(ctx, input);
			case STEP.AVAILABILITY:
				return onAvailability(ctx, input);
			case STEP.CONFIRM_RESTART:
				return onConfirmRestart(ctx, input);
			default:
				// Unknown step — re-ask nothing, defer to AI.
				return { messages: [], deferToAi: {} };
		}
	}
};

function onName(ctx: FlowContext, input: FlowInput): FlowResult {
	if (input.kind === 'interpreted') {
		// The AI already extracted the name (PLAN 4.6 structured interpretation).
		const name = input.value.trim().slice(0, 40);
		if (!name) return { messages: [], deferToAi: {} };
		return {
			messages: toActionQuestion(name),
			patch: { displayName: name, step: STEP.ACTION }
		};
	}
	if (input.kind === 'text') {
		const name = parseName(input.text);
		if (!name) {
			// Unclear (e.g. they asked a question) → AI: try extraction, else
			// answer from the KB and re-ask.
			return {
				messages: [],
				deferToAi: { interpret: { field: 'name', options: [] } }
			};
		}
		return {
			messages: toActionQuestion(name),
			patch: { displayName: name, step: STEP.ACTION }
		};
	}
	// Tapped a stray button or sent media on the name step → defer to AI (media is
	// handled globally by the router; buttons here are unexpected).
	return { messages: [], deferToAi: {} };
}

function onAction(ctx: FlowContext, input: FlowInput): FlowResult {
	let choice: ActionId | null = null;
	if (input.kind === 'button') {
		choice = (ACTION_IDS as readonly string[]).includes(input.id) ? (input.id as ActionId) : null;
	} else if (input.kind === 'text') {
		choice = parseActionText(input.text);
	} else if (input.kind === 'interpreted') {
		choice = (ACTION_IDS as readonly string[]).includes(input.value)
			? (input.value as ActionId)
			: null;
	}

	if (!choice) return { messages: [], deferToAi: {} };

	if (choice === 'res') {
		return {
			messages: [{ kind: 'text', body: K3_DECLINED }],
			patch: {
				status: 'declined',
				step: null,
				data: { action: 'res' },
				done: true
			}
		};
	}

	// grup | avisam → ask availability.
	return {
		messages: [K4_AVAILABILITY],
		patch: { step: STEP.AVAILABILITY, data: { action: choice } }
	};
}

function onAvailability(ctx: FlowContext, input: FlowInput): FlowResult {
	const action = (ctx.data.action as ActionId) ?? 'avisam';
	const name = greetName(ctx);

	const complete = (availability: AvailabilityId | 'custom', raw?: string): FlowResult => ({
		messages: [{ kind: 'text', body: k5Close(name, action) }],
		patch: {
			status: 'completed',
			step: null,
			done: true,
			data:
				availability === 'custom' ? { availability, availability_raw: raw ?? '' } : { availability }
		}
	});

	if (input.kind === 'list') {
		const id = (AVAILABILITY_IDS as readonly string[]).includes(input.id)
			? (input.id as AvailabilityId)
			: null;
		if (id) return complete(id);
		return { messages: [], deferToAi: {} };
	}

	if (input.kind === 'text') {
		const scripted = parseAvailability(input.text);
		if (scripted) return complete(scripted);
		// Couldn't parse deterministically → ask AI to interpret; stub returns null,
		// so the router answers from the KB and re-asks K4.
		return {
			messages: [],
			deferToAi: {
				interpret: { field: 'availability', options: [...AVAILABILITY_IDS] }
			}
		};
	}

	if (input.kind === 'interpreted') {
		if ((AVAILABILITY_IDS as readonly string[]).includes(input.value)) {
			return complete(input.value as AvailabilityId);
		}
		// AI decided it's a genuine free-form availability → store as custom.
		return complete('custom', input.raw);
	}

	return { messages: [], deferToAi: {} };
}

function onConfirmRestart(ctx: FlowContext, input: FlowInput): FlowResult {
	let yes: boolean | null = null;
	if (input.kind === 'button') yes = input.id === 'yes' ? true : input.id === 'no' ? false : null;
	else if (input.kind === 'text') {
		const n = normalizeText(input.text);
		if (/\bsi\b|\bsisi\b|\bvale\b|\bval\b|\bok\b|dacord|clar|esclar|canviar/.test(n)) yes = true;
		else if (/\bno\b|\bnop\b|deixa|res/.test(n)) yes = false;
	}

	if (yes === true) {
		return {
			messages: [{ kind: 'text', body: RETURNING_RESTART_LEAD }, K3_ACTION],
			// Reuse the known name; jump straight to the action question, reset answers.
			patch: { status: 'active', step: STEP.ACTION, data: {} }
		};
	}
	if (yes === false) {
		return {
			messages: [{ kind: 'text', body: RETURNING_KEEP }],
			patch: { status: 'completed', step: null }
		};
	}
	return { messages: [], deferToAi: {} };
}
