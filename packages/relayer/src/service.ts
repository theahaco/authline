import { StrKey } from "@stellar/stellar-sdk"
import {
	resolveOfficialAsset,
	type ActivationStatus,
	type OfficialAsset,
} from "@theahaco/authline"
import { type RelayerConfig } from "./config.js"

/** Ledger view of one holder: activation state plus bare account existence. */
export interface AccountView {
	status: ActivationStatus
	/**
	 * Whether the G-account exists on-ledger at all — a missing trustline and a
	 * missing account read identically from the trustline entry, and an
	 * exchange handles them differently (fund vs. onboard). Always `true` for
	 * contract holders (existence is not modeled for them).
	 */
	accountExists: boolean
}

/**
 * The chain, abstracted so the HTTP layer is testable without RPC.
 * `server.ts` supplies the real implementation; unit tests supply fakes.
 */
export interface ChainOps {
	view(asset: OfficialAsset, account: string): Promise<AccountView>
	/**
	 * Simulate the authorizer's `is_eligible(account)` — would
	 * `authorize_trustline` be permitted by the policy right now?
	 */
	isEligible(asset: OfficialAsset, account: string): Promise<boolean>
	/** Submit `authorize_trustline(account)` signed by the relayer. Tx hash. */
	authorize(asset: OfficialAsset, account: string): Promise<string>
}

export interface HttpResult {
	status: number
	body: Record<string, unknown>
}

/** Why an account is not ready, in words an integrator can switch on. */
export type NotReadyReason =
	| "no_account"
	| "no_trustline"
	| "trustline_unauthorized"
	| "not_authorized"

/** Typed authorizer refusals, keyed by `Error(Contract, #n)` code. */
const CONTRACT_REFUSALS: Record<
	number,
	{ status: number; error: string; detail: string }
> = {
	1: {
		status: 403,
		error: "account_banned",
		detail: "the account is on the issuer's denylist",
	},
	2: {
		status: 403,
		error: "account_not_allowed",
		detail:
			"allowlist policy: the issuer has not admitted this account (KYC pending?)",
	},
	3: {
		status: 409,
		error: "no_trustline",
		detail:
			"the account has no trustline for this asset yet — create one first " +
			"(the Authline onboard router does both in one transaction)",
	},
	4: {
		status: 503,
		error: "authorizer_paused",
		detail: "the issuer has paused the authorizer — retry later",
	},
}

const json = (status: number, body: Record<string, unknown>): HttpResult => ({
	status,
	body,
})

const err = (status: number, error: string, detail: string): HttpResult =>
	json(status, { error, detail })

/** Map a chain failure to an HTTP refusal, or a 502 for anything untyped. */
export function explainChainError(e: unknown): HttpResult {
	const text = e instanceof Error ? e.message : String(e)
	const m = /Error\(Contract, #(\d+)\)/.exec(text)
	if (m) {
		const known = CONTRACT_REFUSALS[Number(m[1])]
		if (known) return err(known.status, known.error, known.detail)
		return err(502, "contract_error", `authorizer refused: ${text}`)
	}
	return err(502, "chain_error", text)
}

/**
 * "Ready" means: a payment of this asset to this account will succeed right
 * now. For a contract holder (e.g. a passkey smart account) the SAC's
 * `authorized()` view is the only signal; for a G-account it is the classic
 * trustline, plus the AUTHORIZED flag when the asset is regulated.
 */
export function computeReady(
	asset: OfficialAsset,
	view: AccountView,
): { ready: boolean; reason?: NotReadyReason } {
	const s = view.status
	if (s.holderKind === "contract") {
		return s.sacAuthorized === true
			? { ready: true }
			: { ready: false, reason: "not_authorized" }
	}
	if (!view.accountExists) return { ready: false, reason: "no_account" }
	if (!s.hasTrustline) return { ready: false, reason: "no_trustline" }
	if (asset.authorizer && !s.isAuthorized)
		return { ready: false, reason: "trustline_unauthorized" }
	return { ready: true }
}

function resolveAsset(
	cfg: RelayerConfig,
	query: URLSearchParams,
): OfficialAsset | HttpResult {
	const code = query.get("asset") ?? cfg.defaultAsset
	const asset = resolveOfficialAsset(code, cfg.network)
	if (!asset)
		return err(
			404,
			"unknown_asset",
			`'${code}' is not a pinned asset on ${cfg.network}`,
		)
	return asset
}

const isAsset = (x: OfficialAsset | HttpResult): x is OfficialAsset =>
	!("status" in x)

function parseAccount(raw: string): string | HttpResult {
	if (StrKey.isValidEd25519PublicKey(raw) || StrKey.isValidContract(raw))
		return raw
	return err(400, "invalid_account", `'${raw}' is not a Stellar address`)
}

async function handleReady(
	cfg: RelayerConfig,
	ops: ChainOps,
	asset: OfficialAsset,
	account: string,
): Promise<HttpResult> {
	const view = await ops.view(asset, account)
	const { ready, reason } = computeReady(asset, view)
	const regulated = Boolean(asset.authorizer)
	// Only consult policy when authorize could actually be the fix.
	let authorizable: boolean | undefined
	if (!ready && regulated) {
		try {
			authorizable = await ops.isEligible(asset, account)
		} catch {
			authorizable = undefined
		}
	}
	const s = view.status
	return json(200, {
		account,
		asset: asset.code,
		network: asset.network,
		regulated,
		ready,
		...(reason ? { reason } : {}),
		...(authorizable !== undefined ? { authorizable } : {}),
		status: {
			holderKind: s.holderKind,
			accountExists: view.accountExists,
			hasTrustline: s.hasTrustline,
			isAuthorized: s.isAuthorized,
			...(s.sacAuthorized !== undefined
				? { sacAuthorized: s.sacAuthorized }
				: {}),
			...(s.readError ? { readError: s.readError } : {}),
		},
	})
}

async function handleAuthorize(
	cfg: RelayerConfig,
	ops: ChainOps,
	asset: OfficialAsset,
	account: string,
): Promise<HttpResult> {
	if (!asset.authorizer)
		return err(
			400,
			"asset_not_regulated",
			`${asset.code} is an open asset — holders need no authorization`,
		)
	// Idempotent: authorizing an already-ready account is a success, not a
	// chain round-trip the relayer pays fees for.
	const before = await ops.view(asset, account)
	if (computeReady(asset, before).ready)
		return json(200, {
			account,
			asset: asset.code,
			authorized: true,
			alreadyAuthorized: true,
		})
	try {
		const txHash = await ops.authorize(asset, account)
		return json(200, {
			account,
			asset: asset.code,
			authorized: true,
			alreadyAuthorized: false,
			txHash,
		})
	} catch (e) {
		return explainChainError(e)
	}
}

/**
 * Route one request. Pure with respect to HTTP: the caller passes method,
 * URL and the bearer token (if any); the chain is behind {@link ChainOps}.
 *
 * Routes:
 *   GET  /healthz
 *   GET  /v1/accounts/:account/ready      [?asset=CODE]
 *   POST /v1/accounts/:account/authorize  [?asset=CODE]
 */
export async function handleRequest(
	cfg: RelayerConfig,
	ops: ChainOps,
	method: string,
	url: URL,
	bearerToken?: string,
): Promise<HttpResult> {
	if (url.pathname === "/healthz")
		return json(200, {
			ok: true,
			network: cfg.network,
			relayer: cfg.signer.publicKey(),
			defaultAsset: cfg.defaultAsset,
		})

	const m = /^\/v1\/accounts\/([^/]+)\/(ready|authorize)$/.exec(url.pathname)
	if (!m) return err(404, "not_found", "see /healthz for the route list")
	const [, rawAccount, action] = m

	const account = parseAccount(rawAccount)
	if (typeof account !== "string") return account
	const asset = resolveAsset(cfg, url.searchParams)
	if (!isAsset(asset)) return asset

	if (action === "ready") {
		if (method !== "GET") return err(405, "method_not_allowed", "use GET")
		return handleReady(cfg, ops, asset, account)
	}

	// authorize
	if (method !== "POST") return err(405, "method_not_allowed", "use POST")
	if (cfg.apiToken && bearerToken !== cfg.apiToken)
		return err(401, "unauthorized", "pass Authorization: Bearer <token>")
	return handleAuthorize(cfg, ops, asset, account)
}
