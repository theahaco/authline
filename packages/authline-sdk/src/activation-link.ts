import { StrKey } from "@stellar/stellar-sdk"

/**
 * Tier 0 of the integration ladder (docs/integration-tiers.md): a platform
 * whose withdrawal failed because the destination cannot hold the asset yet
 * sends the user to a hosted activation page with a plain link, and the page
 * sends them back once the account is ready. No SDK, no backend, no key — the
 * link is the whole integration.
 *
 * The emitter (`activationLink`) and the receiving page (`safeReturnUrl`)
 * share this module so the two can never disagree on what a valid link is.
 */

/** Query parameter carrying the platform page the user returns to. */
export const RETURN_URL_PARAM = "return_url"

/** Longest return URL accepted — generous for a real page, short enough for a QR code. */
export const RETURN_URL_MAX = 2048

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Validate a return URL for the hosted page to link back to.
 *
 * The page only ever renders the result as a link the user clicks, beside its
 * host, so the checks are the ones that stop that link from misleading them:
 * an absolute `https:` URL (plain `http:` only on a loopback host, for local
 * development), and no `user:pass@` part — `https://exchange.com@evil.example`
 * parses to the host `evil.example`, and a user reading the link would not
 * notice. Anything else yields `null` and the page shows no return link.
 */
export function safeReturnUrl(raw: string | null | undefined): URL | null {
	if (!raw || raw.length > RETURN_URL_MAX) return null
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}
	const httpsOk = url.protocol === "https:"
	const loopbackOk = url.protocol === "http:" && LOOPBACK.has(url.hostname)
	if (!httpsOk && !loopbackOk) return null
	if (url.username || url.password) return null
	return url
}

/**
 * Build the Tier 0 activation link: the hosted page, preselected on `asset`,
 * previewing `address` (the withdrawal destination), with a way back to
 * `returnUrl` once the account can receive the asset.
 *
 * ```ts
 * activationLink({
 *   base: "https://authline.io/app.html",
 *   asset: "EURCV",
 *   address: withdrawal.destination,
 *   returnUrl: "https://exchange.example/withdrawals/123",
 * })
 * // https://authline.io/app.html?asset=EURCV&address=G…&return_url=https%3A%2F%2F…
 * ```
 *
 * There is no default `base`, as with `onboardingRequest`'s `hostedBase`: the
 * integrator names the page it sends its users to.
 */
export function activationLink(opts: {
	/** The hosted activation page, e.g. `https://authline.io/app.html`. */
	base: string
	/** Asset code the page opens on, e.g. `EURCV`. */
	asset: string
	/** The account to activate — a `G…` account or a `C…` smart account. */
	address?: string
	/** Where the user goes back to afterwards (https; see {@link safeReturnUrl}). */
	returnUrl?: string
}): string {
	const base = opts.base.replace(/[?#].*$/, "")
	let parsed: URL
	try {
		parsed = new URL(base)
	} catch {
		throw new Error(`base is not an absolute URL: ${opts.base}`)
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
		throw new Error(`base must be an http(s) URL, got ${parsed.protocol}`)
	if (!/^[A-Za-z0-9]{1,12}$/.test(opts.asset))
		throw new Error(`asset is not a Stellar asset code: ${opts.asset}`)
	if (
		opts.address !== undefined &&
		!StrKey.isValidEd25519PublicKey(opts.address) &&
		!StrKey.isValidContract(opts.address)
	)
		throw new Error(
			`address must be a G… account or a C… contract: ${opts.address}`,
		)
	if (opts.returnUrl !== undefined && !safeReturnUrl(opts.returnUrl))
		throw new Error(
			"returnUrl must be an absolute https URL (http only on localhost) " +
				`with no credentials, at most ${RETURN_URL_MAX} characters: ${opts.returnUrl}`,
		)

	const params = new URLSearchParams({ asset: opts.asset })
	if (opts.address) params.set("address", opts.address)
	if (opts.returnUrl) params.set(RETURN_URL_PARAM, opts.returnUrl)
	return `${base}?${params.toString()}`
}
