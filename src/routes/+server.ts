/**
 * The index: nothing to see here — forward straight to the bot's WhatsApp chat.
 *
 * The wa.me target is resolved from Meta at runtime (single source of truth —
 * see $lib/server/wa/wame.ts; `WA_ME_URL` var = manual override). Until the
 * Meta setup exists the resolver returns null and we forward to the
 * association's site instead. Always 302: never let a stale target get stuck
 * in browser caches.
 *
 * The index accepts the same query params as wa.me itself (`?text=` = the
 * prefilled message) and forwards them onto the target, so other sites (e.g.
 * the sardanes landing) can link `wa.barrakudesbegur.org/?text=…` exactly as
 * they would a wa.me link — without ever knowing the number. The params are
 * dropped on the no-Meta fallback: they only mean something to WhatsApp.
 */

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveWaMeUrl, forwardWaMeParams } from '$lib/server/wa/wame';
import type { Env } from '$lib/server/types';

const FALLBACK = 'https://barrakudesbegur.org';

export const GET: RequestHandler = async ({ platform, url }) => {
	const env = (platform?.env ?? {}) as Env;
	const waMe = await resolveWaMeUrl(env);
	redirect(302, waMe ? forwardWaMeParams(waMe, url.searchParams) : FALLBACK);
};
