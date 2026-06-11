import {
	Account,
	Asset,
	BASE_FEE,
	Contract,
	Keypair,
	TransactionBuilder,
	rpc,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import { defaultAllowHttp } from "./onboard.js"

export interface ActivationStatus {
	/** Whether the account holds a trustline for the asset. */
	hasTrustline: boolean
	/** Whether that trustline is authorized (AUTH_REQUIRED satisfied). */
	isAuthorized: boolean
	/** Whether the trustline holds partial authorization (maintain liabilities only). */
	isAuthorizedToMaintainLiabilities: boolean
	/**
	 * The SAC's own view, read by simulating `authorized(account)` against the
	 * asset's Stellar Asset Contract. For a G-account this reflects the same
	 * classic trustline flag as {@link isAuthorized} — reading both confirms the
	 * Soroban path agrees with the ledger. `false` without a trustline (the SAC
	 * traps on a missing trustline entry, which semantically is "not authorized").
	 * `undefined` when no `sac`/`networkPassphrase` was supplied or the
	 * simulation failed.
	 */
	sacAuthorized?: boolean
	/**
	 * Set when a read failed and the booleans above defaulted to `false`. The
	 * pre-check stays non-throwing (the activate flow surfaces real submit
	 * errors), but callers can now tell "not activated" from "could not read".
	 */
	readError?: string
}

/** AUTHORIZED flag bit on a classic trustline (`TrustLineFlags::AUTHORIZED_FLAG`). */
const AUTHORIZED_FLAG = 1
/** AUTHORIZED_TO_MAINTAIN_LIABILITIES flag bit (partial authorization). */
const AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG = 2

/**
 * Simulate the SAC's `authorized(account)` view call. Verified to decode in
 * pure JS under Protocol 26 (the P26 decode caveat applies only to
 * simulations that WRITE a trustline authorization flag, not reads). The
 * sequence number is irrelevant to simulation, so a dummy source Account
 * avoids a getAccount round-trip.
 */
async function simulateSacAuthorized(
	server: rpc.Server,
	networkPassphrase: string,
	sac: string,
	account: string,
): Promise<boolean> {
	const tx = new TransactionBuilder(new Account(account, "0"), {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.addOperation(
			new Contract(sac).call(
				"authorized",
				xdr.ScVal.scvAddress(
					xdr.ScAddress.scAddressTypeAccount(
						Keypair.fromPublicKey(account).xdrAccountId(),
					),
				),
			),
		)
		.setTimeout(60)
		.build()
	const sim = await server.simulateTransaction(tx)
	if (!rpc.Api.isSimulationSuccess(sim) || !sim.result)
		throw new Error(
			`SAC authorized() simulation failed: ${"error" in sim ? sim.error : "no result"}`,
		)
	const val: unknown = scValToNative(sim.result.retval)
	if (typeof val !== "boolean")
		throw new Error(`SAC authorized() returned a non-boolean: ${String(val)}`)
	return val
}

/**
 * Whether `account` already holds an authorized trustline for the asset, read
 * straight from the ledger via Stellar RPC (`getLedgerEntries`) — no Horizon.
 * Lets the UI short-circuit ("already activated") instead of prompting a
 * signature, and the e2e suites assert the post-onboard trustline state.
 *
 * Classic trustline flags are the ground truth. When `sac` and
 * `networkPassphrase` are supplied, the SAC's `authorized(account)` view is
 * also simulated so callers can confirm the Soroban-level state agrees.
 *
 * A missing trustline or an unfunded account reads as the not-activated
 * `{ false, false, false }`; a read error does too, but is surfaced in
 * `readError` so callers can tell the cases apart. (A misconfigured
 * insecure-http endpoint still throws at construction.)
 */
export async function getActivationStatus(args: {
	/** Stellar RPC URL — the same endpoint used to build and submit the onboard tx. */
	rpcUrl: string
	account: string
	assetCode: string
	assetIssuer: string
	/** The asset's SAC id — enables the `sacAuthorized` view read. */
	sac?: string
	/** Network passphrase — required for the `sacAuthorized` view read. */
	networkPassphrase?: string
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
	const wantSac = Boolean(args.sac && args.networkPassphrase)
	try {
		const { entries } = await server.getLedgerEntries(key)
		if (!entries || entries.length === 0)
			return {
				hasTrustline: false,
				isAuthorized: false,
				isAuthorizedToMaintainLiabilities: false,
				// No trustline entry → the SAC's authorized() traps; semantically
				// "not authorized", so report false instead of simulating. The one
				// exception is the issuer's own account: it never holds a trustline
				// to itself, yet the SAC reports it as always authorized.
				...(wantSac
					? { sacAuthorized: args.account === args.assetIssuer }
					: {}),
			}
		const tl = entries[0].val.trustLine()
		const flags = tl.flags()
		const status: ActivationStatus = {
			hasTrustline: true,
			isAuthorized: (flags & AUTHORIZED_FLAG) !== 0,
			isAuthorizedToMaintainLiabilities:
				(flags & AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG) !== 0,
		}
		if (wantSac) {
			try {
				status.sacAuthorized = await simulateSacAuthorized(
					server,
					args.networkPassphrase as string,
					args.sac as string,
					args.account,
				)
			} catch (e) {
				// Classic flags stay authoritative; the SAC view is best-effort.
				status.readError = e instanceof Error ? e.message : String(e)
			}
		}
		return status
	} catch (e) {
		// Unfunded/missing account or a transient read error → not yet activated,
		// with the failure surfaced so callers can tell it apart.
		return {
			hasTrustline: false,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: false,
			readError: e instanceof Error ? e.message : String(e),
		}
	}
}
