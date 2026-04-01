import { Buffer } from "buffer"
import { Address } from "@stellar/stellar-sdk"
import {
	AssembledTransaction,
	Client as ContractClient,
	ClientOptions as ContractClientOptions,
	MethodOptions,
	Result,
	Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract"
import type {
	u32,
	i32,
	u64,
	i64,
	u128,
	i128,
	u256,
	i256,
	Option,
	Timepoint,
	Duration,
} from "@stellar/stellar-sdk/contract"
export * from "@stellar/stellar-sdk"
export * as contract from "@stellar/stellar-sdk/contract"
export * as rpc from "@stellar/stellar-sdk/rpc"

if (typeof window !== "undefined") {
	//@ts-ignore Buffer exists
	window.Buffer = window.Buffer || Buffer
}

export const networks = {
	unknown: {
		networkPassphrase: "Public Global Stellar Network ; September 2015",
		contractId: "CB2DHZMQHQE3TGUMD6BRM7UCJZNIPKDRVEQOWBIRRS3G2FZOGDTRKSB3",
	},
} as const

export const Errors = {
	1: { message: "AccountBanned" },
	2: { message: "AccountAlreadyAuthorized" },
	3: { message: "FailedToAuthorizeWithSAC" },
	4: { message: "ContractPaused" },
	5: { message: "FailedToSetAdmin" },
	6: { message: "FailedToTransferWithSAC" },
	7: { message: "NoSuchRedemptionRequest" },
	8: { message: "RedemptionRequestMustBePositive" },
	9: { message: "FailedToClawbackWithSAC" },
	10: { message: "ConversionError" },
	11: { message: "CannotAuthorizeAdminContract" },
	12: { message: "AlreadyInitialized" },
	13: { message: "TooManyAccounts" },
	14: { message: "NoTrustline" },
}

export type AKey =
	| { tag: "ASac"; values: void }
	| { tag: "AUnpaused"; values: void }
	| { tag: "AB"; values: readonly [string] }

export interface Client {
	/**
	 * Construct and simulate a admin_get transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Get current admin
	 */
	admin_get: (
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Option<string>>>

	/**
	 * Construct and simulate a admin_set transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Transfer to new admin
	 * Should be called in the same transaction as deploying the contract to ensure that
	 * a different account try to become admin
	 */
	admin_set: (
		{ new_admin }: { new_admin: string },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<null>>

	/**
	 * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Admin can upgrade the contract with given hash.
	 */
	upgrade: (
		{ wasm_hash }: { wasm_hash: Buffer },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<null>>

	/**
	 * Construct and simulate a init transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * The source account should should be the issuer of the asset which is intially the admin of this contract.
	 * This contract is set as the admin of the SAC and the operator is set to this contract.
	 * Lastly the contract is unpaused.
	 */
	init: (
		{ sac, operator }: { sac: string; operator: string },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a add_banned_accounts transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Add to the contract’s set of banned accounts. Max 50 accounts per call.
	 */
	add_banned_accounts: (
		{ accounts }: { accounts: Array<string> },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a remove_banned_accounts transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Remove from the contract’s set of banned accounts. Max 50 accounts per call.
	 */
	remove_banned_accounts: (
		{ accounts }: { accounts: Array<string> },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a authorize_trustline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Since AUTH_REQUIRED is set, accounts must call this method to request authorizing their trustline.
	 * The method will check if the account is banned,
	 * if not will call the SAC's set_authorized method and add the account to the contract’s set of authorized accounts.
	 */
	authorize_trustline: (
		{ account }: { account: string },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a deauthorize_trustline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * The issuer can remove an account’s authorization via the SAC's set_authorized method.
	 */
	deauthorize_trustline: (
		{ account }: { account: string },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Start the pausing process
	 */
	pause: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

	/**
	 * Construct and simulate a unpause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * End the pausing process
	 */
	unpause: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

	/**
	 * Construct and simulate a batch_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * An iterator method which removes a batch from the set of authorized accounts,
	 * revoking authorization from each with a call to the SAC's set_authorized method and transfers the batch to the set of paused accounts.
	 */
	batch_pause: (
		{ accounts }: { accounts: Array<string> },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a batch_unpause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Batches of accounts are removed from the set of paused accounts, authorized, and returned to the set of authorized accounts.
	 */
	batch_unpause: (
		{ accounts }: { accounts: Array<string> },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a clawback transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * burn funds from an account.
	 */
	clawback: (
		{ account, amount }: { account: string; amount: i128 },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a mint_to_account transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Mint to a normal authoirzed account
	 */
	mint_to_account: (
		{ account, amount }: { account: string; amount: i128 },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a freeze_accounts transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Ban account and remove authorization
	 */
	freeze_accounts: (
		{ accounts }: { accounts: Array<string> },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>

	/**
	 * Construct and simulate a unfreeze_accounts transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
	 * Unban account and authorize
	 */
	unfreeze_accounts: (
		{ accounts }: { accounts: Array<string> },
		options?: MethodOptions,
	) => Promise<AssembledTransaction<Result<void>>>
}
export class Client extends ContractClient {
	static async deploy<T = Client>(
		/** Constructor/Initialization Args for the contract's `__constructor` method */
		{ admin }: { admin: string },
		/** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
		options: MethodOptions &
			Omit<ContractClientOptions, "contractId"> & {
				/** The hash of the Wasm blob, which must already be installed on-chain. */
				wasmHash: Buffer | string
				/** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
				salt?: Buffer | Uint8Array
				/** The format used to decode `wasmHash`, if it's provided as a string. */
				format?: "hex" | "base64"
			},
	): Promise<AssembledTransaction<T>> {
		return ContractClient.deploy({ admin }, options)
	}
	constructor(public readonly options: ContractClientOptions) {
		super(
			new ContractSpec([
				"AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADgAAAAAAAAANQWNjb3VudEJhbm5lZAAAAAAAAAEAAAAAAAAAGEFjY291bnRBbHJlYWR5QXV0aG9yaXplZAAAAAIAAAAAAAAAGEZhaWxlZFRvQXV0aG9yaXplV2l0aFNBQwAAAAMAAAAAAAAADkNvbnRyYWN0UGF1c2VkAAAAAAAEAAAAAAAAABBGYWlsZWRUb1NldEFkbWluAAAABQAAAAAAAAAXRmFpbGVkVG9UcmFuc2ZlcldpdGhTQUMAAAAABgAAAAAAAAAXTm9TdWNoUmVkZW1wdGlvblJlcXVlc3QAAAAABwAAAAAAAAAfUmVkZW1wdGlvblJlcXVlc3RNdXN0QmVQb3NpdGl2ZQAAAAAIAAAAAAAAABdGYWlsZWRUb0NsYXdiYWNrV2l0aFNBQwAAAAAJAAAAAAAAAA9Db252ZXJzaW9uRXJyb3IAAAAACgAAAAAAAAAcQ2Fubm90QXV0aG9yaXplQWRtaW5Db250cmFjdAAAAAsAAAAAAAAAEkFscmVhZHlJbml0aWFsaXplZAAAAAAADAAAAAAAAAAPVG9vTWFueUFjY291bnRzAAAAAA0AAAAAAAAAC05vVHJ1c3RsaW5lAAAAAA4=",
				"AAAAAAAAABFHZXQgY3VycmVudCBhZG1pbgAAAAAAAAlhZG1pbl9nZXQAAAAAAAAAAAAAAQAAA+gAAAAT",
				"AAAAAAAAAI9UcmFuc2ZlciB0byBuZXcgYWRtaW4KU2hvdWxkIGJlIGNhbGxlZCBpbiB0aGUgc2FtZSB0cmFuc2FjdGlvbiBhcyBkZXBsb3lpbmcgdGhlIGNvbnRyYWN0IHRvIGVuc3VyZSB0aGF0CmEgZGlmZmVyZW50IGFjY291bnQgdHJ5IHRvIGJlY29tZSBhZG1pbgAAAAAJYWRtaW5fc2V0AAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
				"AAAAAAAAAC9BZG1pbiBjYW4gdXBncmFkZSB0aGUgY29udHJhY3Qgd2l0aCBnaXZlbiBoYXNoLgAAAAAHdXBncmFkZQAAAAABAAAAAAAAAAl3YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAA=",
				"AAAAAAAAABxDb25zdHJ1Y3RvciB0byBzZXQgdGhlIGFkbWluAAAADV9fY29uc3RydWN0b3IAAAAAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAA",
				"AAAAAAAAAOFUaGUgc291cmNlIGFjY291bnQgc2hvdWxkIHNob3VsZCBiZSB0aGUgaXNzdWVyIG9mIHRoZSBhc3NldCB3aGljaCBpcyBpbnRpYWxseSB0aGUgYWRtaW4gb2YgdGhpcyBjb250cmFjdC4KVGhpcyBjb250cmFjdCBpcyBzZXQgYXMgdGhlIGFkbWluIG9mIHRoZSBTQUMgYW5kIHRoZSBvcGVyYXRvciBpcyBzZXQgdG8gdGhpcyBjb250cmFjdC4KTGFzdGx5IHRoZSBjb250cmFjdCBpcyB1bnBhdXNlZC4AAAAAAAAEaW5pdAAAAAIAAAAAAAAAA3NhYwAAAAATAAAAAAAAAAhvcGVyYXRvcgAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
				"AAAAAAAAAElBZGQgdG8gdGhlIGNvbnRyYWN04oCZcyBzZXQgb2YgYmFubmVkIGFjY291bnRzLiBNYXggNTAgYWNjb3VudHMgcGVyIGNhbGwuAAAAAAAAE2FkZF9iYW5uZWRfYWNjb3VudHMAAAAAAQAAAAAAAAAIYWNjb3VudHMAAAPqAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
				"AAAAAAAAAE5SZW1vdmUgZnJvbSB0aGUgY29udHJhY3TigJlzIHNldCBvZiBiYW5uZWQgYWNjb3VudHMuIE1heCA1MCBhY2NvdW50cyBwZXIgY2FsbC4AAAAAABZyZW1vdmVfYmFubmVkX2FjY291bnRzAAAAAAABAAAAAAAAAAhhY2NvdW50cwAAA+oAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
				"AAAAAAAAAQdTaW5jZSBBVVRIX1JFUVVJUkVEIGlzIHNldCwgYWNjb3VudHMgbXVzdCBjYWxsIHRoaXMgbWV0aG9kIHRvIHJlcXVlc3QgYXV0aG9yaXppbmcgdGhlaXIgdHJ1c3RsaW5lLgpUaGUgbWV0aG9kIHdpbGwgY2hlY2sgaWYgdGhlIGFjY291bnQgaXMgYmFubmVkLAppZiBub3Qgd2lsbCBjYWxsIHRoZSBTQUMncyBzZXRfYXV0aG9yaXplZCBtZXRob2QgYW5kIGFkZCB0aGUgYWNjb3VudCB0byB0aGUgY29udHJhY3TigJlzIHNldCBvZiBhdXRob3JpemVkIGFjY291bnRzLgAAAAATYXV0aG9yaXplX3RydXN0bGluZQAAAAABAAAAAAAAAAdhY2NvdW50AAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
				"AAAAAAAAAFdUaGUgaXNzdWVyIGNhbiByZW1vdmUgYW4gYWNjb3VudOKAmXMgYXV0aG9yaXphdGlvbiB2aWEgdGhlIFNBQydzIHNldF9hdXRob3JpemVkIG1ldGhvZC4AAAAAFWRlYXV0aG9yaXplX3RydXN0bGluZQAAAAAAAAEAAAAAAAAAB2FjY291bnQAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
				"AAAAAAAAABlTdGFydCB0aGUgcGF1c2luZyBwcm9jZXNzAAAAAAAABXBhdXNlAAAAAAAAAAAAAAA=",
				"AAAAAAAAABdFbmQgdGhlIHBhdXNpbmcgcHJvY2VzcwAAAAAHdW5wYXVzZQAAAAAAAAAAAA==",
				"AAAAAAAAANRBbiBpdGVyYXRvciBtZXRob2Qgd2hpY2ggcmVtb3ZlcyBhIGJhdGNoIGZyb20gdGhlIHNldCBvZiBhdXRob3JpemVkIGFjY291bnRzLApyZXZva2luZyBhdXRob3JpemF0aW9uIGZyb20gZWFjaCB3aXRoIGEgY2FsbCB0byB0aGUgU0FDJ3Mgc2V0X2F1dGhvcml6ZWQgbWV0aG9kIGFuZCB0cmFuc2ZlcnMgdGhlIGJhdGNoIHRvIHRoZSBzZXQgb2YgcGF1c2VkIGFjY291bnRzLgAAAAtiYXRjaF9wYXVzZQAAAAABAAAAAAAAAAhhY2NvdW50cwAAA+oAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
				"AAAAAAAAAHxCYXRjaGVzIG9mIGFjY291bnRzIGFyZSByZW1vdmVkIGZyb20gdGhlIHNldCBvZiBwYXVzZWQgYWNjb3VudHMsIGF1dGhvcml6ZWQsIGFuZCByZXR1cm5lZCB0byB0aGUgc2V0IG9mIGF1dGhvcml6ZWQgYWNjb3VudHMuAAAADWJhdGNoX3VucGF1c2UAAAAAAAABAAAAAAAAAAhhY2NvdW50cwAAA+oAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
				"AAAAAAAAABtidXJuIGZ1bmRzIGZyb20gYW4gYWNjb3VudC4AAAAACGNsYXdiYWNrAAAAAgAAAAAAAAAHYWNjb3VudAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
				"AAAAAAAAACNNaW50IHRvIGEgbm9ybWFsIGF1dGhvaXJ6ZWQgYWNjb3VudAAAAAAPbWludF90b19hY2NvdW50AAAAAAIAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
				"AAAAAAAAACRCYW4gYWNjb3VudCBhbmQgcmVtb3ZlIGF1dGhvcml6YXRpb24AAAAPZnJlZXplX2FjY291bnRzAAAAAAEAAAAAAAAACGFjY291bnRzAAAD6gAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
				"AAAAAAAAABtVbmJhbiBhY2NvdW50IGFuZCBhdXRob3JpemUAAAAAEXVuZnJlZXplX2FjY291bnRzAAAAAAAAAQAAAAAAAAAIYWNjb3VudHMAAAPqAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
				"AAAAAgAAAAAAAAAAAAAABEFLZXkAAAADAAAAAAAAAAAAAAAEQVNhYwAAAAAAAAAAAAAACUFVbnBhdXNlZAAAAAAAAAEAAAAAAAAAAkFCAAAAAAABAAAAEw==",
			]),
			options,
		)
	}
	public readonly fromJSON = {
		admin_get: this.txFromJSON<Option<string>>,
		admin_set: this.txFromJSON<null>,
		upgrade: this.txFromJSON<null>,
		init: this.txFromJSON<Result<void>>,
		add_banned_accounts: this.txFromJSON<Result<void>>,
		remove_banned_accounts: this.txFromJSON<Result<void>>,
		authorize_trustline: this.txFromJSON<Result<void>>,
		deauthorize_trustline: this.txFromJSON<Result<void>>,
		pause: this.txFromJSON<null>,
		unpause: this.txFromJSON<null>,
		batch_pause: this.txFromJSON<Result<void>>,
		batch_unpause: this.txFromJSON<Result<void>>,
		clawback: this.txFromJSON<Result<void>>,
		mint_to_account: this.txFromJSON<Result<void>>,
		freeze_accounts: this.txFromJSON<Result<void>>,
		unfreeze_accounts: this.txFromJSON<Result<void>>,
	}
}
