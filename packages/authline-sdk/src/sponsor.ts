import {
	Asset,
	BASE_FEE,
	TransactionBuilder,
	type Operation,
	type Transaction,
} from "@stellar/stellar-sdk"
import { type OnboarderConfig } from "./index.js"

/**
 * Sponsorship: how an integrator pays for a holder's onboarding.
 *
 * Two protocol features, for two different costs:
 *
 *   - the RESERVE (0.5 XLM per trustline, +1 XLM for a new account) is covered
 *     by CAP-33 sponsorship — the sponsor signs `BeginSponsoringFutureReserves`;
 *   - the FEE is covered by a CAP-15 fee bump — {@link buildFeeBump} wraps a
 *     transaction the holder has ALREADY signed.
 *
 * The operational consequence is the reason to prefer this shape: a fee-bump
 * envelope carries no sequence number of its own (the inner transaction's is
 * used), so an operations account that only ever *signs* — never sources —
 * consumes no sequence and cannot become a serialization bottleneck, however
 * many holders onboard at once.
 */

/** Effective source of an operation: its own, or the transaction's. */
function sourceOf(op: Operation, tx: Transaction): string {
	return op.source ?? tx.source
}

/**
 * Assert that `txXdr` is safe for `sponsor` to sign.
 *
 * THIS IS THE SECURITY BOUNDARY for an operations account. `BeginSponsoringFutureReserves`
 * sponsors *every* reserve created until the matching end — so blind-signing a
 * transaction someone else built lets them park arbitrary reserve-consuming
 * entries (extra trustlines, data entries, signers, claimable balances) on the
 * sponsor's balance, or gift themselves XLM through a `CreateAccount` starting
 * balance. An operations account MUST therefore either build the transaction
 * itself or run it through this check before adding its signature.
 *
 * Accepts exactly the two onboarding shapes this SDK produces and nothing else:
 *
 *   sponsor-sourced (new account):
 *     Begin(sponsor) · CreateAccount(user, 0) · ChangeTrust(user) · End(user)
 *   user-sourced (existing account):
 *     Begin(sponsor) · ChangeTrust(user) · End(user)
 *
 * Throws with a specific reason on anything else. Returns silently when safe.
 */
export function assertSafeToSponsor(opts: {
	txXdr: string
	networkPassphrase: string
	/** The operations account being asked to sign. */
	sponsor: string
	/** The holder being onboarded — the only account that may be sponsored. */
	user: string
	config: Pick<OnboarderConfig, "assetCode" | "assetIssuer">
}): void {
	const parsed = TransactionBuilder.fromXDR(opts.txXdr, opts.networkPassphrase)
	if ("innerTransaction" in parsed) {
		throw new Error(
			"refusing to vet a fee-bump envelope — check the inner transaction, " +
				"which is what actually creates the sponsored reserves",
		)
	}
	const tx = parsed
	const bad = (why: string) => {
		throw new Error(`unsafe to sponsor: ${why}`)
	}

	if (tx.source !== opts.sponsor && tx.source !== opts.user) {
		bad(
			`the transaction is sourced by ${tx.source}, which is neither the ` +
				`sponsor nor the holder`,
		)
	}

	const ops = tx.operations
	if (ops.length < 3) bad(`expected at least 3 operations, got ${ops.length}`)

	// ── The sponsorship window must open first and close last, so nothing can
	// ── be smuggled in outside our inspection of the middle.
	const first = ops[0]
	if (first.type !== "beginSponsoringFutureReserves") {
		bad(
			`the first operation is ${first.type}, not beginSponsoringFutureReserves`,
		)
	}
	const begin = first as Operation.BeginSponsoringFutureReserves
	if (begin.sponsoredId !== opts.user) {
		bad(
			`the sponsorship names ${begin.sponsoredId}, not the holder ${opts.user}`,
		)
	}
	if (sourceOf(begin, tx) !== opts.sponsor) {
		bad(
			`the sponsoring operation is sourced by ${sourceOf(begin, tx)}, ` +
				`not the sponsor`,
		)
	}

	const last = ops[ops.length - 1]
	if (last.type !== "endSponsoringFutureReserves") {
		bad(
			`the sponsorship window is not closed by the final operation ` +
				`(${last.type}) — everything after an unclosed Begin is sponsored`,
		)
	}
	if (sourceOf(last, tx) !== opts.user) {
		bad(
			`the sponsorship is ended by ${sourceOf(last, tx)}, not the holder — ` +
				`only the sponsored account may close its own window`,
		)
	}

	// ── The middle: exactly the reserve-creating work we intend to pay for.
	const middle = ops.slice(1, -1)
	let trustlines = 0
	for (const op of middle) {
		if (op.type === "changeTrust") {
			trustlines++
			const ct = op as Operation.ChangeTrust
			const line = ct.line
			if (!(line instanceof Asset)) {
				bad("the trustline is a liquidity-pool share, not the asset")
			}
			const asset = line as Asset
			if (
				asset.getCode() !== opts.config.assetCode ||
				asset.getIssuer() !== opts.config.assetIssuer
			) {
				bad(
					`the trustline is for ${asset.getCode()}:${asset.getIssuer()}, ` +
						`not ${opts.config.assetCode}:${opts.config.assetIssuer}`,
				)
			}
			if (ct.limit !== undefined && Number(ct.limit) === 0) {
				bad(
					"the trustline limit is 0, which deletes the line rather than opening it",
				)
			}
			if (sourceOf(ct, tx) !== opts.user) {
				bad(`the trustline is opened for ${sourceOf(ct, tx)}, not the holder`)
			}
		} else if (op.type === "createAccount") {
			const ca = op as Operation.CreateAccount
			if (ca.destination !== opts.user) {
				bad(`the transaction creates ${ca.destination}, not the holder`)
			}
			// A starting balance is paid from the sponsor's SPENDABLE XLM, not
			// out of sponsored reserves — an unbounded gift, so it must be zero.
			if (Number(ca.startingBalance) !== 0) {
				bad(
					`the new account is funded with ${ca.startingBalance} XLM of the ` +
						`sponsor's own balance; the sponsored base reserve is enough`,
				)
			}
			if (sourceOf(ca, tx) !== opts.sponsor) {
				bad(
					`the account creation is sourced by ${sourceOf(ca, tx)}, not the sponsor`,
				)
			}
		} else {
			// Anything else inside an open sponsorship window is a reserve the
			// sponsor did not agree to pay for, or an outright transfer.
			bad(`unexpected operation inside the sponsorship window: ${op.type}`)
		}
	}
	if (trustlines !== 1) {
		bad(`expected exactly 1 trustline to sponsor, found ${trustlines}`)
	}
}

/**
 * Wrap an ALREADY-SIGNED transaction in a CAP-15 fee bump so `feeSource` pays
 * the fee and the holder pays nothing.
 *
 * The inner transaction's signatures survive wrapping — its hash is unchanged —
 * so this is applied AFTER the holder signs. That ordering is what removes the
 * coordination problem from a sponsored handoff: there is no pre-signed envelope
 * ageing on the sponsor's sequence number, because the fee bump has no sequence
 * number at all.
 *
 * `baseFee` is per operation and the network charges `baseFee * (innerOps + 1)`;
 * it must be at least the inner transaction's own per-operation fee.
 */
export function buildFeeBump(opts: {
	/** Base64 XDR of the signed inner transaction. */
	innerXdr: string
	networkPassphrase: string
	/** The operations account paying the fee. Consumes no sequence number. */
	feeSource: string
	/** Per-operation fee in stroops (default: {@link BASE_FEE}). */
	baseFee?: string
}): string {
	const inner = TransactionBuilder.fromXDR(
		opts.innerXdr,
		opts.networkPassphrase,
	)
	if ("innerTransaction" in inner) {
		throw new Error("innerXdr is already a fee-bump transaction")
	}
	if (inner.signatures.length === 0) {
		throw new Error(
			"the inner transaction is unsigned — a fee bump does not authorize it, " +
				"so wrapping it now would only pay for a transaction nobody signed",
		)
	}
	return TransactionBuilder.buildFeeBumpTransaction(
		opts.feeSource,
		opts.baseFee ?? BASE_FEE,
		inner,
		opts.networkPassphrase,
	).toXDR()
}
