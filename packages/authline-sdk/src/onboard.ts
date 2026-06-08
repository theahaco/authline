import {
	Address,
	BASE_FEE,
	Contract,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import { type OnboarderConfig } from "./index.js"

/**
 * Allow cleartext http only for a local RPC (localhost / 127.0.0.1) unless the
 * caller explicitly overrides `allowHttp`. Keeps the secure default for remote
 * RPC while letting local/standalone dev (http RPC) work without a footgun.
 */
export function defaultAllowHttp(rpcUrl: string): boolean {
	try {
		const h = new URL(rpcUrl).hostname
		return h === "localhost" || h === "127.0.0.1"
	} catch {
		return false
	}
}

export interface BuildOnboardOptions {
	/** Soroban RPC URL. */
	rpcUrl: string
	/** Network passphrase (mainnet / testnet). */
	networkPassphrase: string
	/** The holder's account (G...), who signs the single resulting transaction. */
	holder: string
	/** Resolved onboarder config (see `discoverOnboarder`). Must include `onboard`. */
	config: OnboarderConfig
	allowHttp?: boolean
}

/**
 * Build the **one-signature** CAP-73 onboarding transaction. The returned base64
 * XDR is unsigned: hand it to the wallet (e.g. Stellar Wallets Kit) for the
 * holder to sign, then submit via Soroban RPC.
 *
 * On-chain this invokes `onboard(sac, authorizer, holder)`, which runs
 * `SAC.trust(holder)` (CAP-73, Protocol 26) and `authorizer.authorize_trustline(holder)`
 * under the holder's single authorization.
 *
 * Note: CAP-73 `trust()` has no sponsorship — the holder must control a funded,
 * on-ledger account that can cover the 0.5 XLM trustline reserve. For a brand-new
 * or under-funded account, use the CAP-33 sponsored path instead.
 *
 * SECURITY: `config` carries the on-chain ids (`sac`, `authorizer`, `onboard`)
 * the holder will authorize in one signature. If it originated from
 * `discoverOnboarder` (an issuer-advertised, untrusted stellar.toml), it MUST be
 * reconciled against the pinned registry first — pass `network` to
 * `discoverOnboarder` or call `reconcileWithRegistry` — or a spoofed toml can
 * redirect the trustline/authorize to attacker-controlled contracts.
 */
export async function buildOnboardTx(
	opts: BuildOnboardOptions,
): Promise<string> {
	if (!opts.config.onboard) {
		throw new Error(
			"config.onboard is required for the one-signature path; the issuer has not deployed the onboard wrapper",
		)
	}
	if (!opts.config.sac || !opts.config.authorizer) {
		throw new Error(
			"config.sac and config.authorizer are required for the one-signature CAP-73 path " +
				"(regulated / AUTH_REQUIRED assets). An open asset has no authorizer — use " +
				"buildSponsoredOnboardTx instead.",
		)
	}
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const source = await server.getAccount(opts.holder)

	const onboard = new Contract(opts.config.onboard)
	const op = onboard.call(
		"onboard",
		new Address(opts.config.sac).toScVal(),
		new Address(opts.config.authorizer).toScVal(),
		new Address(opts.holder).toScVal(),
	)

	const tx = new TransactionBuilder(source, {
		fee: BASE_FEE,
		networkPassphrase: opts.networkPassphrase,
	})
		.addOperation(op)
		.setTimeout(180)
		.build()

	// Simulate + assemble footprint/resource fees so the tx is submit-ready.
	const prepared = await server.prepareTransaction(tx)
	return prepared.toXDR()
}

export interface BuildTrustOptions {
	/** Soroban RPC URL. */
	rpcUrl: string
	/** Network passphrase (mainnet / testnet). */
	networkPassphrase: string
	/** The holder's account (G...), who signs the single resulting transaction. */
	holder: string
	/** Resolved config; only `sac` is used. `authorizer`/`onboard` are ignored. */
	config: OnboarderConfig
	allowHttp?: boolean
}

/**
 * Build the **one-signature** CAP-73 trust transaction for an OPEN asset.
 * Invokes `SAC.trust(holder)` directly (no authorizer, no onboard wrapper):
 * for a non-`AUTH_REQUIRED` asset the trustline is created already authorized
 * under the holder's single signature. The returned base64 XDR is unsigned —
 * hand it to the wallet to sign, then submit via Soroban RPC.
 *
 * Like CAP-73 `trust()`, this has no sponsorship: the holder must control a
 * funded account that can cover the 0.5 XLM trustline reserve. For a regulated
 * (`AUTH_REQUIRED`) asset use {@link buildOnboardTx} instead.
 *
 * SECURITY: `config.sac` is the contract the holder's trustline is created
 * against. If `config` originated from `discoverOnboarder` (an untrusted
 * stellar.toml), reconcile it against the pinned registry first
 * (`reconcileWithRegistry`, or pass `network` to `discoverOnboarder`) so a
 * spoofed toml cannot redirect the trustline to an attacker-controlled SAC.
 */
export async function buildTrustTx(opts: BuildTrustOptions): Promise<string> {
	if (!opts.config.sac) {
		throw new Error(
			"config.sac is required for the CAP-73 trust path (open asset)",
		)
	}
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const source = await server.getAccount(opts.holder)

	const sac = new Contract(opts.config.sac)
	const op = sac.call("trust", new Address(opts.holder).toScVal())

	const tx = new TransactionBuilder(source, {
		fee: BASE_FEE,
		networkPassphrase: opts.networkPassphrase,
	})
		.addOperation(op)
		.setTimeout(180)
		.build()

	// Simulate + assemble footprint/resource fees so the tx is submit-ready.
	const prepared = await server.prepareTransaction(tx)
	return prepared.toXDR()
}
