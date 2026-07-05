/**
 * The decision contract's pure core: JSON recovery, whitelist validation, the
 * erasure gate, and the deterministic fallback. No model, no store.
 */

import { describe, it, expect } from 'vitest';
import {
	parseDecision,
	extractJson,
	mayDelete,
	fallbackDecision,
	DECISION_JSON_SCHEMA
} from '../src/lib/server/ai/decide.ts';
import { makeState } from './util.ts';

describe('extractJson', () => {
	it('parses plain and fenced JSON', () => {
		expect(extractJson('{"reply":"hola","actions":[]}')).toEqual({ reply: 'hola', actions: [] });
		expect(extractJson('```json\n{"reply":"ei","actions":[]}\n```')).toEqual({
			reply: 'ei',
			actions: []
		});
	});

	it('recovers JSON wrapped in prose', () => {
		const raw = 'És clar! Aquí tens: {"reply":"ei","actions":[]} — som-hi';
		expect(extractJson(raw)).toEqual({ reply: 'ei', actions: [] });
	});

	it('handles a nested actions array (the case a non-greedy regex would truncate)', () => {
		const raw =
			'{"reply":"fet","actions":[{"type":"record_signup","choice":"grup"},{"type":"set_display_name","name":"Pol"}],"control":{"kind":"none"}}';
		const obj = extractJson(raw) as { actions: unknown[] };
		expect(obj.actions).toHaveLength(2);
	});

	it('is string-aware (braces inside strings do not break matching)', () => {
		const raw = '{"reply":"un {emoji} }{ rar","actions":[]}';
		expect(extractJson(raw)).toEqual({ reply: 'un {emoji} }{ rar', actions: [] });
	});

	it('returns null on garbage', () => {
		expect(extractJson('cap json aquí')).toBeNull();
		expect(extractJson('')).toBeNull();
	});
});

describe('parseDecision', () => {
	it('keeps valid actions and drops invalid ones without losing the good', () => {
		const d = parseDecision(
			JSON.stringify({
				reply: 'ok',
				actions: [
					{ type: 'record_signup', choice: 'grup' },
					{ type: 'record_signup', choice: 'nope' }, // bad enum → dropped
					{ type: 'teleport' }, // unknown type → dropped
					{ type: 'set_display_name', name: 'Pol' }
				]
			})
		);
		expect(d?.actions).toEqual([
			{ type: 'record_signup', choice: 'grup' },
			{ type: 'set_display_name', name: 'Pol' }
		]);
	});

	it('requires a non-empty reply', () => {
		expect(parseDecision('{"reply":"","actions":[]}')).toBeNull();
		expect(parseDecision('{"actions":[]}')).toBeNull();
		expect(parseDecision('not json')).toBeNull();
	});

	it('parses a valid control (buttons/list) and ignores kind:none', () => {
		const btn = parseDecision(
			'{"reply":"q","actions":[],"control":{"kind":"buttons","options":[{"title":"Sí"},{"title":"No"}]}}'
		);
		expect(btn?.control).toEqual({ kind: 'buttons', options: [{ title: 'Sí' }, { title: 'No' }] });
		const none = parseDecision('{"reply":"q","actions":[],"control":{"kind":"none"}}');
		expect(none?.control).toBeUndefined();
	});

	it('trims empty options and drops an option-less control', () => {
		const d = parseDecision(
			'{"reply":"q","actions":[],"control":{"kind":"buttons","options":[{"title":"  "}]}}'
		);
		expect(d?.control).toBeUndefined();
	});

	it('validates record_availability note and set_display_name length via schema pipe', () => {
		const d = parseDecision(
			JSON.stringify({
				reply: 'ok',
				actions: [{ type: 'record_availability', bucket: 'custom', note: 'divendres nit' }]
			})
		);
		expect(d?.actions[0]).toEqual({
			type: 'record_availability',
			bucket: 'custom',
			note: 'divendres nit'
		});
	});
});

describe('mayDelete (erasure gate)', () => {
	const armed = { erasurePending: true };
	const notArmed = { erasurePending: false };
	const confirm = { reply: 'x', actions: [{ type: 'confirm_erasure' as const }] };
	const none = { reply: 'x', actions: [] };

	it('only deletes when armed on a prior turn AND a confirm signal is present', () => {
		expect(mayDelete(armed, { decision: confirm })).toBe(true);
		expect(mayDelete(armed, { tapYes: true })).toBe(true);
		expect(mayDelete(notArmed, { decision: confirm })).toBe(false); // single-message bypass blocked
		expect(mayDelete(notArmed, { tapYes: true })).toBe(false);
		expect(mayDelete(armed, { decision: none })).toBe(false); // armed but no confirm
	});
});

describe('fallbackDecision', () => {
	it('never carries actions and nudges the next missing field mid-survey', () => {
		const d = fallbackDecision(
			makeState({
				survey: {
					status: 'active',
					collected: { signup: null, availability: null, availabilityRaw: null },
					instanceId: 1
				},
				missing: ['signup']
			})
		);
		expect(d.actions).toEqual([]);
		expect(d.reply).toContain('grup'); // signup nudge
		expect(d.reply.length).toBeGreaterThan(0);
	});

	it('is a plain apology when no survey is active', () => {
		const d = fallbackDecision(
			makeState({
				survey: {
					status: 'none',
					collected: { signup: null, availability: null, availabilityRaw: null },
					instanceId: null
				},
				missing: []
			})
		);
		expect(d.actions).toEqual([]);
		expect(d.reply).toContain('Instagram');
	});
});

describe('DECISION_JSON_SCHEMA', () => {
	it('enumerates exactly the whitelisted action types', () => {
		const types: readonly string[] =
			DECISION_JSON_SCHEMA.properties.actions.items.properties.type.enum;
		expect(types).toContain('set_display_name');
		expect(types).toContain('confirm_erasure');
		expect(types).not.toContain('teleport');
	});
});
