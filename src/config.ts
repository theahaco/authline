import {
	resolveOfficialAsset,
	netFromPassphrase,
	isValidIssuer,
	isValidContractId,
	ROUTERS,
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
warnIfInvalid("ROUTER", import.meta.env.PUBLIC_ROUTER, "C")
warnIfInvalid("STELLAR_RPC_URL", import.meta.env.PUBLIC_STELLAR_RPC_URL, "url")
warnIfInvalid(
	"STELLAR_HORIZON_URL",
	import.meta.env.PUBLIC_STELLAR_HORIZON_URL,
	"url",
)

const CODE = import.meta.env.PUBLIC_ASSET_CODE ?? "EURCV"
// Resolve the pinned registry entry by (code, network) — never by code alone, so
// a known code on testnet does not pick up a mainnet asset's name/clawback flags.
// Env always wins for display; on-chain ids prefer env and fall back to the
// registry-verified pinned ids so a known asset is fully wired.
const NET_TAG = netFromPassphrase(NETWORK.passphrase)
const pinned = resolveOfficialAsset(CODE, NET_TAG)

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
	sac: import.meta.env.PUBLIC_SAC ?? pinned?.sac ?? "",
	authorizer: import.meta.env.PUBLIC_AUTHORIZER ?? pinned?.authorizer ?? "",
	router: import.meta.env.PUBLIC_ROUTER ?? ROUTERS[NET_TAG] ?? "",
	backends: ["cap73-one-signature", "cap33-sponsored"],
	name: import.meta.env.PUBLIC_ASSET_NAME ?? pinned?.name ?? "Stellar asset",
	glyph: CODE.slice(0, 2).toUpperCase(),
	kind:
		import.meta.env.PUBLIC_ASSET_KIND ?? pinned?.homeDomain ?? "Stellar asset",
	networkLabel: NETWORK_LABEL,
	capability: (import.meta.env.PUBLIC_AUTHORIZER
		? "permissionedOneStep"
		: (pinned?.capability ?? "open")) as AssetCapability,
	authRevocable:
		import.meta.env.PUBLIC_ASSET_REVOCABLE === "true" ||
		(pinned?.authRevocable ?? false),
	authClawback:
		import.meta.env.PUBLIC_ASSET_CLAWBACK === "true" ||
		(pinned?.authClawback ?? false),
}

// Every activation flows through the router (which discovers the asset's
// capability on-chain) — a missing router id means activation cannot build
// transactions at all. Surface that loudly here instead of failing deep
// inside transaction building.
if (!ASSET.router)
	console.error(
		`[config] no onboard router configured for ${NETWORK_LABEL} — ` +
			"set PUBLIC_ROUTER or pin it in the SDK's ROUTERS.",
	)

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

const roadmap: DirItem[] = [
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
	// dedupe: do not list a roadmap asset that is already the live asset
	...roadmap.filter((a) => a.code !== ASSET.assetCode),
]

export const REPO_URL = "https://github.com/theahaco/stellar-assets"
