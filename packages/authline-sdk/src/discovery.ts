import { StrKey } from "@stellar/stellar-sdk"
import { type Backend, type OnboarderConfig } from "./index.js"
import {
	netFromPassphrase,
	reconcileWithRegistry,
	type StellarNet,
} from "./registry.js"

/** Reject anything that is not a bare hostname[:port] (no scheme/path/userinfo). */
const HOSTNAME_RE = /^[a-z0-9.-]+(:\d+)?$/i
/** A stellar.toml far larger than this is abnormal; cap before parsing. */
const MAX_TOML_BYTES = 100_000

export interface DiscoverOptions {
	/**
	 * The network the discovered asset will be used on. When set, the result is
	 * reconciled against the pinned registry: a curated code whose advertised
	 * issuer/SAC/authorizer differ from the pinned values is REJECTED (throws).
	 * Pass this (a `StellarNet` or a network passphrase) for any flow that builds
	 * a signed transaction from the result — otherwise the config is the issuer's
	 * UNVERIFIED self-advertisement.
	 */
	network?: StellarNet | string
	/** Override `fetch` (tests / custom agents). */
	fetchImpl?: typeof fetch
}

/**
 * Discover an issuer's Trustline Onboarder support from its domain's
 * `stellar.toml` (SEP-1). The issuer advertises a `[TRUSTLINE_ONBOARDER]`
 * block. `AUTHORIZER` is present only for regulated (`AUTH_REQUIRED`) assets;
 * an open asset (USDC/EURC) omits it. For example (regulated):
 *
 * ```toml
 * [TRUSTLINE_ONBOARDER]
 * ASSET_CODE = "EURCV"
 * ASSET_ISSUER = "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G"
 * SAC = "C..."
 * AUTHORIZER = "C..."          # Trustline Authorizer (SAC admin); regulated assets only
 * ONBOARD_WRAPPER = "C..."     # one-signature CAP-73 wrapper
 * BACKENDS = ["cap73-onesig", "cap33-sponsored"]
 * ```
 *
 * SECURITY: the returned config is the issuer's self-advertisement. StrKey
 * validation proves the ids are well-formed, NOT that they are the *right* ids.
 * Pass `opts.network` so the result is reconciled against the pinned registry
 * before it is ever used to build a signed transaction. Never pass a `domain`
 * sourced from untrusted user input on a server (SSRF).
 */
export async function discoverOnboarder(
	domain: string,
	opts: DiscoverOptions = {},
): Promise<OnboarderConfig | null> {
	const host = domain.trim().replace(/\/+$/, "")
	if (!HOSTNAME_RE.test(host) || host.includes(".."))
		throw new Error(`discoverOnboarder: invalid domain '${domain}'`)
	const fetchImpl = opts.fetchImpl ?? fetch
	const res = await fetchImpl(`https://${host}/.well-known/stellar.toml`)
	if (!res.ok) return null
	const text = await res.text()
	if (text.length > MAX_TOML_BYTES)
		throw new Error("discoverOnboarder: stellar.toml exceeds size cap")
	const config = parseOnboarderToml(text)
	if (config && opts.network != null) {
		const net: StellarNet =
			opts.network === "PUBLIC" ||
			opts.network === "TESTNET" ||
			opts.network === "FUTURENET" ||
			opts.network === "LOCAL"
				? opts.network
				: netFromPassphrase(opts.network)
		return reconcileWithRegistry(config, net)
	}
	return config
}

/** Parse the `[TRUSTLINE_ONBOARDER]` block out of a stellar.toml document. */
export function parseOnboarderToml(toml: string): OnboarderConfig | null {
	const block = sectionBody(toml, "TRUSTLINE_ONBOARDER")
	if (!block) return null

	const assetCode = str(block, "ASSET_CODE")
	const assetIssuer = str(block, "ASSET_ISSUER")
	const sac = str(block, "SAC")
	const authorizer = str(block, "AUTHORIZER")
	// SEP-1 §6 field is ONBOARD_WRAPPER; accept legacy ONBOARD as an alias.
	const onboard = str(block, "ONBOARD_WRAPPER") || str(block, "ONBOARD")
	const backends = arr(block, "BACKENDS")
		.map(normalizeBackend)
		.filter(isBackend)

	// Per SEP-1 §6, ASSET_CODE / ASSET_ISSUER / SAC are always required.
	// AUTHORIZER is conditional: present for AUTH_REQUIRED assets, omitted for
	// open assets (USDC/EURC) — so it MUST NOT be required here, or the parser
	// would reject the spec's own open-asset toml.
	if (!assetCode || !assetIssuer || !sac) return null

	// A present-but-malformed strkey is a misconfiguration, not "no onboarder":
	// reject it loudly so garbage never reaches `new Address(...)` downstream.
	if (!StrKey.isValidEd25519PublicKey(assetIssuer))
		throw new Error(
			`[TRUSTLINE_ONBOARDER]: ASSET_ISSUER is not a valid G-address: ${assetIssuer}`,
		)
	if (!StrKey.isValidContract(sac))
		throw new Error(
			`[TRUSTLINE_ONBOARDER]: SAC is not a valid C-address: ${sac}`,
		)
	if (authorizer && !StrKey.isValidContract(authorizer))
		throw new Error(
			`[TRUSTLINE_ONBOARDER]: AUTHORIZER is not a valid C-address: ${authorizer}`,
		)
	if (onboard && !StrKey.isValidContract(onboard))
		throw new Error(
			`[TRUSTLINE_ONBOARDER]: ONBOARD_WRAPPER is not a valid C-address: ${onboard}`,
		)

	return {
		assetCode,
		assetIssuer,
		sac,
		authorizer,
		onboard: onboard || undefined,
		backends: backends.length
			? backends
			: ["cap73-one-signature", "cap33-sponsored"],
	}
}

function sectionBody(toml: string, name: string): string | null {
	const lines = toml.split(/\r?\n/)
	const start = lines.findIndex((l) => l.trim() === `[${name}]`)
	if (start < 0) return null
	const body: string[] = []
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\s*\[/.test(lines[i])) break
		body.push(lines[i])
	}
	return body.join("\n")
}

function str(block: string, key: string): string {
	// Accept double- or single-quoted TOML string values (both are valid TOML).
	// NOTE: this is a minimal line scanner, not a full TOML parser — multi-line
	// arrays and inline tables are out of scope; use a real parser for those.
	const m = block.match(
		new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"),
	)
	return m ? (m[1] ?? m[2] ?? "") : ""
}
function arr(block: string, key: string): string[] {
	const m = block.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"))
	if (!m) return []
	return m[1]
		.split(",")
		.map((s) => s.trim().replace(/^"|"$/g, ""))
		.filter(Boolean)
}
/** SEP-1 §6 uses the short token `cap73-onesig`; normalize to the SDK's canonical form. */
function normalizeBackend(s: string): string {
	return s === "cap73-onesig" ? "cap73-one-signature" : s
}
function isBackend(s: string): s is Backend {
	return s === "cap73-one-signature" || s === "cap33-sponsored"
}
