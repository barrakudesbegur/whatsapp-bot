/**
 * Router dispatch + edge cases (PLAN 4.3 / 4.5 / 4.8), driven through the SAME
 * handleWebhook path the real webhook uses, over the in-memory Store fake.
 * Fixtures cover text, button reply, list reply, status update and media.
 */

import { describe, it, expect } from 'vitest';
import {
	newHarness,
	text,
	button,
	list,
	pickKind,
	texts,
	runWebhook,
	type Harness
} from './util.ts';
import { validateOutMessage } from '../src/lib/server/messages.ts';
import type { SentMessage } from '../src/lib/server/wa/sender.ts';
import type { WebhookEnvelope } from '../src/lib/server/wa/wire.ts';

const TRIGGER = "Explica'm això del curs de sardanes 💃";
const WA = '34600111222';

function assertWithinLimits(sent: SentMessage[]) {
	for (const s of sent) expect(validateOutMessage(s.message)).toEqual([]);
}

// Raw fixtures (not via the simulator) ------------------------------------
function rawText(waId: string, id: string, body: string): WebhookEnvelope {
	return {
		object: 'whatsapp_business_account',
		entry: [
			{
				id: 'e',
				changes: [
					{
						field: 'messages',
						value: {
							messaging_product: 'whatsapp',
							metadata: { phone_number_id: 'PN' },
							contacts: [{ profile: { name: 'Tester' }, wa_id: waId }],
							messages: [
								{
									from: waId,
									id,
									timestamp: '1',
									type: 'text',
									text: { body }
								}
							]
						}
					}
				]
			}
		]
	};
}

function rawImage(waId: string, id: string): WebhookEnvelope {
	return {
		object: 'whatsapp_business_account',
		entry: [
			{
				id: 'e',
				changes: [
					{
						field: 'messages',
						value: {
							messaging_product: 'whatsapp',
							metadata: { phone_number_id: 'PN' },
							messages: [
								{
									from: waId,
									id,
									timestamp: '1',
									type: 'image',
									image: { id: 'media-1' }
								}
							]
						}
					}
				]
			}
		]
	};
}

function rawStatus(msgId: string, status: string, errors?: unknown[]): WebhookEnvelope {
	return {
		object: 'whatsapp_business_account',
		entry: [
			{
				id: 'e',
				changes: [
					{
						field: 'messages',
						value: {
							messaging_product: 'whatsapp',
							metadata: { phone_number_id: 'PN' },
							statuses: [
								{
									id: msgId,
									status,
									timestamp: '1',
									recipient_id: WA,
									...(errors ? { errors } : {})
								} as never
							]
						}
					}
				]
			}
		]
	};
}

// -------------------------------------------------------------------------

describe('full survey via the simulator path', () => {
	it('trigger → name → grup → availability → close, with correct D1 state', async () => {
		const h = newHarness();

		const k1 = await text(h, WA, TRIGGER);
		assertWithinLimits(k1);
		expect(texts(k1)[0]).toContain('com vols que et digui');

		const k2 = await text(h, WA, 'Pol');
		assertWithinLimits(k2);
		expect(texts(k2)[0]).toContain('Genial, Pol!');
		const k3buttons = pickKind(k2, 'buttons');
		expect(k3buttons).toBeDefined();

		const k4 = await button(h, WA, 'grup', k3buttons!.waMessageId);
		assertWithinLimits(k4);
		const k4list = pickKind(k4, 'list');
		expect(k4list).toBeDefined();

		const k5 = await list(h, WA, 'dissabtes', k4list!.waMessageId);
		assertWithinLimits(k5);
		expect(texts(k5)[0]).toContain('ja està');
		expect(texts(k5)[0]).toContain('invitació al grup');

		// D1 state
		const person = await h.store.getPersonByWaId(WA);
		expect(person?.display_name).toBe('Pol');
		const inst = await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes');
		expect(inst?.status).toBe('completed');
		expect(inst?.completed_at).not.toBeNull();
		expect(JSON.parse(inst!.data_json)).toEqual({
			action: 'grup',
			availability: 'dissabtes'
		});
	});

	it('avisam path also completes', async () => {
		const h = newHarness();
		await text(h, WA, TRIGGER);
		const k2 = await text(h, WA, 'Marina');
		const k4 = await button(h, WA, 'avisam', pickKind(k2, 'buttons')!.waMessageId);
		const k5 = await list(h, WA, 'diumenges', pickKind(k4, 'list')!.waMessageId);
		expect(texts(k5)[0]).toContain("t'escric per aquí");
		const person = await h.store.getPersonByWaId(WA);
		const inst = await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes');
		expect(JSON.parse(inst!.data_json)).toEqual({
			action: 'avisam',
			availability: 'diumenges'
		});
	});

	it('declined path ends the flow', async () => {
		const h = newHarness();
		await text(h, WA, TRIGGER);
		const k2 = await text(h, WA, 'Jan');
		const res = await button(h, WA, 'res', pickKind(k2, 'buttons')!.waMessageId);
		expect(texts(res)[0]).toContain('Cap problema!');
		const person = await h.store.getPersonByWaId(WA);
		const inst = await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes');
		expect(inst?.status).toBe('declined');
		expect(JSON.parse(inst!.data_json)).toMatchObject({ action: 'res' });
	});
});

describe('duplicate / out-of-order webhooks', () => {
	it('replaying the same message id produces no second send', async () => {
		const h = newHarness();
		const first = await runWebhook(h, rawText(WA, 'wamid.DUP', TRIGGER));
		expect(first.length).toBeGreaterThan(0);
		const replay = await runWebhook(h, rawText(WA, 'wamid.DUP', TRIGGER));
		expect(replay).toEqual([]);
	});
});

describe('status webhooks', () => {
	it('updates the matching outbound message row (and logs failures)', async () => {
		const h = newHarness();
		const sent = await text(h, WA, TRIGGER);
		const outId = sent[0]!.waMessageId;

		await runWebhook(h, rawStatus(outId, 'delivered'));
		expect((await h.store.getMessageByWaId(outId))?.status).toBe('delivered');

		await runWebhook(h, rawStatus(outId, 'failed', [{ code: 131047, title: 'boom' }]));
		const row = await h.store.getMessageByWaId(outId);
		expect(row?.status).toBe('failed');
		expect(row?.error_json).toContain('131047');
	});

	it('ignores a status for an unknown message id', async () => {
		const h = newHarness();
		await expect(runWebhook(h, rawStatus('wamid.NOPE', 'read'))).resolves.toEqual([]);
	});
});

describe('media / audio / sticker', () => {
	it('apologizes and re-asks the pending question', async () => {
		const h = newHarness();
		await text(h, WA, TRIGGER); // now on step 'name'
		const out = await runWebhook(h, rawImage(WA, 'wamid.IMG'));
		const bodies = texts(out);
		expect(bodies[0]).toContain('només sé llegir text');
		// re-asks K1 (the pending question)
		expect(bodies.join('\n')).toContain('com vols que et digui');
	});
});

describe('unknown person out of nowhere', () => {
	it('falls back to the AI stub and offers the survey', async () => {
		const h = newHarness();
		const out = await text(h, '34699000000', 'hola qui ets?');
		expect(out).toHaveLength(1);
		expect(texts(out)[0]).toContain('curs de sardanes'); // stub nudges the survey
	});
});

describe('returning completed person', () => {
	async function complete(h: Harness) {
		await text(h, WA, TRIGGER);
		const k2 = await text(h, WA, 'Pol');
		const k4 = await button(h, WA, 'grup', pickKind(k2, 'buttons')!.waMessageId);
		await list(h, WA, 'dissabtes', pickKind(k4, 'list')!.waMessageId);
	}

	it('re-triggering offers to change answers', async () => {
		const h = newHarness();
		await complete(h);
		const again = await text(h, WA, TRIGGER);
		const prompt = pickKind(again, 'buttons');
		expect(prompt).toBeDefined();
		expect((prompt!.message as { body: string }).body).toContain('Ja et tenia apuntat');

		// "No" keeps it completed.
		const no = await button(h, WA, 'no', prompt!.waMessageId);
		expect(texts(no)[0]).toContain('tal com estava');
		const person = await h.store.getPersonByWaId(WA);
		const inst = await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes');
		expect(inst?.status).toBe('completed');
	});

	it("'Sí' restarts at the action question", async () => {
		const h = newHarness();
		await complete(h);
		const again = await text(h, WA, TRIGGER);
		const yes = await button(h, WA, 'yes', pickKind(again, 'buttons')!.waMessageId);
		expect(pickKind(yes, 'buttons')).toBeDefined(); // K3 action again
	});
});

describe('GDPR erase', () => {
	it('confirms then anonymizes the person and deletes messages', async () => {
		const h = newHarness();
		await text(h, WA, TRIGGER);
		await text(h, WA, 'Pol');

		const confirm = await text(h, WA, 'esborra les meves dades si us plau');
		const prompt = pickKind(confirm, 'buttons');
		expect(prompt).toBeDefined();
		expect((prompt!.message as { body: string }).body).toContain('esborri totes les teves dades');

		const personBefore = await h.store.getPersonByWaId(WA);
		const done = await button(h, WA, 'gdpr_yes', prompt!.waMessageId);
		expect(texts(done)[0]).toContain('He esborrat les teves dades');

		// person row scrubbed; original wa_id no longer resolves.
		expect(await h.store.getPersonByWaId(WA)).toBeNull();
		const msgs = await h.store.listMessagesForPerson(personBefore!.id);
		expect(msgs).toEqual([]);
	});

	it('declining keeps the data', async () => {
		const h = newHarness();
		await text(h, WA, TRIGGER);
		const confirm = await text(h, WA, 'vull esborrar les meves dades');
		const no = await button(h, WA, 'gdpr_no', pickKind(confirm, 'buttons')!.waMessageId);
		expect(texts(no)[0]).toContain('no esborro res');
		expect(await h.store.getPersonByWaId(WA)).not.toBeNull();
	});
});

describe('optimistic concurrency (step CAS)', () => {
	it('a second update against a stale step is rejected', async () => {
		const h = newHarness();
		const created = await h.store.createFlowInstance({
			personId: 1,
			flowType: 'curs-sardanes',
			status: 'active',
			step: 'action',
			dataJson: '{}',
			createdAt: 't0'
		});
		const ok1 = await h.store.updateFlowStep(created.id, 'action', {
			status: 'active',
			step: 'availability',
			dataJson: '{}',
			updatedAt: 't1'
		});
		const ok2 = await h.store.updateFlowStep(created.id, 'action', {
			status: 'active',
			step: 'availability',
			dataJson: '{}',
			updatedAt: 't2'
		});
		expect(ok1).toBe(true);
		expect(ok2).toBe(false); // another invocation already advanced past 'action'
	});
});

describe('off-script step answer with the AI stub', () => {
	it('answers from the KB stub and re-asks the pending question', async () => {
		const h = newHarness();
		await text(h, WA, TRIGGER);
		await text(h, WA, 'Pol'); // on 'action'
		// gibberish on the action step → stub answers + re-asks the buttons
		const out = await text(h, WA, 'escolta i què passa si plou?');
		expect(out.length).toBeGreaterThanOrEqual(2);
		expect(pickKind(out, 'buttons')).toBeDefined(); // re-asked K3
	});
});
