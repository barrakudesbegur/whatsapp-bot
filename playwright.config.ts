import { defineConfig, devices } from '@playwright/test';

// Non-default port so this can run alongside other local dev servers.
const PORT = 5193;

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}',
	// Cold `vite dev` boots + the local D1 settling can race the first test.
	retries: process.env.CI ? 2 : 1,
	use: {
		baseURL: `http://localhost:${PORT}`,
		...devices['Desktop Chrome']
	},
	// `vite dev` gives the emulated Cloudflare platform (local D1 + AI bindings)
	// via the adapter's platformProxy. `.dev.vars` enables DEV_SIMULATOR +
	// DEV_ACCESS_BYPASS, so /admin is reachable and the Simulador works. Migrations
	// are applied first. DEV_FAKE_AI swaps the model for the deterministic
	// FakeDecider: e2e runs spend no Workers AI neurons and never flake on model
	// output.
	webServer: {
		command: `npm run db:apply:local && npx vite dev --port ${PORT} --strictPort`,
		port: PORT,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: { DEV_FAKE_AI: 'true' }
	}
});
