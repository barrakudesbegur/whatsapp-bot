import { error, type Handle } from '@sveltejs/kit';
import { verifyAccess, type AccessEnv } from '$lib/server/access';

/**
 * Gate everything under /admin behind Cloudflare Access. `/webhook` and the
 * public info page stay open. Fails closed: a 403 unless Access verifies the
 * request (or DEV_ACCESS_BYPASS locally). The verified identity is stashed on
 * `event.locals` for the page load.
 *
 * NOTE: this is a defense-in-depth gate for admin *page* navigations. Admin data
 * lives in remote functions / +server endpoints, whose requests do NOT reliably
 * carry the /admin pathname here — each of those calls `requireAdmin()` itself.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const p = event.url.pathname;
	if (p === '/admin' || p.startsWith('/admin/')) {
		const env = event.platform?.env as AccessEnv | undefined;
		const identity = await verifyAccess(event.request, env);
		if (!identity) error(403, 'No tens accés a aquesta zona.');
		event.locals.identity = identity;
	}
	return resolve(event);
};
