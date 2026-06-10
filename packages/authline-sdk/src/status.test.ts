import { afterEach, describe, expect, it, vi } from "vitest"
import { rpc } from "@stellar/stellar-sdk"
import { getActivationStatus } from "./status.js"

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const ACCT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
const RPC = "https://soroban-testnet.stellar.org"

// status.ts reads entries[0].val.trustLine().flags(); a duck-typed entry is
// enough to exercise the decode without constructing real ledger XDR.
const entryWithFlags = (flags: number) => ({
	val: { trustLine: () => ({ flags: () => flags }) },
})
const stubLedgerEntries = (entries: unknown[]) =>
	vi
		.spyOn(rpc.Server.prototype, "getLedgerEntries")
		.mockResolvedValue({ entries } as never)

afterEach(() => vi.restoreAllMocks())

const status = (rpcUrl = RPC, allowHttp?: boolean) =>
	getActivationStatus({
		rpcUrl,
		allowHttp,
		account: ACCT,
		assetCode: "USDC",
		assetIssuer: ISSUER,
	})

describe("getActivationStatus (Stellar RPC, no Horizon)", () => {
	it("reports an authorized trustline when AUTHORIZED_FLAG is set", async () => {
		stubLedgerEntries([entryWithFlags(1)])
		await expect(status()).resolves.toEqual({
			hasTrustline: true,
			isAuthorized: true,
		})
	})

	it("reports a created-but-unauthorized trustline when the flag is clear", async () => {
		stubLedgerEntries([entryWithFlags(0)])
		await expect(status()).resolves.toEqual({
			hasTrustline: true,
			isAuthorized: false,
		})
	})

	it("reports no trustline when the ledger entry is absent", async () => {
		stubLedgerEntries([])
		await expect(status()).resolves.toEqual({
			hasTrustline: false,
			isAuthorized: false,
		})
	})

	it("allows a localhost-http RPC (local-dev default)", async () => {
		stubLedgerEntries([])
		await expect(status("http://localhost:8000")).resolves.toEqual({
			hasTrustline: false,
			isAuthorized: false,
		})
	})

	it("refuses a remote http RPC by default", async () => {
		stubLedgerEntries([])
		await expect(status("http://rpc.evil.example")).rejects.toThrow(/insecure/)
	})
})
