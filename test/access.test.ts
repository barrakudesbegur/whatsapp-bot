/**
 * Access token extraction. Cloudflare Access only injects the
 * `Cf-Access-Jwt-Assertion` header on Access-routed paths (our /admin page), not
 * on SvelteKit remote-function calls to `/_app/remote/*`. `readAccessToken()`
 * falls back to the host-scoped `CF_Authorization` cookie, which the browser
 * sends on every same-host request. These vectors pin that behavior.
 */

import { describe, it, expect } from 'vitest';
import { readAccessToken, verifyAccess } from '../src/lib/server/access.ts';

const req = (headers: Record<string, string>) => new Request('https://x/', { headers });

describe('readAccessToken', () => {
	it('uses the assertion header when present', () => {
		expect(readAccessToken(req({ 'cf-access-jwt-assertion': 'HEADER_JWT' }))).toBe('HEADER_JWT');
	});

	it('falls back to the CF_Authorization cookie when the header is absent', () => {
		expect(readAccessToken(req({ cookie: 'CF_Authorization=COOKIE_JWT' }))).toBe('COOKIE_JWT');
	});

	it('prefers the header over the cookie', () => {
		const r = req({
			'cf-access-jwt-assertion': 'HEADER_JWT',
			cookie: 'CF_Authorization=COOKIE_JWT'
		});
		expect(readAccessToken(r)).toBe('HEADER_JWT');
	});

	it('finds CF_Authorization among other cookies (with spacing)', () => {
		const r = req({ cookie: 'foo=1; CF_Authorization=COOKIE_JWT; bar=2' });
		expect(readAccessToken(r)).toBe('COOKIE_JWT');
	});

	it('does not match a differently-named cookie that contains the name', () => {
		const r = req({ cookie: 'X_CF_Authorization=nope; CF_Authorization_x=nope' });
		expect(readAccessToken(r)).toBeNull();
	});

	it('returns null when neither header nor cookie is present', () => {
		expect(readAccessToken(req({}))).toBeNull();
		expect(readAccessToken(req({ cookie: 'other=1' }))).toBeNull();
	});

	it('treats an empty CF_Authorization value as absent', () => {
		expect(readAccessToken(req({ cookie: 'CF_Authorization=' }))).toBeNull();
	});
});

describe('verifyAccess — dev bypass production interlock', () => {
	const bare = () => new Request('https://x/'); // no Access JWT

	it('bypasses locally: DEV_ACCESS_BYPASS with WA disabled', async () => {
		expect(await verifyAccess(bare(), { DEV_ACCESS_BYPASS: 'true', WA_ENABLED: 'false' })).toEqual({
			email: 'dev@localhost'
		});
	});

	it('does NOT bypass when WA is enabled (prod), even with the flag set', async () => {
		// Interlock holds: with no JWT and no Access config it falls through to null
		// instead of granting admin — a leaked prod DEV_ACCESS_BYPASS opens nothing.
		expect(
			await verifyAccess(bare(), { DEV_ACCESS_BYPASS: 'true', WA_ENABLED: 'true' })
		).toBeNull();
	});
});
