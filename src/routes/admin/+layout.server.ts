import type { LayoutServerLoad } from './$types';

// Auth is enforced in hooks.server.ts (Cloudflare Access), which also sets
// locals.identity. Here we just expose the config the admin UI needs.
export const load: LayoutServerLoad = ({ locals, platform }) => {
	// `wrangler types` narrows vars to their literal (e.g. WA_ENABLED: "false").
	// These are runtime-toggleable, so read them through a widened view.
	const env = platform?.env as { DEV_SIMULATOR?: string; WA_ENABLED?: string } | undefined;
	return {
		email: locals.identity?.email ?? null,
		simulatorEnabled: env?.DEV_SIMULATOR === 'true',
		waEnabled: env?.WA_ENABLED === 'true'
	};
};
