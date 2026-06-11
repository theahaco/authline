import { defineConfig } from "@playwright/test"

const PORT = 4173
export default defineConfig({
	testDir: "tests/e2e",
	testMatch: "**/*.spec.ts",
	timeout: 240_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		actionTimeout: 30_000,
	},
	webServer: {
		// Builds the USDC app to dist/, the regulated TLO app to dist/tlo/, and the
		// regulated EURCV app to dist/eurcv/, then serves all from one preview:
		// /app.html, /tlo/app.html, /eurcv/app.html. The EURCV build reuses the SDK
		// + base dist produced by build:e2e:tlo, so it runs vite directly.
		command: `npm run build:e2e:tlo && npx vite build --mode e2e-eurcv --outDir dist/eurcv && npx vite preview --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/app.html`,
		timeout: 240_000,
		reuseExistingServer: !process.env.CI,
	},
})
