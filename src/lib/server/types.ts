/**
 * The bot core's view of the Worker bindings/vars it needs (a structural subset
 * of SvelteKit's generated `App.Platform['env']`). The SvelteKit layer passes
 * `platform.env` into the framework-agnostic core; tests pass a partial literal.
 */
export interface Env {
	/** The bot's D1 database (schema in migrations/). */
	DB: D1Database;
	/** Workers AI (free-text fallback). */
	AI: Ai;
	/**
	 * Text-generation model id for Kudi's free-text answers. Overrides the
	 * built-in default (see PRIMARY_MODEL) so the model is swappable as config.
	 */
	AI_MODEL?: string;

	/**
	 * Live agenda feed (the landing's events collection as JSON). Unset or
	 * "off" disables the fetch (e.g. in unit tests).
	 */
	EVENTS_JSON_URL?: string;

	// --- Meta WhatsApp Cloud API ---
	/** "true" enables real outbound sends; anything else = log-only no-op. */
	WA_ENABLED?: string;
	/**
	 * The bot's public wa.me chat link (e.g. "https://wa.me/34XXXXXXXXX"). When
	 * set, the index page 301-redirects to it; unset → informative page.
	 */
	WA_ME_URL?: string;
	/** Graph API version segment, e.g. "v23.0". */
	WA_GRAPH_VERSION?: string;
	WA_VERIFY_TOKEN?: string;
	WA_APP_SECRET?: string;
	WA_ACCESS_TOKEN?: string;
	WA_PHONE_NUMBER_ID?: string;

	// --- Local-dev only (never set in production) ---
	/** "true" enables the dev simulator (the Simulador tab + simulate command). */
	DEV_SIMULATOR?: string;
	/**
	 * "true" replaces the model with the deterministic FakeDecider (no Workers AI
	 * neurons spent). Only honored while WA_ENABLED !== "true". The Playwright
	 * webServer sets it (via process env in `vite dev`) so e2e never calls the
	 * real model.
	 */
	DEV_FAKE_AI?: string;
}
