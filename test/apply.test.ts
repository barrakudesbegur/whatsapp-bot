/**
 * applyDecision over the in-memory store: each action maps to the right D1 write,
 * code derives completion (the model never completes), and model-generated options
 * render as valid WhatsApp interactives (or degrade to text).
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/lib/server/db/memory.ts';
import { Sender } from '../src/lib/server/wa/sender.ts';
import { applyDecision, stripEmDash } from '../src/lib/server/survey/apply.ts';
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
	it('set_display_name saves the name the person said, clamped to 40 chars', async () => {
		const { store, person, deps } = await setup();
		const name = 'x'.repeat(60);
		await run(
			deps,
			person,
			{
				replies: [{ text: 'ok' }],
				actions: [{ type: 'set_display_name', name }]
			},
			{ userMessage: `em dic ${name}` }
		);
		expect((await store.getPerson(person.id))?.display_name).toHaveLength(40);
	});

	it('drops a hallucinated name the person never said (observed live: «Marc»)', async () => {
		const { store, person, deps } = await setup();
		await run(
			deps,
			person,
			{
				replies: [{ text: 'Perfecte, Marc!' }],
				actions: [{ type: 'set_display_name', name: 'Marc' }]
			},
			{ userMessage: 'els caps de setmana', transcript: [{ role: 'user', text: 'hola' }] }
		);
		expect((await store.getPerson(person.id))?.display_name).toBeNull();
	});

	it('accepts a name from an earlier user turn, the profile name, or Anònim', async () => {
		const { store, person, deps } = await setup();
		await run(
			deps,
			person,
			{ replies: [{ text: 'ok' }], actions: [{ type: 'set_display_name', name: 'Joan' }] },
			{ userMessage: 'sí', transcript: [{ role: 'user', text: 'em dic joan' }] }
		);
		expect((await store.getPerson(person.id))?.display_name).toBe('Joan');

		await run(
			deps,
			person,
			{ replies: [{ text: 'ok' }], actions: [{ type: 'set_display_name', name: 'Prof' }] },
			{ person: { displayName: 'Joan', profileName: 'Prof', isAnonymous: false } }
		);
		expect((await store.getPerson(person.id))?.display_name).toBe('Prof');

		await run(deps, person, {
			replies: [{ text: 'ok' }],
			actions: [{ type: 'set_display_name', name: 'Anònim' }]
		});
		expect((await store.getPerson(person.id))?.display_name).toBe('Anònim');
	});

	it('accepts the accented spelling of a name the person typed without accents', async () => {
		const { store, person, deps } = await setup();
		// Person types «merce», the model canonicalizes to «Mercè» (proper Catalan).
		await run(
			deps,
			person,
			{ replies: [{ text: 'ok' }], actions: [{ type: 'set_display_name', name: 'Mercè' }] },
			{ userMessage: 'em dic merce' }
		);
		expect((await store.getPerson(person.id))?.display_name).toBe('Mercè');
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

	it('a decision that both declines AND signs up resolves last-write-wins (not latched to declined)', async () => {
		const { store, person, deps } = await setup();
		await run(deps, person, {
			replies: [{ text: 'va, apuntat!' }],
			actions: [{ type: 'decline_survey' }, { type: 'record_signup', choice: 'grup' }]
		});
		const row = await surveyRow(store, person.id);
		// signup ends 'grup', so the draft is active (awaiting availability), NOT a
		// closed 'declined' submission stamped completed.
		expect(row?.status).toBe('active');
		expect(row?.completed_at).toBeNull();
		expect(JSON.parse(row!.data_json)).toMatchObject({ action: 'grup' });
	});

	it('custom availability with no note is NOT recorded (survey keeps asking, stores no junk)', async () => {
		const { store, person, deps } = await setup();
		await run(deps, person, {
			replies: [{ text: 'i quan et va bé?' }],
			actions: [
				{ type: 'record_signup', choice: 'grup' },
				{ type: 'record_availability', bucket: 'custom' }
			]
		});
		const row = await surveyRow(store, person.id);
		// signup captured, availability left unset → active, never completed with a
		// meaningless bare 'custom'.
		expect(row?.status).toBe('active');
		expect(JSON.parse(row!.data_json)).toEqual({ action: 'grup' });
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

	it('a bubble with an image URL from the KB sends an image with the text as caption', async () => {
		const { person, deps } = await setup();
		const link = 'https://barrakudesbegur.org/events/2026-sant-pere.jpg';
		const sent = await run(
			deps,
			person,
			{ replies: [{ text: 'El cartell de Sant Pere! 🧡', image: link }], actions: [] },
			{ kb: `## AGENDA\n- [PROPER] 2026-06-27 — Sant Pere (url) · cartell: ${link}` }
		);
		expect(sent[0]!.message).toEqual({
			kind: 'image',
			link,
			caption: 'El cartell de Sant Pere! 🧡'
		});
		expect(validateOutMessage(sent[0]!.message)).toEqual([]);
	});

	it('an image URL NOT in the KB degrades to plain text (anti-hallucination)', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [{ text: 'mira el cartell', image: 'https://evil.example/fake.jpg' }],
			actions: []
		});
		expect(sent[0]!.message).toEqual({ kind: 'text', body: 'mira el cartell' });
	});

	it('a truncated PREFIX of a real KB image URL is rejected (exact match, not substring)', async () => {
		const { person, deps } = await setup();
		const link = 'https://barrakudesbegur.org/events/2026-sant-pere.jpg';
		const sent = await run(
			deps,
			person,
			// URL minus its «.jpg» — a substring of the real one, but not a real image.
			{
				replies: [{ text: 'mira', image: 'https://barrakudesbegur.org/events/2026-sant-pere' }],
				actions: []
			},
			{ kb: `## AGENDA\n- [PROPER] 2026-06-27 — Sant Pere (url) · cartell: ${link}` }
		);
		expect(sent[0]!.message).toEqual({ kind: 'text', body: 'mira' });
	});

	it('a turn that would send nothing falls back to a non-empty apology instead of silence', async () => {
		const { person, deps } = await setup();
		// Single caption-less bubble whose image is not in the KB → drops to [].
		const sent = await run(deps, person, {
			replies: [{ text: '', image: 'https://evil.example/fake.jpg' }],
			actions: []
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]!.message.kind).toBe('text');
		expect((sent[0]!.message as { body: string }).body).toContain('encallat');
	});

	it('a control with duplicate button titles degrades to plain text (Meta rejects dupes)', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [
				{ text: 'tria', control: { kind: 'buttons', options: [{ title: 'Sí' }, { title: 'Sí' }] } }
			],
			actions: []
		});
		expect(sent[0]!.message.kind).toBe('text');
		expect(validateOutMessage(sent[0]!.message)).toEqual([]);
	});

	it('em dashes never reach WhatsApp (owner rule: not used in Catalan)', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [{ text: 'Encara no ho sabem — primer volem veure-ho 😊' }],
			actions: []
		});
		expect((sent[0]!.message as { body: string }).body).toBe(
			'Encara no ho sabem, primer volem veure-ho 😊'
		);

		expect(stripEmDash('Fet! — i ja està')).toBe('Fet! i ja està');
		expect(stripEmDash('un guionet 10-12 es queda')).toBe('un guionet 10-12 es queda');
		expect(stripEmDash('— hola')).toBe('hola');
	});

	it('a caption-less bubble with a non-KB image is dropped, the rest still sends', async () => {
		const { person, deps } = await setup();
		const sent = await run(deps, person, {
			replies: [{ text: '', image: 'https://evil.example/fake.jpg' }, { text: 'segona' }],
			actions: []
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]!.message).toEqual({ kind: 'text', body: 'segona' });
	});
});
