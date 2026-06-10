import { scValToNative, xdr } from "@stellar/stellar-sdk"

/** The router's `OnboardStatus` discriminant (see the trustline-onboard contract). */
export type OnboardStatusTag = "Authorized" | "TrustlineOnly"

/**
 * Decode the router's `OnboardStatus` from a transaction's `returnValue`.
 *
 * A `#[contracttype]` unit enum serializes as a single-symbol vec, so
 * `scValToNative` yields e.g. `["TrustlineOnly"]`; a bare symbol is handled
 * too. Returns `null` when the value is absent or undecodable, so each caller
 * picks its own fallback rather than silently claiming a stronger outcome
 * (e.g. "authorized") than the chain actually reported.
 */
export function decodeOnboardStatus(
	returnValue: xdr.ScVal | null | undefined,
): OnboardStatusTag | null {
	if (!returnValue) return null
	try {
		const rv = scValToNative(returnValue)
		const tag = Array.isArray(rv) ? rv[0] : rv
		return tag === "Authorized" || tag === "TrustlineOnly" ? tag : null
	} catch {
		return null
	}
}
