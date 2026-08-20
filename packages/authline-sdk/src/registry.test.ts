import { describe, expect, it } from "vitest"
import {
	OFFICIAL_ASSETS,
	ROUTERS,
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

	it("pins are unique per (code, network)", () => {
		// resolveOfficialAsset returns the FIRST match — a duplicate pin would
		// silently shadow the later one.
		const keys = OFFICIAL_ASSETS.map((a) => `${a.code}:${a.network}`)
		expect(new Set(keys).size).toBe(keys.length)
	})

	it("resolves testnet USDC by (code, network) as an open asset", () => {
		const a = resolveOfficialAsset("USDC", "TESTNET")
		expect(a).not.toBeNull()
		expect(a?.issuer).toBe(TESTNET_USDC_ISSUER)
		expect(a?.sac).toBe(TESTNET_USDC_SAC)
		expect(a?.capability).toBe("open")
		expect(a?.authorizer).toBeUndefined()
	})

	it("resolves the testnet EURCV-style test token (TLO) as a one-step permissioned asset", () => {
		const a = resolveOfficialAsset("TLO", "TESTNET")
		expect(a).not.toBeNull()
		expect(a?.capability).toBe("permissionedOneStep")
		expect(a?.sac).toBe(
			"CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3",
		)
		expect(a?.authorizer).toBe(
			"CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
		)
	})

	it("resolves the testnet EURCV test token distinctly from mainnet EURCV", () => {
		const t = resolveOfficialAsset("EURCV", "TESTNET")
		expect(t).not.toBeNull()
		expect(t?.capability).toBe("permissionedOneStep")
		expect(t?.issuer).toBe(
			"GC66PIMV4S2WEQYG3UFOGG7Z4OIAQAKJLEKX6C5ZQ6AZT4FUXUPOGIKL",
		)
		expect(t?.sac).toBe(
			"CCST65QNIHUJ3V2JK5SDTXUXYSGQZI6MSSXDMNRA55ECJEWU4UFDLQHR",
		)
		// The asset-agnostic Trustline Authorizer, not the Tranche-1 stub.
		expect(t?.authorizer).toBe(
			"CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM",
		)
		// A different issuer from mainnet EURCV, but the same auth flags.
		expect(t?.issuer).not.toBe(resolveOfficialAsset("EURCV", "PUBLIC")?.issuer)
		expect(t?.authRevocable).toBe(true)
		expect(t?.authClawback).toBe(true)
	})

	it("resolves Circle's official testnet EURC as an open asset", () => {
		const a = resolveOfficialAsset("EURC", "TESTNET")
		expect(a?.issuer).toBe(
			"GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO",
		)
		expect(a?.sac).toBe(
			"CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
		)
		expect(a?.capability).toBe("open")
		expect(a?.authorizer).toBeUndefined()
		// Unlike mainnet EURC, Circle's testnet issuer has NO auth flags at all.
		expect(a?.authRevocable).toBe(false)
		expect(a?.authClawback).toBe(false)
		// Distinct from Circle's mainnet EURC issuer.
		expect(a?.issuer).not.toBe(resolveOfficialAsset("EURC", "PUBLIC")?.issuer)
	})

	it("resolves BLND on both networks with distinct issuers", () => {
		const main = resolveOfficialAsset("BLND", "PUBLIC")
		expect(main?.issuer).toBe(
			"GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY",
		)
		expect(main?.sac).toBe(
			"CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY",
		)
		expect(main?.capability).toBe("open")
		expect(main?.authRevocable).toBe(false)
		expect(main?.authClawback).toBe(false)
		const test = resolveOfficialAsset("BLND", "TESTNET")
		expect(test?.issuer).toBe(
			"GCZLTPB2YA4G2OWOBZ4XUS7TUXLBSCGXPZ5AL3W2UFDQ7RD7WJMG4EDT",
		)
		expect(test?.sac).toBe(
			"CDJOMK2UQX5TTFBMHSYGIHB4LSNZ4VECABT2PM3DH3TXQ4NQAWILR3ZU",
		)
		expect(test?.capability).toBe("open")
		expect(test?.issuer).not.toBe(main?.issuer)
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

	it("pins a valid testnet router id", () => {
		expect(ROUTERS.TESTNET).toMatch(/^C[A-Z2-7]{55}$/)
	})

	it("rejects a spoofed router for a curated code", () => {
		expect(() =>
			reconcileWithRegistry(
				{
					assetCode: "USDC",
					assetIssuer: TESTNET_USDC_ISSUER,
					sac: TESTNET_USDC_SAC,
					router: TESTNET_USDC_SAC, // a C-address, but not the pinned router
				},
				"TESTNET",
			),
		).toThrow(/does not match the pinned value/)
	})

	it("rejects a spoofed router even for an UNCURATED code", () => {
		// The router is asset-independent — the check must not be skipped by the
		// uncurated-code early return.
		expect(() =>
			reconcileWithRegistry(
				{
					assetCode: "ZZZX",
					assetIssuer: TESTNET_USDC_ISSUER,
					sac: TESTNET_USDC_SAC,
					router: TESTNET_USDC_SAC, // not the pinned router
				},
				"TESTNET",
			),
		).toThrow(/does not match the pinned value/)
	})

	it("accepts the pinned router and passes uncurated codes through", () => {
		const cfg = {
			assetCode: "ZZZX",
			assetIssuer: TESTNET_USDC_ISSUER,
			sac: TESTNET_USDC_SAC,
			router: ROUTERS.TESTNET,
		}
		expect(reconcileWithRegistry(cfg, "TESTNET")).toBe(cfg)
	})
})
