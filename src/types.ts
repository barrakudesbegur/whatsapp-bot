/**
 * Worker bindings, secrets and vars. See wrangler.jsonc (vars) and .dev.vars
 * (secrets + local-only dev switches).
 */
export interface Env {
  /** The bot's D1 database (schema in migrations/). */
  DB: D1Database;
  /** Workers AI — declared now, wired by the AI-fallback stage. */
  AI: Ai;
  /** Static assets (the /admin SPA). */
  ASSETS: Fetcher;

  // --- Cloudflare Access (admin gate) ---
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_EMAIL_DOMAIN?: string;

  // --- Meta WhatsApp Cloud API ---
  /** "true" enables real outbound sends; anything else = log-only no-op. */
  WA_ENABLED?: string;
  /** Graph API version segment, e.g. "v23.0". */
  WA_GRAPH_VERSION?: string;
  WA_VERIFY_TOKEN?: string;
  WA_APP_SECRET?: string;
  WA_ACCESS_TOKEN?: string;
  WA_PHONE_NUMBER_ID?: string;

  // --- Local-dev only (never set in production) ---
  /** "true" exposes POST /dev/simulate. */
  DEV_SIMULATOR?: string;
  /** "true" lets /admin/api/* through without an Access JWT. */
  DEV_ACCESS_BYPASS?: string;
}
