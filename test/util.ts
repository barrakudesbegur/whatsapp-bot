/**
 * Test helpers: build router deps over the in-memory Store fake and drive the
 * SAME router code path the real webhook uses, via the simulator envelope
 * builder. Outbound sends are log-only (WA_ENABLED unset), recorded in the fake.
 */

import { MemoryStore } from '../src/lib/server/db/memory.ts';
import { StubAiProvider } from '../src/lib/server/ai/provider.ts';
import { makeDeps, handleWebhook, type RouterDeps } from '../src/lib/server/router.ts';
import { buildSimulatedWebhook, type SimulateInput } from '../src/lib/server/wa/simulate.ts';
import type { Env } from '../src/lib/server/types.ts';
import type { OutMessage } from '../src/lib/server/messages.ts';
import type { SentMessage } from '../src/lib/server/wa/sender.ts';
import type { WebhookEnvelope } from '../src/lib/server/wa/wire.ts';

export function testEnv(overrides: Partial<Env> = {}): Env {
	return { WA_ENABLED: 'false', ...overrides } as Env;
}

export interface Harness {
	deps: RouterDeps;
	store: MemoryStore;
	ai: StubAiProvider;
}

export function newHarness(env: Env = testEnv()): Harness {
	const store = new MemoryStore();
	const ai = new StubAiProvider();
	return { deps: makeDeps(env, store, ai), store, ai };
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

export const button = (h: Harness, wa_id: string, id: string, context_wa_message_id: string) =>
	simulate(h, { wa_id, button_reply: { id, context_wa_message_id } });

export const list = (h: Harness, wa_id: string, id: string, context_wa_message_id: string) =>
	simulate(h, { wa_id, list_reply: { id, context_wa_message_id } });

// Selectors ----------------------------------------------------------------
export function pickKind(sent: SentMessage[], kind: OutMessage['kind']): SentMessage | undefined {
	return sent.find((s) => s.message.kind === kind);
}

export function texts(sent: SentMessage[]): string[] {
	return sent
		.filter((s) => s.message.kind === 'text')
		.map((s) => (s.message as { body: string }).body);
}

export function allText(sent: SentMessage[]): string {
	return sent.map((s) => (s.message.kind === 'text' ? s.message.body : s.message.body)).join('\n');
}
