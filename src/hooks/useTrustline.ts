import {
	Asset,
	Horizon,
	Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import { useCallback, useState } from "react"
import { horizonUrl, networkPassphrase } from "../contracts/util"
import { useWallet } from "./useWallet"

type Status = "idle" | "loading" | "success" | "error"

export function useTrustline() {
	const { address, signTransaction, updateBalances } = useWallet()
	const [status, setStatus] = useState<Status>("idle")
	const [error, setError] = useState<string | null>(null)

	const reset = useCallback(() => {
		setStatus("idle")
		setError(null)
	}, [])

	const addTrustline = useCallback(
		async (assetCode: string, issuer: string) => {
			if (!address) return

			setStatus("loading")
			setError(null)

			try {
				const horizon = new Horizon.Server(horizonUrl)
				const sourceAccount = await horizon.loadAccount(address)
				const asset = new Asset(assetCode, issuer)

				const tx = new TransactionBuilder(sourceAccount, {
					fee: "100",
					networkPassphrase: networkPassphrase as string,
				})
					.addOperation(Operation.changeTrust({ asset }))
					.setTimeout(180)
					.build()

				const { signedTxXdr } = await signTransaction(tx.toXDR(), {
					networkPassphrase,
				})
				const result = await horizon.submitTransaction(
					TransactionBuilder.fromXDR(
						signedTxXdr,
						networkPassphrase as string,
					),
				)
				if ((result as any).successful) {
					setStatus("success")
					await updateBalances()
				} else {
					setError("Transaction failed")
					setStatus("error")
				}
			} catch (e: any) {
				const extras = e?.response?.data?.extras
				const resultCodes = extras?.result_codes
				const msg =
					resultCodes?.operations?.[0] ||
					resultCodes?.transaction ||
					extras?.result_xdr ||
					(e instanceof Error ? e.message : String(e))
				setError(String(msg))
				setStatus("error")
			}
		},
		[address, signTransaction, updateBalances],
	)

	const removeTrustline = useCallback(
		async (assetCode: string, issuer: string) => {
			if (!address) return

			setStatus("loading")
			setError(null)

			try {
				const horizon = new Horizon.Server(horizonUrl)
				const sourceAccount = await horizon.loadAccount(address)
				const asset = new Asset(assetCode, issuer)

				const tx = new TransactionBuilder(sourceAccount, {
					fee: "100",
					networkPassphrase: networkPassphrase as string,
				})
					.addOperation(Operation.changeTrust({ asset, limit: "0" }))
					.setTimeout(180)
					.build()

				const { signedTxXdr } = await signTransaction(tx.toXDR(), {
					networkPassphrase,
				})
				const result = await horizon.submitTransaction(
					TransactionBuilder.fromXDR(
						signedTxXdr,
						networkPassphrase as string,
					),
				)
				if ((result as any).successful) {
					setStatus("success")
					await updateBalances()
				} else {
					setError("Transaction failed")
					setStatus("error")
				}
			} catch (e: any) {
				const extras = e?.response?.data?.extras
				const resultCodes = extras?.result_codes
				const msg =
					resultCodes?.operations?.[0] ||
					resultCodes?.transaction ||
					extras?.result_xdr ||
					(e instanceof Error ? e.message : String(e))
				setError(String(msg))
				setStatus("error")
			}
		},
		[address, signTransaction, updateBalances],
	)

	return { addTrustline, removeTrustline, status, error, reset }
}
