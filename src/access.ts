/**
 * Admin authorization via Cloudflare Access (Zero Trust).
 *
 * Ported from coin-reader/functions/_lib/access.ts. The `/admin/*` routes sit
 * behind a Cloudflare Access application; Access authenticates the user at the
 * edge and forwards a signed JWT in `Cf-Access-Jwt-Assertion`. We verify the
 * SIGNATURE here (not just trust the header) — that's what prevents spoofing.
 *
 * FAILS CLOSED: with no team/AUD configured (and no dev bypass), every request
 * is refused. Local dev sets DEV_ACCESS_BYPASS=true in .dev.vars (there is no
 * Access in front of `wrangler dev`).
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { forbidden } from "./lib/http.ts";
import type { Env } from "./types.ts";

export interface AccessIdentity {
  email: string;
}

// One JWKS resolver per team domain, reused across requests in this isolate.
// jose caches the fetched keys internally with a cooldown.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let resolver = jwksCache.get(teamDomain);
  if (!resolver) {
    resolver = createRemoteJWKSet(
      new URL(`${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, resolver);
  }
  return resolver;
}

/**
 * Require a request to be authenticated by Cloudflare Access. Returns the
 * caller's identity, or a 403 Response to return as-is.
 */
export async function requireAccess(
  request: Request,
  env: Env,
): Promise<AccessIdentity | Response> {
  // Local-dev bypass — NEVER set in production. Fails closed unless exactly "true".
  if (env.DEV_ACCESS_BYPASS === "true") return { email: "dev@localhost" };

  const team = env.CF_ACCESS_TEAM_DOMAIN;
  // Comma-separated: the production app's AUD plus (optionally) the AUD of the
  // app guarding preview deployments (see coin-reader/wrangler.toml).
  const aud = (env.CF_ACCESS_AUD ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!team || aud.length === 0) return forbidden("access not configured");

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return forbidden("not signed in");

  try {
    const { payload } = await jwtVerify(token, jwks(team), {
      issuer: team,
      audience: aud,
    });
    const email =
      typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email) return forbidden("no identity");

    const allowed = env.CF_ACCESS_EMAIL_DOMAIN?.toLowerCase();
    if (allowed) {
      const suffix = allowed.startsWith("@") ? allowed : `@${allowed}`;
      if (!email.endsWith(suffix)) return forbidden("email not allowed");
    }
    return { email };
  } catch {
    return forbidden("invalid access token");
  }
}
