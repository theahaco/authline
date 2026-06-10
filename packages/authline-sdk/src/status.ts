import { Horizon } from "@stellar/stellar-sdk"
import { defaultAllowHttp } from "./onboard.js"

export interface ActivationStatus {
	/** Whether the account holds a trustline for the asset. */
	hasTrustline: boolean
	/** Whether that trustline is authorized (AUTH_REQUIRED satisfied). */
	isAuthorized: boolean
}

/**
 * Whether the asset is `AUTH_REQUIRED` (a regulated asset like EURCV that needs
 * issuer authorization) vs an open classic asset (USDC, EURC) that only needs a
 * trustline created. Drives whether onboarding includes an authorize-on-behalf
 * step at all.
 */
export async function assetAuthRequired(args: {
	horizonUrl: string
	assetIssuer: string
	/** Allow a cleartext-http Horizon; defaults to localhost-only (`defaultAllowHttp`). */
	allowHttp?: boolean
}): Promise<boolean> {
	const horizon = new Horizon.Server(args.horizonUrl, {
		allowHttp: args.allowHttp ?? defaultAllowHttp(args.horizonUrl),
	})
	try {
		const issuer = await horizon.loadAccount(args.assetIssuer)
		return !!issuer.flags?.auth_required
	} catch (e) {
		// Only a 404 (issuer account does not exist) is a definitive "no auth
		// required". A transient/network/5xx error is NOT — failing open here
		// would silently downgrade a regulated asset to the no-authorize path
		// and produce an unauthorized, unusable trustline. Rethrow so callers
		// fail loud (or prefer the pinned registry capability for known assets).
		const status = (e as { response?: { status?: number } })?.response?.status
		if (status === 404) return false
		throw e instanceof Error
			? e
			: new Error(
					`assetAuthRequired: could not load issuer ${args.assetIssuer}`,
				)
	}
}

/**
 * Check whether `account` already has an authorized trustline for the asset, so
 * the UI can short-circuit ("already activated") instead of prompting a signature.
 */
export async function getActivationStatus(args: {
	horizonUrl: string
	account: string
	assetCode: string
	assetIssuer: string
	/** Allow a cleartext-http Horizon; defaults to localhost-only (`defaultAllowHttp`). */
	allowHttp?: boolean
}): Promise<ActivationStatus> {
	const horizon = new Horizon.Server(args.horizonUrl, {
		allowHttp: args.allowHttp ?? defaultAllowHttp(args.horizonUrl),
	})
	try {
		const acc = await horizon.loadAccount(args.account)
		const tl = acc.balances.find(
			(b) =>
				b.asset_type !== "native" &&
				b.asset_type !== "liquidity_pool_shares" &&
				(b as Horizon.HorizonApi.BalanceLineAsset).asset_code ===
					args.assetCode &&
				(b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer ===
					args.assetIssuer,
		) as Horizon.HorizonApi.BalanceLineAsset | undefined
		return { hasTrustline: !!tl, isAuthorized: !!tl?.is_authorized }
	} catch {
		// Account not found / not funded yet.
		return { hasTrustline: false, isAuthorized: false }
	}
}
