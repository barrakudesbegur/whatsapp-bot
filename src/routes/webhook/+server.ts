/**
 * Meta WhatsApp Cloud API webhook. This is a plain endpoint (NOT a
 * remote function): Meta is an external caller that POSTs its own JSON to a
 * fixed URL and signs it with `X-Hub-Signature-256` over the RAW body, so we
 * need the untouched request. Public — the /admin gate in hooks.server.ts does
 * not apply here.
 */

import type { RequestHandler } from './$types';
import { verifySignature } from '$lib/server/signature';
import { handleWebhook } from '$lib/server/router';
import { getDeps } from '$lib/server/bindings';
import type { WebhookEnvelope } from '$lib/server/wa/wire';

// GET: Meta verification handshake — echo hub.challenge when the token matches.
export const GET: RequestHandler = ({ url, platform }) => {
	const mode = url.searchParams.get('hub.mode');
	const token = url.searchParams.get('hub.verify_token');
	const challenge = url.searchParams.get('hub.challenge');
	if (mode === 'subscribe' && token && token === platform?.env?.WA_VERIFY_TOKEN) {
		return new Response(challenge ?? '', { status: 200 });
	}
	return new Response('forbidden', { status: 403 });
};

// POST: inbound events. Verify the signature over the RAW body BEFORE parsing.
export const POST: RequestHandler = async ({ request, platform }) => {
	const raw = await request.text();
	const signature = request.headers.get('x-hub-signature-256');
	const valid = await verifySignature(platform?.env?.WA_APP_SECRET ?? '', signature, raw);
	if (!valid) return new Response('invalid signature', { status: 403 }); // fail closed

	let envelope: WebhookEnvelope;
	try {
		envelope = JSON.parse(raw) as WebhookEnvelope;
	} catch {
		return new Response('bad request', { status: 400 });
	}

	try {
		await handleWebhook(envelope, getDeps());
	} catch (err) {
		// Never make Meta retry-storm us; inbound is already deduped. Log + 200.
		console.error('webhook processing error', err);
	}
	return new Response('EVENT_RECEIVED', { status: 200 });
};
