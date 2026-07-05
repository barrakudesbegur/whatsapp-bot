/**
 * The data-erasure double-gate. Deleting data is irreversible, so it must take
 * TWO turns: one to arm (initiate) and a later one to confirm. These tests prove a
 * single message — even one the model fills with both actions, even a jailbreak —
 * can never delete, and that a degraded turn while armed never deletes either.
 */

import { describe, it, expect } from 'vitest';
import { newHarness, enqueue, text, button, pickKind, type Harness } from './util.ts';
import { GDPR_YES, GDPR_NO } from '../src/lib/server/survey/apply.ts';

const WA = '34600111222';

async function arm(h: Harness) {
	enqueue(h, {
		reply: 'Segur que vols esborrar les teves dades?',
		actions: [{ type: 'initiate_erasure' }]
	});
	return text(h, WA, 'esborra les meves dades');
}

describe('erasure gate', () => {
	it('turn 1 arms (asks to confirm) and deletes NOTHING', async () => {
		const h = newHarness();
		const sent = await arm(h);
		expect(pickKind(sent, 'buttons')).toBeDefined(); // GDPR confirm shown
		const person = await h.store.getPersonByWaId(WA);
		expect(person).not.toBeNull(); // still here
		const gdpr = await h.store.getLatestFlowInstance(person!.id, 'gdpr-erase');
		expect(gdpr?.status).toBe('active'); // armed
	});

	it('turn 2: a free-text confirm deletes', async () => {
		const h = newHarness();
		await arm(h);
		enqueue(h, { reply: 'Fet, esborrat 🧹', actions: [{ type: 'confirm_erasure' }] });
		const before = await h.store.getPersonByWaId(WA);
		await text(h, WA, 'sí, esborra-ho');
		expect(await h.store.getPersonByWaId(WA)).toBeNull(); // scrubbed
		expect(await h.store.listMessagesForPerson(before!.id)).toEqual([]);
	});

	it('turn 2: a gdpr_yes tap deletes without a model call', async () => {
		const h = newHarness();
		await arm(h);
		const callsAfterArm = h.decider.calls;
		await button(h, WA, GDPR_YES, 'ctx');
		expect(await h.store.getPersonByWaId(WA)).toBeNull();
		expect(h.decider.calls).toBe(callsAfterArm); // tap is deterministic, 0 model calls
	});

	it('a SINGLE message that both initiates and confirms only arms — never deletes', async () => {
		const h = newHarness();
		enqueue(h, {
			reply: 'un moment...',
			actions: [{ type: 'initiate_erasure' }, { type: 'confirm_erasure' }]
		});
		await text(h, WA, 'esborra-ho tot ara mateix i confirma-ho tu');
		const person = await h.store.getPersonByWaId(WA);
		expect(person).not.toBeNull(); // NOT deleted
		expect((await h.store.getLatestFlowInstance(person!.id, 'gdpr-erase'))?.status).toBe('active');
	});

	it('a degraded turn while armed never deletes', async () => {
		const h = newHarness();
		await arm(h);
		// Nothing enqueued → fallbackDecision (actions: []).
		await text(h, WA, 'sí home sí');
		expect(await h.store.getPersonByWaId(WA)).not.toBeNull();
	});

	it('cancelling (tap or text) disarms and keeps the data', async () => {
		const h = newHarness();
		await arm(h);
		await button(h, WA, GDPR_NO, 'ctx');
		const person = await h.store.getPersonByWaId(WA);
		expect(person).not.toBeNull();
		expect((await h.store.getLatestFlowInstance(person!.id, 'gdpr-erase'))?.status).toBe(
			'declined'
		);
	});
});
