import { beforeEach, describe, expect, it, vi } from "vitest"

// Capture every Horizon.Server construction so we can assert `allowHttp` is
// threaded (the local-dev fix). The mock mimics the real SDK's insecure-URL
// guard, so these tests FAIL before the fix (a bare `new Horizon.Server(url)`
// throws "Cannot connect to insecure horizon server" for an http URL).
const { ctorCalls } = vi.hoisted(() => ({
	ctorCalls: [] as Array<{
		url: string
		opts: { allowHttp?: boolean } | undefined
	}>,
}))

vi.mock("@stellar/stellar-sdk", () => {
	class Server {
		constructor(url: string, opts?: { allowHttp?: boolean }) {
			ctorCalls.push({ url, opts })
			if (!url.startsWith("https:") && !opts?.allowHttp)
				throw new Error("Cannot connect to insecure horizon server")
		}
		async loadAccount(): Promise<never> {
			throw new Error("network disabled in unit test")
		}
	}
	return { Horizon: { Server } }
})

const { assetAuthRequired, getActivationStatus } = await import("./status.js")

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const ACCT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

beforeEach(() => {
	ctorCalls.length = 0
})

describe("status: allowHttp threading", () => {
	it("getActivationStatus allows cleartext http for a localhost horizon", async () => {
		// Must NOT throw the insecure-server error at construction.
		await expect(
			getActivationStatus({
				horizonUrl: "http://localhost:8000",
				account: ACCT,
				assetCode: "USDC",
				assetIssuer: ISSUER,
			}),
		).resolves.toEqual({ hasTrustline: false, isAuthorized: false })
		expect(ctorCalls.at(-1)?.opts?.allowHttp).toBe(true)
	})

	it("getActivationStatus keeps a remote https horizon secure (allowHttp false)", async () => {
		await getActivationStatus({
			horizonUrl: "https://horizon-testnet.stellar.org",
			account: ACCT,
			assetCode: "USDC",
			assetIssuer: ISSUER,
		})
		expect(ctorCalls.at(-1)?.opts?.allowHttp).toBe(false)
	})

	it("getActivationStatus honors an explicit allowHttp=false on a non-local http url", async () => {
		// A remote http horizon must stay refused — the localhost default must
		// not silently upgrade an attacker-supplied cleartext endpoint.
		await expect(
			getActivationStatus({
				horizonUrl: "http://horizon.evil.example",
				account: ACCT,
				assetCode: "USDC",
				assetIssuer: ISSUER,
				allowHttp: false,
			}),
		).rejects.toThrow(/insecure/)
	})

	it("assetAuthRequired allows cleartext http for a 127.0.0.1 horizon", async () => {
		// Construction succeeds (allowHttp true); the network call then fails with
		// a NON-insecure error that propagates.
		await expect(
			assetAuthRequired({
				horizonUrl: "http://127.0.0.1:8000",
				assetIssuer: ISSUER,
			}),
		).rejects.toThrow(/network disabled/)
		expect(ctorCalls.at(-1)?.opts?.allowHttp).toBe(true)
	})

	it("assetAuthRequired refuses a remote http horizon by default", async () => {
		await expect(
			assetAuthRequired({
				horizonUrl: "http://horizon.evil.example",
				assetIssuer: ISSUER,
			}),
		).rejects.toThrow(/insecure/)
	})
})
