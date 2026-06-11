import {
	Account,
	Address,
	Asset,
	BASE_FEE,
	Contract,
	Keypair,
	StrKey,
	TransactionBuilder,
	rpc,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import { defaultAllowHttp } from "./onboard.js"

export interface ActivationStatus {
	/**
	 * What kind of holder `account` is: a classic G-account or a Soroban
	 * contract (e.g. a passkey smart account). Contract holders cannot hold
	 * classic trustlines — their asset state lives in the SAC's contract-data
	 * Balance entry, so `sacAuthorized` is the authoritative signal for them.
	 */
	holderKind: "account" | "contract"
	/** Whether the account holds a classic trustline (always false for contracts). */
	hasTrustline: boolean
	/** Whether that trustline is authorized (AUTH_REQUIRED satisfied; classic only). */
	isAuthorized: boolean
	/** Whether the trustline holds partial authorization (maintain liabilities only). */
	isAuthorizedToMaintainLiabilities: boolean
	/**
	 * The SAC's own view, read by simulating `authorized(account)` against the
	 * asset's Stellar Asset Contract. For a G-account this reflects the same
	 * classic trustline flag as {@link isAuthorized} — reading both confirms the
	 * Soroban path agrees with the ledger. For a CONTRACT holder this is the
	 * real authorization state (SAC defaults: true for open assets, false for
	 * AUTH_REQUIRED ones). For a G-account without a trustline the SAC traps,
	 * which semantically is "not authorized" → reported as `false` without
	 * simulating. `undefined` when no `sac`/`networkPassphrase` was supplied or
	 * the simulation failed.
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
 * (the asset issuer — always a funded G-account) avoids a getAccount
 * round-trip and works for both G and C holders.
 */
async function simulateSacAuthorized(
	server: rpc.Server,
	networkPassphrase: string,
	sac: string,
	account: string,
	simSource: string,
): Promise<boolean> {
	const tx = new TransactionBuilder(new Account(simSource, "0"), {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.addOperation(
			new Contract(sac).call("authorized", new Address(account).toScVal()),
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
 * Whether `account` already holds an authorized position in the asset, read
 * straight from the ledger via Stellar RPC (`getLedgerEntries`) — no Horizon.
 * Lets the UI short-circuit ("already activated") instead of prompting a
 * signature, and the e2e suites assert the post-onboard state.
 *
 * G-accounts: classic trustline flags are the ground truth; when `sac` and
 * `networkPassphrase` are supplied, the SAC's `authorized(account)` view is
 * also simulated so callers can confirm the Soroban-level state agrees.
 *
 * Contract holders (C-addresses, e.g. passkey smart accounts): there is no
 * trustline — the SAC view is the authoritative state and requires `sac` +
 * `networkPassphrase`.
 *
 * A missing trustline or an unfunded account reads as not-activated; a read
 * failure does too, but is surfaced in `readError` so callers can tell the
 * cases apart. This function never rejects for a bad/unreadable ACCOUNT —
 * only for static misconfiguration (an insecure non-localhost http RPC
 * throws at Server construction).
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
	const isContract = StrKey.isValidContract(args.account)
	const holderKind = isContract ? ("contract" as const) : ("account" as const)
	const wantSac = Boolean(args.sac && args.networkPassphrase)

	const notActivated = (readError?: string): ActivationStatus => ({
		holderKind,
		hasTrustline: false,
		isAuthorized: false,
		isAuthorizedToMaintainLiabilities: false,
		...(readError ? { readError } : {}),
	})

	// ── Contract holder: no trustline exists or ever will — the SAC's
	// contract-data Balance entry (read via authorized()) IS the state. ──
	if (isContract) {
		// Without the SAC view there is NOTHING readable for a contract holder —
		// say so instead of returning a definitive-looking "not activated".
		if (!wantSac)
			return notActivated(
				"contract holders require `sac` and `networkPassphrase` — there is no trustline to read",
			)
		const status = notActivated()
		try {
			status.sacAuthorized = await simulateSacAuthorized(
				server,
				args.networkPassphrase as string,
				args.sac as string,
				args.account,
				args.assetIssuer,
			)
		} catch (e) {
			status.readError = e instanceof Error ? e.message : String(e)
		}
		return status
	}

	// ── Classic G-account holder. ──
	try {
		// Inside the try: an invalid/malformed account must surface as readError,
		// not a rejection (the documented non-throwing contract).
		const key = xdr.LedgerKey.trustline(
			new xdr.LedgerKeyTrustLine({
				accountId: Keypair.fromPublicKey(args.account).xdrAccountId(),
				asset: new Asset(
					args.assetCode,
					args.assetIssuer,
				).toTrustLineXDRObject(),
			}),
		)
		const { entries } = await server.getLedgerEntries(key)
		if (!entries || entries.length === 0)
			return {
				...notActivated(),
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
			holderKind,
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
					args.assetIssuer,
				)
			} catch (e) {
				// Classic flags stay authoritative; the SAC view is best-effort.
				status.readError = e instanceof Error ? e.message : String(e)
			}
		}
		return status
	} catch (e) {
		// Unfunded/missing/malformed account or a transient read error → not yet
		// activated, with the failure surfaced so callers can tell it apart.
		return notActivated(e instanceof Error ? e.message : String(e))
	}
}
