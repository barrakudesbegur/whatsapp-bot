/** Small JSON response helpers, mirroring coin-reader/functions/_lib/http.ts. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const badRequest = (message: string): Response =>
  json({ error: message }, 400);
export const notFound = (): Response => json({ error: "not found" }, 404);
export const forbidden = (message: string): Response =>
  json({ error: message }, 403);
