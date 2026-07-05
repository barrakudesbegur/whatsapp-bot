/**
 * The index page permanently redirects to the bot's WhatsApp chat (wa.me) when
 * `WA_ME_URL` is configured (wrangler.jsonc vars). While it isn't — e.g. local
 * dev, or until the bot's number is public — the informative page renders
 * instead. 301 on purpose: browsers may cache it, so only set the var once the
 * wa.me link is final.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ platform }) => {
	const waMe = platform?.env?.WA_ME_URL?.trim();
	if (waMe) redirect(301, waMe);
	return {};
};
