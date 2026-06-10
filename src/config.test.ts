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
		// Router comes from the pinned registry when PUBLIC_ROUTER is unset.
		const { ROUTERS } = await import("@theaha/authline")
		expect(ASSET.router).toBe(ROUTERS.TESTNET)
		expect(ASSETS[0]).toMatchObject({ code: "USDC", status: "live" })
	})

	it("defaults to the testnet test token (USDC) when PUBLIC_ASSET_CODE is unset on testnet", async () => {
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		// PUBLIC_ASSET_CODE intentionally unset — must NOT fall back to mainnet
		// EURCV (which has no testnet issuer/SAC), but to the pinned testnet token.
		const { ASSET } = await import("./config")
		expect(ASSET.assetCode).toBe("USDC")
		expect(ASSET.sac).toBe(TESTNET_USDC_SAC)
		expect(ASSET.capability).toBe("open")
	})

	it("wires the EURCV-style test token (TLO) as a one-step permissioned asset on testnet", async () => {
		vi.stubEnv("PUBLIC_ASSET_CODE", "TLO")
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		// Only the code is set — sac/authorizer/capability come from the pin.
		const { ASSET } = await import("./config")
		expect(ASSET.assetCode).toBe("TLO")
		expect(ASSET.capability).toBe("permissionedOneStep")
		expect(ASSET.sac).toBe(
			"CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3",
		)
		expect(ASSET.authorizer).toBe(
			"CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
		)
		const { ROUTERS } = await import("@theaha/authline")
		expect(ASSET.router).toBe(ROUTERS.TESTNET)
	})

	it("prefers PUBLIC_ROUTER over the pinned router", async () => {
		vi.stubEnv("PUBLIC_ASSET_CODE", "USDC")
		vi.stubEnv("PUBLIC_ASSET_ISSUER", TESTNET_USDC_ISSUER)
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		vi.stubEnv(
			"PUBLIC_ROUTER",
			"CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
		)
		const { ASSET } = await import("./config")
		expect(ASSET.router).toBe(
			"CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
		)
	})

	it("falls back to empty router and complains loudly when nothing is pinned", async () => {
		vi.stubEnv("PUBLIC_ASSET_CODE", "EURCV")
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Public Global Stellar Network ; September 2015",
		)
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { ASSET } = await import("./config")
		expect(ASSET.router).toBe("")
		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining("no onboard router configured"),
		)
		spy.mockRestore()
	})
})
