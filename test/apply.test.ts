/**
 * applyDecision over the in-memory store: each action maps to the right D1 write,
 * code derives completion (the model never completes), and model-generated options
 * render as valid WhatsApp interactives (or degrade to text).
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/lib/server/db/memory.ts';
import { Sender } from '../src/lib/server/wa/sender.ts';
import { applyDecision } from '../src/lib/server/survey/apply.ts';
import { validateOutMessage, type OutMessage } from '../src/lib/server/messages.ts';
import { makeState, testEnv } from './util.ts';
import type { Decision } from '../src/lib/server/ai/decide.ts';
import type { SentMessage } from '../src/lib/server/wa/sender.ts';

async function setup() {
	const store = new MemoryStore();
	const person = await store.upsertPerson('34600111222', 'Prof', 't0');
	const sender = new Sender(testEnv(), store);
	return { store, person, deps: { store, sender } };
}

const run = (
	deps: { store: MemoryStore; sender: Sender },
	person: { id: number; wa_id: string },
	decision: Decision,
	stateOver = {}
): Promise<SentMessage[]> => applyDecision(makeState(stateOver), decision, null, person, deps);

async function surveyRow(store: MemoryStore, personId: number) {
	return store.getLatestFlowInstance(personId, 'curs-sardanes');
}

describe('applyDecision — writes', () => {
	it('set_display_name saves the name, clamped to 40 chars', async () => {
		const { store, person, deps } = await setup();
		await run(deps, person, {
			replies: [{ text: 'ok' }],
			actions: [{ type: 'set_display_name', name: 'x'.repeat(60) }]
		});
		expect((await store.getPerson(person.id))?.display_name).toHaveLength(40);
	});

	it('records signup + availability and CODE derives completion', async () => {
		const { store, person, deps } = await setup();
		await run(deps, person, {
			replies: [{ text: 'apuntat!' }],
			actions: [
				{ type: 'record_signup', choice: 'grup' },
				{ type: 'record_availability', bucket: 'dissabtes' }
			]
		});
		const row = await surveyRow(store, person.id);
		expect(row?.status).toBe('completed');
		expect(row?.completed_at).not.toBeNull();
		expect(JSON.parse(row!.data_json)).toEqual({ action: 'grup', availability: 'dissabtes' });
	});

	it('record_signup res → declined', async () => {
		const { store, person, deps } = await setup();
		await run(deps, person, {
			replies: [{ text: 'cap problema' }],
			actions: [{ type: 'decline_survey' }]
		});
		const row = await surveyRow(store, person.id);
		expect(row?.status).toBe('declined');
		expect(JSON.parse(row!.data_json)).toMatchObject({ action: 'res' });
	});

	it('custom availability stores the free-text note as availability_raw', async () => {
		const { store, person, deps } = await setup();
		await run(deps, person, {
			replies: [{ text: 'apuntat' }],
			actions: [
				{ type: 'record_signup', choice: 'avisam' },
				{ type: 'record_availability', bucket: 'custom', note: 'divendres a la nit' }
			]
		});
		expect(JSON.parse((await surveyRow(store, person.id))!.data_json)).toEqual({
			action: 'avisam',
			availability: 'custom',
			availability_raw: 'divendres a la nit'
		});
	});

	it('restart_survey resets answers but keeps the display name', async () => {
		const { store, person, deps } = await setup();
		await store.setDisplayName(person.id, 'Pol', 't0');
		const created = await store.createFlowInstance({
			personId: person.id,
			flowType: 'curs-sardanes',
			status: 'completed',
			step: null,
			dataJson: JSON.stringify({ action: 'grup', availability: 'dissabtes' }),
			createdAt: 't0'
		});
		await run(
			deps,
			person,
			{ replies: [{ text: 'refem-ho' }], actions: [{ type: 'restart_survey' }] },
			{
				survey: {
					status: 'completed',
					collected: { signup: 'grup', availability: 'dissabtes', availabilityRaw: null },
					instanceId: created.id
				}
			}
		);
		const row = await surveyRow(store, person.id);
		expect(row?.status).toBe('active');
		expect(JSON.parse(row!.data_json)).toEqual({});
		expect((await store.getPerson(person.id))?.display_name).toBe('Pol'); // kept
	});
});

describe('applyDecision — reply rendering', () => {
	it('a decision with no control sends a plain text', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, { replies: [{ text: 'què vols saber?' }], actions: [] });
		expect(sent[0]!.message.kind).toBe('text');
	});

	it('multiple bubbles send in order; any bubble can carry its control', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [
				{ text: 'Fet, Pol! 🧡' },
				{
					text: 'Què vols que faci?',
					control: { kind: 'buttons', options: [{ title: 'Al grup' }, { title: 'Res' }] }
				},
				{ text: 'I si tens dubtes, pregunta!' }
			],
			actions: []
		});
		expect(sent.map((s) => s.message.kind)).toEqual(['text', 'buttons', 'text']);
		for (const s of sent) expect(validateOutMessage(s.message)).toEqual([]);
	});

	it('generated button options render as a valid interactive within WhatsApp limits', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [
				{
					text: 'Què vols que faci?',
					control: {
						kind: 'buttons',
						options: [{ title: 'Afegeix-me al grup' }, { title: "Només avisa'm" }, { title: 'Res' }]
					}
				}
			],
			actions: []
		});
		const msg = sent[0]!.message as OutMessage;
		expect(msg.kind).toBe('buttons');
		expect(validateOutMessage(msg)).toEqual([]);
	});

	it('generated list options render as a valid list', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [
				{
					text: 'Quan et va bé?',
					control: {
						kind: 'list',
						label: 'Tria quan',
						options: [{ title: 'Dissabtes' }, { title: 'Diumenges' }]
					}
				}
			],
			actions: []
		});
		const msg = sent[0]!.message as OutMessage;
		expect(msg.kind).toBe('list');
		expect(validateOutMessage(msg)).toEqual([]);
	});

	it('over-long option titles are clamped so the interactive stays valid', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [
				{ text: 'tria', control: { kind: 'buttons', options: [{ title: 'x'.repeat(40) }] } }
			],
			actions: []
		});
		expect(validateOutMessage(sent[0]!.message)).toEqual([]);
	});

	it('an all-empty control degrades to plain text', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [{ text: 'hola', control: { kind: 'buttons', options: [{ title: '   ' }] } }],
			actions: []
		});
		expect(sent[0]!.message.kind).toBe('text');
	});
});
