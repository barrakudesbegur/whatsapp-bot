/**
 * WorkersAiDecider's degradation ladder, with a mocked env.AI.run:
 *   rung 1: valid JSON via response_format → Decision (meta logged);
 *   rung 2: response_format rejected → retry without it; prose-wrapped JSON is
 *           still recovered by extractJson;
 *   rung 3: garbage / thrown error → fallbackDecision with actions: [] — a
 *           degraded turn can never mutate state.
 */

import { describe, it, expect } from 'vitest';
import { WorkersAiDecider, PRIMARY_MODEL } from '../src/lib/server/ai/workers-ai-decider.ts';
import type { Env } from '../src/lib/server/types.ts';
import { makeState } from './util.ts';

function fakeEnv(run: (model: unknown, input: unknown) => Promise<unknown>): Env {
	return { AI: { run } } as unknown as Env;
}

const VALID = JSON.stringify({
	reply: 'Ei! Som-hi 🧡',
	actions: [{ type: 'record_signup', choice: 'grup' }]
});

describe('WorkersAiDecider', () => {
	it('rung 1: sends response_format json_schema and parses a valid decision', async () => {
		let seen: Record<string, unknown> | undefined;
		const env = fakeEnv(async (_m, input) => {
			seen = input as Record<string, unknown>;
			return { response: VALID, usage: { total_tokens: 99 } };
		});
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.decision.actions).toEqual([{ type: 'record_signup', choice: 'grup' }]);
		expect(out.meta.model).toBe(PRIMARY_MODEL);
		expect(out.meta.tokens).toBe(99);
		expect(seen?.response_format).toMatchObject({ type: 'json_schema' });
	});

	it('honors the AI_MODEL override', async () => {
		const env = fakeEnv(async () => ({ response: VALID }));
		(env as { AI_MODEL?: string }).AI_MODEL = '@cf/other/model';
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.meta.model).toBe('@cf/other/model');
	});

	it('rung 1b: an already-parsed JSON-mode response object is accepted', async () => {
		const env = fakeEnv(async () => ({ response: JSON.parse(VALID) }));
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.decision.reply).toContain('Som-hi');
	});

	it('rung 2: retries without response_format when the binding rejects it', async () => {
		let calls = 0;
		const env = fakeEnv(async (_m, input) => {
			calls++;
			if ((input as Record<string, unknown>).response_format) {
				throw new Error('response_format not supported');
			}
			return { response: 'És clar!\n```json\n' + VALID + '\n```' };
		});
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(calls).toBe(2);
		expect(out.decision.actions).toHaveLength(1); // recovered from fenced prose
	});

	it('rung 3: garbage output → fallback with NO actions', async () => {
		const env = fakeEnv(async () => ({ response: 'sóc un model que no sap fer JSON' }));
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.decision.actions).toEqual([]);
		expect(out.decision.reply.length).toBeGreaterThan(0);
	});

	it('rung 3: thrown error → fallback with NO actions and #error meta', async () => {
		const env = fakeEnv(async () => {
			throw new Error('boom');
		});
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.decision.actions).toEqual([]);
		expect(out.meta.model).toContain('#error');
	});
});
