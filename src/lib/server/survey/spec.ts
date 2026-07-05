/**
 * Declarative spec for the `curs-sardanes` submission — DATA, not control flow.
 *
 * This replaces the old step state-machine. It describes which fields the survey
 * collects and their canonical option labels, so the decide() prompt can tell the
 * model what's still missing and offer sensible options. The model decides how and
 * when to ask; code derives what's missing and when the draft is complete.
 *
 * Adding a future flow = another spec like this + a branch in survey vocabulary.
 * The durable record stays `flow_instances.data_json = { action, availability,
 * availability_raw? }` so the admin inbox and CSV export are unaffected.
 */

import type { SignupChoice, AvailabilityBucket } from '../ai/decide.ts';

export const SURVEY_ID = 'curs-sardanes';
export const GDPR_FLOW = 'gdpr-erase';

/** Collected answers, mapped to/from data_json. */
export interface SurveyCollected {
	signup: SignupChoice | null;
	availability: string | null;
	availabilityRaw: string | null;
}

export type SurveyStatus = 'none' | 'active' | 'completed' | 'declined';

/** Human labels the prompt renders so the model's questions + options stay on-brand. */
export const SIGNUP_LABELS: Record<SignupChoice, string> = {
	grup: 'Afegeix-me al grup',
	avisam: "Només avisa'm",
	res: 'Res, gràcies'
};

export const AVAILABILITY_LABELS: Record<Exclude<AvailabilityBucket, 'custom'>, string> = {
	dissabtes: 'Dissabtes',
	diumenges: 'Diumenges',
	'entre-setmana': 'Entre setmana',
	depen: 'Depèn del cap de setmana',
	igual: "M'és igual, tot em va bé"
};

/** Parse the stored data_json blob into typed collected answers. */
export function parseCollected(dataJson: string | null | undefined): SurveyCollected {
	let data: Record<string, unknown> = {};
	if (dataJson) {
		try {
			data = JSON.parse(dataJson) as Record<string, unknown>;
		} catch {
			data = {};
		}
	}
	const signup =
		data.action === 'grup' || data.action === 'avisam' || data.action === 'res'
			? (data.action as SignupChoice)
			: null;
	return {
		signup,
		availability: typeof data.availability === 'string' ? data.availability : null,
		availabilityRaw: typeof data.availability_raw === 'string' ? data.availability_raw : null
	};
}

/** Serialize collected answers back to the data_json shape (unchanged for admin/CSV). */
export function toDataJson(c: SurveyCollected): string {
	const out: Record<string, unknown> = {};
	if (c.signup) out.action = c.signup;
	if (c.availability) out.availability = c.availability;
	if (c.availability === 'custom' && c.availabilityRaw) out.availability_raw = c.availabilityRaw;
	return JSON.stringify(out);
}

/**
 * Which fields are still worth asking, in ask order. Name is soft: it's asked for
 * but a person may decline it (→ "Anònim") without blocking completion.
 */
export function deriveMissing(
	c: SurveyCollected,
	displayName: string | null
): ('name' | 'signup' | 'availability')[] {
	const missing: ('name' | 'signup' | 'availability')[] = [];
	if (!displayName) missing.push('name');
	if (!c.signup) missing.push('signup');
	// Availability is moot once they've said "res, gràcies".
	if (c.signup !== 'res' && !c.availability) missing.push('availability');
	return missing;
}

/**
 * Terminal state derived from the draft — CODE owns completion, the model never
 * does. Completed once we know the signup preference and (for group/notify)
 * their availability; "res" is a declined submission.
 */
export function deriveStatus(c: SurveyCollected): SurveyStatus {
	if (c.signup === 'res') return 'declined';
	if (c.signup && c.availability) return 'completed';
	return 'active';
}
