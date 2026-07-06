/**
 * Deterministic Decider for local dev / e2e: a tiny rule-based survey flow with
 * NO model call, so Playwright runs never spend Workers AI neurons (the free
 * tier is ~50 real messages/day) and never flake on model output.
 *
 * Selected by `makeDecider` (bindings.ts) when DEV_FAKE_AI=true — and only
 * while WA_ENABLED !== 'true', so it can never take over production.
 */

import { SIGNUP_LABELS, AVAILABILITY_LABELS } from '../survey/spec.ts';
import type {
	Decider,
	DecideOutput,
	Decision,
	DecisionState,
	SignupChoice,
	AvailabilityBucket
} from './decide.ts';

const SIGNUP_BUTTONS = {
	kind: 'buttons' as const,
	options: Object.values(SIGNUP_LABELS).map((title) => ({ title }))
};

const AVAILABILITY_LIST = {
	kind: 'list' as const,
	label: 'Quan em va bé',
	options: Object.values(AVAILABILITY_LABELS).map((title) => ({ title }))
};

function matchLabel<K extends string>(labels: Record<K, string>, msg: string): K | undefined {
	const m = msg.trim().toLowerCase();
	return (Object.keys(labels) as K[]).find((k) => labels[k].toLowerCase() === m);
}

export class FakeDecider implements Decider {
	async decide(state: DecisionState): Promise<DecideOutput> {
		const t0 = Date.now();
		return { decision: this.next(state), meta: { model: 'fake', latencyMs: Date.now() - t0 } };
	}

	private next(state: DecisionState): Decision {
		const msg = state.userMessage.trim();
		const name = state.person.displayName;

		if (state.survey.status === 'none' || state.survey.status === 'declined') {
			return {
				replies: [
					{
						text:
							"T'ho explico! Estem explorant un curs de sardanes a Begur, en cap de setmana. " +
							'Abans de res, com vols que et digui?'
					}
				],
				actions: [{ type: 'start_survey' }]
			};
		}

		const availability = matchLabel(AVAILABILITY_LABELS, msg) as AvailabilityBucket | undefined;
		if (availability) {
			return {
				replies: [{ text: `Doncs ja està, ${name ?? 'crack'}! Gràcies 🧡` }],
				actions: [{ type: 'record_availability', bucket: availability }]
			};
		}

		const signup = matchLabel(SIGNUP_LABELS, msg) as SignupChoice | undefined;
		if (signup) {
			return {
				replies: [{ text: 'Última pregunteta: quan et sol anar bé?', control: AVAILABILITY_LIST }],
				actions: [{ type: 'record_signup', choice: signup }]
			};
		}

		if (state.missing[0] === 'name') {
			return {
				replies: [
					{ text: `Genial, ${msg}!` },
					{ text: 'Què vols que faci quan sapiguem si es fa el curs?', control: SIGNUP_BUTTONS }
				],
				actions: [{ type: 'set_display_name', name: msg.slice(0, 40) }]
			};
		}

		return { replies: [{ text: "D'acord! 👍" }], actions: [] };
	}
}
