import { describe, expect, it } from "vitest"
import {
	OFFICIAL_ASSETS,
	reconcileWithRegistry,
	resolveOfficialAsset,
	validateOfficialAsset,
} from "./registry.js"

const TESTNET_USDC_ISSUER =
	"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const TESTNET_USDC_SAC =
	"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
const MAINNET_USDC_ISSUER =
	"GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

describe("registry", () => {
	it("every pinned entry is valid", () => {
		expect(() => OFFICIAL_ASSETS.forEach(validateOfficialAsset)).not.toThrow()
	})

	it("resolves testnet USDC by (code, network) as an open asset", () => {
		const a = resolveOfficialAsset("USDC", "TESTNET")
		expect(a).not.toBeNull()
		expect(a?.issuer).toBe(TESTNET_USDC_ISSUER)
		expect(a?.sac).toBe(TESTNET_USDC_SAC)
		expect(a?.capability).toBe("open")
		expect(a?.authorizer).toBeUndefined()
	})

	it("keeps mainnet USDC distinct from testnet USDC", () => {
		expect(resolveOfficialAsset("USDC", "PUBLIC")?.issuer).toBe(
			MAINNET_USDC_ISSUER,
		)
	})

	it("rejects a spoofed issuer for a curated testnet code", () => {
		expect(() =>
			reconcileWithRegistry(
				{
					assetCode: "USDC",
					assetIssuer: MAINNET_USDC_ISSUER, // wrong issuer for TESTNET
					sac: TESTNET_USDC_SAC,
				},
				"TESTNET",
			),
		).toThrow(/does not match the pinned value/)
	})

	it("rejects a spoofed SAC for a curated testnet code", () => {
		expect(() =>
			reconcileWithRegistry(
				{
					assetCode: "USDC",
					assetIssuer: TESTNET_USDC_ISSUER, // correct issuer…
					sac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", // …wrong SAC (mainnet's)
				},
				"TESTNET",
			),
		).toThrow(/does not match the pinned value/)
	})
})
