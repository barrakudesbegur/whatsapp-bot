import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';

// /admin has no content of its own — land on the first tab.
export const load = () => {
	redirect(307, resolve('/admin/converses'));
};
