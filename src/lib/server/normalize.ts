/**
 * Text normalization for fuzzy trigger/keyword matching: lowercase, strip
 * accents, drop punctuation and emoji, collapse whitespace. Catalan-friendly
 * (accents and the geminated-l middle dot are removed; apostrophes become
 * spaces so "explica'm" -> "explica m").
 */
export function normalizeText(input: string): string {
	return input
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '') // combining diacritics
		.replace(/[^a-z0-9\s]/g, ' ') // punctuation, emoji, symbols -> space
		.replace(/\s+/g, ' ')
		.trim();
}

function tokens(normalized: string): string[] {
	return normalized ? normalized.split(' ') : [];
}

/**
 * Does an inbound message trigger a flow? `trigger` is the raw trigger phrase;
 * `input` is the raw inbound text. Matches when the normalized input equals the
 * trigger, contains it as a substring, or shares at least 70% of the trigger's
 * words (order-independent) — enough to catch "explica'm el curs de sardanes"
 * or a stray emoji while ignoring unrelated chatter.
 */
export function triggerMatches(input: string, trigger: string): boolean {
	const a = normalizeText(input);
	const b = normalizeText(trigger);
	if (!b) return false;
	if (a === b || a.includes(b)) return true;

	const inputSet = new Set(tokens(a));
	const triggerTokens = tokens(b);
	if (triggerTokens.length === 0) return false;
	const present = triggerTokens.filter((t) => inputSet.has(t)).length;
	return present / triggerTokens.length >= 0.7;
}

/** Loose yes/no parse for typed confirmations (accents already stripped). */
export function parseYesNo(input: string): 'yes' | 'no' | null {
	const n = normalizeText(input);
	if (!n) return null;
	const t = new Set(tokens(n));
	const yes = ['si', 'sisi', 'ok', 'okay', 'vale', 'val', 'dacord', 'clar', 'esclar'];
	const no = ['no', 'nop', 'nope', 'cancel', 'cancella'];
	if (yes.some((w) => t.has(w))) return 'yes';
	if (no.some((w) => t.has(w))) return 'no';
	return null;
}
