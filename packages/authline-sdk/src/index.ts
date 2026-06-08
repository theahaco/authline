/**
 * @theaha/authline
 *
 * Integrator SDK for establishing a Stellar trustline on behalf of a user.
 * Exchanges, brokers and wallets use this to onboard a holder during a
 * withdrawal — for OPEN assets (USDC/EURC, not AUTH_REQUIRED) the trustline is
 * simply created (optionally sponsored); for REGULATED assets (EURCV-style,
 * AUTH_REQUIRED) it is also authorized on the user's behalf with no user or
 * issuer signature. Discover an issuer's config from its stellar.toml, build
 * the right transaction for the asset class, and check activation status.
 *
 * See the SEP draft: ../../sep/SEP-XXXX-trustline-onboarder.md
 */

export type Backend = "cap73-one-signature" | "cap33-sponsored"

/** Resolved onboarder configuration for a single asset. */
export interface OnboarderConfig {
	/** Classic asset code, e.g. "EURCV". */
	assetCode: string
	/** Classic asset issuer (G...). */
	assetIssuer: string
	/** The asset's Stellar Asset Contract (C...). */
	sac: string
	/** The Trustline Authorizer contract (the SAC admin) (C...). */
	authorizer: string
	/** The one-signature onboard wrapper contract (C...), if deployed. */
	onboard?: string
	/** Backends the issuer supports, in preference order. */
	backends: Backend[]
}

export {
	discoverOnboarder,
	discoverOnboarder as discover,
	parseOnboarderToml,
} from "./discovery.js"
// Curated, issuer-pinned registry + StrKey validation (anti-copycat defense).
export {
	OFFICIAL_ASSETS,
	validateOfficialAsset,
	assetsForNetwork,
	resolveOfficialAsset,
	reconcileWithRegistry,
	netFromPassphrase,
	isValidIssuer,
	isValidContractId,
	type OfficialAsset,
	type AssetCapability,
	type StellarNet,
	type ReconcilableConfig,
} from "./registry.js"
export {
	buildOnboardTx,
	buildTrustTx,
	type BuildOnboardOptions,
	type BuildTrustOptions,
} from "./onboard.js"
export {
	getActivationStatus,
	getActivationStatus as status,
	assetAuthRequired,
	type ActivationStatus,
} from "./status.js"
// Third-party (exchange / broker / wallet) integration surface.
export {
	buildAuthorizeTx,
	buildSponsoredOnboardTx,
	onboardingRequest,
	asAccount,
	type OnboardingRequest,
} from "./exchange.js"

/**
 * Pick the backend to use for a given holder. The CAP-73 one-signature path is
 * preferred when the wrapper is deployed and the holder already has a funded,
 * on-ledger account (CAP-73 `trust()` has no sponsorship — the holder pays the
 * trustline reserve). Otherwise fall back to the CAP-33 sponsored path.
 */
export function selectBackend(
	config: { onboard?: string; backends: Backend[] },
	holder: { exists: boolean; fundedForReserve: boolean },
): Backend {
	const canOneSig =
		!!config.onboard &&
		config.backends.includes("cap73-one-signature") &&
		holder.exists &&
		holder.fundedForReserve
	if (canOneSig) return "cap73-one-signature"
	return "cap33-sponsored"
}
