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
