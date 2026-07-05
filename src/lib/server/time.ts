/** ISO-8601 UTC timestamp — the one format all timestamps are stored in. */
export function nowIso(): string {
	return new Date().toISOString();
}
