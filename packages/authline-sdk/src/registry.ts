import { StrKey } from "@stellar/stellar-sdk"

/**
 * Trust-establishment capability of an asset, mirroring the model introduced by
 * `theahaco/stellar-assets` PR #10 so the two codebases classify assets the same
 * way:
 *  - `open`               — not `AUTH_REQUIRED`: `changeTrust` only, usable immediately.
 *  - `permissionedOneStep`— `AUTH_REQUIRED` with an authorizer: one-step onboard
 *                           (one signature) creates + authorizes the trustline.
 *  - `permissionedManual` — `AUTH_REQUIRED`, the issuer authorizes off-platform.
 */
export type AssetCapability =
	| "open"
	| "permissionedOneStep"
	| "permissionedManual"

export type StellarNet = "PUBLIC" | "TESTNET" | "FUTURENET" | "LOCAL"

/**
 * A curated, issuer-**pinned** asset entry. Pinning the issuer + SAC (and never
 * resolving an asset by code alone) is the anti-copycat / scam-issuer defense
 * ported from `stellar-assets/src/contracts/assets.ts`. Open assets share a code
 * across many issuers, so a code is never enough to trust an asset.
 */
export interface OfficialAsset {
	code: string
	/** PINNED issuer (`G…`) — never resolve an asset by code alone. */
	issuer: string
	/** PINNED canonical Stellar Asset Contract id (`C…`), verified, not derived at runtime. */
	sac: string
	/** Required iff `capability === "permissionedOneStep"`: the `authorize_trustline` contract (`C…`). */
	authorizer?: string
	capability: AssetCapability
	name: string
	network: StellarNet
	homeDomain?: string
	/** Issuer can freeze (deauthorize) the trustline. */
	authRevocable?: boolean
	/** Issuer can claw back balances — surfaced as a UI warning. */
	authClawback?: boolean
	/** Date the on-chain facts (issuer/SAC/flags) were verified — provenance marker. */
	verifiedAt?: string
}

/**
 * Verified mainnet assets (issuer + SAC + flags checked on-chain on 2026-06-04),
 * mirroring the pinned registry in `stellar-assets`. Extend per deployment; every
 * entry is checksum-validated at module load (see {@link validateOfficialAsset}).
 */
export const OFFICIAL_ASSETS: OfficialAsset[] = [
	{
		code: "USDC",
		issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
		sac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
		capability: "open",
		name: "USD Coin",
		network: "PUBLIC",
		homeDomain: "circle.com",
		authRevocable: true,
		authClawback: false,
		verifiedAt: "2026-06-04",
	},
	{
		code: "EURC",
		issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
		sac: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
		capability: "open",
		name: "Euro Coin",
		network: "PUBLIC",
		homeDomain: "circle.com",
		authRevocable: true,
		authClawback: false,
		verifiedAt: "2026-06-04",
	},
	{
		code: "EURCV",
		issuer: "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G",
		sac: "CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH",
		authorizer: "CB2DHZMQHQE3TGUMD6BRM7UCJZNIPKDRVEQOWBIRRS3G2FZOGDTRKSB3",
		capability: "permissionedOneStep",
		name: "EUR CoinVertible",
		network: "PUBLIC",
		homeDomain: "sgforge.com",
		authRevocable: true,
		authClawback: true,
		verifiedAt: "2026-06-04",
	},
	{
		// Blend Capital's BLND — issuer verified via Blend docs + StellarExpert
		// (115k+ trustlines vs 17 for the nearest copycat, ~7,000x; open flags);
		// SAC re-derived with Asset.contractId(PUBLIC) and probed live on
		// mainnet RPC (name() simulation), 2026-06-11. NOTE: homeDomain below is
		// the issuer's known project domain for display — the issuer account has
		// no on-chain home_domain and blend.capital serves no stellar.toml, so
		// unlike the Circle pins it is not on-chain/SEP-1 verifiable.
		code: "BLND",
		issuer: "GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY",
		sac: "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY",
		capability: "open",
		name: "Blend",
		network: "PUBLIC",
		homeDomain: "blend.capital",
		authRevocable: false,
		authClawback: false,
		verifiedAt: "2026-06-11",
	},
	{
		// Testnet entry: issuer + flags verified via Horizon (2026-06-08); the SAC
		// is the deterministic `Asset.contractId(TESTNET)` id (same derivation that
		// reproduces every pinned mainnet SAC), deployed on testnet. Testnet has no
		// scam-issuer risk, so a derived+deployed SAC is acceptable here.
		code: "USDC",
		issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
		sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
		capability: "open",
		name: "USD Coin",
		network: "TESTNET",
		homeDomain: "centre.io",
		authRevocable: true,
		authClawback: false,
		verifiedAt: "2026-06-08",
	},
	{
		// Testnet EURCV-style regulated test asset: AUTH_REQUIRED, with the
		// asset-agnostic Trustline Authorizer set as its SAC admin — so the router
		// discovers `authorize_trustline` on-chain and authorizes in one step, the
		// same path mainnet EURCV uses. Issuer auth flags read via Horizon
		// (2026-06-10); the on-chain discovery + authorize is proven by
		// tests/e2e/testnet-tlo.e2e.test.ts. Activate it in the dApp with
		// PUBLIC_ASSET_CODE=TLO.
		code: "TLO",
		issuer: "GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U",
		sac: "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3",
		authorizer: "CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
		capability: "permissionedOneStep",
		name: "Trustline Onboard Test (EURCV-style)",
		network: "TESTNET",
		authRevocable: true,
		authClawback: false,
		verifiedAt: "2026-06-10",
	},
	{
		// Testnet EURCV test token — same code as the mainnet asset, so the
		// dApp's EURCV flow is exercisable end-to-end on testnet (resolution is
		// per (code, network), so this never shadows the mainnet pin). Issued by
		// scripts/issue-test-asset.sh: AUTH_REQUIRED + AUTH_REVOCABLE +
		// AUTH_CLAWBACK_ENABLED, matching mainnet EURCV's flags, with the
		// asset-agnostic Trustline Authorizer (contracts/trustline-authorizer,
		// denylist policy) as the SAC admin.
		//
		// RE-ISSUED 2026-08-20 to replace the Tranche-1 `authorizer-stub`: SAC
		// adminship is one-way, and the stub exposes no `set_admin`, so the old
		// asset (issuer GCTYD662…76L7, authorizer CCRKMAOB…3D4X) is permanently
		// stuck with it and could not be upgraded in place.
		//
		// Verified 2026-08-20: issuer flags via Horizon, SAC id re-derived with
		// Asset.contractId(TESTNET), and SAC admin() == authorizer /
		// authorizer sac() == SAC via RPC simulation. Activate in the dApp with
		// PUBLIC_ASSET_CODE=EURCV.
		code: "EURCV",
		issuer: "GC66PIMV4S2WEQYG3UFOGG7Z4OIAQAKJLEKX6C5ZQ6AZT4FUXUPOGIKL",
		sac: "CCST65QNIHUJ3V2JK5SDTXUXYSGQZI6MSSXDMNRA55ECJEWU4UFDLQHR",
		authorizer: "CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM",
		capability: "permissionedOneStep",
		name: "EUR CoinVertible (testnet test token)",
		network: "TESTNET",
		authRevocable: true,
		authClawback: true,
		verifiedAt: "2026-08-20",
	},
	{
		// Circle's OFFICIAL testnet EURC (same process as the testnet USDC pin):
		// issuer verified via Horizon — dominant by 10x (1758 authorized
		// trustlines), on-chain home_domain circle.com — and listed in Circle's
		// EURC contract-addresses docs. Open flags (matches mainnet EURC's
		// capability; unlike mainnet, testnet EURC is not auth_revocable). SAC
		// re-derived with Asset.contractId(TESTNET) and probed live (2026-06-11).
		code: "EURC",
		issuer: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO",
		sac: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
		capability: "open",
		name: "Euro Coin",
		network: "TESTNET",
		homeDomain: "circle.com",
		authRevocable: false,
		authClawback: false,
		verifiedAt: "2026-06-11",
	},
	{
		// Testnet BLND test token (OPEN — no auth flags, no authorizer), issued
		// by scripts/issue-test-asset.sh with REGULATED=0: exercises the open
		// one-step path. Issuer flags verified via Horizon, SAC deployed and the
		// derived Asset.contractId(TESTNET) matches (2026-06-11). The real BLND
		// is the mainnet pin above.
		code: "BLND",
		issuer: "GCZLTPB2YA4G2OWOBZ4XUS7TUXLBSCGXPZ5AL3W2UFDQ7RD7WJMG4EDT",
		sac: "CDJOMK2UQX5TTFBMHSYGIHB4LSNZ4VECABT2PM3DH3TXQ4NQAWILR3ZU",
		capability: "open",
		name: "Blend (testnet test token)",
		network: "TESTNET",
		authRevocable: false,
		authClawback: false,
		verifiedAt: "2026-06-11",
	},
]

/**
 * Validate a pinned entry: checksum-valid strkeys and capability/authorizer
 * coherence. Throws — a typo'd or malicious address is rejected at load time
 * rather than silently used.
 */
export function validateOfficialAsset(a: OfficialAsset): void {
	if (!StrKey.isValidEd25519PublicKey(a.issuer))
		throw new Error(
			`registry: ${a.code} issuer is not a valid G-address: ${a.issuer}`,
		)
	if (!StrKey.isValidContract(a.sac))
		throw new Error(
			`registry: ${a.code} sac is not a valid C-address: ${a.sac}`,
		)
	if (a.authorizer && !StrKey.isValidContract(a.authorizer))
		throw new Error(
			`registry: ${a.code} authorizer is not a valid C-address: ${a.authorizer}`,
		)
	if (a.capability === "permissionedOneStep" && !a.authorizer)
		throw new Error(
			`registry: ${a.code} is permissionedOneStep but has no authorizer`,
		)
}

// Fail fast at module load if any pinned entry is malformed.
OFFICIAL_ASSETS.forEach(validateOfficialAsset)

/**
 * Pinned Authline onboard-router ids per network — the deploy-once, stateless
 * singleton exposing `onboard(sac, holder)`. PINNED like the assets above
 * (never resolved from an advertised source). TESTNET is filled by the
 * deployment task; PUBLIC is added when the mainnet router ships. Future:
 * resolve via the on-chain stellar-registry instead.
 */
export const ROUTERS: Partial<Record<StellarNet, string>> = {
	// Deployed from contracts/trustline-onboard @ 9925c31 (wasm hash
	// ef08ae22467dd80bdb8c0017beb6c90964baacb8c6ab1fb673fb2bc765f206e9),
	// verified on-chain 2026-06-10.
	TESTNET: "CABVVUYHXS6UVN2VYYXKEUO2XEJIAGMTEYF2BOWGUUJVOO2IGPRWZAX4",
}

// Fail fast at module load if a pinned router id is malformed.
Object.values(ROUTERS).forEach((id) => {
	if (!StrKey.isValidContract(id))
		throw new Error(`registry: pinned router is not a valid C-address: ${id}`)
})

/** StrKey validators re-exposed so consumers can validate addresses without importing the base SDK. */
export const isValidIssuer = (s: string): boolean =>
	StrKey.isValidEd25519PublicKey(s)
export const isValidContractId = (s: string): boolean =>
	StrKey.isValidContract(s)

/** Map a network passphrase to the `StellarNet` tag used by the registry. */
export function netFromPassphrase(passphrase: string): StellarNet {
	if (passphrase.includes("Public Global")) return "PUBLIC"
	if (passphrase.includes("Test SDF Network")) return "TESTNET"
	if (passphrase.includes("Future")) return "FUTURENET"
	return "LOCAL"
}

/** Curated assets for a given network. */
export function assetsForNetwork(net: StellarNet): OfficialAsset[] {
	return OFFICIAL_ASSETS.filter((a) => a.network === net)
}

/**
 * Resolve a pinned asset by (code, network) — **never by code alone**. Returns
 * `null` when the code is not in the curated registry for that network, so a
 * caller cannot silently trust an arbitrary issuer for a well-known code.
 */
export function resolveOfficialAsset(
	code: string,
	net: StellarNet,
): OfficialAsset | null {
	return (
		OFFICIAL_ASSETS.find((a) => a.code === code && a.network === net) ?? null
	)
}

/** Minimal shape reconciled against the registry (a discovered onboarder config). */
export interface ReconcilableConfig {
	assetCode: string
	assetIssuer: string
	sac: string
	authorizer?: string
	/** Onboard router advertised by the issuer — must match the pinned ROUTERS id for the network when both exist. */
	router?: string
}

/**
 * Reconcile an advertised/discovered config against the pinned registry. This is
 * the enforcement half of the anti-copycat defense: when the asset code is
 * curated for `net`, every on-chain id (issuer, SAC, authorizer) MUST equal the
 * pinned value, or this throws — refusing to let a spoofed `stellar.toml`
 * redirect a trustline/authorize to attacker-controlled ids. When the code is
 * NOT curated there is nothing to pin against, so the config is returned
 * unchanged (callers should treat uncurated assets with extra caution) — EXCEPT
 * the router: it is asset-independent (one pinned singleton per network), so an
 * advertised router is checked against `ROUTERS` regardless of curation.
 *
 * Returns the same config on success so it can be used inline.
 */
export function reconcileWithRegistry<T extends ReconcilableConfig>(
	config: T,
	net: StellarNet,
): T {
	const assertEq = (
		field: string,
		got: string | undefined,
		want: string | undefined,
	): void => {
		if (want && got && got !== want)
			throw new Error(
				`registry: discovered ${config.assetCode} ${field} ${got} does not match ` +
					`the pinned value ${want} — refusing a possibly-spoofed onboarder config`,
			)
	}
	// Asset-independent: a spoofed advertised router is rejected even for
	// asset codes the registry does not curate.
	assertEq("router", config.router, ROUTERS[net])
	const pinned = resolveOfficialAsset(config.assetCode, net)
	if (!pinned) return config
	assertEq("issuer", config.assetIssuer, pinned.issuer)
	assertEq("SAC", config.sac, pinned.sac)
	assertEq("authorizer", config.authorizer, pinned.authorizer)
	return config
}
