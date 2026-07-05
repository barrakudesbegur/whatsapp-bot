/**
 * Bridges SvelteKit's `platform.env` (Cloudflare bindings) to the
 * framework-agnostic bot core. Call these inside remote functions, +server
 * handlers or server loads (they use `getRequestEvent()`).
 */

import { getRequestEvent } from '$app/server';
import type { Env } from './types.ts';
import { D1Store } from './db/d1.ts';
import { WorkersAiProvider } from './ai/workers-ai.ts';
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

/** Full router deps (env + D1 store + Workers AI provider) for the current request. */
export function getDeps(): RouterDeps {
	const env = getEnv();
	const store = new D1Store(env.DB);
	return makeDeps(env, store, new WorkersAiProvider(env, store));
}
