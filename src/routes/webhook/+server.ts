/**
 * Meta WhatsApp Cloud API webhook. This is a plain endpoint (NOT a
 * remote function): Meta is an external caller that POSTs its own JSON to a
 * fixed URL and signs it with `X-Hub-Signature-256` over the RAW body, so we
 * need the untouched request. Public — the /admin gate in hooks.server.ts does
 * not apply here.
 */

import type { RequestHandler } from './$types';
import { verifySignature, timingSafeEqual } from '$lib/server/signature';
import { handleWebhook } from '$lib/server/router';
import { getDeps } from '$lib/server/bindings';
import type { WebhookEnvelope } from '$lib/server/wa/wire';

// GET: Meta verification handshake — echo hub.challenge when the token matches.
export const GET: RequestHandler = ({ url, platform }) => {
	const mode = url.searchParams.get('hub.mode');
	const token = url.searchParams.get('hub.verify_token');
	const challenge = url.searchParams.get('hub.challenge');
	const expected = platform?.env?.WA_VERIFY_TOKEN;
	if (mode === 'subscribe' && token && expected && timingSafeEqual(token, expected)) {
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

	// getDeps() reads the request's ALS scope (env + D1), so it MUST be built here,
	// not inside the background task. Nothing downstream calls getRequestEvent().
	const deps = getDeps();
	const work = handleWebhook(envelope, deps).catch((err) => {
		// Never make Meta retry-storm us; the inbound is already deduped. Log + 200.
		console.error('webhook processing error', err);
	});

	// Fast-ack in production: return 200 to Meta immediately and finish the pipeline
	// (the model call + sends) in the background, so a slow turn never delays the ack
	// or risks Meta throttling the webhook. Locally (WA disabled — vite dev, the chat
	// CLI, e2e) there is no background-task budget and the chat CLI reads replies from
	// D1 right after the POST resolves, so AWAIT inline there instead.
	if (platform?.env?.WA_ENABLED === 'true' && platform.ctx?.waitUntil) {
		platform.ctx.waitUntil(work);
	} else {
		await work;
	}
	return new Response('EVENT_RECEIVED', { status: 200 });
};
