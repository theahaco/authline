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
		// Builds the USDC app to dist/ and the regulated TLO app to dist/tlo/, then
		// serves both from one preview: USDC at /app.html, TLO at /tlo/app.html.
		command: `npm run build:e2e:tlo && npx vite preview --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/app.html`,
		timeout: 240_000,
		reuseExistingServer: !process.env.CI,
	},
})
