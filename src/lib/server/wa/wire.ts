/**
 * WhatsApp Cloud API wire types + payload builders.
 *
 * Shapes verified against the current official Cloud API docs (Graph v23.0):
 * - inbound webhook: object/entry[]/changes[]/value with `messages[]` and/or
 *   `statuses[]`.
 * - outbound: POST graph.facebook.com/<version>/<phone_number_id>/messages with
 *   `{ messaging_product:"whatsapp", recipient_type:"individual", to, type, ... }`.
 *
 * Only the fields the bot actually reads/writes are typed; everything else is
 * preserved verbatim in D1 `body_json` for the transcript.
 */

import type { OutMessage } from '../messages.ts';

// --- Inbound webhook ------------------------------------------------------

export interface WebhookEnvelope {
	object?: string;
	entry?: WebhookEntry[];
}

export interface WebhookEntry {
	id?: string;
	changes?: WebhookChange[];
}

export interface WebhookChange {
	field?: string;
	value?: WebhookValue;
}

export interface WebhookValue {
	messaging_product?: string;
	metadata?: { display_phone_number?: string; phone_number_id?: string };
	contacts?: WebhookContact[];
	messages?: InboundMessage[];
	statuses?: StatusUpdate[];
}

export interface WebhookContact {
	profile?: { name?: string };
	wa_id?: string;
}

export interface InboundMessage {
	from: string;
	id: string;
	timestamp?: string;
	type: string; // text | interactive | image | audio | video | sticker | document | location | ...
	text?: { body: string };
	interactive?: {
		type: 'button_reply' | 'list_reply' | string;
		button_reply?: { id: string; title: string };
		list_reply?: { id: string; title: string; description?: string };
	};
	/** Present on interactive replies: the outbound message being replied to. */
	context?: { id?: string; from?: string; forwarded?: boolean };
	image?: { id?: string; mime_type?: string; caption?: string };
	audio?: { id?: string; mime_type?: string; voice?: boolean };
	video?: { id?: string; mime_type?: string; caption?: string };
	sticker?: { id?: string; mime_type?: string };
	document?: { id?: string; filename?: string; mime_type?: string };
	location?: { latitude?: number; longitude?: number; name?: string };
	[key: string]: unknown;
}

export interface StatusUpdate {
	id: string;
	status: 'sent' | 'delivered' | 'read' | 'failed' | string;
	timestamp?: string;
	recipient_id?: string;
	errors?: MetaError[];
	[key: string]: unknown;
}

export interface MetaError {
	code?: number;
	title?: string;
	message?: string;
	error_data?: { details?: string };
	[key: string]: unknown;
}

// --- Outbound payload builder --------------------------------------------

export interface OutboundPayload {
	messaging_product: 'whatsapp';
	recipient_type: 'individual';
	to: string;
	type: 'text' | 'interactive';
	text?: { body: string; preview_url?: boolean };
	interactive?: OutboundInteractive;
}

type OutboundInteractive =
	| {
			type: 'button';
			header?: { type: 'text'; text: string };
			body: { text: string };
			footer?: { text: string };
			action: {
				buttons: { type: 'reply'; reply: { id: string; title: string } }[];
			};
	  }
	| {
			type: 'list';
			header?: { type: 'text'; text: string };
			body: { text: string };
			footer?: { text: string };
			action: {
				button: string;
				sections: {
					title?: string;
					rows: { id: string; title: string; description?: string }[];
				}[];
			};
	  };

/** Turn an abstract OutMessage into a Graph API `/messages` request body. */
export function toOutboundPayload(to: string, msg: OutMessage): OutboundPayload {
	const base = {
		messaging_product: 'whatsapp',
		recipient_type: 'individual',
		to
	} as const;

	if (msg.kind === 'text') {
		return {
			...base,
			type: 'text',
			text: { body: msg.body, preview_url: false }
		};
	}

	if (msg.kind === 'buttons') {
		return {
			...base,
			type: 'interactive',
			interactive: {
				type: 'button',
				...(msg.header ? { header: { type: 'text' as const, text: msg.header } } : {}),
				body: { text: msg.body },
				...(msg.footer ? { footer: { text: msg.footer } } : {}),
				action: {
					buttons: msg.buttons.map((b) => ({
						type: 'reply' as const,
						reply: { id: b.id, title: b.title }
					}))
				}
			}
		};
	}

	// list
	return {
		...base,
		type: 'interactive',
		interactive: {
			type: 'list',
			...(msg.header ? { header: { type: 'text' as const, text: msg.header } } : {}),
			body: { text: msg.body },
			...(msg.footer ? { footer: { text: msg.footer } } : {}),
			action: {
				button: msg.button,
				sections: [
					{
						...(msg.sectionTitle ? { title: msg.sectionTitle } : {}),
						rows: msg.rows.map((r) => ({
							id: r.id,
							title: r.title,
							...(r.description ? { description: r.description } : {})
						}))
					}
				]
			}
		}
	};
}
