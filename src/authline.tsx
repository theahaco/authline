import {
	StellarWalletsKit,
	WalletNetwork,
	allowAllModules,
	FREIGHTER_ID,
	XBULL_ID,
	ALBEDO_ID,
	LOBSTR_ID,
	HANA_ID,
} from "@creit.tech/stellar-wallets-kit"
import { rpc, TransactionBuilder } from "@stellar/stellar-sdk"
import {
	buildOnboardTx,
	buildTrustTx,
	getActivationStatus,
	isValidIssuer,
} from "@theaha/authline"
import { useCallback, useEffect, useState } from "react"
import { ASSET, ASSETS, NETWORK, REPO_URL, type DirItem } from "./config.js"

// ── Warm "paper" palette (AL) ────────────────────────────────────────
const AL = {
	paper: "#F3EDE1",
	card: "#FFFFFF",
	line: "#E4DAC8",
	lineSoft: "rgba(124,108,80,0.18)",
	emerald: "#16734A",
	emeraldBright: "#1C9460",
	emeraldSoft: "#E5EFE4",
	emeraldLine: "#C2DEC6",
	ink: "#1C1813",
	mut: "#7C7264",
	mut2: "#A89C8B",
	disp: '"Bricolage Grotesque", system-ui, sans-serif',
	mono: '"IBM Plex Mono", ui-monospace, monospace',
}

const short = (s: string, a = 4, b = 4) =>
	s ? `${s.slice(0, a)}…${s.slice(-b)}` : ""
const IS_PUBLIC = NETWORK.passphrase.includes("Public")
const explorerBase = IS_PUBLIC
	? "https://stellar.expert/explorer/public"
	: "https://stellar.expert/explorer/testnet"
const txUrl = (h: string) => `${explorerBase}/tx/${h}`
const acctUrl = (a: string) => `${explorerBase}/account/${a}`

// Map the configured passphrase to the wallet kit's network. WalletNetwork's
// enum values ARE the passphrases, so an exact match is correct for public /
// testnet / futurenet / standalone — instead of collapsing every non-mainnet
// network to TESTNET, which makes wallets reject the real-passphrase tx locally.
const WALLET_NETWORK =
	(Object.values(WalletNetwork).find((v) => v === NETWORK.passphrase) as
		| WalletNetwork
		| undefined) ?? WalletNetwork.TESTNET

const kit = new StellarWalletsKit({
	network: WALLET_NETWORK,
	selectedWalletId: FREIGHTER_ID,
	modules: allowAllModules(),
})

/**
 * Optional test seam: an injected signer used by the e2e browser tests so the
 * real dApp can run without a wallet extension. Inert in production (the
 * `window` hook is never set there).
 */
interface E2ESigner {
	address: string
	signTransaction(xdr: string): Promise<{ signedTxXdr: string }>
}
const e2eSigner = (): E2ESigner | undefined =>
	typeof window !== "undefined"
		? (window as unknown as { __AUTHLINE_E2E__?: E2ESigner }).__AUTHLINE_E2E__
		: undefined

/** Sign via the injected e2e signer when present, otherwise the wallet kit. */
async function signTx(xdr: string, address: string): Promise<string> {
	const e2e = e2eSigner()
	if (e2e) return (await e2e.signTransaction(xdr)).signedTxXdr
	const { signedTxXdr } = await kit.signTransaction(xdr, {
		networkPassphrase: NETWORK.passphrase,
		address,
	})
	return signedTxXdr
}

type Phase =
	| "directory"
	| "idle"
	| "ready"
	| "building"
	| "signing"
	| "submitting"
	| "success"
	| "error"
	| "already"
	| "preview"

// ── Atoms ────────────────────────────────────────────────────────────
function Pill({
	children,
	tone = "mut",
	accent,
}: {
	children: React.ReactNode
	tone?: "mut" | "err"
	accent?: boolean
}) {
	const map = {
		mut: { bg: "rgba(124,114,100,0.08)", fg: AL.mut, bd: AL.lineSoft },
		accent: { bg: AL.emeraldSoft, fg: AL.emeraldBright, bd: AL.emeraldLine },
		err: {
			bg: "rgba(181,83,46,0.12)",
			fg: "#B5532E",
			bd: "rgba(181,83,46,0.35)",
		},
	} as const
	const c = map[accent ? "accent" : tone]
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 7,
				whiteSpace: "nowrap",
				fontFamily: AL.mono,
				fontSize: 11,
				fontWeight: 500,
				letterSpacing: "0.08em",
				textTransform: "uppercase",
				color: c.fg,
				background: c.bg,
				border: `1px solid ${c.bd}`,
				borderRadius: 999,
				padding: "5px 11px",
			}}
		>
			{children}
		</span>
	)
}
function Dot({
	color = AL.emerald,
	size = 6,
	pulse,
}: {
	color?: string
	size?: number
	pulse?: boolean
}) {
	return (
		<span
			style={{
				width: size,
				height: size,
				borderRadius: size,
				background: color,
				flexShrink: 0,
				animation: pulse ? "alglow 1.4s ease-in-out infinite" : "none",
			}}
		/>
	)
}
function Spinner({
	color = AL.emerald,
	size = 16,
	track = "rgba(120,140,160,0.25)",
}: {
	color?: string
	size?: number
	track?: string
}) {
	return (
		<span
			className="al-spin"
			style={{
				width: size,
				height: size,
				borderRadius: size,
				display: "inline-block",
				border: `${Math.max(2, size / 7)}px solid ${track}`,
				borderTopColor: color,
				flexShrink: 0,
			}}
		/>
	)
}
function AssetGlyph({
	label = "EU",
	size = 44,
	muted = false,
}: {
	label?: string
	size?: number
	muted?: boolean
}) {
	return (
		<div
			style={{
				width: size,
				height: size,
				borderRadius: size * 0.3,
				flexShrink: 0,
				background: muted ? "rgba(124,114,100,0.08)" : AL.emeraldSoft,
				border: `1px solid ${muted ? AL.line : AL.emeraldLine}`,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontFamily: AL.disp,
				fontWeight: 700,
				fontSize: size * 0.34,
				color: muted ? AL.mut : AL.emeraldBright,
			}}
		>
			{label}
		</div>
	)
}
function KV({
	k,
	v,
	accent,
	mono = true,
}: {
	k: React.ReactNode
	v: React.ReactNode
	accent?: string
	mono?: boolean
}) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 12,
			}}
		>
			<span
				style={{
					fontFamily: AL.disp,
					fontSize: 13.5,
					color: AL.mut,
					whiteSpace: "nowrap",
					flexShrink: 0,
				}}
			>
				{k}
			</span>
			<span
				style={{
					fontFamily: mono ? AL.mono : AL.disp,
					fontSize: 13.5,
					fontWeight: 500,
					color: accent || AL.ink,
					whiteSpace: "nowrap",
				}}
			>
				{v}
			</span>
		</div>
	)
}
function Primary({
	children,
	onClick,
	disabled,
	full = true,
}: {
	children: React.ReactNode
	onClick?: () => void
	disabled?: boolean
	full?: boolean
}) {
	return (
		<button
			className="al-cta"
			onClick={onClick}
			disabled={disabled}
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 9,
				width: full ? "100%" : "auto",
				border: "none",
				cursor: disabled ? "default" : "pointer",
				background: disabled ? "#EAE2D4" : AL.emerald,
				color: disabled ? AL.mut : "#FFFFFF",
				fontFamily: AL.disp,
				fontWeight: 600,
				fontSize: 15,
				letterSpacing: "-0.01em",
				padding: "14px 20px",
				borderRadius: 12,
				boxShadow: disabled ? "none" : "0 8px 22px -8px rgba(22,115,74,0.55)",
			}}
		>
			{children}
		</button>
	)
}
function Ghost({
	children,
	onClick,
	full,
	href,
}: {
	children: React.ReactNode
	onClick?: () => void
	full?: boolean
	href?: string
}) {
	const style: React.CSSProperties = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		width: full ? "100%" : "auto",
		cursor: "pointer",
		background: "transparent",
		color: AL.ink,
		border: `1px solid ${AL.line}`,
		fontFamily: AL.disp,
		fontWeight: 500,
		fontSize: 14,
		padding: "13px 18px",
		borderRadius: 12,
		textDecoration: "none",
		boxSizing: "border-box",
	}
	if (href)
		return (
			<a
				className="al-cta"
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				style={style}
			>
				{children}
			</a>
		)
	return (
		<button className="al-cta" onClick={onClick} style={style}>
			{children}
		</button>
	)
}
function Divider() {
	return <div style={{ height: 1, background: AL.line, margin: "16px 0" }} />
}

// ── Wallet modal (wired to Stellar Wallets Kit) ──────────────────────
const WALLETS: [string, string, string][] = [
	["Freighter", FREIGHTER_ID, "Extension"],
	["xBull", XBULL_ID, "Extension"],
	["Albedo", ALBEDO_ID, "Web"],
	["Lobstr", LOBSTR_ID, "Mobile"],
	["Hana", HANA_ID, "Extension"],
]
function WalletModal({
	onPick,
	onClose,
	available,
}: {
	onPick: (id: string) => void
	onClose: () => void
	available: Set<string>
}) {
	return (
		<div
			onClick={onClose}
			style={{
				position: "absolute",
				inset: 0,
				zIndex: 30,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: 24,
				background: "rgba(40,30,15,0.45)",
				backdropFilter: "blur(3px)",
			}}
		>
			<div
				className="al-fade"
				onClick={(e) => e.stopPropagation()}
				style={{
					width: "100%",
					maxWidth: 360,
					background: AL.card,
					borderRadius: 18,
					border: `1px solid ${AL.line}`,
					padding: 22,
					boxShadow: "0 30px 80px -30px rgba(40,30,15,0.35)",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						marginBottom: 16,
					}}
				>
					<div
						style={{
							fontFamily: AL.disp,
							fontWeight: 600,
							fontSize: 17,
							color: AL.ink,
						}}
					>
						Connect a wallet
					</div>
					<button
						className="al-cta"
						onClick={onClose}
						style={{
							width: 28,
							height: 28,
							borderRadius: 8,
							border: `1px solid ${AL.line}`,
							background: "transparent",
							cursor: "pointer",
							color: AL.mut,
							fontSize: 16,
							lineHeight: 1,
						}}
					>
						×
					</button>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{WALLETS.map(([w, id, tag]) => {
						const det = available.has(id)
						return (
							<button
								key={id}
								className="al-wrow al-cta"
								onClick={() => onPick(id)}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 12,
									padding: "11px 13px",
									borderRadius: 12,
									border: `1px solid ${AL.line}`,
									background: "rgba(124,114,100,0.04)",
									cursor: "pointer",
									textAlign: "left",
								}}
							>
								<span
									style={{
										width: 30,
										height: 30,
										borderRadius: 9,
										background: "rgba(124,114,100,0.10)",
										flexShrink: 0,
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										fontFamily: AL.disp,
										fontWeight: 700,
										fontSize: 13,
										color: AL.mut,
									}}
								>
									{w[0]}
								</span>
								<span
									style={{
										fontFamily: AL.disp,
										fontWeight: 500,
										fontSize: 14.5,
										color: AL.ink,
									}}
								>
									{w}
								</span>
								<span
									style={{
										marginLeft: "auto",
										fontFamily: AL.mono,
										fontSize: 10.5,
										letterSpacing: "0.06em",
										textTransform: "uppercase",
										color: det ? AL.emeraldBright : AL.mut2,
									}}
								>
									{det ? "● Detected" : tag}
								</span>
							</button>
						)
					})}
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 12,
						color: AL.mut2,
						textAlign: "center",
						margin: "16px 0 2px",
						lineHeight: 1.4,
					}}
				>
					Non-custodial — Authline never holds your keys.
				</p>
			</div>
		</div>
	)
}

// ── Progress (build → sign → submit) ─────────────────────────────────
const STEPS: [Phase, string][] = [
	["building", "Preparing"],
	["signing", "Sign"],
	["submitting", "Submitting"],
]
function Progress({ state }: { state: Phase }) {
	const idx = STEPS.findIndex(([s]) => s === state)
	return (
		<div style={{ display: "flex", gap: 7, margin: "4px 0 18px" }}>
			{STEPS.map(([s, label], i) => {
				const active = i === idx,
					doneStep = i < idx
				return (
					<div key={s} style={{ flex: 1 }}>
						<div
							style={{
								height: 4,
								borderRadius: 4,
								background: doneStep
									? AL.emerald
									: active
										? AL.emeraldLine
										: AL.line,
								overflow: "hidden",
								position: "relative",
							}}
						>
							{active && (
								<div
									style={{
										position: "absolute",
										inset: 0,
										background: AL.emerald,
										transformOrigin: "left",
										animation: "albar 1.1s ease-out forwards",
									}}
								/>
							)}
						</div>
						<div
							style={{
								fontFamily: AL.mono,
								fontSize: 9.5,
								letterSpacing: "0.08em",
								textTransform: "uppercase",
								marginTop: 7,
								color: doneStep || active ? AL.emeraldBright : AL.mut2,
							}}
						>
							{label}
						</div>
					</div>
				)
			})}
		</div>
	)
}

function AssetRow({ status }: { status: React.ReactNode }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 13,
				marginBottom: 18,
			}}
		>
			<AssetGlyph label={ASSET.glyph} />
			<div style={{ lineHeight: 1.3, minWidth: 0 }}>
				<div
					style={{
						fontFamily: AL.disp,
						fontWeight: 600,
						fontSize: 17,
						color: AL.ink,
					}}
				>
					{ASSET.assetCode}
				</div>
				<div
					style={{
						fontFamily: AL.disp,
						fontSize: 12.5,
						color: AL.mut,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{ASSET.name}
				</div>
				{(ASSET.authClawback || ASSET.authRevocable) && (
					<div
						style={{
							fontFamily: AL.disp,
							fontSize: 11.5,
							color: "#B7791F",
							marginTop: 3,
							display: "flex",
							alignItems: "center",
							gap: 4,
						}}
					>
						<span aria-hidden>⚠</span>{" "}
						{ASSET.authClawback
							? "Issuer can freeze or claw back this asset"
							: "Issuer can freeze this asset"}
					</div>
				)}
			</div>
			<div style={{ marginLeft: "auto", flexShrink: 0 }}>{status}</div>
		</div>
	)
}
function Card({ children }: { children: React.ReactNode }) {
	return (
		<div
			style={{
				width: "100%",
				maxWidth: 384,
				background: AL.card,
				borderRadius: 20,
				border: `1px solid ${AL.line}`,
				padding: 26,
				boxShadow: "0 30px 70px -34px rgba(40,30,15,0.3)",
			}}
		>
			{children}
		</div>
	)
}

function Directory({ onPick }: { onPick: (a: DirItem) => void }) {
	return (
		<div className="al-fade">
			<div
				style={{
					fontFamily: AL.mono,
					fontSize: 11,
					letterSpacing: "0.14em",
					textTransform: "uppercase",
					color: AL.mut2,
					marginBottom: 14,
				}}
			>
				Supported assets
			</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				{ASSETS.map((a) => {
					const live = a.status === "live"
					return (
						<button
							key={a.code}
							className={live ? "al-wrow al-cta" : ""}
							onClick={() => onPick(a)}
							disabled={!live}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 13,
								padding: "12px 13px",
								borderRadius: 13,
								border: `1px solid ${AL.line}`,
								background: live ? "rgba(124,114,100,0.04)" : "transparent",
								cursor: live ? "pointer" : "default",
								opacity: live ? 1 : 0.5,
								textAlign: "left",
							}}
						>
							<AssetGlyph label={a.glyph} size={40} muted={!live} />
							<div style={{ lineHeight: 1.3, minWidth: 0 }}>
								<div
									style={{
										fontFamily: AL.disp,
										fontWeight: 600,
										fontSize: 15.5,
										color: AL.ink,
									}}
								>
									{a.code}
								</div>
								<div
									style={{
										fontFamily: AL.disp,
										fontSize: 12.5,
										color: AL.mut,
										whiteSpace: "nowrap",
										overflow: "hidden",
										textOverflow: "ellipsis",
									}}
								>
									{a.name} · {a.kind}
								</div>
								{a.authClawback && (
									<div
										style={{
											fontFamily: AL.disp,
											fontSize: 11.5,
											color: "#B7791F",
											marginTop: 2,
											display: "flex",
											alignItems: "center",
											gap: 4,
										}}
									>
										<span aria-hidden>⚠</span> Issuer can freeze or claw back
									</div>
								)}
							</div>
							<div
								style={{
									marginLeft: "auto",
									flexShrink: 0,
									display: "flex",
									alignItems: "center",
									gap: 9,
								}}
							>
								{live ? (
									<Pill accent>
										<Dot /> Live
									</Pill>
								) : (
									<Pill>Soon</Pill>
								)}
								{live && (
									<span style={{ color: AL.mut2, fontSize: 17, lineHeight: 1 }}>
										›
									</span>
								)}
							</div>
						</button>
					)
				})}
			</div>
		</div>
	)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function AuthlineApp() {
	const [address, setAddress] = useState("")
	const [phase, setPhase] = useState<Phase>("directory")
	const [showModal, setShowModal] = useState(false)
	const [hash, setHash] = useState<string | null>(null)
	const [errMsg, setErrMsg] = useState("")
	const [available, setAvailable] = useState<Set<string>>(new Set())
	// wallet availability for the modal detection dots
	useEffect(() => {
		let cancelled = false
		kit
			.getSupportedWallets()
			.then((ws) => {
				if (!cancelled)
					setAvailable(
						new Set(ws.filter((w) => w.isAvailable).map((w) => w.id)),
					)
			})
			.catch(() => {})
		return () => {
			cancelled = true
		}
	}, [])

	// ?address=… read-only preview
	useEffect(() => {
		let cancelled = false
		const a = new URLSearchParams(window.location.search).get("address")
		if (a && isValidIssuer(a)) {
			setAddress(a)
			getActivationStatus({
				horizonUrl: NETWORK.horizonUrl,
				account: a,
				assetCode: ASSET.assetCode,
				assetIssuer: ASSET.assetIssuer,
			})
				.then((st) => {
					if (!cancelled) setPhase(st.isAuthorized ? "already" : "preview")
				})
				.catch(() => {
					if (!cancelled) setPhase("preview")
				})
		}
		return () => {
			cancelled = true
		}
	}, [])

	const connect = useCallback(async (id: string) => {
		try {
			const e2e = e2eSigner()
			let addr: string
			if (e2e) {
				addr = e2e.address
			} else {
				kit.setWallet(id)
				addr = (await kit.getAddress()).address
			}
			setShowModal(false)
			setAddress(addr)
			const st = await getActivationStatus({
				horizonUrl: NETWORK.horizonUrl,
				account: addr,
				assetCode: ASSET.assetCode,
				assetIssuer: ASSET.assetIssuer,
			})
			setPhase(st.isAuthorized ? "already" : "ready")
		} catch (e) {
			setShowModal(false)
			setErrMsg(e instanceof Error ? e.message : String(e))
			setPhase("error")
		}
	}, [])

	const pick = (a: DirItem) => {
		if (a.status === "live") setPhase(address ? "ready" : "idle")
	}
	const back = () => {
		setShowModal(false)
		setAddress("")
		setHash(null)
		setPhase("directory")
	}
	const reset = () => {
		setHash(null)
		setErrMsg("")
		setPhase(address ? "ready" : "directory")
	}

	const activate = useCallback(async () => {
		setErrMsg("")
		setPhase("building")
		try {
			const xdr =
				ASSET.capability === "open" || !ASSET.authorizer
					? await buildTrustTx({
							rpcUrl: NETWORK.rpcUrl,
							networkPassphrase: NETWORK.passphrase,
							holder: address,
							config: ASSET,
							allowHttp: NETWORK.allowHttp,
						})
					: await buildOnboardTx({
							rpcUrl: NETWORK.rpcUrl,
							networkPassphrase: NETWORK.passphrase,
							holder: address,
							config: ASSET,
							allowHttp: NETWORK.allowHttp,
						})
			setPhase("signing")
			const signedTxXdr = await signTx(xdr, address)
			setPhase("submitting")
			const server = new rpc.Server(NETWORK.rpcUrl, {
				allowHttp: NETWORK.allowHttp,
			})
			const sent = await server.sendTransaction(
				TransactionBuilder.fromXDR(signedTxXdr, NETWORK.passphrase),
			)
			if (sent.status === "ERROR")
				throw new Error("Transaction submission failed")
			// Bound the confirmation poll: a tx that never lands must surface an
			// error instead of leaving the UI stuck on "Submitting…" forever.
			const deadline = Date.now() + 180_000
			let got = await server.getTransaction(sent.hash)
			while (got.status === "NOT_FOUND" && Date.now() < deadline) {
				await sleep(1100)
				got = await server.getTransaction(sent.hash)
			}
			if (got.status === "NOT_FOUND")
				throw new Error("Transaction not confirmed within 180s — try again")
			if (got.status !== "SUCCESS")
				throw new Error(`Transaction ${got.status.toLowerCase()}`)
			setHash(sent.hash)
			setPhase("success")
		} catch (e) {
			setErrMsg(e instanceof Error ? e.message : String(e))
			setPhase("error")
		}
	}, [address])

	const busy =
		phase === "building" || phase === "signing" || phase === "submitting"

	let body: React.ReactNode = null
	if (phase === "directory") {
		body = <Directory onPick={pick} />
	} else if (phase === "idle") {
		body = (
			<div className="al-fade">
				<button
					className="al-link"
					onClick={back}
					style={{
						background: "none",
						border: "none",
						cursor: "pointer",
						padding: 0,
						marginBottom: 12,
						fontFamily: AL.disp,
						fontSize: 12.5,
						color: AL.mut,
					}}
				>
					‹ All assets
				</button>
				<AssetRow status={<Pill accent>Auth req.</Pill>} />
				<Divider />
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 14,
						lineHeight: 1.55,
						color: AL.mut,
						margin: "2px 0 18px",
					}}
				>
					Connect a wallet to create <b style={{ color: AL.ink }}>and</b>{" "}
					authorize your {ASSET.assetCode} trustline in a single signature.
				</p>
				<Primary
					onClick={() => (e2eSigner() ? connect("e2e") : setShowModal(true))}
				>
					<svg
						width="15"
						height="15"
						viewBox="0 0 16 16"
						fill="none"
						stroke="#FFFFFF"
						strokeWidth="1.7"
					>
						<rect x="2.5" y="4.5" width="11" height="8" rx="2" />
						<path d="M2.5 7h11" />
					</svg>
					Connect wallet
				</Primary>
				<div
					style={{
						display: "flex",
						justifyContent: "center",
						gap: 16,
						marginTop: 16,
						fontFamily: AL.mono,
						fontSize: 10.5,
						letterSpacing: "0.04em",
						textTransform: "uppercase",
						color: AL.mut2,
					}}
				>
					<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<Dot color={AL.emerald} size={5} /> Non-custodial
					</span>
					<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<Dot color={AL.emerald} size={5} /> CAP-73
					</span>
				</div>
			</div>
		)
	} else if (phase === "preview") {
		body = (
			<div className="al-fade">
				<div
					style={{
						display: "flex",
						gap: 10,
						alignItems: "flex-start",
						background: "rgba(46,111,168,0.08)",
						border: "1px solid rgba(46,111,168,0.28)",
						borderRadius: 12,
						padding: "11px 13px",
						marginBottom: 16,
					}}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="#2E6FA8"
						strokeWidth="1.6"
						style={{ flexShrink: 0, marginTop: 1 }}
					>
						<circle cx="8" cy="8" r="6.5" />
						<path d="M8 7.4v3.2M8 5.2v.2" />
					</svg>
					<div
						style={{
							fontFamily: AL.disp,
							fontSize: 12.5,
							lineHeight: 1.45,
							color: AL.mut,
						}}
					>
						Read-only preview for{" "}
						<span style={{ fontFamily: AL.mono, color: AL.ink }}>
							{short(address, 6, 6)}
						</span>
						. Connect this account to activate.
					</div>
				</div>
				<AssetRow status={<Pill>Not yet</Pill>} />
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV k="Trustline" v="● None" accent={AL.mut} mono={false} />
					<KV k="Authorized" v="No" mono={false} />
				</div>
				<div style={{ marginTop: 18 }}>
					<Primary onClick={() => setShowModal(true)}>
						Connect to activate
					</Primary>
				</div>
			</div>
		)
	} else if (phase === "ready") {
		body = (
			<div className="al-fade">
				<AssetRow status={<Pill accent>Auth req.</Pill>} />
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV k="Your account" v={short(address)} />
					<KV k="Network" v={ASSET.networkLabel} mono={false} />
					<KV
						k="You sign"
						v="1 transaction"
						accent={AL.emeraldBright}
						mono={false}
					/>
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 12.5,
						lineHeight: 1.5,
						color: AL.mut,
						margin: "15px 0 16px",
					}}
				>
					One signature runs{" "}
					<span style={{ fontFamily: AL.mono, color: AL.ink }}>trust()</span>{" "}
					(CAP-73) then authorizes the line — no separate “create a trustline”
					step.
				</p>
				<Primary onClick={activate}>
					<svg
						width="15"
						height="15"
						viewBox="0 0 16 16"
						fill="none"
						stroke="#FFFFFF"
						strokeWidth="1.9"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M3.5 8.5l3 3 6-7" />
					</svg>
					Activate {ASSET.assetCode} · 1 signature
				</Primary>
				<div
					style={{
						textAlign: "center",
						fontFamily: AL.mono,
						fontSize: 10.5,
						color: AL.mut2,
						marginTop: 12,
					}}
				>
					Only the network fee is spent.
				</div>
			</div>
		)
	} else if (busy) {
		const labels: Record<string, string> = {
			building: "Preparing your transaction…",
			signing: "Confirm in your wallet…",
			submitting: "Submitting to the network…",
		}
		body = (
			<div className="al-fade">
				<AssetRow status={<Pill>Pending</Pill>} />
				<Progress state={phase} />
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 12,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<Spinner color={AL.emerald} size={20} />
					<div
						style={{
							fontFamily: AL.disp,
							fontSize: 14.5,
							fontWeight: 500,
							color: AL.ink,
						}}
					>
						{labels[phase]}
					</div>
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 12,
						color: AL.mut2,
						margin: "14px 0 16px",
						minHeight: 16,
					}}
				>
					{phase === "signing"
						? "Approve the transaction in your wallet to continue."
						: phase === "submitting"
							? "Waiting for network confirmation."
							: "Building the one-signature onboarding transaction."}
				</p>
				<Primary disabled>
					<Spinner color={AL.mut} size={15} track="rgba(40,30,15,0.12)" />{" "}
					{phase === "signing" ? "Awaiting signature" : "Working…"}
				</Primary>
			</div>
		)
	} else if (phase === "success") {
		body = (
			<div className="al-fade">
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						textAlign: "center",
						paddingTop: 4,
					}}
				>
					<div
						style={{
							width: 62,
							height: 62,
							borderRadius: 62,
							background: AL.emeraldSoft,
							border: `1px solid ${AL.emeraldLine}`,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							marginBottom: 16,
							animation: "alpop .45s cubic-bezier(.2,.8,.3,1.2) both",
						}}
					>
						<svg width="30" height="30" viewBox="0 0 100 100" fill="none">
							<path
								className="al-check-c"
								d="M22 52 L42 72 L84 24"
								stroke={AL.emeraldBright}
								strokeWidth="12"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</div>
					<div
						style={{
							fontFamily: AL.disp,
							fontWeight: 600,
							fontSize: 22,
							color: AL.ink,
							letterSpacing: "-0.02em",
						}}
					>
						{ASSET.assetCode} trustline authorized
					</div>
					<div
						style={{
							fontFamily: AL.disp,
							fontSize: 14,
							color: AL.mut,
							marginTop: 6,
						}}
					>
						You’re ready to receive {ASSET.assetCode}.
					</div>
				</div>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "16px 0",
						margin: "18px 0 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV
						k="Status"
						v="● Authorized"
						accent={AL.emeraldBright}
						mono={false}
					/>
					<KV k="Account" v={short(address)} />
					{hash && <KV k="Transaction" v={short(hash)} />}
				</div>
				<div style={{ display: "flex", gap: 10, marginTop: 16 }}>
					{hash && (
						<Ghost full href={txUrl(hash)}>
							View on Explorer
						</Ghost>
					)}
					<Primary onClick={reset}>Done</Primary>
				</div>
			</div>
		)
	} else if (phase === "already") {
		body = (
			<div className="al-fade">
				<AssetRow
					status={
						<Pill accent>
							<svg
								width="10"
								height="10"
								viewBox="0 0 16 16"
								fill="none"
								stroke={AL.emeraldBright}
								strokeWidth="2.4"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M3.5 8.5l3 3 6-7" />
							</svg>{" "}
							Authorized
						</Pill>
					}
				/>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV k="Your account" v={short(address)} />
					<KV k="Authorized" v="● Yes" accent={AL.emeraldBright} mono={false} />
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 13,
						lineHeight: 1.5,
						color: AL.mut,
						margin: "15px 0 16px",
					}}
				>
					You’re all set — this account can already hold and receive{" "}
					{ASSET.assetCode}.
				</p>
				<Ghost full href={acctUrl(address)}>
					View on Explorer
				</Ghost>
			</div>
		)
	} else if (phase === "error") {
		body = (
			<div className="al-fade">
				<AssetRow status={<Pill tone="err">Failed</Pill>} />
				<div
					style={{
						display: "flex",
						gap: 11,
						alignItems: "flex-start",
						background: "rgba(181,83,46,0.08)",
						border: "1px solid rgba(181,83,46,0.25)",
						borderRadius: 12,
						padding: "13px 14px",
						margin: "4px 0 16px",
					}}
				>
					<svg
						width="17"
						height="17"
						viewBox="0 0 16 16"
						fill="none"
						stroke="#B5532E"
						strokeWidth="1.6"
						style={{ flexShrink: 0, marginTop: 1 }}
					>
						<circle cx="8" cy="8" r="6.5" />
						<path d="M8 5v3.6M8 10.8v.2" />
					</svg>
					<div>
						<div
							style={{
								fontFamily: AL.disp,
								fontWeight: 600,
								fontSize: 14,
								color: AL.ink,
							}}
						>
							Couldn’t authorize
						</div>
						<div
							style={{
								fontFamily: AL.disp,
								fontSize: 12.5,
								lineHeight: 1.45,
								color: AL.mut,
								marginTop: 3,
							}}
						>
							{errMsg ||
								"The transaction was rejected. Nothing was submitted to the network."}
						</div>
					</div>
				</div>
				<div style={{ display: "flex", gap: 10 }}>
					<Ghost full onClick={reset}>
						Cancel
					</Ghost>
					<Primary onClick={activate}>Try again</Primary>
				</div>
			</div>
		)
	}

	const connected =
		!!address && !["idle", "preview", "directory"].includes(phase)
	const head =
		phase === "directory"
			? {
					t: "Activate a Stellar asset",
					s: `One signature to hold any supported asset — ${ASSET.assetCode} is live now, more onboarding soon.`,
				}
			: {
					t: `Activate ${ASSET.assetCode}`,
					s: `Receive ${ASSET.name} in one signature.`,
				}

	return (
		<div
			style={{
				position: "relative",
				width: "100%",
				minHeight: "100%",
				background: AL.paper,
				overflow: "hidden",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<div
				style={{
					position: "absolute",
					top: -180,
					right: -140,
					width: 520,
					height: 520,
					borderRadius: 520,
					background:
						"radial-gradient(circle, rgba(22,115,74,0.05), transparent 62%)",
					pointerEvents: "none",
				}}
			/>
			<div
				style={{
					position: "relative",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "20px 26px",
					flexShrink: 0,
				}}
			>
				<a
					href="./index.html"
					style={{
						display: "flex",
						alignItems: "center",
						gap: 10,
						textDecoration: "none",
					}}
				>
					<svg width="27" height="27" viewBox="0 0 100 100" fill="none">
						<rect
							x="14"
							y="33"
							width="72"
							height="34"
							rx="17"
							stroke={AL.emerald}
							strokeWidth="6.5"
						/>
						<circle cx="67" cy="50" r="12.5" fill={AL.emerald} />
					</svg>
					<span
						style={{
							fontFamily: AL.disp,
							fontWeight: 700,
							fontSize: 19,
							letterSpacing: "-0.03em",
							color: AL.ink,
						}}
					>
						Authline
					</span>
				</a>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 16,
						fontFamily: AL.disp,
						fontSize: 13.5,
						color: AL.mut,
					}}
				>
					<a
						className="al-link"
						href={REPO_URL}
						target="_blank"
						rel="noopener noreferrer"
						style={{ color: AL.mut, textDecoration: "none" }}
					>
						Docs
					</a>
					{connected ? (
						<Pill>
							<Dot color={AL.emeraldBright} /> {short(address)}
						</Pill>
					) : (
						<Pill>
							<Dot color={AL.emerald} /> {IS_PUBLIC ? "Mainnet" : "Testnet"}
						</Pill>
					)}
				</div>
			</div>
			<div
				style={{
					position: "relative",
					flex: 1,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					padding: "8px 24px 40px",
				}}
			>
				<div style={{ textAlign: "center", marginBottom: 22, maxWidth: 380 }}>
					<h1
						style={{
							margin: 0,
							fontFamily: AL.disp,
							fontWeight: 600,
							fontSize: 27,
							letterSpacing: "-0.025em",
							color: AL.ink,
						}}
					>
						{head.t}
					</h1>
					<p
						style={{
							margin: "8px 0 0",
							fontFamily: AL.disp,
							fontSize: 14.5,
							color: AL.mut,
							lineHeight: 1.5,
						}}
					>
						{head.s}
					</p>
				</div>
				<Card>{body}</Card>
				<div
					style={{
						fontFamily: AL.mono,
						fontSize: 11,
						color: AL.mut2,
						marginTop: 20,
						textAlign: "center",
						letterSpacing: "0.03em",
					}}
				>
					Powered by Authline · one signature via CAP-73
				</div>
			</div>
			{showModal && (
				<WalletModal
					onPick={connect}
					onClose={() => setShowModal(false)}
					available={available}
				/>
			)}
		</div>
	)
}
