import {
	Keypair,
	Networks,
	TransactionBuilder,
	Address,
	type xdr,
} from "@stellar/stellar-sdk"
import {
	ROUTERS,
	buildOnboardTx,
	getActivationStatus,
	resolveOfficialAsset,
	type OnboarderConfig,
} from "@theahaco/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
// Smart-account (C-address) holders — the Nido wallet case. A contract cannot
// hold a classic trustline or source a transaction: status must read the SAC
// view, and onboarding needs a separate fee-payer source while the holder
// authorizes via its own SorobanAuthorizationEntry. Any deployed contract id
// works as a stand-in holder for unsigned/simulation-level checks.
const SMART_HOLDER = "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3" // TLO SAC

const PINNED_EURCV = resolveOfficialAsset("EURCV", "TESTNET")!
const EURCV: OnboarderConfig = {
	assetCode: PINNED_EURCV.code,
	assetIssuer: PINNED_EURCV.issuer,
	sac: PINNED_EURCV.sac,
	authorizer: PINNED_EURCV.authorizer,
	router: ROUTERS.TESTNET,
	backends: ["cap73-one-signature"],
}
const USDC = {
	assetCode: "USDC",
	assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
}

describe.skipIf(!RUN)("testnet smart-account (C-address) holders", () => {
	const feePayer = Keypair.random()

	beforeAll(async () => {
		const r = await fetch(
			`https://friendbot.stellar.org/?addr=${feePayer.publicKey()}`,
		)
		if (!r.ok) throw new Error("friendbot failed")
	}, 120_000)

	it("status reads the SAC view: AUTH_REQUIRED default is unauthorized", async () => {
		await expect(
			getActivationStatus({
				rpcUrl: NET.rpcUrl,
				account: SMART_HOLDER,
				assetCode: EURCV.assetCode,
				assetIssuer: EURCV.assetIssuer,
				sac: EURCV.sac,
				networkPassphrase: NET.passphrase,
			}),
		).resolves.toEqual({
			holderKind: "contract",
			hasTrustline: false,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: false,
			sacAuthorized: false,
		})
	})

	it("status reads the SAC view: open-asset default is authorized", async () => {
		await expect(
			getActivationStatus({
				rpcUrl: NET.rpcUrl,
				account: SMART_HOLDER,
				assetCode: USDC.assetCode,
				assetIssuer: USDC.assetIssuer,
				sac: USDC.sac,
				networkPassphrase: NET.passphrase,
			}),
		).resolves.toMatchObject({
			holderKind: "contract",
			sacAuthorized: true,
		})
	})

	it("buildOnboardTx refuses a contract holder without a fee source", async () => {
		await expect(
			buildOnboardTx({
				rpcUrl: NET.rpcUrl,
				networkPassphrase: NET.passphrase,
				holder: SMART_HOLDER,
				config: EURCV,
			}),
		).rejects.toThrow(/feeSource/)
	})

	it("builds a fee-payer-sourced onboard tx whose auth entry belongs to the smart account", async () => {
		const built = await buildOnboardTx({
			rpcUrl: NET.rpcUrl,
			networkPassphrase: NET.passphrase,
			holder: SMART_HOLDER,
			feeSource: feePayer.publicKey(),
			config: EURCV,
		})
		const tx = TransactionBuilder.fromXDR(built, NET.passphrase)
		if ("innerTransaction" in tx) throw new Error("unexpected fee-bump")
		expect(tx.source).toBe(feePayer.publicKey())
		expect(tx.operations).toHaveLength(1)
		const op = tx.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] }
		const auths = op.auth ?? []
		// Exactly one address-credential entry, owned by the smart account — the
		// piece the Nido wallet popup passkey-signs.
		expect(auths).toHaveLength(1)
		const cred = auths[0]?.credentials()
		expect(cred?.switch().name).toBe("sorobanCredentialsAddress")
		const who = Address.fromScAddress(cred!.address().address()).toString()
		expect(who).toBe(SMART_HOLDER)
	})
})
