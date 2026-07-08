/**
 * Typing indicator: the mark-read + "typing…" signal sent right before the model
 * call. Verifies the wire payload, the Sender's no-op/never-throw behaviour, and
 * that the router only shows typing on the decide() path (the media fast path
 * replies instantly and stays silent).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { toTypingPayload } from '../src/lib/server/wa/wire.ts';
import { Sender } from '../src/lib/server/wa/sender.ts';
import { MemoryStore } from '../src/lib/server/db/memory.ts';
import { newHarness, enqueue, text, testEnv, runWebhook } from './util.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubFetch() {
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: { body: string }) => {
			calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
			return new Response(JSON.stringify({ success: true, messages: [{ id: 'wamid.SENT' }] }), {
				status: 200
			});
		})
	);
	return calls;
}

describe('toTypingPayload', () => {
	it('builds the mark-read + typing_indicator payload', () => {
		expect(toTypingPayload('wamid.ABC')).toEqual({
			messaging_product: 'whatsapp',
			status: 'read',
			message_id: 'wamid.ABC',
			typing_indicator: { type: 'text' }
		});
	});
});

describe('Sender.typing', () => {
	it('is a no-op while WA is disabled', async () => {
		const calls = stubFetch();
		const sender = new Sender(testEnv(), new MemoryStore());
		await sender.typing('wamid.X');
		expect(calls).toHaveLength(0);
	});

	it('posts the typing payload to the Graph API when enabled', async () => {
		const calls = stubFetch();
		const sender = new Sender(
			testEnv({ WA_ENABLED: 'true', WA_PHONE_NUMBER_ID: 'PN1', WA_ACCESS_TOKEN: 't' }),
			new MemoryStore()
		);
		await sender.typing('wamid.X');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toContain('/PN1/messages');
		expect(calls[0]!.body).toMatchObject({
			status: 'read',
			message_id: 'wamid.X',
			typing_indicator: { type: 'text' }
		});
	});

	it('never throws — Graph errors and network failures are swallowed', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 500 }))
		);
		const enabled = testEnv({ WA_ENABLED: 'true', WA_PHONE_NUMBER_ID: 'PN1' });
		await expect(new Sender(enabled, new MemoryStore()).typing('wamid.X')).resolves.toBeUndefined();

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);
		await expect(new Sender(enabled, new MemoryStore()).typing('wamid.X')).resolves.toBeUndefined();
	});

	it('does not record anything in D1', async () => {
		stubFetch();
		const store = new MemoryStore();
		const person = await store.upsertPerson('34600', null, 't0');
		const sender = new Sender(testEnv({ WA_ENABLED: 'true', WA_PHONE_NUMBER_ID: 'PN1' }), store);
		await sender.typing('wamid.X');
		expect(await store.listMessagesForPerson(person.id)).toEqual([]);
	});
});

describe('router: typing only on the decide() path', () => {
	const WA = '34600111222';
	const liveEnv = () => testEnv({ WA_ENABLED: 'true', WA_PHONE_NUMBER_ID: 'PN1' });

	it('free text → typing indicator BEFORE the reply send', async () => {
		const calls = stubFetch();
		const h = newHarness(liveEnv());
		enqueue(h, { replies: [{ text: 'ei!' }], actions: [] });
		await text(h, WA, 'hola');
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls[0]!.body).toMatchObject({ status: 'read', typing_indicator: { type: 'text' } });
		expect(calls[1]!.body).toMatchObject({ type: 'text' }); // the actual reply
	});

	it('media fast-path replies without a typing indicator', async () => {
		const calls = stubFetch();
		const h = newHarness(liveEnv());
		await runWebhook(h, {
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
									{ from: WA, id: 'wamid.IMG9', timestamp: '1', type: 'image', image: { id: 'm' } }
								]
							}
						}
					]
				}
			]
		});
		expect(h.decider.calls).toBe(0); // fast path: no model
		expect(calls.length).toBeGreaterThan(0); // the apology was sent
		for (const c of calls) expect(c.body.typing_indicator).toBeUndefined(); // and no typing
	});
});

describe('Sender.send — transient retry', () => {
	const liveEnv = () =>
		testEnv({ WA_ENABLED: 'true', WA_PHONE_NUMBER_ID: 'PN1', WA_ACCESS_TOKEN: 't' });

	it('retries once on a 5xx and then succeeds', async () => {
		let n = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				n++;
				return n === 1
					? new Response('boom', { status: 503 })
					: new Response(JSON.stringify({ messages: [{ id: 'wamid.OK' }] }), { status: 200 });
			})
		);
		const sender = new Sender(liveEnv(), new MemoryStore());
		const sent = await sender.send({ id: 1, wa_id: '34600' }, [{ kind: 'text', body: 'hola' }]);
		expect(n).toBe(2);
		expect(sent[0]!.status).toBe('sent');
		expect(sent[0]!.waMessageId).toBe('wamid.OK');
	});

	it('does NOT retry a 4xx (validation error) and records failed', async () => {
		let n = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				n++;
				return new Response(JSON.stringify({ error: { code: 131009, message: 'bad' } }), {
					status: 400
				});
			})
		);
		const sender = new Sender(liveEnv(), new MemoryStore());
		const sent = await sender.send({ id: 1, wa_id: '34600' }, [{ kind: 'text', body: 'hola' }]);
		expect(n).toBe(1); // fail fast, no retry on 4xx
		expect(sent[0]!.status).toBe('failed');
	});
});
