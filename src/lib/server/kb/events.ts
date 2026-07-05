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
		return events
			.slice(0, 12)
			.map((e) => {
				const date = (e.startDate ?? '').slice(0, 10);
				const tag = date >= today ? 'PROPER' : 'passat';
				return `- [${tag}] ${date} — ${e.title}: ${e.description} (${e.url})`;
			})
			.join('\n');
	} catch (err) {
		console.error('events feed fetch failed', err);
		return undefined;
	}
}
