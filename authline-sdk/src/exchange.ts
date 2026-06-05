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
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? false,
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
}): Promise<string> {
	const horizon = new Horizon.Server(opts.horizonUrl)
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
	/** Hosted Authline activation page, prefilled for the user. */
	hostedUrl: string
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
	const base = (
		opts.hostedBase ??
		"https://dgetsylver.github.io/trustline-onboarder-wip/app.html"
	).replace(/\/$/, "")
	return {
		sep7Uri: sep7,
		deepLink: sep7,
		hostedUrl: `${base}?address=${encodeURIComponent(opts.userAddress)}`,
	}
}

/** Convenience: rebuild a sponsor `Account` object (sequence) from a raw value. */
export function asAccount(accountId: string, sequence: string): Account {
	return new Account(accountId, sequence)
}
