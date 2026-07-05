/**
 * Deterministic Decider for unit tests. Enqueue the decision(s) a test expects
 * (a fixed Decision or a `(state) => Decision` function); `calls` counts how many
 * times decide() ran, so tests can assert the one-call budget and that the
 * fast-paths (media apology, webhook dedupe) make ZERO model calls. No network.
 */

import {
	fallbackDecision,
	type Decider,
	type DecideOutput,
	type Decision,
	type DecisionState
} from './decide.ts';

type Scripted = Decision | ((state: DecisionState) => Decision);

export class ScriptedDecider implements Decider {
	private queue: Scripted[] = [];
	/** Number of decide() invocations — assert cost / fast-path behaviour. */
	calls = 0;
	/** Every state decide() was called with, in order (for assertions). */
	seen: DecisionState[] = [];

	constructor(...initial: Scripted[]) {
		this.queue.push(...initial);
	}

	/** Queue the next decision(s) to return. */
	enqueue(...decisions: Scripted[]): void {
		this.queue.push(...decisions);
	}

	async decide(state: DecisionState): Promise<DecideOutput> {
		this.calls++;
		this.seen.push(state);
		const next = this.queue.shift();
		const decision = next
			? typeof next === 'function'
				? next(state)
				: next
			: fallbackDecision(state);
		return { decision, meta: { model: 'scripted', latencyMs: 0 } };
	}
}
