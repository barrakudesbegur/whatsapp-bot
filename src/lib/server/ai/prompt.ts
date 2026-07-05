/**
 * Knowledge-base assembly for Kudi's prompt. Pure, unit-tested without a model.
 *
 * `buildKbBlock` folds the static KB, the organiser-editable `kb_entries`, the
 * course status setting and the live events feed into one Catalan CONEIXEMENT
 * block. `decide-prompt.ts` embeds it in the system prompt so every answer is
 * grounded in curated knowledge (the model is told to answer ONLY from it).
 */

export interface KbBlockInput {
	staticKb: string;
	dynamicEntries: { title: string; content: string }[];
	courseStatus: string;
	courseStatusNote: string;
	/** Formatted agenda lines fetched live from the landing (may be undefined). */
	eventsSection?: string;
}

const COURSE_STATUS_CA: Record<string, string> = {
	exploring: 'encara és només una idea; estem mirant si hi ha prou gent interessada',
	confirmed: 'CONFIRMAT: el curs es farà!',
	cancelled: 'descartat: de moment no es farà'
};

export function buildKbBlock(i: KbBlockInput): string {
	const parts: string[] = ['## CONEIXEMENT\n' + i.staticKb.trim()];

	if (i.dynamicEntries.length > 0) {
		parts.push('## MÉS CONEIXEMENT (actualitzat pels organitzadors)');
		for (const e of i.dynamicEntries) parts.push(`### ${e.title}\n${e.content.trim()}`);
	}

	const statusCa = COURSE_STATUS_CA[i.courseStatus] ?? i.courseStatus;
	parts.push(
		'## ESTAT ACTUAL DEL CURS DE SARDANES\n' +
			statusCa +
			(i.courseStatusNote ? ` — ${i.courseStatusNote}` : '')
	);

	if (i.eventsSection) {
		parts.push(
			'## AGENDA DELS BARRAKUDES (de barrakudesbegur.org; PROPER = encara ha de passar)\n' +
				i.eventsSection
		);
	}

	return parts.join('\n\n');
}
