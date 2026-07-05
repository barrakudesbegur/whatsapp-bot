/**
 * Admin authorization via Cloudflare Access (Zero Trust). Ported from
 * coin-reader. The /admin section sits behind a Cloudflare Access application;
 * Access authenticates at the edge and forwards a signed JWT in
 * `Cf-Access-Jwt-Assertion`. We verify the SIGNATURE here (not just trust the
 * header) — that's what prevents spoofing.
 *
 * SECURITY NOTE (SvelteKit): the `handle` hook's `event.url` reflects the
 * *calling page* for remote-function requests and must not be used for
 * authorization. So every admin remote function / endpoint calls `requireAdmin()`
 * itself — it reads the real request headers via `getRequestEvent()` and fails
 * closed. The hook gate on /admin pages is defense-in-depth.
 *
 * Local dev sets DEV_ACCESS_BYPASS=true in .dev.vars (there is no Access in
 * front of `vite dev`).
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';

/** The subset of `platform.env` this module reads (generated Env is a superset). */
export interface AccessEnv {
	DEV_ACCESS_BYPASS?: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	CF_ACCESS_AUD?: string;
	CF_ACCESS_EMAIL_DOMAIN?: string;
}

export interface AccessIdentity {
	email: string;
}

// One JWKS resolver per team domain, reused across requests in this isolate.
// jose caches the fetched keys internally with a cooldown.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
	let resolver = jwksCache.get(teamDomain);
	if (!resolver) {
		resolver = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
		jwksCache.set(teamDomain, resolver);
	}
	return resolver;
}

/**
 * Resolve the caller's identity, or null when the request is not authorized.
 * Fails closed.
 */
export async function verifyAccess(
	request: Request,
	env: AccessEnv | undefined
): Promise<AccessIdentity | null> {
	// Local-dev bypass — NEVER set in production. Fails closed unless exactly "true".
	if (env?.DEV_ACCESS_BYPASS === 'true') return { email: 'dev@localhost' };

	const team = env?.CF_ACCESS_TEAM_DOMAIN;
	// Comma-separated: the production app's AUD plus (optionally) the preview app's.
	const aud = (env?.CF_ACCESS_AUD ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!team || aud.length === 0) return null;

	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) return null;

	try {
		const { payload } = await jwtVerify(token, jwks(team), {
			issuer: team,
			audience: aud
		});
		const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
		if (!email) return null;

		const allowed = env?.CF_ACCESS_EMAIL_DOMAIN?.toLowerCase();
		if (allowed) {
			const suffix = allowed.startsWith('@') ? allowed : `@${allowed}`;
			if (!email.endsWith(suffix)) return null;
		}
		return { email };
	} catch {
		return null;
	}
}

/**
 * Authorize the current request inside a remote function / server load / +server
 * handler. Throws a 403 unless Cloudflare Access verifies the caller (or
 * DEV_ACCESS_BYPASS locally). This is the primary guard for admin data — do NOT
 * rely on the hook alone.
 */
export async function requireAdmin(): Promise<AccessIdentity> {
	const { request, platform } = getRequestEvent();
	const identity = await verifyAccess(request, platform?.env as AccessEnv | undefined);
	if (!identity) error(403, 'No tens accés a aquesta zona.');
	return identity;
}
