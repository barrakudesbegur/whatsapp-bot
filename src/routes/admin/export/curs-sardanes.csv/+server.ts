/**
 * CSV of completed curs-sardanes surveys. A plain endpoint (browsers download
 * it directly). Guarded by requireAdmin() — the /admin hook gate is
 * defense-in-depth but this reads real data, so it verifies Access itself.
 */

import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/access';
import { getStore } from '$lib/server/bindings';
import { csvRow } from '$lib/server/render';

export const GET: RequestHandler = async () => {
	await requireAdmin();
	const rows = await getStore().exportCompletedFlows('curs-sardanes');
	const header = csvRow([
		'name',
		'wa_id',
		'action',
		'availability',
		'availability_raw',
		'completed_at'
	]);
	const lines = rows.map((r) => {
		let data: { action?: string; availability?: string; availability_raw?: string } = {};
		try {
			data = JSON.parse(r.data_json);
		} catch {
			/* keep empty */
		}
		return csvRow([
			r.display_name ?? r.profile_name ?? '',
			r.wa_id,
			data.action ?? '',
			data.availability ?? '',
			data.availability_raw ?? '',
			r.completed_at ?? ''
		]);
	});
	const csv = [header, ...lines].join('\n') + '\n';
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="curs-sardanes.csv"'
		}
	});
};
