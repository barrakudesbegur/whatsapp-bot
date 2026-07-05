/**
 * The index: nothing to see here — forward straight to the bot's WhatsApp chat.
 *
 * The wa.me target is resolved from Meta at runtime (single source of truth —
 * see $lib/server/wa/wame.ts; `WA_ME_URL` var = manual override). Until the
 * Meta setup exists the resolver returns null and we forward to the
 * association's site instead. Always 302: never let a stale target get stuck
 * in browser caches.
 */

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveWaMeUrl } from '$lib/server/wa/wame';
import type { Env } from '$lib/server/types';

const FALLBACK = 'https://barrakudesbegur.org';

export const GET: RequestHandler = async ({ platform }) => {
	const env = (platform?.env ?? {}) as Env;
	const waMe = await resolveWaMeUrl(env);
	redirect(302, waMe ?? FALLBACK);
};
