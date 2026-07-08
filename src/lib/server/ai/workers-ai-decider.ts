/**
 * Production Decider: one Workers AI call per turn, hardened so correctness never
 * depends on the model obeying the prompt.
 *
 * The call is a PLAIN chat completion — no `response_format`. Workers AI JSON
 * mode (json_schema) failed live with "AiError 5024: JSON Mode couldn't be met"
 * after 30–90 s of constrained decoding on EVERY turn, while the unconstrained
 * retry answered in ~3 s; the prompt's output contract + `extractJson` +
 * `parseDecision` (valibot whitelist) recover and validate the JSON instead,
 * tolerating prose and fences.
 *
 * Degradation ladder (a degraded turn NEVER mutates state — fallbackDecision
 * carries no actions):
 *   1. env.AI.run, bounded by a hard timeout → extractJson/parseDecision.
 *   2. Unusable/garbage output, a thrown error, or a timeout → fallbackDecision.
 *
 * Model is CONFIG: `AI_MODEL` overrides PRIMARY_MODEL (currently Llama 3.3 70B
 * fp8-fast — fast + strong Catalan).
 */

import type { Env } from '../types.ts';
import {
	fallbackDecision,
	parseDecision,
	type AiMeta,
	type Decider,
	type DecideOutput,
	type DecisionState
} from './decide.ts';
import { buildDecideMessages, type DecideMessage } from './decide-prompt.ts';

/** Default model, overridable per-environment via the `AI_MODEL` var (config, no code change). */
export const PRIMARY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Generation bounds. Kudi's bubbles must be SHORT (owner requirement), so
// max_tokens caps the damage of a rambling turn while leaving room for
// multi-bubble JSON. 768 is comfortable headroom for a normal Decision (1–3
// short bubbles + a control + actions is ~350 output tokens) while bounding a
// runaway generation — output tokens bill ~7.7x input, so an uncapped ramble is
// both the slowest AND the most expensive failure. The penalties are MILD on
// purpose: the aggressive values tried before (repetition 1.2 + frequency 0.4)
// corrupted Catalan morphology ("t'explichi") by pre-penalizing correct tokens
// already present in the large prompt — and cross-turn re-asking is prevented by
// real transcript turns in the prompt, not by decoding penalties.
const MAX_TOKENS = 768;
const TEMPERATURE = 0.3;
const REPETITION_PENALTY = 1.05;
const FREQUENCY_PENALTY = 0.1;

// Hard cap on model think-time — production saw a 195 s hang (gemma-4); better
// to trip the deterministic fallback than keep the person waiting forever.
// Generous on purpose (owner's call): a slow real answer beats a fast apology,
// even though WhatsApp's typing indicator only lasts ~25 s.
const TIMEOUT_MS = 90_000;

interface ChatResult {
	response?: unknown;
	usage?: { total_tokens?: number };
}
type RunInput = {
	messages: DecideMessage[];
	max_tokens?: number;
	temperature?: number;
	repetition_penalty?: number;
	frequency_penalty?: number;
};

/** The subset of Workers AI `run` options we use — extra request headers, for
 * the `x-session-affinity` prefix-cache routing hint. */
type AiRunOptions = { extraHeaders?: Record<string, string> };

export class WorkersAiDecider implements Decider {
	private readonly model: string;

	constructor(
		private readonly env: Env,
		private readonly timeoutMs: number = TIMEOUT_MS
	) {
		this.model = env.AI_MODEL?.trim() || PRIMARY_MODEL;
	}

	async decide(state: DecisionState): Promise<DecideOutput> {
		const t0 = Date.now();
		const messages = buildDecideMessages(state);
		try {
			const res = await this.run(messages, state.sessionKey);
			const decision = parseDecision(textOf(res));
			if (decision) return { decision, meta: this.meta(t0, tokensOf(res)) };
			// Ran fine but produced unusable JSON → deterministic (non-mutating) fallback.
			console.error('decide(): model returned unusable output → fallback', {
				sample: textOf(res).slice(0, 200)
			});
			return { decision: fallbackDecision(state), meta: this.meta(t0, tokensOf(res)) };
		} catch (err) {
			console.error('decide(): model call failed → fallback', err);
			return { decision: fallbackDecision(state), meta: this.errorMeta(t0) };
		}
	}

	private run(messages: DecideMessage[], sessionKey?: string): Promise<unknown> {
		// Call through env.AI (a detached `run` loses its `this` and throws).
		const ai = this.env.AI as unknown as {
			run(model: string, input: RunInput, options?: AiRunOptions): Promise<unknown>;
		};
		const input: RunInput = {
			messages,
			max_tokens: MAX_TOKENS,
			temperature: TEMPERATURE,
			repetition_penalty: REPETITION_PENALTY,
			frequency_penalty: FREQUENCY_PENALTY
		};
		// Prefix caching: route this person's turns to the same warm instance so
		// the identical system prefix is served from cache (discounted tokens +
		// faster TTFT) instead of being re-prefilled. Omitted (no header) when we
		// have no stable key — the model still runs, just without the cache hint.
		const options: AiRunOptions | undefined = sessionKey
			? { extraHeaders: { 'x-session-affinity': sessionKey } }
			: undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`decide(): model call timed out after ${this.timeoutMs}ms`)),
				this.timeoutMs
			);
		});
		return Promise.race([ai.run(this.model, input, options), timedOut]).finally(() =>
			clearTimeout(timer)
		);
	}

	private meta(t0: number, tokens?: number): AiMeta {
		return { model: this.model, latencyMs: Date.now() - t0, tokens };
	}

	private errorMeta(t0: number): AiMeta {
		return { model: `${this.model}#error`, latencyMs: Date.now() - t0 };
	}
}

function textOf(res: unknown): string {
	if (typeof res === 'string') return res;
	const r = res as ChatResult | null;
	if (typeof r?.response === 'string') return r.response;
	// Some responses arrive already parsed — re-stringify for extractJson.
	if (r?.response && typeof r.response === 'object') {
		try {
			return JSON.stringify(r.response);
		} catch {
			return '';
		}
	}
	return '';
}

function tokensOf(res: unknown): number | undefined {
	const r = res as ChatResult | null;
	const t = r?.usage?.total_tokens;
	return typeof t === 'number' ? t : undefined;
}
