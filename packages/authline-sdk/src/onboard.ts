import {
	Address,
	BASE_FEE,
	Contract,
	StrKey,
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
	/** Stellar RPC URL. */
	rpcUrl: string
	/** Network passphrase (mainnet / testnet). */
	networkPassphrase: string
	/**
	 * The holder being onboarded. A classic G-account (default: also the tx
	 * source and sole signer) or a CONTRACT address (smart account) — contracts
	 * cannot source a transaction, so `feeSource` is then required and the
	 * holder authorizes via its own SorobanAuthorizationEntry instead
	 * (signed by the smart wallet, e.g. via the kit's signTransaction).
	 */
	holder: string
	/**
	 * Transaction source / fee payer. Defaults to `holder`. REQUIRED (a funded
	 * G-account) when `holder` is a contract address; the resulting tx then
	 * needs TWO signatures: the smart account's auth entry (wallet) and this
	 * account's envelope signature.
	 */
	feeSource?: string
	/** Resolved onboarder config. Must include `sac` and `router`. */
	config: OnboarderConfig
	allowHttp?: boolean
}

/**
 * Build the **one-signature** onboarding transaction. The returned base64 XDR
 * is unsigned: hand it to the wallet (e.g. Stellar Wallets Kit) for the holder
 * to sign, then submit via Stellar RPC.
 *
 * On-chain this invokes the Authline router's `onboard(sac, holder)`, which
 * runs CAP-73 `SAC.trust(holder)` and then DISCOVERS the asset's capability
 * from `SAC.admin()` (CAP-68): an admin contract exposing
 * `authorize_trustline` authorizes the line in the same transaction; an asset
 * with no one-step authorizer keeps the trustline and reports `TrustlineOnly`.
 * There is no open-vs-regulated branching on the client.
 *
 * Note: CAP-73 `trust()` has no sponsorship — the holder must control a
 * funded, on-ledger account that can cover the 0.5 XLM trustline reserve. For
 * a brand-new or under-funded account, use the CAP-33 sponsored path instead.
 *
 * SECURITY: `config.sac` is the contract the holder's trustline is created
 * against, and `config.router` is what the holder authorizes in one
 * signature. If `config` originated from `discoverOnboarder` (an untrusted
 * stellar.toml), it MUST be reconciled against the pinned registry first —
 * pass `network` to `discoverOnboarder` or call `reconcileWithRegistry` —
 * and the router SHOULD be the pinned `ROUTERS` id, never an advertised one.
 */
export async function buildOnboardTx(
	opts: BuildOnboardOptions,
): Promise<string> {
	if (!opts.config.sac) {
		throw new Error("config.sac is required to build the onboard transaction")
	}
	if (!opts.config.router) {
		throw new Error(
			"config.router is required — the Authline onboard router id for this " +
				"network (pin it via ROUTERS or your app's router config)",
		)
	}
	const sourceId = opts.feeSource ?? opts.holder
	if (StrKey.isValidContract(sourceId)) {
		throw new Error(
			"a contract address cannot source a transaction — pass a funded " +
				"G-account as feeSource when onboarding a smart-account holder",
		)
	}
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const source = await server.getAccount(sourceId)

	const router = new Contract(opts.config.router)
	const op = router.call(
		"onboard",
		new Address(opts.config.sac).toScVal(),
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
