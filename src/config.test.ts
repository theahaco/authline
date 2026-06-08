import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const TESTNET_USDC_ISSUER =
	"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const TESTNET_USDC_SAC =
	"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

describe("config — testnet USDC (env-driven)", () => {
	beforeEach(() => {
		vi.resetModules()
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("resolves USDC as the live, open asset on testnet", async () => {
		vi.stubEnv("PUBLIC_ASSET_CODE", "USDC")
		vi.stubEnv("PUBLIC_ASSET_ISSUER", TESTNET_USDC_ISSUER)
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		// PUBLIC_SAC intentionally unset — must fall back to the pinned registry SAC.

		const { ASSET, ASSETS } = await import("./config")

		expect(ASSET.assetCode).toBe("USDC")
		expect(ASSET.assetIssuer).toBe(TESTNET_USDC_ISSUER)
		expect(ASSET.sac).toBe(TESTNET_USDC_SAC) // from the pinned registry entry
		expect(ASSET.capability).toBe("open")
		expect(ASSET.authorizer).toBe("")
		expect(ASSETS[0]).toMatchObject({ code: "USDC", status: "live" })
	})
})
