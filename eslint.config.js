import { config } from "@theahaco/ts-config/eslint"
import { globalIgnores } from "eslint/config"
import globals from "globals"

/** @type {import("eslint").Linter.Config[]} */
export default [
	globalIgnores([
		"dist",
		// Generated contract-client packages stay ignored, but the hand-written
		// authline SDK is first-class source and must be linted (its build
		// output is not).
		"packages/*",
		"!packages/authline-sdk",
		"packages/authline-sdk/dist",
		"target/packages",
		"src/contracts/*",
		"!src/contracts/util.ts",
		"!src/contracts/assets.ts",
	]),
	...config,
	{
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
			parserOptions: {
				tsconfigRoot: import.meta.dirname,
			},
		},
	},
	{
		files: [
			"**/*.test.ts",
			"tests/**/*.{ts,tsx}",
			"scripts/**/*.mjs",
			"vitest.config.ts",
			"playwright.config.ts",
		],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
]
