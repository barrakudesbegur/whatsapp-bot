/**
 * Live agenda layer of Kudi's KB: the landing site's `events` content
 * collection, exposed as a static JSON endpoint (landing-barrakudes
 * src/pages/events.json.js) and fetched here at answer time — single source
 * of truth, nothing duplicated into this repo. Edge-cached ~15 min; any
 * failure just drops the section from the prompt.
 */

import type { Env } from '../types.ts';

export interface LandingEvent {
	title: string;
	description: string;
	startDate: string;
	endDate: string | null;
	url: string;
	/** Absolute URL of the event poster image (null when the event has none). */
	image?: string | null;
	/** Instagram post URL for the event (null when there is none). */
	instagram?: string | null;
}

export async function fetchEventsSection(
	env: Env,
	fetcher: typeof fetch = fetch
): Promise<string | undefined> {
	const url = env.EVENTS_JSON_URL;
	if (!url || url === 'off') return undefined;
	try {
		const res = await fetcher(url, {
			signal: AbortSignal.timeout(4000),
			cf: { cacheTtl: 900, cacheEverything: true }
		} as RequestInit);
		if (!res.ok) return undefined;
		const body = (await res.json()) as { events?: LandingEvent[] };
		const events = body.events ?? [];
		if (events.length === 0) return undefined;
		const today = new Date().toISOString().slice(0, 10);
		// The feed arrives newest-first. Keep every upcoming event but only the 4
		// most recent past ones: each line costs real prompt tokens (3 URLs), and
		// nobody asks about the agenda of two summers ago.
		const dateOf = (e: LandingEvent) => (e.startDate ?? '').slice(0, 10);
		const upcoming = events.filter((e) => dateOf(e) >= today);
		const recentPast = events.filter((e) => dateOf(e) < today).slice(0, 4);
		return [...upcoming, ...recentPast]
			.slice(0, 12)
			.map((e) => {
				const date = (e.startDate ?? '').slice(0, 10);
				const tag = date >= today ? 'PROPER' : 'passat';
				const extras =
					(e.image ? ` · cartell: ${e.image}` : '') +
					(e.instagram ? ` · instagram: ${e.instagram}` : '');
				return `- [${tag}] ${date} — ${e.title}: ${e.description} (${e.url})${extras}`;
			})
			.join('\n');
	} catch (err) {
		console.error('events feed fetch failed', err);
		return undefined;
	}
}
