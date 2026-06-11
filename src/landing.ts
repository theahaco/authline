/**
 * Landing-page glue, sharing the SAME config the dApp uses, so the marketing
 * page can never drift from what app.html actually offers:
 *
 * 1. The "Built for real money" asset grid renders from the live directory —
 *    live tiles deep-link into the dApp (./app.html?asset=CODE).
 * 2. The hero activation card cycles through the LIVE assets and its
 *    "Activate X" button navigates to the dApp instead of play-acting a fake
 *    "authorized" outcome (which confused people into thinking they were done).
 *
 * The config module drags in the Stellar SDK (registry validation), so it is
 * loaded with a dynamic import: the static landing paints instantly and the
 * data-driven parts hydrate when the (code-split) chunk arrives.
 */

const $ = (id: string) => document.getElementById(id)

async function main() {
	const { ASSETS, LIVE_ASSETS, NETWORK_LABEL } = await import("./config.js")

	// Activation needs the per-network onboard router; without one (e.g. mainnet
	// until its router ships) "Live now" would overpromise — the honest badge is
	// that the asset is listed/verified, with activation still to come.
	const ACTIVATABLE = Boolean(LIVE_ASSETS[0]?.router)

	// ── Asset grid — generated from the dApp directory ───────────────────
	const grid = $("assetGrid")
	if (grid) {
		grid.innerHTML = ""
		for (const a of ASSETS) {
			const live = a.status === "live"
			const card = document.createElement(live ? "a" : "div")
			// "in" included: this runs after the inline reveal-observer scan, so
			// generated cards must not wait for an observation that never comes.
			card.className = `acard ${live ? "live" : "soon"} reveal in`
			if (card instanceof HTMLAnchorElement) {
				card.href = `./app.html?asset=${encodeURIComponent(a.code)}`
				card.setAttribute(
					"aria-label",
					`${a.code} — ${a.name}. Open in the Authline app.`,
				)
			}
			const glyph = document.createElement("div")
			glyph.className = "aglyph"
			glyph.textContent = a.glyph
			const txt = document.createElement("div")
			const code = document.createElement("div")
			code.className = "acode"
			code.textContent = a.code
			const name = document.createElement("div")
			name.className = "aname"
			name.textContent =
				a.kind && a.kind !== "Stellar asset" ? `${a.name} · ${a.kind}` : a.name
			txt.append(code, name)
			const badge = document.createElement("span")
			badge.className = `abadge ${live ? "live" : "soon"}`
			badge.textContent = live
				? ACTIVATABLE
					? "● Live now"
					: "Listed — soon"
				: "Coming soon"
			card.append(glyph, txt, badge)
			grid.appendChild(card)
		}
	}

	// ── Hero activation card — cycles LIVE assets, links to the dApp ─────
	const mGlyph = $("mGlyph")
	const mName = $("mName")
	const mIssuer = $("mIssuer")
	const mCode = $("mCode")
	const mBtnText = $("mBtnText")
	const mBtn = $("mBtn")
	const mNet = $("mNet")
	const mock = $("mock")

	let current = LIVE_ASSETS[0]
	function paint(a: (typeof LIVE_ASSETS)[number]) {
		current = a
		if (mGlyph) mGlyph.textContent = a.glyph
		if (mName) mName.textContent = a.name
		if (mIssuer) mIssuer.textContent = a.kind
		if (mCode) mCode.textContent = a.assetCode
		if (mBtnText) mBtnText.textContent = `Activate ${a.assetCode}`
	}

	if (mNet) mNet.textContent = NETWORK_LABEL
	if (current) paint(current)

	const reducedMotion = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches
	if (mock && LIVE_ASSETS.length > 1 && !reducedMotion) {
		let i = 0
		let paused = false
		// Don't swap the asset out from under a pointer hovering the card/button.
		mock.addEventListener("mouseenter", () => (paused = true))
		mock.addEventListener("mouseleave", () => (paused = false))
		mock.addEventListener("focusin", () => (paused = true))
		mock.addEventListener("focusout", () => (paused = false))
		setInterval(() => {
			if (paused) return
			i = (i + 1) % LIVE_ASSETS.length
			mock.style.transition = "opacity .28s"
			mock.style.opacity = "0"
			setTimeout(() => {
				const next = LIVE_ASSETS[i]
				if (next) paint(next)
				mock.style.opacity = "1"
			}, 280)
		}, 3200)
	}

	// The real thing is one click away — no more pretend-authorization.
	mBtn?.addEventListener("click", () => {
		if (current)
			window.location.href = `./app.html?asset=${encodeURIComponent(current.assetCode)}`
	})
}

void main()
