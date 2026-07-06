import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The simulator is dev-only; hide the route entirely when it's off so a
// stray link or bookmark can't reach it.
export const load: PageLoad = async ({ parent }) => {
	const { simulatorEnabled } = await parent();
	if (!simulatorEnabled) error(404, 'Not found');
};
