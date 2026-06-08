import { describe, expect, it } from "vitest"
import { OFFICIAL_ASSETS } from "./registry.js"

describe("registry smoke", () => {
	it("exposes the pinned assets array", () => {
		expect(Array.isArray(OFFICIAL_ASSETS)).toBe(true)
		expect(OFFICIAL_ASSETS.length).toBeGreaterThan(0)
	})
})
