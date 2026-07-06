/**
 * Bridges SvelteKit's `platform.env` (Cloudflare bindings) to the
 * framework-agnostic bot core. Call these inside remote functions, +server
 * handlers or server loads (they use `getRequestEvent()`).
 */

import { getRequestEvent } from '$app/server';
import type { Env } from './types.ts';
import type { Decider } from './ai/decide.ts';
import { D1Store } from './db/d1.ts';
import { WorkersAiDecider } from './ai/workers-ai-decider.ts';
import { FakeDecider } from './ai/fake-decider.ts';
import { makeDeps, type RouterDeps } from './router.ts';

/** The Worker env for the current request. Throws if the D1 binding is missing. */
export function getEnv(): Env {
	const env = getRequestEvent().platform?.env as Env | undefined;
	if (!env?.DB) {
		throw new Error('platform.env.DB is not available — is this running on Workers?');
	}
	return env;
}

/** A D1-backed store for the current request. */
export function getStore(): D1Store {
	return new D1Store(getEnv().DB);
}

/**
 * DEV_FAKE_AI=true swaps the model for the deterministic FakeDecider so e2e
 * runs and local smoke tests spend ZERO Workers AI neurons. Read from the
 * Worker env (.dev.vars) or, in `vite dev` (Node), from the process env — the
 * Playwright webServer sets it there. Hard-latched to WA being disabled, so it
 * can never take over production.
 */
function makeDecider(env: Env): Decider {
	const flagged =
		env.DEV_FAKE_AI === 'true' ||
		(typeof process !== 'undefined' && process.env?.DEV_FAKE_AI === 'true');
	if (flagged && env.WA_ENABLED !== 'true') return new FakeDecider();
	return new WorkersAiDecider(env);
}

/** Full router deps (env + D1 store + AI decider) for the current request. */
export function getDeps(): RouterDeps {
	const env = getEnv();
	const store = new D1Store(env.DB);
	return makeDeps(env, store, makeDecider(env));
}
