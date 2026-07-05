/**
 * wa.me link resolution — single source of truth is Meta (the Graph API knows
 * the number behind WA_PHONE_NUMBER_ID); WA_ME_URL is a manual override; no
 * credentials → null (the index endpoint then falls back to the association
 * site). Cached per isolate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWaMeUrl, clearWaMeCache } from '../src/lib/server/wa/wame.ts';
import { testEnv } from './util.ts';

beforeEach(() => clearWaMeCache());

const CREDS = { WA_PHONE_NUMBER_ID: 'PN1', WA_ACCESS_TOKEN: 'tok', WA_GRAPH_VERSION: 'v23.0' };

function metaFetch(displayNumber: string) {
	return vi.fn(async (url: string | URL | Request) => {
		expect(String(url)).toContain('/v23.0/PN1?fields=display_phone_number');
		return new Response(JSON.stringify({ display_phone_number: displayNumber }), { status: 200 });
	}) as unknown as typeof fetch;
}

describe('resolveWaMeUrl', () => {
	it('WA_ME_URL override wins without touching the network', async () => {
		const fetcher = vi.fn() as unknown as typeof fetch;
		const url = await resolveWaMeUrl(testEnv({ WA_ME_URL: 'https://wa.me/34123456789' }), fetcher);
		expect(url).toBe('https://wa.me/34123456789');
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('resolves the number from Meta and strips formatting', async () => {
		const url = await resolveWaMeUrl(testEnv(CREDS), metaFetch('+34 612 34 56 78'));
		expect(url).toBe('https://wa.me/34612345678');
	});

	it('caches the lookup per isolate', async () => {
		const fetcher = metaFetch('+34 612 34 56 78');
		await resolveWaMeUrl(testEnv(CREDS), fetcher);
		await resolveWaMeUrl(testEnv(CREDS), fetcher);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('returns null without credentials (no Meta setup yet)', async () => {
		const fetcher = vi.fn() as unknown as typeof fetch;
		expect(await resolveWaMeUrl(testEnv(), fetcher)).toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('fails soft on Graph errors and bad payloads', async () => {
		expect(
			await resolveWaMeUrl(
				testEnv(CREDS),
				(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
			)
		).toBeNull();
		clearWaMeCache();
		expect(
			await resolveWaMeUrl(testEnv(CREDS), (async () => {
				throw new Error('network down');
			}) as unknown as typeof fetch)
		).toBeNull();
	});
});
