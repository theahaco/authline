import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import {
	RETURN_URL_MAX,
	RETURN_URL_PARAM,
	activationLink,
	safeReturnUrl,
} from "./activation-link.js"

const HOLDER = Keypair.random().publicKey()
const SMART = StrKey.encodeContract(Buffer.alloc(32, 7))
const BASE = "https://authline.io/app.html"

describe("safeReturnUrl", () => {
	it("accepts an absolute https URL", () => {
		const u = safeReturnUrl("https://exchange.example/withdraw/42?retry=1")
		expect(u?.host).toBe("exchange.example")
		expect(u?.href).toBe("https://exchange.example/withdraw/42?retry=1")
	})

	it("accepts plain http only on a loopback host", () => {
		expect(safeReturnUrl("http://localhost:5173/withdraw.html")).not.toBeNull()
		expect(safeReturnUrl("http://127.0.0.1:8080/")).not.toBeNull()
		expect(safeReturnUrl("http://[::1]:3000/")).not.toBeNull()
		expect(safeReturnUrl("http://exchange.example/withdraw")).toBeNull()
	})

	it("refuses script, data and relative URLs", () => {
		expect(safeReturnUrl("javascript:alert(1)")).toBeNull()
		expect(safeReturnUrl("data:text/html,<p>hi</p>")).toBeNull()
		expect(safeReturnUrl("/withdraw")).toBeNull()
		expect(safeReturnUrl("//evil.example/")).toBeNull()
	})

	it("refuses credentials that disguise the real host", () => {
		// Parses to host evil.example — a reader sees exchange.com.
		expect(safeReturnUrl("https://exchange.com@evil.example/")).toBeNull()
		expect(safeReturnUrl("https://user:pw@exchange.example/")).toBeNull()
	})

	it("refuses empty and oversized values", () => {
		expect(safeReturnUrl(null)).toBeNull()
		expect(safeReturnUrl(undefined)).toBeNull()
		expect(safeReturnUrl("")).toBeNull()
		const long = `https://exchange.example/${"a".repeat(RETURN_URL_MAX)}`
		expect(safeReturnUrl(long)).toBeNull()
	})
})

describe("activationLink", () => {
	it("builds the Tier 0 link the hosted page reads", () => {
		const link = activationLink({
			base: BASE,
			asset: "EURCV",
			address: HOLDER,
			returnUrl: "https://exchange.example/withdraw/42?retry=1&x=a b",
		})
		const u = new URL(link)
		expect(`${u.origin}${u.pathname}`).toBe(BASE)
		expect(u.searchParams.get("asset")).toBe("EURCV")
		expect(u.searchParams.get("address")).toBe(HOLDER)
		// Round-trips intact, including its own query string.
		expect(u.searchParams.get(RETURN_URL_PARAM)).toBe(
			"https://exchange.example/withdraw/42?retry=1&x=a b",
		)
	})

	it("needs only the asset", () => {
		expect(activationLink({ base: BASE, asset: "USDC" })).toBe(
			`${BASE}?asset=USDC`,
		)
	})

	it("accepts a smart-account holder", () => {
		const link = activationLink({ base: BASE, asset: "USDC", address: SMART })
		expect(new URL(link).searchParams.get("address")).toBe(SMART)
	})

	it("drops a query or fragment already on the base", () => {
		expect(
			activationLink({ base: `${BASE}?asset=OLD#top`, asset: "TLO" }),
		).toBe(`${BASE}?asset=TLO`)
	})

	it("rejects inputs the page would ignore or refuse", () => {
		expect(() =>
			activationLink({ base: "authline.io/app", asset: "X" }),
		).toThrow(/absolute URL/)
		expect(() =>
			activationLink({ base: "ftp://authline.io/app", asset: "X" }),
		).toThrow(/http\(s\)/)
		expect(() => activationLink({ base: BASE, asset: "EUR-CV" })).toThrow(
			/asset code/,
		)
		expect(() =>
			activationLink({ base: BASE, asset: "EURCV", address: "GNOPE" }),
		).toThrow(/G… account or a C… contract/)
		expect(() =>
			activationLink({
				base: BASE,
				asset: "EURCV",
				returnUrl: "http://exchange.example/withdraw",
			}),
		).toThrow(/returnUrl/)
	})

	it("emits nothing safeReturnUrl would refuse", () => {
		const returnUrl = "https://exchange.example/w"
		const link = activationLink({ base: BASE, asset: "EURCV", returnUrl })
		const back = new URL(link).searchParams.get(RETURN_URL_PARAM)
		expect(safeReturnUrl(back)?.href).toBe(returnUrl)
	})
})
