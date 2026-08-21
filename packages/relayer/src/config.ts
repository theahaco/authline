import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk"
import { assetsForNetwork, type StellarNet } from "@theahaco/authline"

/** Everything the relayer needs, read once from the environment at boot. */
export interface RelayerConfig {
	network: StellarNet
	networkPassphrase: string
	rpcUrl: string
	/** Funded submitter for `authorize_trustline` — any low-privilege account. */
	signer: Keypair
	/** Optional bearer token; when set, POST /authorize requires it. */
	apiToken?: string
	port: number
	/** Asset code used when a request does not pass `?asset=`. */
	defaultAsset: string
}

/** The networks the relayer serves — a hosted relayer has no LOCAL story. */
type RelayerNet = "TESTNET" | "PUBLIC"

const DEFAULTS: Record<RelayerNet, { rpcUrl: string; passphrase: string }> = {
	TESTNET: {
		rpcUrl: "https://soroban-testnet.stellar.org",
		passphrase: Networks.TESTNET,
	},
	PUBLIC: {
		rpcUrl: "https://mainnet.sorobanrpc.com",
		passphrase: Networks.PUBLIC,
	},
}

/**
 * Parse the environment into a {@link RelayerConfig}, failing fast with a
 * message that names the variable — a relayer that boots half-configured
 * would fail later, per-request, in a way that looks like a chain problem.
 *
 * SECURITY: `RELAYER_SECRET` must be a dedicated, low-privilege operations
 * account. It pays transaction fees and nothing else — `authorize_trustline`
 * is permissionless, so this key holds no authority worth stealing. Never
 * use the authorizer admin key here.
 */
export function loadConfig(env: NodeJS.ProcessEnv): RelayerConfig {
	const netName = (env.STELLAR_NETWORK ?? "TESTNET").toUpperCase()
	if (netName !== "TESTNET" && netName !== "PUBLIC")
		throw new Error(
			`STELLAR_NETWORK must be TESTNET or PUBLIC, got '${netName}'`,
		)
	const network = netName as RelayerNet

	const secret = env.RELAYER_SECRET
	if (!secret || !StrKey.isValidEd25519SecretSeed(secret))
		throw new Error(
			"RELAYER_SECRET must be set to the S... secret of a funded, " +
				"low-privilege operations account (it only pays fees)",
		)

	const port = Number(env.PORT ?? "8787")
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(`PORT must be a port number, got '${env.PORT}'`)

	const defaultAsset = env.DEFAULT_ASSET ?? "EURCV"
	if (!assetsForNetwork(network).some((a) => a.code === defaultAsset))
		throw new Error(
			`DEFAULT_ASSET '${defaultAsset}' is not pinned for ${network} — ` +
				"pin it in packages/authline-sdk/src/registry.ts first",
		)

	return {
		network,
		networkPassphrase: env.NETWORK_PASSPHRASE ?? DEFAULTS[network].passphrase,
		rpcUrl: env.RPC_URL ?? DEFAULTS[network].rpcUrl,
		signer: Keypair.fromSecret(secret),
		apiToken: env.RELAYER_API_TOKEN || undefined,
		port,
		defaultAsset,
	}
}
