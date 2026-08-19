import {
	Networks,
	type Operation,
	TransactionBuilder,
	type Transaction,
} from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	buildClaimTx,
	buildClaimableBalanceDelivery,
	findClaimableBalances,
	planClaim,
} from "./claimable.js"

const SENDER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
const USER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const ISSUER = "GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U"
const CONTRACT = "CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU"
const config = { assetCode: "TLO", assetIssuer: ISSUER }
const net = Networks.TESTNET

const parse = (xdr: string) =>
	TransactionBuilder.fromXDR(xdr, net) as Transaction
const kinds = (xdr: string) =>
	parse(xdr).operations.map((o: Operation) => o.type)

describe("buildClaimableBalanceDelivery", () => {
	const base = {
		networkPassphrase: net,
		sender: SENDER,
		senderSequence: "100",
		recipient: USER,
		amount: "100.0000000",
		config,
	}

	it("creates one claimable balance naming the recipient unconditionally", () => {
		const { xdr, balanceId } = buildClaimableBalanceDelivery(base)
		const tx = parse(xdr)
		expect(tx.operations).toHaveLength(1)
		const op = tx.operations[0] as Operation.CreateClaimableBalance
		expect(op.type).toBe("createClaimableBalance")
		expect(op.claimants).toHaveLength(1)
		expect(op.claimants[0].destination).toBe(USER)
		expect(op.amount).toBe("100.0000000")
		// The id is derived from the sender + sequence baked into this envelope.
		expect(balanceId).toMatch(/^00[0-9a-f]{70}$/)
	})

	it("adds the sender as a time-delayed second claimant when a reclaim window is set", () => {
		const { xdr } = buildClaimableBalanceDelivery({
			...base,
			reclaimAfterSeconds: 86_400,
		})
		const op = parse(xdr).operations[0] as Operation.CreateClaimableBalance
		expect(op.claimants.map((c) => c.destination)).toEqual([USER, SENDER])
		// The recipient must stay unconditional even with a sweep window.
		expect(op.claimants[0].predicate.switch().name).toBe(
			"claimPredicateUnconditional",
		)
		expect(op.claimants[1].predicate.switch().name).toBe("claimPredicateNot")
	})

	it("omits the sweep claimant when the sender is the recipient", () => {
		// Naming the same destination twice is CREATE_CLAIMABLE_BALANCE_MALFORMED.
		const { xdr } = buildClaimableBalanceDelivery({
			...base,
			recipient: SENDER,
			reclaimAfterSeconds: 86_400,
		})
		const op = parse(xdr).operations[0] as Operation.CreateClaimableBalance
		expect(op.claimants).toHaveLength(1)
		expect(op.claimants[0].destination).toBe(SENDER)
		expect(op.claimants[0].predicate.switch().name).toBe(
			"claimPredicateUnconditional",
		)
	})

	it("derives a different balance id for a different sequence number", () => {
		const a = buildClaimableBalanceDelivery(base)
		const b = buildClaimableBalanceDelivery({ ...base, senderSequence: "101" })
		expect(a.balanceId).not.toBe(b.balanceId)
	})

	it("rejects a contract recipient — claimants must be classic accounts", () => {
		expect(() =>
			buildClaimableBalanceDelivery({ ...base, recipient: CONTRACT }),
		).toThrow(/must be a classic G-address/)
	})

	it("rejects a non-positive amount", () => {
		expect(() =>
			buildClaimableBalanceDelivery({ ...base, amount: "0" }),
		).toThrow(/positive decimal/)
	})

	it("rejects a non-positive reclaim window", () => {
		expect(() =>
			buildClaimableBalanceDelivery({ ...base, reclaimAfterSeconds: 0 }),
		).toThrow(/positive number of seconds/)
	})
})

describe("buildClaimTx", () => {
	const balanceId = buildClaimableBalanceDelivery({
		networkPassphrase: net,
		sender: SENDER,
		senderSequence: "100",
		recipient: USER,
		amount: "1",
		config,
	}).balanceId
	const base = {
		networkPassphrase: net,
		claimant: USER,
		sourceSequence: "5",
		balanceId,
		config,
	}

	it("claims alone when the trustline already exists", () => {
		expect(kinds(buildClaimTx(base))).toEqual(["claimClaimableBalance"])
	})

	it("fuses a sponsored trustline onto the claim — one user signature", () => {
		const xdr = buildClaimTx({
			...base,
			createTrustline: true,
			sponsor: SENDER,
		})
		expect(kinds(xdr)).toEqual([
			"beginSponsoringFutureReserves",
			"changeTrust",
			"endSponsoringFutureReserves",
			"claimClaimableBalance",
		])
		const tx = parse(xdr)
		// The user sources the envelope, so their single signature covers it all;
		// only the begin-sponsor op is charged to the integrator.
		expect(tx.source).toBe(USER)
		expect(tx.operations[0].source).toBe(SENDER)
		expect(tx.operations[1].source).toBeUndefined()
		expect(tx.operations[3].source).toBeUndefined()
	})

	it("sources the envelope on the integrator so a broke user pays no fee", () => {
		const xdr = buildClaimTx({
			...base,
			createTrustline: true,
			sponsor: SENDER,
			feeSource: SENDER,
		})
		const tx = parse(xdr)
		// The integrator pays the fee and the reserve; the user still signs once
		// because every op that touches their account names them as source.
		expect(tx.source).toBe(SENDER)
		expect(tx.operations[1].source).toBe(USER)
		expect(tx.operations[2].source).toBe(USER)
		expect(tx.operations[3].source).toBe(USER)
	})

	it("omits the sponsorship pair when the claimant funds their own reserve", () => {
		// The activation-page shape: a funded user claims for themselves.
		expect(kinds(buildClaimTx({ ...base, createTrustline: true }))).toEqual([
			"changeTrust",
			"claimClaimableBalance",
		])
	})

	it("rejects an account sponsoring itself", () => {
		expect(() =>
			buildClaimTx({ ...base, createTrustline: true, sponsor: USER }),
		).toThrow(/must not be the claimant/)
	})

	it("rejects a malformed balance id", () => {
		expect(() => buildClaimTx({ ...base, balanceId: "deadbeef" })).toThrow(
			/not a claimable balance id/,
		)
	})
})

describe("planClaim", () => {
	it("fuses trustline and claim for an open asset — one signature", () => {
		const plan = planClaim({
			hasTrustline: false,
			isAuthorized: false,
			authRequired: false,
		})
		expect(plan.steps.map((s) => s.kind)).toEqual(["claim-with-trustline"])
		expect(plan.userSignatures).toBe(1)
	})

	it("claims directly when an authorized trustline is already in place", () => {
		const plan = planClaim({
			hasTrustline: true,
			isAuthorized: true,
			authRequired: true,
		})
		expect(plan.steps.map((s) => s.kind)).toEqual(["claim"])
		expect(plan.userSignatures).toBe(1)
	})

	it("authorizes for free before claiming an unauthorized regulated trustline", () => {
		const plan = planClaim({
			hasTrustline: true,
			isAuthorized: false,
			authRequired: true,
		})
		expect(plan.steps.map((s) => s.kind)).toEqual(["authorize", "claim"])
		// The authorize costs the user nothing (Case A).
		expect(plan.steps[0].signer).toBe("integrator")
		expect(plan.userSignatures).toBe(1)
	})

	it("splits a regulated cold start into three steps, two user-signed", () => {
		// A Soroban authorize cannot share a transaction with classic ops, so the
		// claim cannot be fused onto the trustline here — this asserts the
		// protocol constraint the module documents.
		const plan = planClaim({
			hasTrustline: false,
			isAuthorized: false,
			authRequired: true,
		})
		expect(plan.steps.map((s) => s.kind)).toEqual([
			"create-trustline",
			"authorize",
			"claim",
		])
		expect(plan.steps[1].signer).toBe("integrator")
		expect(plan.userSignatures).toBe(2)
	})

	it("treats an open asset with an unauthorized trustline as claimable", () => {
		// Open assets have no AUTHORIZED flag to satisfy.
		const plan = planClaim({
			hasTrustline: true,
			isAuthorized: false,
			authRequired: false,
		})
		expect(plan.steps.map((s) => s.kind)).toEqual(["claim"])
		expect(plan.userSignatures).toBe(1)
	})
})

describe("findClaimableBalances — claimability", () => {
	const ME = SENDER
	const OTHER = USER
	const NOW = new Date("2026-08-18T00:00:00Z")

	const record = (id: string, predicate: unknown, dest = ME) => ({
		id,
		asset: `TLO:${ISSUER}`,
		amount: "10.0000000",
		claimants: [{ destination: dest, predicate }],
	})
	const mockHorizon = (records: unknown[]) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ _embedded: { records } }),
			})),
		)
	}
	afterEach(() => vi.unstubAllGlobals())

	const find = (opts = {}) =>
		findClaimableBalances({
			horizonUrl: "https://horizon-testnet.stellar.org",
			claimant: ME,
			now: NOW,
			...opts,
		})

	it("keeps an unconditional claimant", async () => {
		mockHorizon([record("00" + "a".repeat(70), { unconditional: true })])
		const out = await find()
		expect(out).toHaveLength(1)
		expect(out[0].claimableNow).toBe(true)
	})

	it("drops a time-locked reclaim fallback and reports when it opens", async () => {
		// The exact shape a `reclaimAfterSeconds` delivery creates for its SENDER:
		// Horizon lists it, but claiming before the unlock is CANNOT_CLAIM.
		mockHorizon([
			record("00" + "b".repeat(70), {
				not: { abs_before: "2026-09-17T11:43:49Z" },
			}),
		])
		expect(await find()).toHaveLength(0)
		const all = await find({ includeUnclaimable: true })
		expect(all[0].claimableNow).toBe(false)
		expect(all[0].claimableAfter).toBe("2026-09-17T11:43:49Z")
	})

	it("keeps a reclaim fallback once its unlock has passed", async () => {
		mockHorizon([
			record("00" + "c".repeat(70), {
				not: { abs_before: "2026-01-01T00:00:00Z" },
			}),
		])
		expect((await find())[0].claimableNow).toBe(true)
	})

	it("honours a plain deadline predicate", async () => {
		mockHorizon([
			record("00" + "d".repeat(70), { abs_before: "2026-01-01T00:00:00Z" }),
		])
		expect(await find()).toHaveLength(0)
	})

	it("evaluates and/or over nested predicates", async () => {
		mockHorizon([
			record("00" + "e".repeat(70), {
				and: [{ unconditional: true }, { abs_before: "2027-01-01T00:00:00Z" }],
			}),
			record("00" + "f".repeat(70), {
				or: [{ abs_before: "2026-01-01T00:00:00Z" }, { unconditional: true }],
			}),
		])
		expect(await find()).toHaveLength(2)
	})

	it("evaluates the predicate of the QUERIED claimant, not the first one", async () => {
		// A delivery to someone else, with ME only as the locked fallback.
		mockHorizon([
			{
				id: "00" + "1".repeat(70),
				asset: `TLO:${ISSUER}`,
				amount: "10.0000000",
				claimants: [
					{ destination: OTHER, predicate: { unconditional: true } },
					{
						destination: ME,
						predicate: { not: { abs_before: "2026-09-17T00:00:00Z" } },
					},
				],
			},
		])
		expect(await find()).toHaveLength(0)
	})
})
