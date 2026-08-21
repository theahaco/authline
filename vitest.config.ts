import { fileURLToPath } from "url"
import { defineConfig } from "vitest/config"

const root = fileURLToPath(new URL(".", import.meta.url))

// Alias the workspace SDK to its TS source so unit tests run without a build.
// (Vite resolves the SDK's internal `./x.js` specifiers to the `.ts` sources.)
export default defineConfig({
	resolve: {
		alias: {
			"@theahaco/authline-relayer": `${root}packages/relayer/src/server.ts`,
			"@theahaco/authline": `${root}packages/authline-sdk/src/index.ts`,
		},
	},
	test: {
		environment: "node",
		include: [
			"src/**/*.test.ts",
			"packages/**/src/**/*.test.ts",
			"tests/e2e/**/*.e2e.test.ts",
		],
		exclude: ["node_modules/**", "dist/**"],
	},
})
