/**
 * Router dispatch (AI-first), driven through the SAME handleWebhook path the real
 * webhook uses, over the in-memory store + a ScriptedDecider. Assertions are on
 * routing + applied state — never on model-authored copy.
 */

import { describe, it, expect } from 'vitest';
import { newHarness, enqueue, text, button, pickKind, texts, bodies, runWebhook } from './util.ts';
import { validateOutMessage } from '../src/lib/server/messages.ts';
import type { SentMessage } from '../src/lib/server/wa/sender.ts';
import type { WebhookEnvelope } from '../src/lib/server/wa/wire.ts';

const WA = '34600111222';

function assertWithinLimits(sent: SentMessage[]) {
	for (const s of sent) expect(validateOutMessage(s.message)).toEqual([]);
}

// Raw fixtures (bypass the simulator) -------------------------------------
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
							messages: [{ from: waId, id, timestamp: '1', type: 'text', text: { body } }]
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
							messages: [{ from: waId, id, timestamp: '1', type: 'image', image: { id: 'm1' } }]
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

describe('AI-first survey via decisions', () => {
	it('start → name → signup → availability completes, with correct D1 state', async () => {
		const h = newHarness();
		enqueue(h, {
			reply: "T'ho explico! Com vols que et digui?",
			actions: [{ type: 'start_survey' }]
		});
		await text(h, WA, "explica'm el curs de sardanes");

		enqueue(h, { reply: 'Genial, Pol!', actions: [{ type: 'set_display_name', name: 'Pol' }] });
		await text(h, WA, 'em dic Pol');

		enqueue(h, {
			reply: 'Fet! Quan et va bé?',
			actions: [{ type: 'record_signup', choice: 'grup' }]
		});
		await text(h, WA, "apunta'm al grup");

		enqueue(h, {
			reply: 'Ja està! 🎉',
			actions: [{ type: 'record_availability', bucket: 'dissabtes' }]
		});
		const last = await text(h, WA, 'els dissabtes');

		expect(texts(last)[0]).toContain('Ja està');
		const person = await h.store.getPersonByWaId(WA);
		expect(person?.display_name).toBe('Pol');
		const inst = await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes');
		expect(inst?.status).toBe('completed');
		expect(JSON.parse(inst!.data_json)).toEqual({ action: 'grup', availability: 'dissabtes' });
	});

	it('a single free-text message costs exactly one model call', async () => {
		const h = newHarness();
		enqueue(h, { reply: 'ei!', actions: [] });
		await text(h, WA, 'hola qui ets?');
		expect(h.decider.calls).toBe(1);
	});

	it('mixed intent: answers a question AND records an answer in one turn', async () => {
		const h = newHarness();
		enqueue(h, {
			reply: 'És gratis de moment! I t’apunto al grup 🧡',
			actions: [{ type: 'record_signup', choice: 'grup' }]
		});
		await text(h, WA, 'és gratis? apunta’m al grup');
		const person = await h.store.getPersonByWaId(WA);
		const inst = await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes');
		expect(JSON.parse(inst!.data_json)).toMatchObject({ action: 'grup' });
	});

	it('handles a refused name gracefully (Anònim) and keeps going', async () => {
		const h = newHarness();
		enqueue(h, { reply: 'Som-hi!', actions: [{ type: 'start_survey' }] });
		await text(h, WA, 'vull saber del curs');
		enqueue(h, {
			reply: 'Cap problema, de moment et dic Anònim 😊 Quan sapiguem si es fa, què vols que faci?',
			actions: [{ type: 'set_display_name', name: 'Anònim' }]
		});
		await text(h, WA, "no te'l vull donar");
		const person = await h.store.getPersonByWaId(WA);
		expect(person?.display_name).toBe('Anònim');
		const inst = await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes');
		expect(inst?.status).toBe('active'); // conversation continues
	});

	it('renders model-generated options as a valid interactive', async () => {
		const h = newHarness();
		enqueue(h, {
			reply: 'Què vols que faci?',
			actions: [{ type: 'start_survey' }],
			control: {
				kind: 'buttons',
				options: [{ title: 'Al grup' }, { title: "Avisa'm" }, { title: 'Res' }]
			}
		});
		const sent = await text(h, WA, 'què passa quan se sàpiga?');
		assertWithinLimits(sent);
		expect(pickKind(sent, 'buttons')).toBeDefined();
	});
});

describe('interactive taps flow back through the model', () => {
	it('a tapped option is understood as free text (tapped=true, title as message)', async () => {
		const h = newHarness();
		// Kudi previously offered a list; the user taps "Dissabtes".
		enqueue(h, {
			reply: 'Apuntat!',
			actions: [{ type: 'record_availability', bucket: 'dissabtes' }]
		});
		await button(h, WA, 'opt_0', 'ctx-msg-id', 'Dissabtes');
		const state = h.decider.seen.at(-1);
		expect(state?.tapped).toBe(true);
		expect(state?.userMessage).toBe('Dissabtes');
		expect(h.decider.calls).toBe(1);
	});
});

describe('deterministic fast-paths make zero model calls', () => {
	it('unsupported media apologizes (and nudges an active survey) without calling the model', async () => {
		const h = newHarness();
		enqueue(h, { reply: 'Som-hi!', actions: [{ type: 'start_survey' }] });
		await text(h, WA, 'comencem'); // survey active, name missing
		const before = h.decider.calls;

		const out = await runWebhook(h, rawImage(WA, 'wamid.IMG'));
		expect(bodies(out)).toContain('només sé llegir text');
		expect(bodies(out)).toContain('com vols que et digui'); // name nudge
		expect(h.decider.calls).toBe(before); // no extra model call
	});
});

describe('duplicate / out-of-order webhooks', () => {
	it('replaying the same message id produces no second send and no second model call', async () => {
		const h = newHarness();
		enqueue(h, { reply: 'ei', actions: [] });
		const first = await runWebhook(h, rawText(WA, 'wamid.DUP', 'hola'));
		expect(first.length).toBeGreaterThan(0);
		const replay = await runWebhook(h, rawText(WA, 'wamid.DUP', 'hola'));
		expect(replay).toEqual([]);
		expect(h.decider.calls).toBe(1);
	});
});

describe('status webhooks', () => {
	it('updates the matching outbound row and logs failures', async () => {
		const h = newHarness();
		enqueue(h, { reply: 'ei', actions: [] });
		const sent = await text(h, WA, 'hola');
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

describe('degradation: an empty decider queue falls back without mutating', () => {
	it('replies deterministically and applies no side effects', async () => {
		const h = newHarness();
		const out = await text(h, WA, 'qualsevol cosa'); // nothing enqueued → fallbackDecision
		expect(texts(out)[0]).toContain('Instagram');
		const person = await h.store.getPersonByWaId(WA);
		expect(await h.store.getLatestFlowInstance(person!.id, 'curs-sardanes')).toBeNull();
	});
});
