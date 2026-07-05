/**
 * Test helpers. Drives the SAME handleWebhook path the real webhook uses, over
 * the in-memory Store fake and a ScriptedDecider (queue the decisions a test
 * expects). Outbound sends are log-only (WA_ENABLED unset), recorded in the fake.
 */

import { MemoryStore } from '../src/lib/server/db/memory.ts';
import { ScriptedDecider } from '../src/lib/server/ai/scripted-decider.ts';
import { makeDeps, handleWebhook, type RouterDeps } from '../src/lib/server/router.ts';
import { buildSimulatedWebhook, type SimulateInput } from '../src/lib/server/wa/simulate.ts';
import type { Env } from '../src/lib/server/types.ts';
import type { OutMessage } from '../src/lib/server/messages.ts';
import type { SentMessage } from '../src/lib/server/wa/sender.ts';
import type { WebhookEnvelope } from '../src/lib/server/wa/wire.ts';
import type { Decision, DecisionState } from '../src/lib/server/ai/decide.ts';

export function testEnv(overrides: Partial<Env> = {}): Env {
	return { WA_ENABLED: 'false', ...overrides } as Env;
}

export interface Harness {
	deps: RouterDeps;
	store: MemoryStore;
	decider: ScriptedDecider;
}

export function newHarness(env: Env = testEnv(), decider = new ScriptedDecider()): Harness {
	const store = new MemoryStore();
	return { deps: makeDeps(env, store, decider), store, decider };
}

type Scripted = Decision | ((state: DecisionState) => Decision);

/** Queue the decision(s) the model should "return" for the next inbound(s). */
export function enqueue(h: Harness, ...decisions: Scripted[]): void {
	h.decider.enqueue(...decisions);
}

export async function simulate(h: Harness, input: SimulateInput): Promise<SentMessage[]> {
	return handleWebhook(buildSimulatedWebhook(input), h.deps);
}

export async function runWebhook(h: Harness, envelope: WebhookEnvelope): Promise<SentMessage[]> {
	return handleWebhook(envelope, h.deps);
}

// Convenience drivers ------------------------------------------------------
export const text = (h: Harness, wa_id: string, body: string, name?: string) =>
	simulate(h, { wa_id, text: body, ...(name ? { name } : {}) });

export const button = (
	h: Harness,
	wa_id: string,
	id: string,
	context_wa_message_id: string,
	title?: string
) =>
	simulate(h, { wa_id, button_reply: { id, context_wa_message_id, ...(title ? { title } : {}) } });

export const list = (
	h: Harness,
	wa_id: string,
	id: string,
	context_wa_message_id: string,
	title?: string
) => simulate(h, { wa_id, list_reply: { id, context_wa_message_id, ...(title ? { title } : {}) } });

// Selectors ----------------------------------------------------------------
export function pickKind(sent: SentMessage[], kind: OutMessage['kind']): SentMessage | undefined {
	return sent.find((s) => s.message.kind === kind);
}

export function texts(sent: SentMessage[]): string[] {
	return sent
		.filter((s) => s.message.kind === 'text')
		.map((s) => (s.message as { body: string }).body);
}

export function bodies(sent: SentMessage[]): string {
	return sent.map((s) => (s.message as { body: string }).body).join('\n');
}

// A DecisionState with sane defaults for unit-testing applyDecision directly.
export function makeState(over: Partial<DecisionState> = {}): DecisionState {
	return {
		now: '2026-07-06T00:00:00.000Z',
		person: { displayName: null, profileName: null, isAnonymous: false },
		survey: {
			status: 'none',
			collected: { signup: null, availability: null, availabilityRaw: null },
			instanceId: null
		},
		missing: ['name', 'signup', 'availability'],
		course: { status: 'exploring', note: '' },
		kb: 'KB',
		transcript: [],
		userMessage: 'hola',
		tapped: false,
		...over
	};
}
