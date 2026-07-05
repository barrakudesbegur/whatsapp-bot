/**
 * Inbox admin data (PLAN 4.7) as SvelteKit remote functions — the type-safe
 * replacement for the old hand-written `/admin/api/*` Hono routes + fetch client.
 *
 * SECURITY: every function calls `requireAdmin()` first. The /admin hook gate
 * does NOT reliably cover remote-function requests (their URL reflects the
 * calling page), so this in-function check is the real guard.
 */

import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { query, command } from '$app/server';
import { requireAdmin } from '$lib/server/access';
import { getStore, getDeps } from '$lib/server/bindings';
import { renderMessage } from '$lib/server/render';
import { nowIso } from '$lib/server/time';

const WINDOW_MS = 24 * 60 * 60 * 1000;

function windowOpen(lastInboundAt: string | null): boolean {
	return lastInboundAt != null && Date.now() - Date.parse(lastInboundAt) < WINDOW_MS;
}

// --- Conversations --------------------------------------------------------

export const conversations = query(async () => {
	await requireAdmin();
	const store = getStore();
	return (await store.listConversations()).map((cv) => ({
		id: cv.person.id,
		name: cv.person.display_name || cv.person.profile_name || cv.person.wa_id,
		waId: cv.person.wa_id,
		gdprDeleted: cv.person.gdpr_deleted === 1,
		lastMessageAt: cv.lastMessageAt,
		windowOpen: windowOpen(cv.person.last_inbound_at),
		flowStatus: cv.flowStatus,
		flowType: cv.flowType
	}));
});

export const conversation = query(v.number(), async (id) => {
	await requireAdmin();
	const store = getStore();
	const person = await store.getPerson(id);
	if (!person) error(404, 'not found');
	const rows = await store.listMessagesForPerson(id);
	return {
		person: {
			id: person.id,
			name: person.display_name || person.profile_name || person.wa_id,
			waId: person.wa_id,
			gdprDeleted: person.gdpr_deleted === 1,
			windowOpen: windowOpen(person.last_inbound_at)
		},
		messages: rows.map(renderMessage)
	};
});

export const reply = command(
	v.object({ personId: v.number(), text: v.pipe(v.string(), v.trim(), v.nonEmpty()) }),
	async ({ personId, text }) => {
		await requireAdmin();
		const deps = getDeps();
		const person = await deps.store.getPerson(personId);
		if (!person || person.gdpr_deleted === 1) error(404, 'not found');
		// 24h customer-service window: free-form replies are only allowed within it.
		if (!windowOpen(person.last_inbound_at)) error(409, 'window_closed');
		const [sent] = await deps.sender.send(person, [{ kind: 'text', body: text }]);
		await conversation(personId).refresh();
		return { status: sent?.status ?? 'logged' };
	}
);

export const erasePerson = command(v.number(), async (personId) => {
	await requireAdmin();
	const store = getStore();
	const person = await store.getPerson(personId);
	if (!person) error(404, 'not found');
	await store.anonymizePerson(personId, nowIso());
	await conversations().refresh();
	return { erased: true };
});

// --- Knowledge base -------------------------------------------------------

export const kbEntries = query(async () => {
	await requireAdmin();
	return getStore().listKbEntries(false);
});

export const saveKb = command(
	v.object({
		slug: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9-]+$/, 'slug must be kebab-case')),
		title: v.pipe(v.string(), v.trim(), v.nonEmpty('title required')),
		content_md: v.optional(v.string(), ''),
		active: v.optional(v.boolean(), true)
	}),
	async ({ slug, title, content_md, active }) => {
		await requireAdmin();
		const entry = await getStore().upsertKbEntry({
			slug,
			title,
			contentMd: content_md,
			active,
			at: nowIso()
		});
		await kbEntries().refresh();
		return entry;
	}
);

export const deleteKb = command(v.number(), async (id) => {
	await requireAdmin();
	const deleted = await getStore().deleteKbEntry(id);
	await kbEntries().refresh();
	return { deleted };
});

// --- Settings (course status) ---------------------------------------------

export const settings = query(async () => {
	await requireAdmin();
	const store = getStore();
	return {
		course_status: (await store.getSetting('course_status')) ?? 'exploring',
		course_status_note: (await store.getSetting('course_status_note')) ?? ''
	};
});

export const saveSettings = command(
	v.object({
		course_status: v.picklist(['exploring', 'confirmed', 'cancelled']),
		course_status_note: v.optional(v.string(), '')
	}),
	async ({ course_status, course_status_note }) => {
		await requireAdmin();
		const store = getStore();
		const at = nowIso();
		await store.setSetting('course_status', course_status, at);
		await store.setSetting('course_status_note', course_status_note, at);
		await settings().refresh();
		return { course_status, course_status_note };
	}
);
