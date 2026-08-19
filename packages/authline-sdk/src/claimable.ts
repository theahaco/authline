import {
	Account,
	Asset,
	BASE_FEE,
	Claimant,
	Operation,
	StrKey,
	TransactionBuilder,
	rpc,
	xdr,
} from "@stellar/stellar-sdk"
import { defaultAllowHttp } from "./onboard.js"
import { type OnboarderConfig } from "./index.js"

/**
 * Claimable-balance delivery — the "recipient isn't ready" path.
 *
 * An exchange processing a withdrawal cannot pay a user who holds no trustline:
 * the payment bounces. Instead of blocking the withdrawal on the user, the
 * exchange sends a CLAIMABLE BALANCE, which needs no trustline on the recipient
 * side, and the user claims it later on the activation page.
 *
 * The claim itself carries the onboarding: the claim transaction opens the
 * trustline (reserve sponsored by the exchange) and claims the balance in ONE
 * classic transaction, so the user signs ONCE.
 *
 * ── The regulated-asset constraint ──────────────────────────────────────────
 * That single-signature guarantee holds for OPEN assets. For an AUTH_REQUIRED
 * asset the trustline must be AUTHORIZED at claim time, and authorization in
 * this standard is a Soroban call (`Authorizer.authorize_trustline`). A Soroban
 * invocation must be the ONLY operation in its transaction — the network
 * rejects a mixed envelope with "Transaction contains more than one operation"
 * — so authorization cannot be folded in between `changeTrust` and
 * `claimClaimableBalance`. A regulated claim is therefore a three-step plan
 * (see {@link planClaim}), of which the user signs two; the authorize step
 * costs no user signature (Case A). {@link buildClaimTx} still produces the
 * one-signature envelope whenever the trustline is already authorized.
 */

/** How the recipient's claim should be sequenced. See {@link planClaim}. */
export type ClaimStepKind =
	| "create-trustline"
	| "authorize"
	| "claim"
	| "claim-with-trustline"

export interface ClaimStep {
	kind: ClaimStepKind
	/** Who must sign this step. `integrator` steps cost the user nothing. */
	signer: "user" | "integrator" | "user+integrator"
	/** Human-readable purpose, safe to surface in a UI. */
	description: string
}

export interface ClaimPlan {
	steps: ClaimStep[]
	/** How many signatures the USER must provide across the whole plan. */
	userSignatures: number
}

/**
 * Decide how a given recipient claims a balance for a given asset, from the
 * activation status already read via `getActivationStatus`.
 *
 * - No trustline, OPEN asset → a single `claim-with-trustline` transaction
 *   (one user signature): sponsored `ChangeTrust` + `ClaimClaimableBalance`.
 * - Trustline exists and is authorized → a single `claim` (one user signature).
 * - No trustline, AUTH_REQUIRED asset → three steps, two of them signed by the
 *   user, with the integrator's permissionless `authorize` in between.
 * - Trustline exists but is unauthorized → `authorize` (integrator, no user
 *   signature) then `claim` (one user signature).
 */
export function planClaim(args: {
	/** Whether the recipient already holds a classic trustline for the asset. */
	hasTrustline: boolean
	/** Whether that trustline is authorized. */
	isAuthorized: boolean
	/** Whether the asset is AUTH_REQUIRED (needs an authorize step at all). */
	authRequired: boolean
}): ClaimPlan {
	const { hasTrustline, isAuthorized, authRequired } = args

	if (hasTrustline && (isAuthorized || !authRequired)) {
		return {
			steps: [
				{
					kind: "claim",
					signer: "user",
					description: "Claim the balance into the existing trustline.",
				},
			],
			userSignatures: 1,
		}
	}

	if (hasTrustline) {
		// Unauthorized line on a regulated asset: the integrator authorizes for
		// free (Case A), then the user's single signature claims.
		return {
			steps: [
				{
					kind: "authorize",
					signer: "integrator",
					description:
						"Authorize the existing trustline on the issuer's behalf (no user signature).",
				},
				{
					kind: "claim",
					signer: "user",
					description: "Claim the balance.",
				},
			],
			userSignatures: 1,
		}
	}

	if (!authRequired) {
		// The headline case: one signature opens the trustline AND claims.
		return {
			steps: [
				{
					kind: "claim-with-trustline",
					signer: "user+integrator",
					description:
						"Open the trustline (reserve sponsored) and claim the balance in one transaction.",
				},
			],
			userSignatures: 1,
		}
	}

	// Regulated + no trustline. A Soroban authorize cannot share a transaction
	// with classic ops, so the claim cannot be fused onto the trustline.
	return {
		steps: [
			{
				kind: "create-trustline",
				signer: "user+integrator",
				description:
					"Open the trustline, reserve sponsored by the integrator (user signs).",
			},
			{
				kind: "authorize",
				signer: "integrator",
				description:
					"Authorize the trustline on the issuer's behalf (no user signature).",
			},
			{
				kind: "claim",
				signer: "user",
				description: "Claim the balance (user signs).",
			},
		],
		userSignatures: 2,
	}
}

export interface ClaimableDelivery {
	/** Unsigned base64 XDR — the integrator signs with `sender` and submits. */
	xdr: string
	/**
	 * The claimable balance id (`00…`, 72 hex chars) this transaction will
	 * create. DERIVED from the sender's account id and the sequence number
	 * baked into `xdr` — if you rebuild the transaction (a re-fetch bumps the
	 * sequence) the id changes, so keep this pair together.
	 */
	balanceId: string
}

/**
 * Build the exchange-side **claimable-balance delivery**: pay a user who has no
 * usable trustline, without bouncing the withdrawal.
 *
 * The recipient is an unconditional claimant. When `reclaimAfterSeconds` is
 * set, the sender is added as a second claimant that becomes eligible only
 * after that delay (`not(beforeRelativeTime)`), so an unclaimed balance — and
 * the reserve backing it — can be swept back instead of being stranded
 * forever. The recipient's own predicate stays unconditional, so a reclaim
 * window never blocks a user who claims in time. If the sender IS the
 * recipient the sweep claimant is omitted rather than duplicated — Stellar
 * rejects a repeated destination as malformed.
 *
 * Signers required on the returned XDR: `sender`.
 */
export function buildClaimableBalanceDelivery(opts: {
	networkPassphrase: string
	/** The integrator account funding and sending the balance. */
	sender: string
	/** Current sequence number of `sender`, as returned by RPC/Horizon. */
	senderSequence: string
	/** The recipient (G-address) who may claim. */
	recipient: string
	/** Amount, as a decimal string (e.g. "100.0000000"). */
	amount: string
	config: Pick<OnboarderConfig, "assetCode" | "assetIssuer">
	/**
	 * Optional sweep window: after this many seconds the SENDER may also claim,
	 * recovering an abandoned balance. Omit for a strictly one-way delivery.
	 */
	reclaimAfterSeconds?: number
}): ClaimableDelivery {
	if (!StrKey.isValidEd25519PublicKey(opts.recipient)) {
		throw new Error(
			`recipient must be a classic G-address — claimable balances cannot ` +
				`name a contract as claimant: ${opts.recipient}`,
		)
	}
	if (!(Number(opts.amount) > 0)) {
		throw new Error(`amount must be a positive decimal string: ${opts.amount}`)
	}

	const claimants = [
		new Claimant(opts.recipient, Claimant.predicateUnconditional()),
	]
	if (opts.reclaimAfterSeconds !== undefined) {
		if (
			!Number.isFinite(opts.reclaimAfterSeconds) ||
			opts.reclaimAfterSeconds <= 0
		) {
			throw new Error(
				`reclaimAfterSeconds must be a positive number of seconds: ${opts.reclaimAfterSeconds}`,
			)
		}
		// Stellar rejects an operation that names the same destination twice
		// (CREATE_CLAIMABLE_BALANCE_MALFORMED). When the sender IS the
		// recipient the sweep claimant would be that duplicate — and it would
		// add nothing, since the recipient can already claim unconditionally,
		// which is strictly better than waiting out the delay. So omit it.
		if (opts.sender !== opts.recipient) {
			claimants.push(
				new Claimant(
					opts.sender,
					Claimant.predicateNot(
						Claimant.predicateBeforeRelativeTime(
							String(Math.floor(opts.reclaimAfterSeconds)),
						),
					),
				),
			)
		}
	}

	const tx = new TransactionBuilder(
		// A local Account avoids an RPC round-trip; the caller already holds the
		// sequence. The balance id below depends on it, hence the paired return.
		new Account(opts.sender, opts.senderSequence),
		{ fee: BASE_FEE, networkPassphrase: opts.networkPassphrase },
	)
		.addOperation(
			Operation.createClaimableBalance({
				asset: new Asset(opts.config.assetCode, opts.config.assetIssuer),
				amount: opts.amount,
				claimants,
			}),
		)
		.setTimeout(180)
		.build()

	return { xdr: tx.toXDR(), balanceId: tx.getClaimableBalanceId(0) }
}

/**
 * Build the recipient's **claim** transaction.
 *
 * When `createTrustline` is set, the transaction also opens the trustline, so
 * the user's SINGLE signature both onboards them and collects the balance:
 *
 *   BeginSponsoringFutureReserves(sponsor) · ChangeTrust(user) ·
 *   EndSponsoringFutureReserves(user) · ClaimClaimableBalance(user)
 *
 * With no `sponsor` the sponsorship pair is omitted and the claimant pays their
 * own 0.5 XLM reserve — the right shape when the user drives the claim from a
 * funded wallet (e.g. an activation page) rather than an exchange handoff.
 *
 * By default the claimant sources the transaction and therefore pays the fee.
 * A user delivered to via a claimable balance is often at (or under) their
 * minimum balance and cannot afford even that, so pass `feeSource` — typically
 * the integrator — to source the envelope elsewhere. The claimant then pays
 * NOTHING: no fee, no reserve, one signature.
 *
 * Signers required: `claimant`, plus `sponsor` and/or `feeSource` when those
 * differ from the claimant.
 *
 * For an AUTH_REQUIRED asset the trustline must already be AUTHORIZED when this
 * lands — a Soroban authorize cannot be folded into this classic envelope. Use
 * {@link planClaim} to sequence it, and run `buildAuthorizeTx` (no user
 * signature) before submitting the claim.
 */
export function buildClaimTx(opts: {
	networkPassphrase: string
	/** The claiming user (G-address), and source of the claim operation. */
	claimant: string
	/**
	 * Sequence number of whichever account sources the transaction — that is
	 * `feeSource` when supplied, otherwise `claimant`.
	 */
	sourceSequence: string
	/** The balance id to claim (from the delivery, or a lookup). */
	balanceId: string
	config: Pick<OnboarderConfig, "assetCode" | "assetIssuer">
	/**
	 * Account that sources the transaction and pays the fee. Defaults to the
	 * claimant; set it to the integrator so a zero-balance user pays nothing.
	 */
	feeSource?: string
	/** Fuse a `ChangeTrust` in front of the claim. */
	createTrustline?: boolean
	/**
	 * The integrator paying the trustline reserve (CAP-33). Omit to have the
	 * claimant pay their own reserve. Must not be the claimant — Stellar
	 * rejects an account sponsoring itself.
	 */
	sponsor?: string
}): string {
	if (opts.sponsor && opts.sponsor === opts.claimant) {
		throw new Error(
			"sponsor must not be the claimant — an account cannot sponsor its own " +
				"reserve; omit `sponsor` to have the claimant pay it directly",
		)
	}
	assertBalanceId(opts.balanceId)

	const source = opts.feeSource ?? opts.claimant
	// Operations only need an explicit source when it differs from the tx
	// source; leaving it undefined keeps the envelope minimal.
	const asUser = source === opts.claimant ? undefined : opts.claimant

	const builder = new TransactionBuilder(
		new Account(source, opts.sourceSequence),
		{ fee: BASE_FEE, networkPassphrase: opts.networkPassphrase },
	)

	if (opts.createTrustline) {
		if (opts.sponsor) {
			builder.addOperation(
				Operation.beginSponsoringFutureReserves({
					sponsoredId: opts.claimant,
					source: opts.sponsor,
				}),
			)
		}
		builder.addOperation(
			Operation.changeTrust({
				asset: new Asset(opts.config.assetCode, opts.config.assetIssuer),
				source: asUser,
			}),
		)
		if (opts.sponsor) {
			builder.addOperation(
				Operation.endSponsoringFutureReserves({ source: asUser }),
			)
		}
	}

	builder.addOperation(
		Operation.claimClaimableBalance({
			balanceId: opts.balanceId,
			source: asUser,
		}),
	)

	return builder.setTimeout(180).build().toXDR()
}

/** A claimable balance as read back off the ledger. */
export interface ClaimableBalanceEntry {
	balanceId: string
	/** Canonical asset string, `CODE:ISSUER` (or `native`). */
	asset: string
	/** Amount as a decimal string. */
	amount: string
	/** Every account named as a claimant. */
	claimants: string[]
	/**
	 * Whether the queried claimant's predicate is satisfied RIGHT NOW. Being
	 * listed as a claimant is not enough: a balance commonly names its sender as
	 * a time-locked reclaim fallback, and claiming before that unlock fails with
	 * `CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM`. Only set by
	 * {@link findClaimableBalances}, which knows which claimant was asked about.
	 */
	claimableNow?: boolean
	/**
	 * When a currently-unclaimable balance becomes claimable, for the simple
	 * `not(before absolute time)` lock that reclaim windows produce. Undefined
	 * for predicates whose unlock instant isn't a single timestamp.
	 */
	claimableAfter?: string
}

/** Horizon's JSON claim predicate. */
interface HorizonPredicate {
	unconditional?: boolean
	abs_before?: string
	rel_before?: string
	not?: HorizonPredicate
	and?: HorizonPredicate[]
	or?: HorizonPredicate[]
}

/**
 * Evaluate a Horizon claim predicate at `now`.
 *
 * `rel_before` is relative to the ledger that CREATED the balance, which the
 * record does not carry — Horizon resolves it to `abs_before` whenever it can.
 * On the rare bare `rel_before` we return `true` rather than hiding a balance
 * that may well be claimable; the submit itself remains the final authority.
 */
function predicateHolds(p: HorizonPredicate | undefined, now: Date): boolean {
	if (!p) return true
	if (p.unconditional) return true
	if (p.not) return !predicateHolds(p.not, now)
	if (p.and) return p.and.every((q) => predicateHolds(q, now))
	if (p.or) return p.or.some((q) => predicateHolds(q, now))
	if (p.abs_before) return now < new Date(p.abs_before)
	if (p.rel_before) return true
	return true
}

/** The instant a `not(abs_before T)` lock opens, if that's the whole predicate. */
function unlockTime(p: HorizonPredicate | undefined): string | undefined {
	return p?.not?.abs_before
}

const BALANCE_ID_RE = /^00[0-9a-f]{70}$/i

function assertBalanceId(id: string): void {
	if (!BALANCE_ID_RE.test(id)) {
		throw new Error(
			`not a claimable balance id (expected 72 hex chars starting "00"): ${id}`,
		)
	}
}

/**
 * Read a claimable balance straight off the ledger by id, via Stellar RPC —
 * no Horizon, matching `getActivationStatus`.
 *
 * Returns `null` when no such balance exists (already claimed, or never
 * created). Use this to confirm a delivery landed and is still claimable
 * before showing the user a claim button.
 */
export async function getClaimableBalance(args: {
	rpcUrl: string
	balanceId: string
	allowHttp?: boolean
}): Promise<ClaimableBalanceEntry | null> {
	assertBalanceId(args.balanceId)
	const server = new rpc.Server(args.rpcUrl, {
		allowHttp: args.allowHttp ?? defaultAllowHttp(args.rpcUrl),
	})
	const key = xdr.LedgerKey.claimableBalance(
		new xdr.LedgerKeyClaimableBalance({
			balanceId: xdr.ClaimableBalanceId.fromXDR(args.balanceId, "hex"),
		}),
	)
	const { entries } = await server.getLedgerEntries(key)
	if (!entries || entries.length === 0) return null
	const cb = entries[0].val.claimableBalance()
	return {
		balanceId: args.balanceId,
		asset: Asset.fromOperation(cb.asset()).toString(),
		amount: formatStroops(cb.amount().toString()),
		claimants: cb.claimants().map((c) => claimantAccountId(c)),
	}
}

function claimantAccountId(c: xdr.Claimant): string {
	return StrKey.encodeEd25519PublicKey(c.v0().destination().ed25519() as Buffer)
}

/** Stroops (int64 string) → the 7-decimal string Stellar amounts use. */
function formatStroops(stroops: string): string {
	const neg = stroops.startsWith("-")
	const digits = (neg ? stroops.slice(1) : stroops).padStart(8, "0")
	const whole = digits.slice(0, -7)
	const frac = digits.slice(-7)
	return `${neg ? "-" : ""}${whole}.${frac}`
}

/**
 * Find the claimable balances an account may claim — for one asset when
 * `config` is given, or across every asset when it is omitted. A page showing
 * several assets should omit it and group the single response by
 * {@link ClaimableBalanceEntry.asset} rather than issuing a request per asset.
 *
 * By default only balances the claimant can claim **right now** are returned.
 * Horizon indexes by claimant without regard to predicates, and a balance
 * routinely names its sender as a time-locked reclaim fallback — so the raw
 * listing includes entries that would fail with
 * `CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM`. Offering those to a user as claimable
 * produces a signature request that cannot succeed. Pass `includeUnclaimable`
 * to get the full list; every entry carries `claimableNow` either way.
 *
 * Enumerating balances BY CLAIMANT requires an index, which Stellar RPC does
 * not provide — so this is the one function here that talks to Horizon, and it
 * is opt-in: pass the `horizonUrl` explicitly. The primary flow never needs it,
 * because the integrator knows the `balanceId` it created and can hand it to
 * the user in the claim link; this covers the "user arrives cold at the
 * activation page" case.
 */
export async function findClaimableBalances(args: {
	horizonUrl: string
	claimant: string
	/** Restrict to one asset. Omit to list every asset waiting for `claimant`. */
	config?: Pick<OnboarderConfig, "assetCode" | "assetIssuer">
	/** Max records to return (Horizon caps at 200). */
	limit?: number
	/** Also return balances this claimant cannot claim yet. */
	includeUnclaimable?: boolean
	/** Evaluation instant for time predicates (defaults to now); for tests. */
	now?: Date
}): Promise<ClaimableBalanceEntry[]> {
	const url = new URL("/claimable_balances", args.horizonUrl)
	url.searchParams.set("claimant", args.claimant)
	if (args.config)
		url.searchParams.set(
			"asset",
			`${args.config.assetCode}:${args.config.assetIssuer}`,
		)
	url.searchParams.set("limit", String(args.limit ?? 50))
	const res = await fetch(url.toString())
	if (!res.ok) {
		throw new Error(
			`Horizon claimable_balances lookup failed: ${res.status} ${res.statusText}`,
		)
	}
	const body = (await res.json()) as {
		_embedded?: {
			records?: {
				id: string
				asset: string
				amount: string
				claimants?: { destination: string; predicate?: HorizonPredicate }[]
			}[]
		}
	}
	const now = args.now ?? new Date()
	const entries = (body._embedded?.records ?? []).map((r) => {
		const mine = (r.claimants ?? []).find(
			(c) => c.destination === args.claimant,
		)
		const claimableAfter = unlockTime(mine?.predicate)
		return {
			balanceId: r.id,
			asset: r.asset,
			amount: r.amount,
			claimants: (r.claimants ?? []).map((c) => c.destination),
			claimableNow: predicateHolds(mine?.predicate, now),
			...(claimableAfter ? { claimableAfter } : {}),
		}
	})
	return args.includeUnclaimable
		? entries
		: entries.filter((e) => e.claimableNow)
}
