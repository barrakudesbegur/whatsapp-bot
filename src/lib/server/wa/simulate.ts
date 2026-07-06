/**
 * Simulator → webhook synthesizer.
 *
 * Builds a realistic Cloud API webhook envelope from a compact simulator request
 * so `/dev/simulate` can drive the SAME router code path (minus the signature
 * check) without Meta. The client renders the conversation from the outbound
 * messages the router returns, and replies to interactive messages by echoing
 * the previous outbound wa_message_id as `context_wa_message_id`.
 */

import type { WebhookEnvelope, InboundMessage } from './wire.ts';

export interface SimulateText {
	wa_id: string;
	name?: string;
	text: string;
}

export interface SimulateButton {
	wa_id: string;
	name?: string;
	button_reply: { id: string; title?: string; context_wa_message_id: string };
}

export interface SimulateList {
	wa_id: string;
	name?: string;
	list_reply: { id: string; title?: string; context_wa_message_id: string };
}

export type SimulateInput = SimulateText | SimulateButton | SimulateList;

export function isSimulateInput(v: unknown): v is SimulateInput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o.wa_id !== 'string' || o.wa_id.length === 0) return false;
	if (typeof o.text === 'string') return true;
	if (
		typeof o.button_reply === 'object' &&
		o.button_reply !== null &&
		typeof (o.button_reply as Record<string, unknown>).id === 'string' &&
		typeof (o.button_reply as Record<string, unknown>).context_wa_message_id === 'string'
	)
		return true;
	if (
		typeof o.list_reply === 'object' &&
		o.list_reply !== null &&
		typeof (o.list_reply as Record<string, unknown>).id === 'string' &&
		typeof (o.list_reply as Record<string, unknown>).context_wa_message_id === 'string'
	)
		return true;
	return false;
}

export function buildSimulatedWebhook(input: SimulateInput): WebhookEnvelope {
	const waId = input.wa_id;
	const now = Math.floor(Date.now() / 1000).toString();
	const id = `sim-${crypto.randomUUID()}`;

	let message: InboundMessage;
	if ('text' in input) {
		message = {
			from: waId,
			id,
			timestamp: now,
			type: 'text',
			text: { body: input.text }
		};
	} else if ('button_reply' in input) {
		const br = input.button_reply;
		message = {
			from: waId,
			id,
			timestamp: now,
			type: 'interactive',
			interactive: {
				type: 'button_reply',
				button_reply: { id: br.id, title: br.title ?? br.id }
			},
			context: { id: br.context_wa_message_id }
		};
	} else {
		const lr = input.list_reply;
		message = {
			from: waId,
			id,
			timestamp: now,
			type: 'interactive',
			interactive: {
				type: 'list_reply',
				list_reply: { id: lr.id, title: lr.title ?? lr.id }
			},
			context: { id: lr.context_wa_message_id }
		};
	}

	return {
		object: 'whatsapp_business_account',
		entry: [
			{
				id: 'sim-entry',
				changes: [
					{
						field: 'messages',
						value: {
							messaging_product: 'whatsapp',
							metadata: {
								display_phone_number: '000000000',
								phone_number_id: 'SIMULATOR'
							},
							contacts: [
								input.name ? { profile: { name: input.name }, wa_id: waId } : { wa_id: waId }
							],
							messages: [message]
						}
					}
				]
			}
		]
	};
}
