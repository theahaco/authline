import { rpc, TransactionBuilder } from "@stellar/stellar-sdk"
import { useCallback, useState } from "react"
import { decodeOnboardStatus } from "./onboard-status.js"
import { buildOnboardTx, defaultAllowHttp } from "./onboard.js"
import { type OnboarderConfig } from "./index.js"

export type ActivationState =
	| "idle"
	| "building"
	| "signing"
	| "submitting"
	| "success"
	| "error"

export interface UseActivationArgs {
	rpcUrl: string
	networkPassphrase: string
	config: OnboarderConfig
	allowHttp?: boolean
	/** Wallet signing callback, e.g. Stellar Wallets Kit `signTransaction`. */
	signTransaction: (
		xdr: string,
		opts: { networkPassphrase: string },
	) => Promise<{ signedTxXdr: string }>
}

/**
 * Headless hook driving the one-signature activation flow. Bring your own
 * wallet `signTransaction` (Stellar Wallets Kit, Freighter, etc.).
 */
export function useActivation(args: UseActivationArgs) {
	const [state, setState] = useState<ActivationState>("idle")
	const [error, setError] = useState<string | null>(null)
	const [hash, setHash] = useState<string | null>(null)
	// The router can succeed (tx SUCCESS) while returning TrustlineOnly — the
	// trustline was created but no one-step authorizer authorized it.
	const [trustlineOnly, setTrustlineOnly] = useState(false)

	const activate = useCallback(
		async (holder: string) => {
			setError(null)
			setTrustlineOnly(false)
			try {
				setState("building")
				const xdr = await buildOnboardTx({
					rpcUrl: args.rpcUrl,
					networkPassphrase: args.networkPassphrase,
					holder,
					config: args.config,
					allowHttp: args.allowHttp,
				})

				setState("signing")
				const { signedTxXdr } = await args.signTransaction(xdr, {
					networkPassphrase: args.networkPassphrase,
				})

				setState("submitting")
				const server = new rpc.Server(args.rpcUrl, {
					allowHttp: args.allowHttp ?? defaultAllowHttp(args.rpcUrl),
				})
				const signed = TransactionBuilder.fromXDR(
					signedTxXdr,
					args.networkPassphrase,
				)
				const sent = await server.sendTransaction(signed)
				if (sent.status === "ERROR")
					throw new Error(
						sent.errorResult?.result().toString() ??
							"sendTransaction returned ERROR",
					)
				setHash(sent.hash)

				// Bound the confirmation poll: a dropped / expired / mempool-evicted
				// tx must surface an error rather than hang the hook forever (mirrors
				// the backend pollForSuccess 180s deadline).
				const deadline = Date.now() + 180_000
				let got = await server.getTransaction(sent.hash)
				while (got.status === "NOT_FOUND" && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 1000))
					got = await server.getTransaction(sent.hash)
				}
				if (got.status === "NOT_FOUND")
					throw new Error(
						"activation timed out: transaction not confirmed within 180s",
					)
				// Compare against the enum so TypeScript narrows `got` to the
				// successful response shape and exposes `returnValue`.
				if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS)
					throw new Error(`activation failed: ${got.status}`)
				// Only claim full activation when the chain explicitly reported
				// Authorized; an absent/undecodable return value must NOT over-claim
				// (this generic hook has no asset-capability hint to fall back on, so
				// "unknown" is treated as trustline-only rather than authorized).
				setTrustlineOnly(decodeOnboardStatus(got.returnValue) !== "Authorized")
				setState("success")
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
				setState("error")
			}
		},
		[args],
	)

	return { state, error, hash, trustlineOnly, activate }
}

export interface ActivateButtonProps extends UseActivationArgs {
	holder: string
	label?: string
}

/** Minimal one-click activation button. */
export function ActivateButton({
	holder,
	label,
	...rest
}: ActivateButtonProps) {
	const { state, error, trustlineOnly, activate } = useActivation(rest)
	const busy =
		state === "building" || state === "signing" || state === "submitting"
	return (
		<div className="trustline-onboarder">
			<button
				disabled={busy || state === "success"}
				onClick={() => void activate(holder)}
			>
				{state === "success"
					? trustlineOnly
						? "Trustline created"
						: "Activated ✓"
					: busy
						? "Activating…"
						: (label ?? `Activate ${rest.config.assetCode} (1 signature)`)}
			</button>
			{state === "error" && <p role="alert">{error}</p>}
		</div>
	)
}
