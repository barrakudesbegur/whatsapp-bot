/**
 * FakeDecider (DEV_FAKE_AI / e2e): the deterministic rule-based survey flow
 * must complete a whole survey through the REAL router path — this is what the
 * Playwright e2e drives, with zero Workers AI neurons spent.
 */

import { describe, it, expect } from 'vitest';
import { FakeDecider } from '../src/lib/server/ai/fake-decider.ts';
import { makeDeps } from '../src/lib/server/router.ts';
import { MemoryStore } from '../src/lib/server/db/memory.ts';
import { testEnv, simulate, texts, type Harness } from './util.ts';

function fakeHarness(): Harness {
	const store = new MemoryStore();
	const decider = new FakeDecider();
	return { deps: makeDeps(testEnv(), store, decider), store, decider } as unknown as Harness;
}

const WA = '34600999888';

describe('FakeDecider drives a full survey deterministically', () => {
	it('trigger → name → signup button → availability row → completed', async () => {
		const h = fakeHarness();

		const s1 = await simulate(h, { wa_id: WA, name: 'Prova', text: "explica'm el curs" });
		expect(texts(s1).join(' ')).toContain('com vols que et digui?');

		const s2 = await simulate(h, { wa_id: WA, text: 'Berta' });
		expect(texts(s2).join(' ')).toContain('Genial, Berta!');
		const buttons = s2.find((m) => m.message.kind === 'buttons');
		expect(buttons).toBeDefined();

		const s3 = await simulate(h, {
			wa_id: WA,
			button_reply: {
				id: 'opt_0',
				title: 'Afegeix-me al grup',
				context_wa_message_id: buttons!.waMessageId
			}
		});
		const list = s3.find((m) => m.message.kind === 'list');
		expect(list).toBeDefined();
		expect((list!.message as { body: string }).body).toContain('Última pregunteta');

		const s4 = await simulate(h, {
			wa_id: WA,
			list_reply: { id: 'opt_0', title: 'Dissabtes', context_wa_message_id: list!.waMessageId }
		});
		expect(texts(s4).join(' ')).toContain('Doncs ja està, Berta!');

		const person = await h.store.getPersonByWaId(WA);
		expect(person?.display_name).toBe('Berta');
		const inst = await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes');
		expect(inst?.status).toBe('completed');
		expect(JSON.parse(inst!.data_json)).toEqual({ action: 'grup', availability: 'dissabtes' });
	});
});
