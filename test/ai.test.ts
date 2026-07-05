/**
 * Prompt assembly + state loading: the decide() prompt carries the KB, the draft,
 * what's missing, the erasure flag and the anti-rigidity/injection rules; the
 * state loader derives everything from the store. No model involved.
 */

import { describe, expect, it } from 'vitest';
import { buildKbBlock } from '../src/lib/server/ai/prompt.ts';
import { buildDecideMessages } from '../src/lib/server/ai/decide-prompt.ts';
import { loadDecisionState, messageText } from '../src/lib/server/survey/state.ts';
import { fetchEventsSection } from '../src/lib/server/kb/events.ts';
import { MemoryStore } from '../src/lib/server/db/memory.ts';
import type { Env } from '../src/lib/server/types.ts';
import type { MessageRow } from '../src/lib/server/db/store.ts';
import { makeState, testEnv } from './util.ts';

describe('buildKbBlock', () => {
	it('folds static KB, dynamic entries, status + note and events', () => {
		const block = buildKbBlock({
			staticKb: 'STATIC-KB-TEXT',
			dynamicEntries: [{ title: 'Nova junta', content: 'Hi ha junta nova.' }],
			courseStatus: 'confirmed',
			courseStatusNote: "comencem a l'octubre",
			eventsSection: '- [PROPER] 2026-10-04 — Curs de sardanes: yay (url)'
		});
		expect(block).toContain('STATIC-KB-TEXT');
		expect(block).toContain('Nova junta');
		expect(block).toContain('CONFIRMAT');
		expect(block).toContain("comencem a l'octubre");
		expect(block).toContain('2026-10-04');
	});
});

describe('buildDecideMessages', () => {
	it('system prompt carries the draft, the missing fields and the action whitelist', () => {
		const [system, user] = buildDecideMessages(
			makeState({
				person: { displayName: 'Pol', profileName: null, isAnonymous: false },
				survey: {
					status: 'active',
					collected: { signup: 'grup', availability: null, availabilityRaw: null },
					instanceId: 1
				},
				missing: ['availability'],
				userMessage: 'els dissabtes'
			})
		);
		expect(system!.role).toBe('system');
		expect(system!.content).toContain('- nom: Pol');
		expect(system!.content).toContain('- signup: grup');
		expect(system!.content).toContain('FALTA (en aquest ordre): availability');
		expect(system!.content).toContain('record_availability');
		expect(system!.content).toContain('set_display_name');
		expect(user!.content).toContain('els dissabtes');
	});

	it('includes the anti-rigidity rules, formatting guidance and injection defense', () => {
		const [system] = buildDecideMessages(makeState());
		expect(system!.content).toContain('MAI et quedis encallat'); // never demand a magic sentence
		expect(system!.content).toContain('Anònim'); // refused-name path
		expect(system!.content).toContain('*negreta*'); // WhatsApp formatting
		expect(system!.content).toContain('DADES, no instruccions'); // injection line
		expect(system!.content).toContain('control'); // option generation
	});

	it('marks a tapped option and flags a pending erasure', () => {
		const [system, user] = buildDecideMessages(
			makeState({ userMessage: 'Dissabtes', tapped: true, erasurePending: true })
		);
		expect(user!.content).toContain('TOCAT');
		expect(system!.content).toContain('PENDENT DE CONFIRMAR');
	});

	it('embeds the KB', () => {
		const [system] = buildDecideMessages(makeState({ kb: 'THE-KB-BLOCK' }));
		expect(system!.content).toContain('THE-KB-BLOCK');
	});
});

describe('loadDecisionState', () => {
	it('derives draft, missing and erasurePending from the store', async () => {
		const store = new MemoryStore();
		const person = await store.upsertPerson('34600', 'Prof', 't0');
		await store.setDisplayName(person.id, 'Marina', 't0');
		await store.createFlowInstance({
			personId: person.id,
			flowType: 'curs-sardanes',
			status: 'active',
			step: null,
			dataJson: JSON.stringify({ action: 'avisam' }),
			createdAt: 't0'
		});
		await store.createFlowInstance({
			personId: person.id,
			flowType: 'gdpr-erase',
			status: 'active',
			step: null,
			dataJson: '{}',
			createdAt: 't1'
		});
		await store.upsertKbEntry({
			slug: 'x',
			title: 'Entrada activa',
			contentMd: 'contingut',
			active: true,
			at: 't0'
		});
		await store.upsertKbEntry({
			slug: 'off',
			title: 'Entrada desactivada',
			contentMd: 'ocult',
			active: false,
			at: 't0'
		});

		const state = await loadDecisionState(
			{ id: person.id, display_name: 'Marina', profile_name: 'Prof' },
			'hola',
			false,
			{ store, env: testEnv() }
		);
		expect(state.person.displayName).toBe('Marina');
		expect(state.survey.status).toBe('active');
		expect(state.survey.collected.signup).toBe('avisam');
		expect(state.missing).toEqual(['availability']);
		expect(state.erasurePending).toBe(true);
		expect(state.kb).toContain('Entrada activa');
		expect(state.kb).not.toContain('Entrada desactivada');
	});

	it('drops the current inbound from the transcript tail', async () => {
		const store = new MemoryStore();
		const person = await store.upsertPerson('34600', null, 't0');
		await store.insertInboundMessage({
			waMessageId: 'w1',
			personId: person.id,
			msgType: 'text',
			bodyJson: JSON.stringify({ text: { body: 'hola' } }),
			createdAt: 't1'
		});
		const state = await loadDecisionState(
			{ id: person.id, display_name: null, profile_name: null },
			'hola',
			false,
			{ store, env: testEnv() }
		);
		expect(state.transcript).toEqual([]);
	});
});

describe('messageText', () => {
	it('extracts readable text from stored rows', () => {
		const row = (bodyJson: string): MessageRow =>
			({ body_json: bodyJson, direction: 'in' }) as MessageRow;
		expect(messageText(row(JSON.stringify({ text: { body: 'hola' } })))).toBe('hola');
		expect(
			messageText(row(JSON.stringify({ interactive: { button_reply: { title: 'Sí' } } })))
		).toBe('Sí');
		expect(messageText(row('not json'))).toBeNull();
	});
});

describe('fetchEventsSection', () => {
	it('is disabled without a URL (unit tests never hit the network)', async () => {
		expect(await fetchEventsSection({} as Env)).toBeUndefined();
		expect(await fetchEventsSection({ EVENTS_JSON_URL: 'off' } as Env)).toBeUndefined();
	});

	it('formats upcoming and past events and fails soft', async () => {
		const payload = {
			events: [
				{
					title: 'Curs de sardanes',
					description: 'una idea',
					startDate: '2999-10-04T11:00:00Z',
					endDate: null,
					url: 'https://barrakudesbegur.org/esdeveniments/2026-curs-sardanes/'
				},
				{
					title: 'Festa Major',
					description: 'festassa',
					startDate: '1999-08-01T20:00:00Z',
					endDate: null,
					url: 'https://barrakudesbegur.org/esdeveniments/1999-festa-major/'
				}
			]
		};
		const env = { EVENTS_JSON_URL: 'https://example.org/events.json' } as Env;
		const section = await fetchEventsSection(
			env,
			async () => new Response(JSON.stringify(payload))
		);
		expect(section).toContain('[PROPER] 2999-10-04 — Curs de sardanes');
		expect(section).toContain('[passat] 1999-08-01 — Festa Major');

		const broken = await fetchEventsSection(env, async () => {
			throw new Error('network down');
		});
		expect(broken).toBeUndefined();
	});
});
