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
import type { AiMeta } from '../ai/provider.ts';
import type { Store } from '../db/store.ts';
import type { Env } from '../types.ts';
import { nowIso } from '../time.ts';
import { toOutboundPayload } from './wire.ts';

const GRAPH_BASE = 'https://graph.facebook.com';

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
	return msg.kind === 'text' ? 'text' : 'interactive';
}

export class Sender {
	constructor(
		private readonly env: Env,
		private readonly store: Store
	) {}

	private get enabled(): boolean {
		return this.env.WA_ENABLED === 'true';
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

		try {
			const res = await this.postToMeta(payload);
			const body = (await res.json().catch(() => ({}))) as {
				messages?: { id?: string }[];
				error?: unknown;
			};
			if (!res.ok || !body.messages?.[0]?.id) {
				const errorJson = JSON.stringify(body.error ?? body ?? { status: res.status });
				const waMessageId = `failed-${crypto.randomUUID()}`;
				await this.record(
					person.id,
					waMessageId,
					message,
					payload,
					opts,
					aiMetaJson,
					'failed',
					errorJson
				);
				console.error('WA send failed', {
					status: res.status,
					error: body.error
				});
				return { waMessageId, message, status: 'failed' };
			}
			const waMessageId = body.messages[0].id!;
			await this.record(person.id, waMessageId, message, payload, opts, aiMetaJson, 'sent');
			return { waMessageId, message, status: 'sent' };
		} catch (err) {
			const waMessageId = `failed-${crypto.randomUUID()}`;
			await this.record(
				person.id,
				waMessageId,
				message,
				payload,
				opts,
				aiMetaJson,
				'failed',
				JSON.stringify({ message: String(err) })
			);
			console.error('WA send threw', err);
			return { waMessageId, message, status: 'failed' };
		}
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
