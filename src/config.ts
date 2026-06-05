import {
	resolveOfficialAsset,
	isValidIssuer,
	isValidContractId,
	type AssetCapability,
	type OnboarderConfig,
} from "@theaha/authline"

/**
 * Config-driven. The live asset + network come from PUBLIC_* env (app/.env or
 * the Pages workflow). Add/replace the live asset by config alone.
 */

export const NETWORK = {
	rpcUrl:
		import.meta.env.PUBLIC_STELLAR_RPC_URL ??
		"https://soroban-testnet.stellar.org",
	horizonUrl:
		import.meta.env.PUBLIC_STELLAR_HORIZON_URL ??
		"https://horizon-testnet.stellar.org",
	passphrase:
		import.meta.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
		"Test SDF Network ; September 2015",
	allowHttp: false,
}

export const NETWORK_LABEL = NETWORK.passphrase.includes("Public")
	? "Stellar · Mainnet"
	: "Stellar · Testnet"

// Light, non-fatal validation of the wired ids — surfaces a typo'd PUBLIC_* var
// in the console instead of failing opaquely deep in transaction building.
function warnIfInvalid(
	label: string,
	value: string | undefined,
	kind: "G" | "C" | "url",
): void {
	if (!value) return
	const ok =
		kind === "G"
			? isValidIssuer(value)
			: kind === "C"
				? isValidContractId(value)
				: /^https?:\/\/\S+$/.test(value)
	if (!ok)
		console.warn(
			`[config] PUBLIC_* ${label} is not a valid ${kind === "url" ? "URL" : `${kind}-address`}: ${value}`,
		)
}
warnIfInvalid("ASSET_ISSUER", import.meta.env.PUBLIC_ASSET_ISSUER, "G")
warnIfInvalid("SAC", import.meta.env.PUBLIC_SAC, "C")
warnIfInvalid("AUTHORIZER", import.meta.env.PUBLIC_AUTHORIZER, "C")
warnIfInvalid("ONBOARD", import.meta.env.PUBLIC_ONBOARD, "C")
warnIfInvalid("STELLAR_RPC_URL", import.meta.env.PUBLIC_STELLAR_RPC_URL, "url")
warnIfInvalid(
	"STELLAR_HORIZON_URL",
	import.meta.env.PUBLIC_STELLAR_HORIZON_URL,
	"url",
)

const CODE = import.meta.env.PUBLIC_ASSET_CODE ?? "EURCV"

/** The live, wired asset (the one the dApp actually activates on-chain). */
export interface AssetConfig extends OnboarderConfig {
	name: string
	glyph: string
	kind: string
	networkLabel: string
	capability: AssetCapability
	/** Issuer can freeze (deauthorize) the trustline. */
	authRevocable: boolean
	/** Issuer can claw back balances — surfaced as a UI warning. */
	authClawback: boolean
}

export const ASSET: AssetConfig = {
	assetCode: CODE,
	assetIssuer:
		import.meta.env.PUBLIC_ASSET_ISSUER ??
		"GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G",
	sac: import.meta.env.PUBLIC_SAC ?? "",
	authorizer: import.meta.env.PUBLIC_AUTHORIZER ?? "",
	onboard: import.meta.env.PUBLIC_ONBOARD,
	backends: ["cap73-one-signature", "cap33-sponsored"],
	name: import.meta.env.PUBLIC_ASSET_NAME ?? "Stellar asset",
	glyph: CODE.slice(0, 2).toUpperCase(),
	kind: import.meta.env.PUBLIC_ASSET_KIND ?? "Stellar asset",
	networkLabel: NETWORK_LABEL,
	capability: (import.meta.env.PUBLIC_AUTHORIZER
		? "permissionedOneStep"
		: "open") as AssetCapability,
	authRevocable: import.meta.env.PUBLIC_ASSET_REVOCABLE === "true",
	authClawback: import.meta.env.PUBLIC_ASSET_CLAWBACK === "true",
}

/** Directory: the configured asset is Live; the rest are the roadmap. */
export interface DirItem {
	code: string
	name: string
	glyph: string
	kind: string
	status: "live" | "soon"
	/** Issuer can claw back balances — drives the directory risk warning. */
	authClawback?: boolean
	/** Issuer can freeze (deauthorize) the trustline. */
	authRevocable?: boolean
}

// Curated roadmap items pull their real flags from the pinned registry, so a
// clawback/freeze-capable asset (e.g. EURCV) is flagged truthfully — never by
// code alone.
const fromRegistry = (code: string, glyph: string, kind: string): DirItem => {
	const a = resolveOfficialAsset(code, "PUBLIC")
	return {
		code,
		glyph,
		kind,
		name: a?.name ?? code,
		status: "soon",
		authClawback: a?.authClawback,
		authRevocable: a?.authRevocable,
	}
}

export const ASSETS: DirItem[] = [
	{
		code: ASSET.assetCode,
		name: ASSET.name,
		glyph: ASSET.glyph,
		kind: ASSET.kind,
		status: "live",
		authClawback: ASSET.authClawback,
		authRevocable: ASSET.authRevocable,
	},
	fromRegistry("USDC", "US", "USD stablecoin"),
	fromRegistry("EURC", "EC", "Euro stablecoin"),
	fromRegistry("EURCV", "EV", "MiCA euro · SG-Forge"),
	{
		code: "BENJI",
		name: "Franklin MMF",
		glyph: "BE",
		kind: "Tokenized treasuries",
		status: "soon",
	},
]

export const REPO_URL = "https://github.com/Dgetsylver/trustline-onboarder-wip"
