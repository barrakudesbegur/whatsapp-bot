/**
 * Meta webhook signature verification.
 *
 * Meta signs the RAW request body with HMAC-SHA256 keyed by the app secret and
 * sends it as `X-Hub-Signature-256: sha256=<hex>`. We MUST verify over the exact
 * bytes we received, BEFORE parsing JSON, and FAIL CLOSED (missing header, wrong
 * length, bad signature, or no configured secret → reject). Uses real WebCrypto.
 */

const encoder = new TextEncoder();

/** Constant-time compare of two equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = '';
	for (const b of bytes) hex += b.toString(16).padStart(2, '0');
	return hex;
}

/** Compute the lowercase hex HMAC-SHA256 of `body` under `secret`. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
	return toHex(sig);
}

/**
 * Verify the `X-Hub-Signature-256` header against the raw body. Fails closed on
 * any anomaly. `header` is the raw header value (e.g. "sha256=abc123...").
 */
export async function verifySignature(
	secret: string | undefined,
	header: string | null,
	rawBody: string
): Promise<boolean> {
	if (!secret) return false;
	if (!header) return false;
	const [scheme, provided] = header.split('=', 2);
	if (scheme !== 'sha256' || !provided) return false;
	const expected = await hmacSha256Hex(secret, rawBody);
	return timingSafeEqualHex(provided.toLowerCase(), expected);
}
