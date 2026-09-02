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
	/**
	 * Interface to bind. `loadConfig` refuses a non-loopback bind without an
	 * `apiToken` — an open POST /authorize spends the operator's XLM.
	 */
	host?: string
	/**
	 * Per-IP request budget per minute for the /v1 routes (both of them hit
	 * RPC on the operator's quota). 0 disables. Default 120.
	 */
	rateLimitRpm?: number
	/**
	 * Cap on concurrently processed /v1 requests — an authorize can block up
	 * to 60 s awaiting confirmation, so unbounded concurrency is connection
	 * (and fee) exhaustion. Excess requests get 503 `too_busy`. Default 8.
	 */
	maxInflight?: number
	/**
	 * Read the client IP from Fly-Client-IP / X-Forwarded-For instead of the
	 * socket. Only behind a trusted reverse proxy — otherwise the header is
	 * attacker-chosen and defeats per-IP limiting.
	 */
	trustProxy?: boolean
}

/** The networks the relayer serves — a hosted relayer has no LOCAL story. */
type RelayerNet = "TESTNET" | "PUBLIC"

/**
 * The pinned asset (if any) whose ISSUER account is `pub`. The registry pins
 * issuer public keys, so this misconfiguration is detectable offline —
 * unlike the authorizer-admin check in `server.ts`, which needs a chain read.
 */
export function findIssuerCollision<A extends { code: string; issuer: string }>(
	pub: string,
	assets: readonly A[],
): A | undefined {
	return assets.find((a) => a.issuer === pub)
}

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
	const signer = Keypair.fromSecret(secret)
	const issuerCollision = findIssuerCollision(
		signer.publicKey(),
		assetsForNetwork(network),
	)
	if (issuerCollision)
		throw new Error(
			`RELAYER_SECRET is the ${issuerCollision.code} ISSUER key. Refusing ` +
				"to start: the relayer must hold a dedicated, fee-only account — " +
				"never the asset issuer key and never the authorizer admin key",
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

	const host = env.HOST ?? "0.0.0.0"
	const apiToken = env.RELAYER_API_TOKEN || undefined
	if (apiToken && apiToken.length < 16)
		throw new Error(
			"RELAYER_API_TOKEN must be at least 16 characters — a short token " +
				"is guessable, and it is the only thing between the internet and " +
				"your fee balance",
		)
	const loopback =
		host === "127.0.0.1" || host === "::1" || host === "localhost"
	if (!apiToken && !loopback)
		throw new Error(
			"refusing to serve a non-loopback interface without RELAYER_API_TOKEN: " +
				"an open POST /authorize lets anyone spend this account's XLM. " +
				"Set RELAYER_API_TOKEN, or bind locally with HOST=127.0.0.1",
		)

	const nonNegInt = (name: string, raw: string | undefined, dflt: number) => {
		if (raw === undefined) return dflt
		const n = Number(raw)
		if (!Number.isInteger(n) || n < 0)
			throw new Error(`${name} must be a non-negative integer, got '${raw}'`)
		return n
	}

	return {
		network,
		networkPassphrase: env.NETWORK_PASSPHRASE ?? DEFAULTS[network].passphrase,
		rpcUrl: env.RPC_URL ?? DEFAULTS[network].rpcUrl,
		signer,
		apiToken,
		port,
		defaultAsset,
		host,
		rateLimitRpm: nonNegInt("RATE_LIMIT_RPM", env.RATE_LIMIT_RPM, 120),
		maxInflight: nonNegInt("MAX_INFLIGHT", env.MAX_INFLIGHT, 8),
		trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
	}
}
