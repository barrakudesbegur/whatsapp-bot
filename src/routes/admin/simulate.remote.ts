/**
 * Dev-only simulator (PLAN 4.7 / 4.8). Synthesizes a Cloud API webhook and runs
 * the SAME router path as the real webhook — minus the signature check — so the
 * whole flow is drivable without Meta. Guarded by `requireAdmin()` AND the
 * DEV_SIMULATOR switch, so it is inert unless explicitly enabled.
 */

import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { command } from '$app/server';
import { requireAdmin } from '$lib/server/access';
import { getEnv, getDeps } from '$lib/server/bindings';
import { buildSimulatedWebhook, type SimulateInput } from '$lib/server/wa/simulate';
import { handleWebhook } from '$lib/server/router';

const interactive = v.object({
	id: v.string(),
	title: v.optional(v.string()),
	context_wa_message_id: v.string()
});

const SimSchema = v.union([
	v.object({ wa_id: v.string(), name: v.optional(v.string()), text: v.string() }),
	v.object({ wa_id: v.string(), name: v.optional(v.string()), button_reply: interactive }),
	v.object({ wa_id: v.string(), name: v.optional(v.string()), list_reply: interactive })
]);

export const simulate = command(SimSchema, async (input) => {
	await requireAdmin();
	if (getEnv().DEV_SIMULATOR !== 'true') error(404, 'simulator disabled');

	const envelope = buildSimulatedWebhook(input as SimulateInput);
	const sent = await handleWebhook(envelope, getDeps());
	return {
		messages: sent.map((s) => ({
			wa_message_id: s.waMessageId,
			status: s.status,
			message: s.message
		}))
	};
});
