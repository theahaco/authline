import {
	Address,
	Asset,
	BASE_FEE,
	Contract,
	Horizon,
	nativeToScVal,
	Operation,
	rpc,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import { useCallback, useEffect, useState } from "react"
import { type OfficialAsset } from "../contracts/assets"
import {
	horizonUrl,
	networkPassphrase,
	rpcUrl,
	trustlineOnboardContractId,
} from "../contracts/util"

export type Status = "idle" | "loading" | "success" | "error"

type SignFn = (
	xdr: string,
	opts: { networkPassphrase: string; address?: string },
) => Promise<{ signedTxXdr: string }>

const PASSPHRASE = networkPassphrase as string

async function pollForSuccess(server: rpc.Server, hash: string): Promise<void> {
	let res = await server.getTransaction(hash)
	const deadline = Date.now() + 180_000
	while (res.status === "NOT_FOUND" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1000))
		res = await server.getTransaction(hash)
	}
	if (res.status !== "SUCCESS") throw new Error(`Transaction ${res.status}`)
}

export function useOnboard(
	asset: OfficialAsset | null,
	address: string | null,
	signTransaction: SignFn,
) {
	const [hasTrustline, setHasTrustline] = useState(false)
	const [isAuthorized, setIsAuthorized] = useState(false)
	const [checking, setChecking] = useState(false)
	const [classic, setClassic] = useState<{ status: Status; error: string }>({
		status: "idle",
		error: "",
	})
	const [authorize, setAuthorize] = useState<{ status: Status; error: string }>(
		{ status: "idle", error: "" },
	)
	const [oneStep, setOneStep] = useState<{ status: Status; error: string }>({
		status: "idle",
		error: "",
	})

	const refresh = useCallback(
		async (account: string) => {
			if (!asset || !account.trim()) return
			setChecking(true)
			try {
				const horizon = new Horizon.Server(horizonUrl)
				const acc = await horizon.loadAccount(account.trim())
				const tl = acc.balances.find(
					(b) =>
						b.asset_type !== "native" &&
						b.asset_type !== "liquidity_pool_shares" &&
						(b as Horizon.HorizonApi.BalanceLineAsset).asset_code ===
							asset.code &&
						(b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer ===
							asset.issuer,
				) as Horizon.HorizonApi.BalanceLineAsset | undefined
				setHasTrustline(!!tl)
				setIsAuthorized(!!tl?.is_authorized)
			} catch (e) {
				// 404 = account not funded / no such account → definitively no trustline.
				// Other (transient/network) errors: keep prior state rather than implying "no trustline".
				const status = (e as { response?: { status?: number } })?.response
					?.status
				if (status === 404) {
					setHasTrustline(false)
					setIsAuthorized(false)
				}
			} finally {
				setChecking(false)
			}
		},
		[asset],
	)

	// Reset per-asset state when the selected asset changes.
	useEffect(() => {
		setHasTrustline(false)
		setIsAuthorized(false)
		setClassic({ status: "idle", error: "" })
		setAuthorize({ status: "idle", error: "" })
		setOneStep({ status: "idle", error: "" })
	}, [asset])

	const runClassic = useCallback(async () => {
		if (!asset || !address) return
		setClassic({ status: "loading", error: "" })
		try {
			const horizon = new Horizon.Server(horizonUrl)
			const source = await horizon.loadAccount(address)
			const tx = new TransactionBuilder(source, {
				fee: BASE_FEE,
				networkPassphrase: PASSPHRASE,
			})
				.addOperation(
					Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer) }),
				)
				.setTimeout(180)
				.build()
			const { signedTxXdr } = await signTransaction(tx.toXDR(), {
				networkPassphrase: PASSPHRASE,
				address,
			})
			const result = await horizon.submitTransaction(
				TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE),
			)
			if (result.successful) {
				setClassic({ status: "success", error: "" })
				await refresh(address)
			} else {
				setClassic({ status: "error", error: "Transaction failed" })
			}
		} catch (e: unknown) {
			const ex = e as {
				response?: {
					data?: {
						extras?: {
							result_codes?: { operations?: string[]; transaction?: string }
							result_xdr?: string
						}
					}
				}
			}
			const codes = ex?.response?.data?.extras?.result_codes
			const msg =
				codes?.operations?.[0] ||
				codes?.transaction ||
				ex?.response?.data?.extras?.result_xdr ||
				(e instanceof Error ? e.message : String(e))
			setClassic({ status: "error", error: String(msg) })
		}
	}, [asset, address, signTransaction, refresh])

	const runAuthorize = useCallback(
		async (account: string) => {
			if (!asset?.authorizer || !address || !account.trim()) return
			setAuthorize({ status: "loading", error: "" })
			try {
				const server = new rpc.Server(rpcUrl, { allowHttp: true })
				const source = await server.getAccount(address)
				const contract = new Contract(asset.authorizer)
				const tx = new TransactionBuilder(source, {
					fee: BASE_FEE,
					networkPassphrase: PASSPHRASE,
				})
					.addOperation(
						contract.call(
							"authorize_trustline",
							nativeToScVal(Address.fromString(account.trim()), {
								type: "address",
							}),
						),
					)
					.setTimeout(180)
					.build()
				const prepared = await server.prepareTransaction(tx)
				const { signedTxXdr } = await signTransaction(prepared.toXDR(), {
					networkPassphrase: PASSPHRASE,
					address,
				})
				const send = await server.sendTransaction(
					TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE),
				)
				if (send.status === "ERROR") {
					throw new Error(
						send.errorResult?.result().toString() ??
							"sendTransaction returned ERROR",
					)
				}
				await pollForSuccess(server, send.hash)
				setAuthorize({ status: "success", error: "" })
				await refresh(account.trim())
			} catch (e) {
				setAuthorize({
					status: "error",
					error: e instanceof Error ? e.message : String(e),
				})
			}
		},
		[asset, address, signTransaction, refresh],
	)

	const runOneStep = useCallback(async () => {
		if (!asset?.authorizer || !address || !trustlineOnboardContractId) return
		setOneStep({ status: "loading", error: "" })
		try {
			const server = new rpc.Server(rpcUrl, { allowHttp: true })
			const source = await server.getAccount(address)
			const contract = new Contract(trustlineOnboardContractId)
			const tx = new TransactionBuilder(source, {
				fee: BASE_FEE,
				networkPassphrase: PASSPHRASE,
			})
				.addOperation(
					contract.call(
						"onboard",
						nativeToScVal(Address.fromString(asset.sac), { type: "address" }),
						nativeToScVal(Address.fromString(asset.authorizer), {
							type: "address",
						}),
						nativeToScVal(Address.fromString(address), { type: "address" }),
					),
				)
				.setTimeout(180)
				.build()
			const prepared = await server.prepareTransaction(tx)
			const { signedTxXdr } = await signTransaction(prepared.toXDR(), {
				networkPassphrase: PASSPHRASE,
				address,
			})
			const send = await server.sendTransaction(
				TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE),
			)
			if (send.status === "ERROR") {
				throw new Error(
					send.errorResult?.result().toString() ??
						"sendTransaction returned ERROR",
				)
			}
			await pollForSuccess(server, send.hash)
			setOneStep({ status: "success", error: "" })
			await refresh(address)
		} catch (e) {
			setOneStep({
				status: "error",
				error: e instanceof Error ? e.message : String(e),
			})
		}
	}, [asset, address, signTransaction, refresh])

	return {
		hasTrustline,
		isAuthorized,
		checking,
		classic,
		authorize,
		oneStep,
		runClassic,
		runAuthorize,
		runOneStep,
		refresh,
	}
}
