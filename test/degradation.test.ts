/**
 * WorkersAiDecider's degradation ladder, with a mocked env.AI.run:
 *   rung 1: one PLAIN chat call (no response_format — JSON mode was removed
 *           after live 5024 failures); prose-wrapped JSON is still recovered
 *           by extractJson;
 *   rung 2: garbage / thrown error / timeout → fallbackDecision with
 *           actions: [] — a degraded turn can never mutate state.
 */

import { describe, it, expect } from 'vitest';
import { WorkersAiDecider, PRIMARY_MODEL } from '../src/lib/server/ai/workers-ai-decider.ts';
import type { Env } from '../src/lib/server/types.ts';
import { makeState } from './util.ts';

function fakeEnv(run: (model: unknown, input: unknown) => Promise<unknown>): Env {
	return { AI: { run } } as unknown as Env;
}

const VALID = JSON.stringify({
	replies: [{ text: 'Ei! Som-hi 🧡' }],
	actions: [{ type: 'record_signup', choice: 'grup' }]
});

describe('WorkersAiDecider', () => {
	it('rung 1: ONE plain call — no response_format — and parses a valid decision', async () => {
		let calls = 0;
		let seen: Record<string, unknown> | undefined;
		const env = fakeEnv(async (_m, input) => {
			calls++;
			seen = input as Record<string, unknown>;
			return { response: VALID, usage: { total_tokens: 99 } };
		});
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(calls).toBe(1);
		expect(out.decision.actions).toEqual([{ type: 'record_signup', choice: 'grup' }]);
		expect(out.meta.model).toBe(PRIMARY_MODEL);
		expect(out.meta.tokens).toBe(99);
		expect(seen?.response_format).toBeUndefined();
		expect(seen?.messages).toBeInstanceOf(Array);
	});

	it('honors the AI_MODEL override', async () => {
		const env = fakeEnv(async () => ({ response: VALID }));
		(env as { AI_MODEL?: string }).AI_MODEL = '@cf/other/model';
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.meta.model).toBe('@cf/other/model');
	});

	it('rung 1b: an already-parsed response object is accepted', async () => {
		const env = fakeEnv(async () => ({ response: JSON.parse(VALID) }));
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.decision.replies[0]!.text).toContain('Som-hi');
	});

	it('rung 1c: JSON wrapped in prose/fences is recovered by extractJson', async () => {
		const env = fakeEnv(async () => ({ response: 'És clar!\n```json\n' + VALID + '\n```' }));
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.decision.actions).toHaveLength(1);
	});

	it('rung 2: garbage output → fallback with NO actions', async () => {
		const env = fakeEnv(async () => ({ response: 'sóc un model que no sap fer JSON' }));
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.decision.actions).toEqual([]);
		expect(out.decision.replies[0]!.text.length).toBeGreaterThan(0);
	});

	it('rung 2: thrown error → fallback with NO actions and #error meta', async () => {
		const env = fakeEnv(async () => {
			throw new Error('boom');
		});
		const out = await new WorkersAiDecider(env).decide(makeState());
		expect(out.decision.actions).toEqual([]);
		expect(out.meta.model).toContain('#error');
	});

	it('rung 2: a hung model call times out → fallback with #error meta', async () => {
		const env = fakeEnv(() => new Promise(() => {})); // never settles
		const out = await new WorkersAiDecider(env, 25).decide(makeState());
		expect(out.decision.actions).toEqual([]);
		expect(out.meta.model).toContain('#error');
	});
});
