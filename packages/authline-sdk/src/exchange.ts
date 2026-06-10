import {
	Account,
	Address,
	Asset,
	BASE_FEE,
	Contract,
	Horizon,
	Operation,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import { defaultAllowHttp } from "./onboard.js"
import { type OnboarderConfig } from "./index.js"

/**
 * Third-party (exchange / broker / wallet) integration surface.
 *
 * The invariant: only the user can sign `ChangeTrust`, so the integrator does
 * everything else — pays the reserve, authorizes on the issuer's behalf, and
 * reduces the user to at most one in-flow signature (zero when they already
 * have an unauthorized trustline).
 */

/**
 * Build the permissionless **authorize-on-behalf** transaction (Soroban).
 * Any funded account (`source`) may submit it — the Authorizer contract is the
 * asset's SAC admin and authorizes the holder unless the policy (denylist /
 * allowlist) says otherwise. No user signature, no manual issuer signature.
 *
 * Returns unsigned base64 XDR for the integrator to sign with `source` and submit.
 */
export async function buildAuthorizeTx(opts: {
	rpcUrl: string
	networkPassphrase: string
	/** The integrator's funded account that submits + signs this tx. */
	source: string
	/** The user whose trustline is being authorized. */
	account: string
	config: OnboarderConfig
	allowHttp?: boolean
}): Promise<string> {
	if (!opts.config.authorizer) {
		throw new Error(
			"config.authorizer is required for authorize-on-behalf (Case A) — " +
				"it is the asset's SAC admin",
		)
	}
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const src = await server.getAccount(opts.source)
	const authorizer = new Contract(opts.config.authorizer)
	const tx = new TransactionBuilder(src, {
		fee: BASE_FEE,
		networkPassphrase: opts.networkPassphrase,
	})
		.addOperation(
			authorizer.call(
				"authorize_trustline",
				new Address(opts.account).toScVal(),
			),
		)
		.setTimeout(180)
		.build()
	const prepared = await server.prepareTransaction(tx)
	return prepared.toXDR()
}

/**
 * Build the **reserve-free** classic onboarding transaction (CAP-33 sponsored
 * `ChangeTrust`). The integrator (`sponsor`) pays the 0.5 XLM trustline reserve;
 * the user signs only the `ChangeTrust`/`END_SPONSORING` ops. Pair with
 * `buildAuthorizeTx` (run by the integrator, no user signature) to authorize.
 *
 * Signers required on the returned XDR: `sponsor` (begin-sponsor) + `user`.
 *
 * SECURITY: `config.assetCode`/`assetIssuer` become the `ChangeTrust` asset the
 * user signs. If `config` came from `discoverOnboarder`, reconcile it against
 * the pinned registry first (pass `network` to `discoverOnboarder`, or call
 * `reconcileWithRegistry`) so a spoofed `stellar.toml` cannot trick the user
 * into trusting a counterfeit issuer for a well-known code.
 */
export async function buildSponsoredOnboardTx(opts: {
	horizonUrl: string
	networkPassphrase: string
	/** The integrator account paying the reserve. */
	sponsor: string
	user: string
	config: OnboarderConfig
	/** Set when the user account does not exist yet (sponsored CreateAccount). */
	createUserAccount?: boolean
	/** Allow a cleartext-http Horizon; defaults to localhost-only (`defaultAllowHttp`). */
	allowHttp?: boolean
}): Promise<string> {
	const horizon = new Horizon.Server(opts.horizonUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.horizonUrl),
	})
	const src = await horizon.loadAccount(opts.sponsor)
	const asset = new Asset(opts.config.assetCode, opts.config.assetIssuer)
	const b = new TransactionBuilder(src, {
		fee: BASE_FEE,
		networkPassphrase: opts.networkPassphrase,
	}).addOperation(
		Operation.beginSponsoringFutureReserves({ sponsoredId: opts.user }),
	)
	if (opts.createUserAccount) {
		b.addOperation(
			Operation.createAccount({ destination: opts.user, startingBalance: "0" }),
		)
	}
	b.addOperation(Operation.changeTrust({ asset, source: opts.user }))
	b.addOperation(Operation.endSponsoringFutureReserves({ source: opts.user }))
	return b.setTimeout(180).build().toXDR()
}

export interface OnboardingRequest {
	/** SEP-7 `web+stellar:tx` URI — open in any Stellar wallet to sign once. */
	sep7Uri: string
	/** Wallet deep-link (SEP-7 is the registered scheme). */
	deepLink: string
	/**
	 * Hosted activation page, prefilled for the user — present ONLY when the
	 * caller supplies `hostedBase` (an origin they control). There is no default
	 * host: an integrator must opt into a hosting origin explicitly.
	 */
	hostedUrl?: string
}

/**
 * Turn an unsigned onboarding transaction into the three handoff forms an
 * integrator can present to the user (Case B/C — user signs once).
 */
export function onboardingRequest(opts: {
	txXdr: string
	networkPassphrase: string
	userAddress: string
	/** Optional callback the wallet returns to after signing (SEP-7 `callback`). */
	callback?: string
	/** Base URL of the hosted activation page. */
	hostedBase?: string
	/** Optional human message shown by the wallet (SEP-7 `msg`). */
	msg?: string
}): OnboardingRequest {
	const params = new URLSearchParams()
	params.set("xdr", opts.txXdr)
	params.set("network_passphrase", opts.networkPassphrase)
	if (opts.callback) params.set("callback", opts.callback)
	if (opts.msg) params.set("msg", opts.msg)
	const sep7 = `web+stellar:tx?${params.toString()}`
	const out: OnboardingRequest = { sep7Uri: sep7, deepLink: sep7 }
	if (opts.hostedBase) {
		const base = opts.hostedBase.replace(/\/$/, "")
		out.hostedUrl = `${base}?address=${encodeURIComponent(opts.userAddress)}`
	}
	return out
}

/** Convenience: rebuild a sponsor `Account` object (sequence) from a raw value. */
export function asAccount(accountId: string, sequence: string): Account {
	return new Account(accountId, sequence)
}
