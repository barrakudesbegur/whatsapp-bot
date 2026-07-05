/**
 * Production Decider: one Workers AI call per turn, hardened so correctness never
 * depends on the model obeying the schema.
 *
 * Degradation ladder (a degraded turn NEVER mutates state — fallbackDecision
 * carries no actions):
 *   1. env.AI.run with `response_format` json_schema → parse → validate.
 *   2. If the binding rejects response_format, retry once without it (extractJson
 *      still recovers JSON from prose/fences) — so a picky model can't silently
 *      disable the AI.
 *   3. Unusable/garbage output or a thrown error → fallbackDecision(state).
 *
 * Model is CONFIG: `AI_MODEL` overrides PRIMARY_MODEL (currently Llama 3.3 70B
 * fp8-fast — fast + strong Catalan + reliable JSON).
 */

import type { Env } from '../types.ts';
import {
	DECISION_JSON_SCHEMA,
	fallbackDecision,
	parseDecision,
	type AiMeta,
	type Decider,
	type DecideOutput,
	type DecisionState
} from './decide.ts';
import { buildDecideMessages } from './decide-prompt.ts';

/** Default model, overridable per-environment via the `AI_MODEL` var (config, no code change). */
export const PRIMARY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Generation is deliberately constrained: Kudi's bubbles must be SHORT (owner
// requirement), and fp8 long generations degenerate into repeating the same
// questions until the token budget runs out (observed live). The repetition/
// frequency penalties break that loop, low temperature keeps decisions precise,
// and max_tokens bounds the damage while leaving room for multi-bubble replies.
const MAX_TOKENS = 512;
const TEMPERATURE = 0.3;
const REPETITION_PENALTY = 1.2;
const FREQUENCY_PENALTY = 0.4;

interface ChatResult {
	response?: unknown;
	usage?: { total_tokens?: number };
}
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type RunInput = {
	messages: ChatMessage[];
	max_tokens?: number;
	temperature?: number;
	repetition_penalty?: number;
	frequency_penalty?: number;
	response_format?: unknown;
};

export class WorkersAiDecider implements Decider {
	private readonly model: string;

	constructor(private readonly env: Env) {
		this.model = env.AI_MODEL?.trim() || PRIMARY_MODEL;
	}

	async decide(state: DecisionState): Promise<DecideOutput> {
		const t0 = Date.now();
		const messages = buildDecideMessages(state);
		try {
			const res = await this.run(messages);
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

	private async run(messages: ChatMessage[]): Promise<unknown> {
		// Call through env.AI (a detached `run` loses its `this` and throws).
		const ai = this.env.AI as unknown as {
			run(model: string, input: RunInput): Promise<unknown>;
		};
		const params = {
			max_tokens: MAX_TOKENS,
			temperature: TEMPERATURE,
			repetition_penalty: REPETITION_PENALTY,
			frequency_penalty: FREQUENCY_PENALTY
		};
		try {
			return await ai.run(this.model, {
				messages,
				...params,
				response_format: { type: 'json_schema', json_schema: DECISION_JSON_SCHEMA }
			});
		} catch (err) {
			// A model/binding that rejects response_format must not disable the AI —
			// retry once relying on the prompt + extractJson to recover the JSON.
			console.error('decide(): response_format rejected → retrying without it', err);
			return await ai.run(this.model, { messages, ...params });
		}
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
	// Some JSON-mode responses arrive already parsed — re-stringify for extractJson.
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
