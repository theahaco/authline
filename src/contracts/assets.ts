import { StrKey } from "@stellar/stellar-sdk"
import { stellarNetwork } from "./util"

export type AssetCapability =
	| "open"
	| "permissionedOneStep"
	| "permissionedManual"
export type StellarNet = "PUBLIC" | "TESTNET" | "FUTURENET" | "LOCAL"

export interface OfficialAsset {
	code: string
	/** PINNED issuer — scam-issuer mitigation; never resolve an asset by code alone. */
	issuer: string
	/** PINNED canonical Stellar Asset Contract id (verified), not derived at runtime. */
	sac: string
	/** Required iff capability === "permissionedOneStep": the authorize_trustline contract. */
	authorizer?: string
	capability: AssetCapability
	name: string
	network: StellarNet
	homeDomain?: string
	/** Issuer can freeze the trustline. */
	authRevocable?: boolean
	/** Issuer can claw back balances — surfaced as a UI warning. */
	authClawback?: boolean
	/** Date the on-chain facts were verified (source-of-truth marker). */
	verifiedAt?: string
}

// All addresses verified on-chain (Horizon /accounts flags + stellar.expert),
// strkeys checksum-valid, on 2026-06-04. See the design spec for sources.
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

// Optional per-deployment override from PUBLIC_TEST_* env vars, preserving the
// scripts/issue-test-asset.sh testnet workflow. Injected for the active network.
function envOverrideAsset(): OfficialAsset | null {
	const code = import.meta.env.PUBLIC_TEST_ASSET_CODE as string | undefined
	const issuer = import.meta.env.PUBLIC_TEST_ASSET_ISSUER as string | undefined
	const sac = import.meta.env.PUBLIC_TEST_SAC as string | undefined
	const authorizer = import.meta.env.PUBLIC_EURCV_AUTH_CONTRACT_ID as
		| string
		| undefined
	if (!code || !issuer || !sac) return null
	return {
		code,
		issuer,
		sac,
		authorizer,
		capability: authorizer ? "permissionedOneStep" : "open",
		name: `${code} (test)`,
		network: stellarNetwork as StellarNet,
		verifiedAt: undefined,
	}
}

function validate(a: OfficialAsset): void {
	if (!StrKey.isValidEd25519PublicKey(a.issuer))
		throw new Error(
			`assets.ts: ${a.code} issuer is not a valid G-address: ${a.issuer}`,
		)
	if (!StrKey.isValidContract(a.sac))
		throw new Error(
			`assets.ts: ${a.code} sac is not a valid C-address: ${a.sac}`,
		)
	if (a.authorizer && !StrKey.isValidContract(a.authorizer))
		throw new Error(
			`assets.ts: ${a.code} authorizer is not a valid C-address: ${a.authorizer}`,
		)
	if (a.capability === "permissionedOneStep" && !a.authorizer)
		throw new Error(
			`assets.ts: ${a.code} is permissionedOneStep but has no authorizer`,
		)
}

const override = envOverrideAsset()
const ALL: OfficialAsset[] = override
	? [...OFFICIAL_ASSETS, override]
	: [...OFFICIAL_ASSETS]
ALL.forEach(validate)

export function assetsForNetwork(
	net: StellarNet = stellarNetwork as StellarNet,
): OfficialAsset[] {
	return ALL.filter((a) => a.network === net)
}
