import { test, expect, type Page } from '@playwright/test';

// The dev server runs with DEV_ACCESS_BYPASS=true and DEV_SIMULATOR=true
// (.dev.vars), so /admin is reachable and the Simulador drives the real router
// (via the simulate remote command) against the local D1.

// Wait for client hydration before interacting — otherwise early clicks land
// before SvelteKit wires up the onclick handlers.
async function gotoHydrated(page: Page, path: string) {
	await page.goto(path);
	await page.locator('html[data-hydrated="true"]').waitFor();
}

async function send(page: Page, text: string) {
	await page.getByRole('textbox', { name: 'Escriu un missatge…' }).fill(text);
	await page.getByRole('button', { name: 'Envia' }).click();
}

test.describe('/admin inbox (SvelteKit remote functions)', () => {
	test('the Simulador drives a full survey and it shows under Converses', async ({ page }) => {
		await gotoHydrated(page, '/admin');
		await expect(page.getByRole('heading', { name: "Panell d'en Kudi" })).toBeVisible();

		// The Simulador starts as a brand-new random person on every load, so runs
		// don't collide via the shared local D1. A unique display name (typed in
		// the chat itself) keeps the Converses lookup exact.
		await page.getByRole('link', { name: 'Simulador' }).click();
		await expect(page.getByText('Persona nova (346')).toBeVisible();
		const name = 'Berta' + Date.now().toString().slice(-8);

		// Trigger → K1 (name question)
		await send(page, "Explica'm això del curs de sardanes");
		await expect(page.getByText('com vols que et digui?')).toBeVisible();

		// Name → K2 info + K3 buttons
		await send(page, name);
		await expect(page.getByText(`Genial, ${name}!`)).toBeVisible();
		const groupBtn = page.getByRole('button', { name: 'Afegeix-me al grup' });
		await expect(groupBtn).toBeEnabled();

		// Tap a button (interactive reply via context.id) → K4 availability list
		await groupBtn.click();
		const dissabtes = page.getByRole('button', { name: 'Dissabtes' });
		await expect(dissabtes).toBeVisible();

		// Tap a list row → K5 close (survey completed)
		await dissabtes.click();
		await expect(page.getByText(`Doncs ja està, ${name}!`)).toBeVisible();

		// The completed conversation appears under Converses with the badge.
		await page.getByRole('link', { name: 'Converses' }).click();
		const item = page.getByRole('button', { name: new RegExp(`${name}.*completed`) });
		await expect(item).toBeVisible();

		// Open it → the transcript renders the whole survey + an open reply box.
		await item.click();
		await expect(page.getByRole('heading', { name })).toBeVisible();
		await expect(page.getByText('Última pregunteta')).toBeVisible();
		await expect(page.getByRole('textbox', { name: 'Respon com en Kudi…' })).toBeVisible();
	});

	test('Coneixement loads the course status and KB', async ({ page }) => {
		await gotoHydrated(page, '/admin');
		await page.getByRole('link', { name: 'Coneixement' }).click();
		await expect(page.getByRole('heading', { name: 'Estat del curs' })).toBeVisible();
		await expect(page.getByRole('combobox')).toBeVisible();
		await expect(page.getByRole('heading', { name: /Entrades \(/ })).toBeVisible();
	});
});
