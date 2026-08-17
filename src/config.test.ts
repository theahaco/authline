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
		const { ROUTERS } = await import("@theahaco/authline")
		expect(ASSET.router).toBe(ROUTERS.TESTNET)
		expect(ASSETS[0]).toMatchObject({ code: "USDC", status: "live" })
	})

	it("exposes every registry-pinned testnet asset as LIVE with no env at all (hosted-build config)", async () => {
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		// The hosted Pages build sets no PUBLIC_ASSET_* env: the directory must
		// still offer every pinned asset — EURCV must NOT render as "soon".
		const { ASSET, ASSETS, LIVE_ASSETS } = await import("./config")
		const liveCodes = LIVE_ASSETS.map((a) => a.assetCode)
		expect(liveCodes).toContain("USDC")
		expect(liveCodes).toContain("TLO")
		expect(liveCodes).toContain("EURCV")
		expect(liveCodes).toContain("EURC")
		expect(liveCodes).toContain("BLND")
		// EURC went live → it must no longer appear as a roadmap "soon" tile.
		expect(
			ASSETS.filter((t) => t.code === "EURC").map((t) => t.status),
		).toEqual(["live"])
		// The env/default asset stays the default selection (first).
		expect(LIVE_ASSETS[0]).toBe(ASSET)
		const eurcvTile = ASSETS.find((t) => t.code === "EURCV")
		expect(eurcvTile?.status).toBe("live")
		// EURC and EURCV must not share a glyph (both are "EU" by prefix).
		expect(eurcvTile?.glyph).toBe("EV")
		expect(ASSETS.find((t) => t.code === "EURC")?.glyph).toBe("EC")
		// A live pinned asset is fully wired straight from the registry.
		const eurcv = LIVE_ASSETS.find((a) => a.assetCode === "EURCV")
		expect(eurcv?.assetIssuer).toBe(
			"GCTYD662VYXT34UEPPURGATJSY3YH3YVDM35A7ZAO5F222WTAY2G76L7",
		)
		expect(eurcv?.sac).toBe(
			"CAPQ3JM4LVTKZRDO4PUR3BWHT4IK6QUQK6GLE24MC7IQ6PKTNNZNXPQT",
		)
		expect(eurcv?.authorizer).toBe(
			"CCRKMAOBTP43QRFZR6A62OPNJNQFNHFEY6APAAI2ABHTFOQ4HTDL3D4X",
		)
		expect(eurcv?.capability).toBe("permissionedOneStep")
		const { ROUTERS } = await import("@theahaco/authline")
		expect(eurcv?.router).toBe(ROUTERS.TESTNET)
	})

	it("dedupes LIVE_ASSETS when the env-configured asset is also pinned", async () => {
		vi.stubEnv("PUBLIC_ASSET_CODE", "EURCV")
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		const { ASSETS, LIVE_ASSETS } = await import("./config")
		expect(LIVE_ASSETS[0]?.assetCode).toBe("EURCV")
		expect(LIVE_ASSETS.filter((a) => a.assetCode === "EURCV")).toHaveLength(1)
		expect(ASSETS.filter((t) => t.code === "EURCV")).toHaveLength(1)
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
		const { ROUTERS } = await import("@theahaco/authline")
		expect(ASSET.router).toBe(ROUTERS.TESTNET)
	})

	it("wires the testnet EURCV test token by code alone (pinned issuer wins over the mainnet default)", async () => {
		vi.stubEnv("PUBLIC_ASSET_CODE", "EURCV")
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		// Only the code is set — the pinned TESTNET issuer must win over the
		// hardcoded mainnet-EURCV fallback issuer.
		const { ASSET } = await import("./config")
		expect(ASSET.assetCode).toBe("EURCV")
		expect(ASSET.assetIssuer).toBe(
			"GCTYD662VYXT34UEPPURGATJSY3YH3YVDM35A7ZAO5F222WTAY2G76L7",
		)
		expect(ASSET.sac).toBe(
			"CAPQ3JM4LVTKZRDO4PUR3BWHT4IK6QUQK6GLE24MC7IQ6PKTNNZNXPQT",
		)
		expect(ASSET.authorizer).toBe(
			"CCRKMAOBTP43QRFZR6A62OPNJNQFNHFEY6APAAI2ABHTFOQ4HTDL3D4X",
		)
		expect(ASSET.capability).toBe("permissionedOneStep")
		expect(ASSET.authRevocable).toBe(true)
	})

	it("treats a blank PUBLIC_ROUTER as unset and still resolves the pinned router", async () => {
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		// A literal `PUBLIC_ROUTER=` in .env loads as "" — it must NOT defeat the
		// pinned-ROUTERS fallback (the "Activation unavailable" footgun).
		vi.stubEnv("PUBLIC_ROUTER", "")
		const { ASSET } = await import("./config")
		const { ROUTERS } = await import("@theahaco/authline")
		expect(ASSET.router).toBe(ROUTERS.TESTNET)
		expect(ASSET.router).not.toBe("")
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
