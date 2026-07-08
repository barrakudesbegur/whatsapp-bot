/**
 * GDPR erasure completeness (Art.17): anonymizePerson must scrub the messages,
 * the person row, AND the survey free text (data_json availability notes the
 * person typed) — and the CSV export must never re-surface an erased person.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/lib/server/db/memory.ts';

async function seedCompleted() {
	const store = new MemoryStore();
	const person = await store.upsertPerson('34600111222', 'Prof', 't0');
	await store.setDisplayName(person.id, 'Marina', 't0');
	await store.insertInboundMessage({
		waMessageId: 'w1',
		personId: person.id,
		msgType: 'text',
		bodyJson: JSON.stringify({ text: { body: 'hola' } }),
		createdAt: 't1'
	});
	await store.createFlowInstance({
		personId: person.id,
		flowType: 'curs-sardanes',
		status: 'completed',
		step: null,
		dataJson: JSON.stringify({
			action: 'grup',
			availability: 'custom',
			availability_raw: 'divendres a la nit a casa la Núria'
		}),
		createdAt: 't1'
	});
	return { store, person };
}

describe('GDPR erasure', () => {
	it('scrubs messages, the person row AND the survey free text', async () => {
		const { store, person } = await seedCompleted();
		await store.anonymizePerson(person.id, 't2');

		const p = await store.getPerson(person.id);
		expect(p?.gdpr_deleted).toBe(1);
		expect(p?.display_name).toBeNull();
		expect(p?.profile_name).toBeNull();
		expect(p?.wa_id).toBe(`deleted:${person.id}`);
		expect(await store.listMessagesForPerson(person.id)).toEqual([]);

		const flow = await store.getLatestFlowInstance(person.id, 'curs-sardanes');
		expect(JSON.parse(flow!.data_json)).toEqual({}); // verbatim note gone
	});

	it('excludes an erased person from the completed-flows CSV export', async () => {
		const { store, person } = await seedCompleted();
		expect(await store.exportCompletedFlows('curs-sardanes')).toHaveLength(1);
		await store.anonymizePerson(person.id, 't2');
		expect(await store.exportCompletedFlows('curs-sardanes')).toHaveLength(0);
	});
});
