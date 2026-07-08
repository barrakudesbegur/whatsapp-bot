/**
 * Abstract outbound message model.
 *
 * Flows produce `OutMessage`s (pure data, no WhatsApp/D1 dependency). The sender
 * (src/wa/sender.ts) turns them into Graph API payloads; tests assert their copy
 * respects WhatsApp's interactive limits. Keeping this abstract is what makes the
 * flow engine unit-testable without any WhatsApp knowledge.
 */

export interface ReplyButton {
	/** Stable id echoed back in the interactive reply (button_reply.id). */
	id: string;
	/** Visible label. WhatsApp caps this at 20 chars. */
	title: string;
}

export interface ListRow {
	id: string;
	/** Row label. WhatsApp caps this at 24 chars. */
	title: string;
	/** Optional secondary line. WhatsApp caps this at 72 chars. */
	description?: string;
}

export type OutMessage =
	| { kind: 'text'; body: string }
	| {
			kind: 'image';
			/** Public https URL Meta downloads the image from (jpg/png). */
			link: string;
			/** Optional caption shown under the image (≤1024 chars). */
			caption?: string;
	  }
	| {
			kind: 'buttons';
			header?: string;
			body: string;
			footer?: string;
			buttons: ReplyButton[];
	  }
	| {
			kind: 'list';
			header?: string;
			body: string;
			footer?: string;
			/** The label of the button that opens the list (≤20 chars). */
			button: string;
			/** Optional section title (≤24 chars); WhatsApp requires ≥1 section. */
			sectionTitle?: string;
			rows: ListRow[];
	  };

// WhatsApp interactive limits (verified against the current Cloud API docs).
// `validateOutMessage` enforces them; applyDecision clamps/degrades any
// model-generated control that doesn't fit.
export const LIMITS = {
	BODY_MAX: 1024,
	CAPTION_MAX: 1024,
	HEADER_MAX: 60,
	FOOTER_MAX: 60,
	MAX_BUTTONS: 3,
	BUTTON_TITLE_MAX: 20,
	MAX_LIST_ROWS: 10,
	LIST_BUTTON_MAX: 20,
	ROW_TITLE_MAX: 24,
	ROW_DESC_MAX: 72,
	SECTION_TITLE_MAX: 24
} as const;

/**
 * Returns a list of human-readable limit violations for an OutMessage. Empty
 * array = valid. Pure; used by tests and (defensively) by the sender.
 */
export function validateOutMessage(msg: OutMessage): string[] {
	const errors: string[] = [];
	const check = (cond: boolean, message: string) => {
		if (!cond) errors.push(message);
	};

	if (msg.kind === 'text') {
		check(msg.body.length > 0, 'text body is empty');
		check(msg.body.length <= LIMITS.BODY_MAX, `text body ${msg.body.length} > ${LIMITS.BODY_MAX}`);
		return errors;
	}

	if (msg.kind === 'image') {
		check(msg.link.startsWith('https://'), `image link "${msg.link}" is not an https URL`);
		if (msg.caption !== undefined)
			check(
				msg.caption.length <= LIMITS.CAPTION_MAX,
				`caption ${msg.caption.length} > ${LIMITS.CAPTION_MAX}`
			);
		return errors;
	}

	check(msg.body.length <= LIMITS.BODY_MAX, `body ${msg.body.length} > ${LIMITS.BODY_MAX}`);
	if (msg.header !== undefined)
		check(
			msg.header.length <= LIMITS.HEADER_MAX,
			`header ${msg.header.length} > ${LIMITS.HEADER_MAX}`
		);
	if (msg.footer !== undefined)
		check(
			msg.footer.length <= LIMITS.FOOTER_MAX,
			`footer ${msg.footer.length} > ${LIMITS.FOOTER_MAX}`
		);

	if (msg.kind === 'buttons') {
		check(
			msg.buttons.length >= 1 && msg.buttons.length <= LIMITS.MAX_BUTTONS,
			`buttons count ${msg.buttons.length} not in 1..${LIMITS.MAX_BUTTONS}`
		);
		const ids = new Set<string>();
		// WhatsApp rejects an interactive whose reply-button titles are not unique
		// (error 131009) — and buildControlMessage assigns unique ids from possibly
		// colliding model titles (two options that clamp to the same 20 chars), so
		// the id check alone can't catch it. Flag it here → the control degrades to
		// a plain text bubble instead of a silently-failed send.
		const titles = new Set<string>();
		for (const b of msg.buttons) {
			check(
				b.title.length <= LIMITS.BUTTON_TITLE_MAX,
				`button title "${b.title}" ${b.title.length} > ${LIMITS.BUTTON_TITLE_MAX}`
			);
			check(b.id.length > 0, 'button id is empty');
			check(!ids.has(b.id), `duplicate button id "${b.id}"`);
			check(!titles.has(b.title), `duplicate button title "${b.title}"`);
			ids.add(b.id);
			titles.add(b.title);
		}
	} else {
		// list
		check(
			msg.button.length <= LIMITS.LIST_BUTTON_MAX,
			`list button "${msg.button}" ${msg.button.length} > ${LIMITS.LIST_BUTTON_MAX}`
		);
		check(
			msg.rows.length >= 1 && msg.rows.length <= LIMITS.MAX_LIST_ROWS,
			`list rows count ${msg.rows.length} not in 1..${LIMITS.MAX_LIST_ROWS}`
		);
		if (msg.sectionTitle !== undefined)
			check(
				msg.sectionTitle.length <= LIMITS.SECTION_TITLE_MAX,
				`section title ${msg.sectionTitle.length} > ${LIMITS.SECTION_TITLE_MAX}`
			);
		const ids = new Set<string>();
		for (const r of msg.rows) {
			check(
				r.title.length <= LIMITS.ROW_TITLE_MAX,
				`row title "${r.title}" ${r.title.length} > ${LIMITS.ROW_TITLE_MAX}`
			);
			if (r.description !== undefined)
				check(
					r.description.length <= LIMITS.ROW_DESC_MAX,
					`row description ${r.description.length} > ${LIMITS.ROW_DESC_MAX}`
				);
			check(r.id.length > 0, 'row id is empty');
			check(!ids.has(r.id), `duplicate row id "${r.id}"`);
			ids.add(r.id);
		}
	}
	return errors;
}
