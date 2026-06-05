import { Horizon } from "@stellar/stellar-sdk"

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
}): Promise<boolean> {
	const horizon = new Horizon.Server(args.horizonUrl)
	try {
		const issuer = await horizon.loadAccount(args.assetIssuer)
		return !!issuer.flags?.auth_required
	} catch {
		return false
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
}): Promise<ActivationStatus> {
	const horizon = new Horizon.Server(args.horizonUrl)
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
