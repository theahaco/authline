import { WalletNetwork } from "@creit.tech/stellar-wallets-kit"
import { z } from "zod"

const envSchema = z.object({
	PUBLIC_STELLAR_NETWORK_PASSPHRASE: z.nativeEnum(WalletNetwork),
	PUBLIC_STELLAR_RPC_URL: z.string(),
	PUBLIC_STELLAR_HORIZON_URL: z.string(),
})

const parsed = envSchema.safeParse(import.meta.env)

const env: z.infer<typeof envSchema> = parsed.success
	? parsed.data
	: {
			PUBLIC_STELLAR_NETWORK_PASSPHRASE: WalletNetwork.PUBLIC,
			PUBLIC_STELLAR_RPC_URL: "https://soroban-rpc.mainnet.stellar.gateway.fm",
			PUBLIC_STELLAR_HORIZON_URL: "https://horizon.stellar.org",
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
