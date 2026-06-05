import { rpc, TransactionBuilder } from "@stellar/stellar-sdk"
import { useCallback, useState } from "react"
import { buildOnboardTx } from "./onboard.js"
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

	const activate = useCallback(
		async (holder: string) => {
			setError(null)
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
					allowHttp: args.allowHttp ?? false,
				})
				const signed = TransactionBuilder.fromXDR(
					signedTxXdr,
					args.networkPassphrase,
				)
				const sent = await server.sendTransaction(signed)
				setHash(sent.hash)

				let got = await server.getTransaction(sent.hash)
				while (got.status === "NOT_FOUND") {
					await new Promise((r) => setTimeout(r, 1000))
					got = await server.getTransaction(sent.hash)
				}
				if (got.status !== "SUCCESS")
					throw new Error(`activation failed: ${got.status}`)
				setState("success")
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
				setState("error")
			}
		},
		[args],
	)

	return { state, error, hash, activate }
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
	const { state, error, activate } = useActivation(rest)
	const busy =
		state === "building" || state === "signing" || state === "submitting"
	return (
		<div className="trustline-onboarder">
			<button
				disabled={busy || state === "success"}
				onClick={() => void activate(holder)}
			>
				{state === "success"
					? "Activated ✓"
					: busy
						? "Activating…"
						: (label ?? `Activate ${rest.config.assetCode} (1 signature)`)}
			</button>
			{state === "error" && <p role="alert">{error}</p>}
		</div>
	)
}
