import { Asset, Keypair, rpc, xdr } from "@stellar/stellar-sdk"
import { defaultAllowHttp } from "./onboard.js"

export interface ActivationStatus {
	/** Whether the account holds a trustline for the asset. */
	hasTrustline: boolean
	/** Whether that trustline is authorized (AUTH_REQUIRED satisfied). */
	isAuthorized: boolean
}

/** AUTHORIZED flag bit on a classic trustline (`TrustLineFlags::AUTHORIZED_FLAG`). */
const AUTHORIZED_FLAG = 1

/**
 * Whether `account` already holds an authorized trustline for the asset, read
 * straight from the ledger via Stellar RPC (`getLedgerEntries`) — no Horizon.
 * Lets the UI short-circuit ("already activated") instead of prompting a
 * signature, and the e2e suites assert the post-onboard trustline state.
 *
 * A missing trustline, an unfunded account, or a transient read error reads as
 * the not-activated `{ false, false }`: this is an optional pre-check, and the
 * activate() flow itself surfaces any real submit error. (A misconfigured
 * insecure-http endpoint still throws at construction.)
 */
export async function getActivationStatus(args: {
	/** Stellar RPC URL — the same endpoint used to build and submit the onboard tx. */
	rpcUrl: string
	account: string
	assetCode: string
	assetIssuer: string
	/** Allow a cleartext-http RPC; defaults to localhost-only (`defaultAllowHttp`). */
	allowHttp?: boolean
}): Promise<ActivationStatus> {
	const server = new rpc.Server(args.rpcUrl, {
		allowHttp: args.allowHttp ?? defaultAllowHttp(args.rpcUrl),
	})
	const key = xdr.LedgerKey.trustline(
		new xdr.LedgerKeyTrustLine({
			accountId: Keypair.fromPublicKey(args.account).xdrAccountId(),
			asset: new Asset(args.assetCode, args.assetIssuer).toTrustLineXDRObject(),
		}),
	)
	try {
		const { entries } = await server.getLedgerEntries(key)
		if (!entries || entries.length === 0)
			return { hasTrustline: false, isAuthorized: false }
		const tl = entries[0].val.trustLine()
		return {
			hasTrustline: true,
			isAuthorized: (tl.flags() & AUTHORIZED_FLAG) !== 0,
		}
	} catch {
		// Unfunded/missing account or a transient read error → not yet activated.
		return { hasTrustline: false, isAuthorized: false }
	}
}
