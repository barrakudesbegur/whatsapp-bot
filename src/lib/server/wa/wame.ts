/**
 * Resolve the bot's public wa.me chat link with a SINGLE SOURCE OF TRUTH: Meta.
 *
 * The bot already holds WhatsApp credentials (WA_PHONE_NUMBER_ID +
 * WA_ACCESS_TOKEN) to send messages, and the Graph API can return the phone
 * number behind that id — so no repo needs to store the number. Until the Meta
 * setup exists (credentials unset/invalid) this resolves to null and the index
 * redirect falls back gracefully.
 *
 * `WA_ME_URL` remains an explicit override for pinning the link by hand
 * (that's also the only case the index answers with a cacheable 301).
 */

import type { Env } from '../types.ts';

const GRAPH_BASE = 'https://graph.facebook.com';

// Per-isolate cache: one Graph lookup per worker isolate, not per request.
let cached: { url: string | null; at: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

/** The bot's wa.me link, or null when it can't be known yet. */
export async function resolveWaMeUrl(
	env: Env,
	fetcher: typeof fetch = fetch
): Promise<string | null> {
	const override = env.WA_ME_URL?.trim();
	if (override) return override;

	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.url;

	const url = await lookupFromMeta(env, fetcher);
	cached = { url, at: Date.now() };
	return url;
}

/** Test hook: drop the per-isolate cache. */
export function clearWaMeCache(): void {
	cached = null;
}

/**
 * Copy click-to-chat query params from an incoming request onto a resolved
 * wa.me link. wa.me accepts `?text=` (the URL-encoded prefilled message; the
 * number lives in the path) — so the index accepts the same params and
 * forwards them, making this host a drop-in stand-in for wa.me that callers
 * can link without knowing the number. Unknown params are forwarded too
 * (wa.me ignores them); a param already on the target (e.g. a `WA_ME_URL`
 * override carrying its own `text`) is overridden by the caller's.
 */
export function forwardWaMeParams(target: string, incoming: URLSearchParams): string {
	const url = new URL(target);
	for (const [key, value] of incoming) url.searchParams.set(key, value);
	return url.href;
}

async function lookupFromMeta(env: Env, fetcher: typeof fetch): Promise<string | null> {
	const phoneId = env.WA_PHONE_NUMBER_ID?.trim();
	const token = env.WA_ACCESS_TOKEN?.trim();
	if (!phoneId || !token) return null;
	try {
		const version = env.WA_GRAPH_VERSION ?? 'v23.0';
		const res = await fetcher(`${GRAPH_BASE}/${version}/${phoneId}?fields=display_phone_number`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(4000)
		});
		if (!res.ok) {
			console.error('wa.me lookup failed', { status: res.status });
			return null;
		}
		const body = (await res.json()) as { display_phone_number?: unknown };
		if (typeof body.display_phone_number !== 'string') return null;
		// "+34 600 00 00 00" → wa.me wants bare digits.
		const digits = body.display_phone_number.replace(/\D/g, '');
		return digits ? `https://wa.me/${digits}` : null;
	} catch (err) {
		console.error('wa.me lookup threw', err);
		return null;
	}
}
