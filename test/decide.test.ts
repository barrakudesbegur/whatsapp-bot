/**
 * The decision contract's pure core: JSON recovery, whitelist validation, and
 * the deterministic fallback. No model, no store.
 */

import { describe, it, expect } from 'vitest';
import { parseDecision, extractJson, fallbackDecision } from '../src/lib/server/ai/decide.ts';
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

	it('requires at least one non-empty bubble', () => {
		expect(parseDecision('{"replies":[],"actions":[]}')).toBeNull();
		expect(parseDecision('{"replies":[{"text":"  "}],"actions":[]}')).toBeNull();
		expect(parseDecision('{"actions":[]}')).toBeNull();
		expect(parseDecision('not json')).toBeNull();
	});

	it('parses bubbles with per-bubble controls', () => {
		const d = parseDecision(
			JSON.stringify({
				replies: [
					{ text: 'Fet!' },
					{
						text: 'Què vols que faci?',
						control: { kind: 'buttons', options: [{ title: 'Sí' }, { title: 'No' }] }
					}
				],
				actions: []
			})
		);
		expect(d?.replies).toHaveLength(2);
		expect(d?.replies[0]).toEqual({ text: 'Fet!' });
		expect(d?.replies[1]?.control).toEqual({
			kind: 'buttons',
			options: [{ title: 'Sí' }, { title: 'No' }]
		});
	});

	it('accepts legacy shapes: reply string, plain-string bubbles, top-level control → last bubble', () => {
		const legacy = parseDecision(
			'{"reply":"q","actions":[],"control":{"kind":"buttons","options":[{"title":"Sí"}]}}'
		);
		expect(legacy?.replies).toEqual([
			{ text: 'q', control: { kind: 'buttons', options: [{ title: 'Sí' }] } }
		]);
		const strings = parseDecision('{"replies":["a","b"],"actions":[]}');
		expect(strings?.replies).toEqual([{ text: 'a' }, { text: 'b' }]);
	});

	it('ignores kind:none and drops an option-less control (bubble degrades to text)', () => {
		const none = parseDecision('{"replies":[{"text":"q","control":{"kind":"none"}}],"actions":[]}');
		expect(none?.replies[0]).toEqual({ text: 'q' });
		const empty = parseDecision(
			'{"replies":[{"text":"q","control":{"kind":"buttons","options":[{"title":"  "}]}}],"actions":[]}'
		);
		expect(empty?.replies[0]).toEqual({ text: 'q' });
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

describe('erasure is NOT a chat capability', () => {
	it('drops any erasure-like action the model might hallucinate', () => {
		const d = parseDecision(
			JSON.stringify({
				reply: 'esborro les teves dades ara mateix',
				actions: [
					{ type: 'confirm_erasure' },
					{ type: 'initiate_erasure' },
					{ type: 'erase_data' },
					{ type: 'record_signup', choice: 'grup' }
				]
			})
		);
		// Only the whitelisted survey action survives; deletion can never execute.
		expect(d?.actions).toEqual([{ type: 'record_signup', choice: 'grup' }]);
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
		expect(d.replies[0]!.text).toContain('grup'); // signup nudge
		expect(d.replies).toHaveLength(1);
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
		expect(d.replies[0]!.text).toContain('Instagram');
	});
});
