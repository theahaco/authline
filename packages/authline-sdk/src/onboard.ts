import {
	Address,
	BASE_FEE,
	Contract,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import { type OnboarderConfig } from "./index.js"

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
		allowHttp: opts.allowHttp ?? false,
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
