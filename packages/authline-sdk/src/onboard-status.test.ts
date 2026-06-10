import { describe, expect, it } from "vitest"
import { xdr } from "@stellar/stellar-sdk"
import { decodeOnboardStatus } from "./onboard-status.js"

// A #[contracttype] unit enum comes back as a single-symbol vec.
const vec = (s: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(s)])

describe("decodeOnboardStatus", () => {
	it("decodes the unit-enum vec shape", () => {
		expect(decodeOnboardStatus(vec("Authorized"))).toBe("Authorized")
		expect(decodeOnboardStatus(vec("TrustlineOnly"))).toBe("TrustlineOnly")
	})

	it("decodes a bare symbol shape", () => {
		expect(decodeOnboardStatus(xdr.ScVal.scvSymbol("TrustlineOnly"))).toBe(
			"TrustlineOnly",
		)
	})

	it("returns null when there is no return value", () => {
		expect(decodeOnboardStatus(null)).toBeNull()
		expect(decodeOnboardStatus(undefined)).toBeNull()
	})

	it("returns null for an unrecognized value", () => {
		expect(decodeOnboardStatus(xdr.ScVal.scvI32(7))).toBeNull()
		expect(decodeOnboardStatus(vec("Nonsense"))).toBeNull()
	})
})
