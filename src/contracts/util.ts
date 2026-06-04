import { WalletNetwork } from "@creit.tech/stellar-wallets-kit"
import { z } from "zod"

const envSchema = z.object({
	PUBLIC_STELLAR_NETWORK_PASSPHRASE: z.nativeEnum(WalletNetwork),
	PUBLIC_STELLAR_RPC_URL: z.string().url(),
	PUBLIC_STELLAR_HORIZON_URL: z.string().url(),
	PUBLIC_TRUSTLINE_ONBOARD_CONTRACT_ID: z.string().optional(),
	PUBLIC_EURCV_AUTH_CONTRACT_ID: z.string().optional(),
	PUBLIC_TEST_ASSET_CODE: z.string().optional(),
	PUBLIC_TEST_ASSET_ISSUER: z.string().optional(),
	PUBLIC_TEST_SAC: z.string().optional(),
})

const parsed = envSchema.safeParse(import.meta.env)

if (!parsed.success) {
	console.error(
		"Invalid PUBLIC_* env configuration; falling back to LOCAL.",
		parsed.error.flatten(),
	)
}
const env: z.infer<typeof envSchema> = parsed.success
	? parsed.data
	: {
			PUBLIC_STELLAR_NETWORK_PASSPHRASE: WalletNetwork.STANDALONE,
			PUBLIC_STELLAR_RPC_URL: "http://localhost:8000/rpc",
			PUBLIC_STELLAR_HORIZON_URL: "http://localhost:8000",
		}

function networkFromPassphrase(passphrase: string) {
	switch (passphrase) {
		case WalletNetwork.PUBLIC:
			return "PUBLIC"
		case WalletNetwork.TESTNET:
			return "TESTNET"
		case WalletNetwork.FUTURENET:
			return "FUTURENET"
		default:
			return "LOCAL"
	}
}

export const stellarNetwork = networkFromPassphrase(
	env.PUBLIC_STELLAR_NETWORK_PASSPHRASE,
)
export const networkPassphrase = env.PUBLIC_STELLAR_NETWORK_PASSPHRASE

// NOTE: needs to be exported for contract files in this directory
export const rpcUrl = env.PUBLIC_STELLAR_RPC_URL
export const horizonUrl = env.PUBLIC_STELLAR_HORIZON_URL
export const trustlineOnboardContractId =
	env.PUBLIC_TRUSTLINE_ONBOARD_CONTRACT_ID
