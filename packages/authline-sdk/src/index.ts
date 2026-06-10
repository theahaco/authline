/**
 * @theaha/authline
 *
 * Integrator SDK for establishing a Stellar trustline on behalf of a user.
 * Exchanges, brokers and wallets use this to onboard a holder during a
 * withdrawal with ONE transaction shape for every asset — the router decides
 * on-chain (via `SAC.admin()`) whether the trustline also needs authorization.
 * The CAP-33 sponsored path (zero-XLM holders) and the authorize-on-behalf
 * Case-A path (zero-signature) remain for integrators. Discover an issuer's
 * config from its stellar.toml, build the single router transaction —
 * `onboard(sac, holder)` discovers the asset class on-chain — and check
 * activation status.
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
	/**
	 * The Authline onboard ROUTER contract (C...) — the single entry point
	 * `onboard(sac, holder)`. Required for the one-signature path; pinned per
	 * network in `ROUTERS`.
	 */
	router?: string
	/**
	 * The asset's authorizer — the SAC admin (C...). INFORMATIONAL for the
	 * one-signature path (the router discovers it on-chain from `SAC.admin()`);
	 * required only for the zero-signature Case-A `buildAuthorizeTx`.
	 */
	authorizer?: string
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
	ROUTERS,
	type OfficialAsset,
	type AssetCapability,
	type StellarNet,
	type ReconcilableConfig,
} from "./registry.js"
export { buildOnboardTx, type BuildOnboardOptions } from "./onboard.js"
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
 * Pick the backend to use for a given holder. The CAP-73 one-signature path
 * is preferred when the router is known and the holder already has a funded,
 * on-ledger account (CAP-73 `trust()` has no sponsorship — the holder pays
 * the trustline reserve). Otherwise fall back to the CAP-33 sponsored path.
 */
export function selectBackend(
	config: { router?: string; backends: Backend[] },
	holder: { exists: boolean; fundedForReserve: boolean },
): Backend {
	const canOneSig =
		!!config.router &&
		config.backends.includes("cap73-one-signature") &&
		holder.exists &&
		holder.fundedForReserve
	if (canOneSig) return "cap73-one-signature"
	return "cap33-sponsored"
}
