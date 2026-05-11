import { WalletNetwork } from "@creit.tech/stellar-wallets-kit"
import { z } from "zod"

const envSchema = z.object({
	PUBLIC_STELLAR_NETWORK_PASSPHRASE: z.nativeEnum(WalletNetwork),
	PUBLIC_STELLAR_RPC_URL: z.string(),
	PUBLIC_STELLAR_HORIZON_URL: z.string(),
	PUBLIC_TRUSTLINE_ONBOARD_CONTRACT_ID: z.string().optional(),
	PUBLIC_EURCV_AUTH_CONTRACT_ID: z.string().optional(),
	PUBLIC_TEST_ASSET_CODE: z.string().optional(),
	PUBLIC_TEST_ASSET_ISSUER: z.string().optional(),
	PUBLIC_TEST_SAC: z.string().optional(),
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
export const trustlineOnboardContractId =
	env.PUBLIC_TRUSTLINE_ONBOARD_CONTRACT_ID

// Mainnet EURCV defaults; override via PUBLIC_TEST_* / PUBLIC_EURCV_AUTH_CONTRACT_ID for testnet.
const MAINNET_EURCV_ISSUER =
	"GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G"
const MAINNET_EURCV_AUTH =
	"CB2DHZMQHQE3TGUMD6BRM7UCJZNIPKDRVEQOWBIRRS3G2FZOGDTRKSB3"
export const assetCode = env.PUBLIC_TEST_ASSET_CODE ?? "EURCV"
export const assetIssuer = env.PUBLIC_TEST_ASSET_ISSUER ?? MAINNET_EURCV_ISSUER
export const assetSacContractId = env.PUBLIC_TEST_SAC
export const eurcvAuthContractId =
	env.PUBLIC_EURCV_AUTH_CONTRACT_ID ?? MAINNET_EURCV_AUTH
