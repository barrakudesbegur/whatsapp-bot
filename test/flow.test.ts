/**
 * Pure-function tests for the curs-sardanes flow: every step, every branch, the
 * edge cases the flow itself owns, and a copy-limits assertion (PLAN 4.4 / 4.8).
 */

import { describe, it, expect } from 'vitest';
import {
	cursSardanesFlow as flow,
	STEP,
	parseName,
	parseAvailability,
	AVAILABILITY_IDS
} from '../src/lib/server/flows/curs-sardanes.ts';
import type { FlowContext, FlowInput } from '../src/lib/server/flows/types.ts';
import { validateOutMessage, type OutMessage } from '../src/lib/server/messages.ts';

const ctx = (over: Partial<FlowContext> = {}): FlowContext => ({
	data: {},
	...over
});

describe('start (K1)', () => {
	it("asks the name and activates on step 'name'", () => {
		const r = flow.start(ctx());
		expect(r.messages).toHaveLength(1);
		expect(r.messages[0]).toMatchObject({ kind: 'text' });
		expect((r.messages[0] as { body: string }).body).toContain('com vols que et digui');
		expect(r.patch).toMatchObject({
			status: 'active',
			step: STEP.NAME,
			data: {}
		});
	});
});

describe('parseName', () => {
	it('accepts a bare name', () => expect(parseName('Pol')).toBe('Pol'));
	it('strips lead-ins', () => {
		expect(parseName('em dic Marina')).toBe('Marina');
		expect(parseName('Sóc en Jordi')).toBe('Jordi');
		expect(parseName('diguem-me Laia!')).toBe('Laia');
	});
	it('returns null for a question (unclear → AI)', () => {
		expect(parseName('però què és això del curs?')).toBeNull();
	});
	it('returns null for empty / letterless input', () => {
		expect(parseName('   ')).toBeNull();
		expect(parseName('123 456')).toBeNull();
	});
});

describe('K1 → name step', () => {
	it('saves display name and asks K2 info + K3 buttons', () => {
		const r = flow.onStep(ctx(), STEP.NAME, { kind: 'text', text: 'Pol' });
		expect(r.patch).toMatchObject({ displayName: 'Pol', step: STEP.ACTION });
		expect(r.messages).toHaveLength(2);
		expect(r.messages[0]!.kind).toBe('text');
		expect((r.messages[0] as { body: string }).body).toContain('Genial, Pol!');
		expect(r.messages[1]!.kind).toBe('buttons');
		const btns = r.messages[1] as Extract<OutMessage, { kind: 'buttons' }>;
		expect(btns.buttons.map((b) => b.id)).toEqual(['grup', 'avisam', 'res']);
	});

	it('defers to AI when the name is unclear', () => {
		const r = flow.onStep(ctx(), STEP.NAME, {
			kind: 'text',
			text: 'abans de res, quant costa el curs?'
		});
		expect(r.deferToAi).toBeDefined();
		expect(r.messages).toHaveLength(0);
	});
});

describe('K3 action step', () => {
	it('grup → asks availability (K4 list)', () => {
		const r = flow.onStep(ctx({ displayName: 'Pol' }), STEP.ACTION, {
			kind: 'button',
			id: 'grup',
			title: 'Afegeix-me al grup'
		});
		expect(r.patch).toMatchObject({
			step: STEP.AVAILABILITY,
			data: { action: 'grup' }
		});
		expect(r.messages[0]!.kind).toBe('list');
	});

	it('avisam → asks availability', () => {
		const r = flow.onStep(ctx(), STEP.ACTION, {
			kind: 'button',
			id: 'avisam',
			title: "Només avisa'm"
		});
		expect(r.patch?.data).toMatchObject({ action: 'avisam' });
		expect(r.messages[0]!.kind).toBe('list');
	});

	it('res → declined, flow ends', () => {
		const r = flow.onStep(ctx(), STEP.ACTION, {
			kind: 'button',
			id: 'res',
			title: 'Res, gràcies'
		});
		expect(r.patch).toMatchObject({
			status: 'declined',
			step: null,
			done: true
		});
		expect(r.patch?.data).toMatchObject({ action: 'res' });
		expect((r.messages[0] as { body: string }).body).toContain('Cap problema!');
	});

	it("parses a typed action ('apunta'm')", () => {
		const r = flow.onStep(ctx(), STEP.ACTION, {
			kind: 'text',
			text: "apunta'm al grup!"
		});
		expect(r.patch?.data).toMatchObject({ action: 'grup' });
	});

	it('defers to AI on gibberish', () => {
		const r = flow.onStep(ctx(), STEP.ACTION, {
			kind: 'text',
			text: 'no ho sé encara'
		});
		expect(r.deferToAi).toBeDefined();
	});
});

describe('K4 availability step', () => {
	for (const id of AVAILABILITY_IDS) {
		it(`list reply ${id} → completes`, () => {
			const r = flow.onStep(
				ctx({ displayName: 'Pol', data: { action: 'grup' } }),
				STEP.AVAILABILITY,
				{
					kind: 'list',
					id,
					title: id
				}
			);
			expect(r.patch).toMatchObject({
				status: 'completed',
				step: null,
				done: true
			});
			expect(r.patch?.data).toMatchObject({ availability: id });
			expect((r.messages[0] as { body: string }).body).toContain('ja està');
		});
	}

	it('grup variant close mentions the group invite', () => {
		const r = flow.onStep(ctx({ data: { action: 'grup' } }), STEP.AVAILABILITY, {
			kind: 'list',
			id: 'dissabtes',
			title: 'Dissabtes'
		});
		expect((r.messages[0] as { body: string }).body).toContain('invitació al grup');
	});

	it('avisam variant close mentions being written to', () => {
		const r = flow.onStep(ctx({ data: { action: 'avisam' } }), STEP.AVAILABILITY, {
			kind: 'list',
			id: 'diumenges',
			title: 'Diumenges'
		});
		expect((r.messages[0] as { body: string }).body).toContain("t'escric per aquí");
	});

	it("scripted-parses free text ('els dissabtes em van bé')", () => {
		const r = flow.onStep(ctx({ data: { action: 'grup' } }), STEP.AVAILABILITY, {
			kind: 'text',
			text: 'els dissabtes em van bé'
		});
		expect(r.patch?.data).toMatchObject({ availability: 'dissabtes' });
	});

	it('defers to AI (with interpret) on unparseable free text', () => {
		const r = flow.onStep(ctx({ data: { action: 'grup' } }), STEP.AVAILABILITY, {
			kind: 'text',
			text: 'quan surti la lluna plena'
		});
		expect(r.deferToAi?.interpret).toMatchObject({ field: 'availability' });
	});

	it('interpreted canonical value completes', () => {
		const r = flow.onStep(ctx({ data: { action: 'grup' } }), STEP.AVAILABILITY, {
			kind: 'interpreted',
			value: 'diumenges',
			raw: 'els dies de missa'
		});
		expect(r.patch?.data).toMatchObject({ availability: 'diumenges' });
	});

	it('interpreted non-canonical value stores custom + raw', () => {
		const r = flow.onStep(ctx({ data: { action: 'avisam' } }), STEP.AVAILABILITY, {
			kind: 'interpreted',
			value: 'whatever',
			raw: 'només de nit'
		});
		expect(r.patch?.data).toMatchObject({
			availability: 'custom',
			availability_raw: 'només de nit'
		});
	});
});

describe('parseAvailability', () => {
	it.each([
		['diumenge al matí', 'diumenges'],
		['entre setmana millor', 'entre-setmana'],
		['depèn del cap de setmana', 'depen'],
		["m'és igual", 'igual'],
		['tot em va bé', 'igual']
	])('%s → %s', (input, expected) => {
		expect(parseAvailability(input)).toBe(expected);
	});
	it('returns null when nothing matches', () => {
		expect(parseAvailability('blblbl')).toBeNull();
	});
});

describe('returning completed (edge case)', () => {
	it('offers to change answers with Sí/No', () => {
		const r = flow.onReturningCompleted!(ctx({ displayName: 'Pol' }));
		expect(r.messages[0]!.kind).toBe('buttons');
		expect(r.patch).toMatchObject({ step: STEP.CONFIRM_RESTART });
		const btns = r.messages[0] as Extract<OutMessage, { kind: 'buttons' }>;
		expect(btns.buttons.map((b) => b.id)).toEqual(['yes', 'no']);
	});

	it('Sí restarts at the action step, resetting data', () => {
		const r = flow.onStep(ctx({ displayName: 'Pol' }), STEP.CONFIRM_RESTART, {
			kind: 'button',
			id: 'yes',
			title: 'Sí'
		});
		expect(r.patch).toMatchObject({
			status: 'active',
			step: STEP.ACTION,
			data: {}
		});
		expect(r.messages.some((m) => m.kind === 'buttons')).toBe(true);
	});

	it('No keeps everything as-is', () => {
		const r = flow.onStep(ctx({ displayName: 'Pol' }), STEP.CONFIRM_RESTART, {
			kind: 'button',
			id: 'no',
			title: 'No'
		});
		expect(r.patch).toMatchObject({ status: 'completed', step: null });
		expect((r.messages[0] as { body: string }).body).toContain('tal com estava');
	});
});

describe('pending() re-ask', () => {
	it.each([STEP.NAME, STEP.ACTION, STEP.AVAILABILITY, STEP.CONFIRM_RESTART])(
		'returns a message for step %s',
		(step) => {
			expect(flow.pending(ctx(), step).length).toBeGreaterThan(0);
		}
	);
});

describe('copy respects WhatsApp interactive limits', () => {
	it('every message the flow can emit is within limits', () => {
		const inputs: Array<[string, FlowInput]> = [
			[STEP.NAME, { kind: 'text', text: 'Pol' }],
			[STEP.ACTION, { kind: 'button', id: 'grup', title: 'x' }],
			[STEP.ACTION, { kind: 'button', id: 'avisam', title: 'x' }],
			[STEP.ACTION, { kind: 'button', id: 'res', title: 'x' }],
			[STEP.AVAILABILITY, { kind: 'list', id: 'depen', title: 'x' }],
			[STEP.CONFIRM_RESTART, { kind: 'button', id: 'yes', title: 'x' }],
			[STEP.CONFIRM_RESTART, { kind: 'button', id: 'no', title: 'x' }]
		];
		const all: OutMessage[] = [
			...flow.start(ctx()).messages,
			...flow.onReturningCompleted!(ctx()).messages
		];
		for (const [step, input] of inputs) {
			all.push(
				...flow.onStep(ctx({ displayName: 'Pol', data: { action: 'grup' } }), step, input).messages
			);
		}
		for (const step of [STEP.NAME, STEP.ACTION, STEP.AVAILABILITY, STEP.CONFIRM_RESTART]) {
			all.push(...flow.pending(ctx(), step));
		}
		const violations = all.flatMap((m) => validateOutMessage(m));
		expect(violations).toEqual([]);
		// sanity: we actually collected the tricky ones (list + buttons)
		expect(all.some((m) => m.kind === 'list')).toBe(true);
		expect(all.some((m) => m.kind === 'buttons')).toBe(true);
	});
});
