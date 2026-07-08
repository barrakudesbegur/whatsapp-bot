/**
 * Outbound sender.
 *
 * Every outbound message is recorded in D1 (direction 'out', full Graph API
 * payload in body_json, flow_instance_id attribution) REGARDLESS of whether it
 * actually hits Meta:
 *  - WA_ENABLED !== "true"  → log-only: record with a fake `local-<uuid>`
 *    wa_message_id and succeed (the whole system is testable via the simulator).
 *  - WA_ENABLED === "true"  → POST to the Graph API; record the real wa_message_id
 *    Meta returns (status 'sent'), or the error payload on failure (status 'failed').
 *
 * The returned SentMessage[] carries each message's wa_message_id so the
 * simulator can render the conversation and reply to interactive messages via
 * context.id.
 */

import type { OutMessage } from '../messages.ts';
import type { AiMeta } from '../ai/decide.ts';
import type { Store } from '../db/store.ts';
import type { Env } from '../types.ts';
import { nowIso } from '../time.ts';
import { toOutboundPayload, toTypingPayload } from './wire.ts';

const GRAPH_BASE = 'https://graph.facebook.com';

// One transient-failure retry for outbound sends. WhatsApp occasionally loses a
// send to a 429/5xx/network blip, and because the inbound is already deduped
// nothing re-triggers a dropped reply — the person sees "typing…" then silence.
// Sends are NOT idempotent (the Cloud API has no idempotency key), so a retry
// after a lost-but-accepted response can duplicate a bubble: an accepted tradeoff
// (a rare duplicate beats losing the reply). App-level rate limits (HTTP 400 +
// code 130429/131056) are deliberately NOT retried here — they need throttling,
// not an immediate retry (that is the separate per-sender budget guard's job).
const MAX_SEND_ATTEMPTS = 2;
const RETRY_BASE_MS = 500;

function isTransient(status: number): boolean {
	return status === 429 || status >= 500;
}

function retryDelayMs(res: Response, attempt: number): number {
	const retryAfter = Number(res.headers.get('retry-after'));
	if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 2000);
	return RETRY_BASE_MS * attempt;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SentMessage {
	waMessageId: string;
	message: OutMessage;
	status: 'sent' | 'logged' | 'failed';
}

export interface SendOptions {
	flowInstanceId?: number | null;
	aiMeta?: AiMeta | null;
}

function msgType(msg: OutMessage): string {
	if (msg.kind === 'text') return 'text';
	if (msg.kind === 'image') return 'image';
	return 'interactive';
}

export class Sender {
	constructor(
		private readonly env: Env,
		private readonly store: Store
	) {}

	private get enabled(): boolean {
		return this.env.WA_ENABLED === 'true';
	}

	/**
	 * Mark an inbound message as read + show the typing indicator ("typing…",
	 * up to ~25s or until the reply lands). Called right before the model call so
	 * the person sees Kudi thinking instead of silence. Best-effort: a no-op while
	 * WA is disabled, never throws, and is NOT recorded in D1 (it's a status
	 * signal, not a message).
	 */
	async typing(inboundWaMessageId: string): Promise<void> {
		if (!this.enabled) return;
		try {
			const res = await this.postToMeta(toTypingPayload(inboundWaMessageId));
			if (!res.ok) {
				console.error('WA typing indicator failed', {
					status: res.status,
					body: await res.text().catch(() => '')
				});
			}
		} catch (err) {
			console.error('WA typing indicator threw', err);
		}
	}

	async send(
		person: { id: number; wa_id: string },
		messages: OutMessage[],
		opts: SendOptions = {}
	): Promise<SentMessage[]> {
		const out: SentMessage[] = [];
		for (const message of messages) {
			out.push(await this.sendOne(person, message, opts));
		}
		return out;
	}

	private async sendOne(
		person: { id: number; wa_id: string },
		message: OutMessage,
		opts: SendOptions
	): Promise<SentMessage> {
		const payload = toOutboundPayload(person.wa_id, message);
		const aiMetaJson = opts.aiMeta ? JSON.stringify(opts.aiMeta) : null;

		if (!this.enabled) {
			const waMessageId = `local-${crypto.randomUUID()}`;
			await this.record(person.id, waMessageId, message, payload, opts, aiMetaJson, 'logged');
			return { waMessageId, message, status: 'logged' };
		}

		let lastError = JSON.stringify({ status: 0 });
		let lastStatus = 0;
		for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
			try {
				const res = await this.postToMeta(payload);
				const body = (await res.json().catch(() => ({}))) as {
					messages?: { id?: string }[];
					error?: { code?: number; message?: string };
				};
				if (res.ok && body.messages?.[0]?.id) {
					const waMessageId = body.messages[0].id;
					await this.record(person.id, waMessageId, message, payload, opts, aiMetaJson, 'sent');
					return { waMessageId, message, status: 'sent' };
				}
				lastError = JSON.stringify(body.error ?? body ?? { status: res.status });
				lastStatus = res.status;
				if (attempt < MAX_SEND_ATTEMPTS && isTransient(res.status)) {
					await sleep(retryDelayMs(res, attempt));
					continue;
				}
				break; // non-retryable, or out of attempts
			} catch (err) {
				// Network throw — retry if attempts remain, else fail.
				lastError = JSON.stringify({ message: String(err) });
				lastStatus = 0;
				if (attempt < MAX_SEND_ATTEMPTS) {
					await sleep(RETRY_BASE_MS * attempt);
					continue;
				}
			}
		}
		const waMessageId = `failed-${crypto.randomUUID()}`;
		await this.record(
			person.id,
			waMessageId,
			message,
			payload,
			opts,
			aiMetaJson,
			'failed',
			lastError
		);
		console.error('WA send failed', { status: lastStatus, error: lastError });
		return { waMessageId, message, status: 'failed' };
	}

	private async postToMeta(payload: unknown): Promise<Response> {
		const version = this.env.WA_GRAPH_VERSION ?? 'v23.0';
		const phoneId = this.env.WA_PHONE_NUMBER_ID;
		const url = `${GRAPH_BASE}/${version}/${phoneId}/messages`;
		return await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.env.WA_ACCESS_TOKEN ?? ''}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});
	}

	private async record(
		personId: number,
		waMessageId: string,
		_message: OutMessage,
		payload: unknown,
		opts: SendOptions,
		aiMetaJson: string | null,
		status: string,
		errorJson: string | null = null
	): Promise<void> {
		const row = await this.store.insertOutboundMessage({
			waMessageId,
			personId,
			msgType: msgType(_message),
			bodyJson: JSON.stringify(payload),
			flowInstanceId: opts.flowInstanceId ?? null,
			aiMetaJson,
			status,
			createdAt: nowIso()
		});
		if (errorJson) {
			await this.store.updateOutboundStatus(waMessageId, status, errorJson, nowIso());
		}
		void row;
	}
}
