import {
	Account,
	Asset,
	BASE_FEE,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	type Transaction,
	type TransactionBuilder as TB,
} from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import { assertSafeToSponsor, buildFeeBump } from "./sponsor.js"

const networkPassphrase = Networks.TESTNET
const SPONSOR_KP = Keypair.random()
const USER_KP = Keypair.random()
const ATTACKER = Keypair.random().publicKey()
const SPONSOR = SPONSOR_KP.publicKey()
const USER = USER_KP.publicKey()
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
const config = { assetCode: "EURCV", assetIssuer: ISSUER }
const asset = new Asset(config.assetCode, config.assetIssuer)

const vet = (txXdr: string) =>
	assertSafeToSponsor({
		txXdr,
		networkPassphrase,
		sponsor: SPONSOR,
		user: USER,
		config,
	})

/** Build from `source`, with the ops the caller supplies. */
function tx(source: string, build: (b: TB) => void): string {
	const b = new TransactionBuilder(new Account(source, "1"), {
		fee: BASE_FEE,
		networkPassphrase,
	})
	build(b)
	return b.setTimeout(180).build().toXDR()
}

/** The legitimate user-sourced shape. */
const goodUserSourced = () =>
	tx(USER, (b) => {
		b.addOperation(
			Operation.beginSponsoringFutureReserves({
				sponsoredId: USER,
				source: SPONSOR,
			}),
		)
		b.addOperation(Operation.changeTrust({ asset }))
		b.addOperation(Operation.endSponsoringFutureReserves({}))
	})

/** The legitimate sponsor-sourced shape, for an account that does not exist. */
const goodSponsorSourced = () =>
	tx(SPONSOR, (b) => {
		b.addOperation(
			Operation.beginSponsoringFutureReserves({ sponsoredId: USER }),
		)
		b.addOperation(
			Operation.createAccount({ destination: USER, startingBalance: "0" }),
		)
		b.addOperation(Operation.changeTrust({ asset, source: USER }))
		b.addOperation(Operation.endSponsoringFutureReserves({ source: USER }))
	})

describe("assertSafeToSponsor — accepts what the SDK builds", () => {
	it("accepts the user-sourced shape", () => {
		expect(() => vet(goodUserSourced())).not.toThrow()
	})

	it("accepts the sponsor-sourced shape with a zero-balance CreateAccount", () => {
		expect(() => vet(goodSponsorSourced())).not.toThrow()
	})
})

describe("assertSafeToSponsor — refuses reserve-draining envelopes", () => {
	it("refuses an extra trustline smuggled into the sponsorship window", () => {
		const other = new Asset("SCAM", ATTACKER)
		const bad = tx(USER, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({
					sponsoredId: USER,
					source: SPONSOR,
				}),
			)
			b.addOperation(Operation.changeTrust({ asset }))
			b.addOperation(Operation.changeTrust({ asset: other }))
			b.addOperation(Operation.endSponsoringFutureReserves({}))
		})
		expect(() => vet(bad)).toThrow(/not EURCV|expected exactly 1 trustline/)
	})

	it("refuses a data entry — a reserve the sponsor never agreed to", () => {
		const bad = tx(USER, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({
					sponsoredId: USER,
					source: SPONSOR,
				}),
			)
			b.addOperation(Operation.changeTrust({ asset }))
			b.addOperation(Operation.manageData({ name: "junk", value: "x" }))
			b.addOperation(Operation.endSponsoringFutureReserves({}))
		})
		expect(() => vet(bad)).toThrow(
			/unexpected operation inside the sponsorship window: manageData/,
		)
	})

	it("refuses an extra signer entry", () => {
		const bad = tx(USER, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({
					sponsoredId: USER,
					source: SPONSOR,
				}),
			)
			b.addOperation(Operation.changeTrust({ asset }))
			b.addOperation(
				Operation.setOptions({
					signer: { ed25519PublicKey: ATTACKER, weight: 1 },
				}),
			)
			b.addOperation(Operation.endSponsoringFutureReserves({}))
		})
		expect(() => vet(bad)).toThrow(
			/unexpected operation inside the sponsorship window/,
		)
	})

	it("refuses a CreateAccount that gifts the sponsor's own XLM", () => {
		const bad = tx(SPONSOR, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({ sponsoredId: USER }),
			)
			b.addOperation(
				// The starting balance comes out of spendable XLM, not the
				// sponsored reserve — an unbounded transfer.
				Operation.createAccount({ destination: USER, startingBalance: "5000" }),
			)
			b.addOperation(Operation.changeTrust({ asset, source: USER }))
			b.addOperation(Operation.endSponsoringFutureReserves({ source: USER }))
		})
		expect(() => vet(bad)).toThrow(/funded with 5000/)
	})

	it("refuses an unclosed sponsorship window", () => {
		const bad = tx(USER, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({
					sponsoredId: USER,
					source: SPONSOR,
				}),
			)
			b.addOperation(Operation.changeTrust({ asset }))
			b.addOperation(Operation.manageData({ name: "after", value: "x" }))
		})
		expect(() => vet(bad)).toThrow(/window is not closed/)
	})

	it("refuses sponsoring somebody other than the holder", () => {
		const bad = tx(USER, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({
					sponsoredId: ATTACKER,
					source: SPONSOR,
				}),
			)
			b.addOperation(Operation.changeTrust({ asset }))
			b.addOperation(
				Operation.endSponsoringFutureReserves({ source: ATTACKER }),
			)
		})
		expect(() => vet(bad)).toThrow(/names .*, not the holder/)
	})

	it("refuses a trustline for a different asset", () => {
		const bad = tx(USER, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({
					sponsoredId: USER,
					source: SPONSOR,
				}),
			)
			b.addOperation(
				Operation.changeTrust({ asset: new Asset("SCAM", ATTACKER) }),
			)
			b.addOperation(Operation.endSponsoringFutureReserves({}))
		})
		expect(() => vet(bad)).toThrow(/the trustline is for SCAM/)
	})

	it("refuses a payment hidden in the window", () => {
		const bad = tx(SPONSOR, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({ sponsoredId: USER }),
			)
			b.addOperation(Operation.changeTrust({ asset, source: USER }))
			b.addOperation(
				Operation.payment({
					destination: ATTACKER,
					asset: Asset.native(),
					amount: "100",
				}),
			)
			b.addOperation(Operation.endSponsoringFutureReserves({ source: USER }))
		})
		expect(() => vet(bad)).toThrow(
			/unexpected operation inside the sponsorship window: payment/,
		)
	})

	it("refuses a transaction sourced by a third party", () => {
		const bad = tx(ATTACKER, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({
					sponsoredId: USER,
					source: SPONSOR,
				}),
			)
			b.addOperation(Operation.changeTrust({ asset, source: USER }))
			b.addOperation(Operation.endSponsoringFutureReserves({ source: USER }))
		})
		expect(() => vet(bad)).toThrow(/neither the sponsor nor the holder/)
	})

	it("refuses a window closed by someone other than the sponsored account", () => {
		const bad = tx(SPONSOR, (b) => {
			b.addOperation(
				Operation.beginSponsoringFutureReserves({ sponsoredId: USER }),
			)
			b.addOperation(Operation.changeTrust({ asset, source: USER }))
			b.addOperation(Operation.endSponsoringFutureReserves({}))
		})
		expect(() => vet(bad)).toThrow(/ended by .*, not the holder/)
	})

	it("refuses a fee-bump envelope, pointing at the inner transaction", () => {
		const inner = TransactionBuilder.fromXDR(
			goodUserSourced(),
			networkPassphrase,
		) as Transaction
		inner.sign(USER_KP)
		const bumped = buildFeeBump({
			innerXdr: inner.toXDR(),
			networkPassphrase,
			feeSource: SPONSOR,
		})
		expect(() => vet(bumped)).toThrow(/check the inner transaction/)
	})
})

describe("buildFeeBump", () => {
	const signedInner = () => {
		const t = TransactionBuilder.fromXDR(
			goodUserSourced(),
			networkPassphrase,
		) as Transaction
		t.sign(USER_KP)
		return t
	}

	it("pays for a holder-signed transaction without touching its signature", () => {
		const inner = signedInner()
		const xdr = buildFeeBump({
			innerXdr: inner.toXDR(),
			networkPassphrase,
			feeSource: SPONSOR,
		})
		const bump = TransactionBuilder.fromXDR(xdr, networkPassphrase)
		if (!("innerTransaction" in bump)) throw new Error("expected a fee bump")
		expect(bump.feeSource).toBe(SPONSOR)
		// The holder's signature survives wrapping — the inner hash is unchanged.
		expect(bump.innerTransaction.signatures).toHaveLength(1)
		expect(bump.innerTransaction.hash()).toEqual(inner.hash())
	})

	it("consumes no sequence number of its own — the inner's is used", () => {
		const inner = signedInner()
		const bump = TransactionBuilder.fromXDR(
			buildFeeBump({
				innerXdr: inner.toXDR(),
				networkPassphrase,
				feeSource: SPONSOR,
			}),
			networkPassphrase,
		)
		if (!("innerTransaction" in bump)) throw new Error("expected a fee bump")
		// This is what lets ONE operations account serve unlimited concurrent
		// onboardings: it signs, but never sequences.
		expect(bump.innerTransaction.sequence).toBe(inner.sequence)
		expect("seqNum" in bump.toEnvelope().feeBump().tx()).toBe(false)
	})

	it("refuses to pay for an unsigned transaction", () => {
		expect(() =>
			buildFeeBump({
				innerXdr: goodUserSourced(),
				networkPassphrase,
				feeSource: SPONSOR,
			}),
		).toThrow(/unsigned/)
	})

	it("refuses to double-wrap a fee bump", () => {
		const once = buildFeeBump({
			innerXdr: signedInner().toXDR(),
			networkPassphrase,
			feeSource: SPONSOR,
		})
		expect(() =>
			buildFeeBump({ innerXdr: once, networkPassphrase, feeSource: SPONSOR }),
		).toThrow(/already a fee-bump/)
	})
})
