import { useCallback, useState } from "react"
import eurcvAuth from "../contracts/eurcv_auth"
import { useWallet } from "./useWallet"

type Status = "idle" | "loading" | "success" | "error"

export function useEurcvAuth() {
	const { address, signTransaction, updateBalances } = useWallet()
	const [status, setStatus] = useState<Status>("idle")
	const [error, setError] = useState<string | null>(null)

	const reset = useCallback(() => {
		setStatus("idle")
		setError(null)
	}, [])

	const authorize = useCallback(async () => {
		if (!address) return

		setStatus("loading")
		setError(null)

		try {
			const tx = await eurcvAuth.authorize_trustline(
				{ account: address },
				{ publicKey: address },
			)
			const { result } = await (tx as any).signAndSend({ signTransaction })

			if (result.isOk()) {
				setStatus("success")
				await updateBalances()
			} else {
				setError(String(result.unwrapErr()))
				setStatus("error")
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
			setStatus("error")
		}
	}, [address, signTransaction, updateBalances])

	return { authorize, status, error, reset }
}
