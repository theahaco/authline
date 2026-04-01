import { Button, Card, Icon, Input, Text } from "@stellar/design-system"
import {
	Asset,
	Horizon,
	Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import { useCallback, useEffect, useState } from "react"
import eurcvAuth from "../contracts/eurcv_auth"
import { horizonUrl, networkPassphrase } from "../contracts/util"
import { useWallet } from "../hooks/useWallet"
import { connectWallet } from "../util/wallet"

const EURCV_ISSUER = "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G"
const eurcAsset = new Asset("EURCV", EURCV_ISSUER)

type Status = "idle" | "loading" | "success" | "error"

export const AuthorizeTrustline = () => {
	const {
		address,
		signTransaction,
		networkPassphrase: walletPassphrase,
	} = useWallet()
	const isWrongNetwork =
		address && walletPassphrase && walletPassphrase !== networkPassphrase
	const [account, setAccount] = useState("")
	const [hasTrustline, setHasTrustline] = useState(false)
	const [isAuthorized, setIsAuthorized] = useState(false)
	const [checking, setChecking] = useState(false)
	const [classicStatus, setClassicStatus] = useState<Status>("idle")
	const [sorobanStatus, setSorobanStatus] = useState<Status>("idle")
	const [classicError, setClassicError] = useState("")
	const [sorobanError, setSorobanError] = useState("")

	const checkAccountStatus = useCallback(async (addr: string) => {
		if (!addr.trim()) return
		setChecking(true)
		try {
			const horizon = new Horizon.Server(horizonUrl)
			const acc = await horizon.loadAccount(addr)
			const trustline = acc.balances.find(
				(b) =>
					b.asset_type !== "native" &&
					b.asset_type !== "liquidity_pool_shares" &&
					(b as Horizon.HorizonApi.BalanceLineAsset).asset_code === "EURCV" &&
					(b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer ===
						EURCV_ISSUER,
			) as Horizon.HorizonApi.BalanceLineAsset | undefined

			setHasTrustline(!!trustline)
			setIsAuthorized(!!trustline?.is_authorized)
		} catch {
			setHasTrustline(false)
			setIsAuthorized(false)
		} finally {
			setChecking(false)
		}
	}, [])

	useEffect(() => {
		if (address && !account) setAccount(address)
	}, [address, account])

	useEffect(() => {
		if (account.trim().length >= 56) {
			void checkAccountStatus(account.trim())
		} else {
			setHasTrustline(false)
			setIsAuthorized(false)
		}
	}, [account, checkAccountStatus, classicStatus, sorobanStatus])

	const handleClassicTrustline = async () => {
		if (!address) return

		setClassicStatus("loading")
		setClassicError("")

		try {
			const horizon = new Horizon.Server(horizonUrl)
			const sourceAccount = await horizon.loadAccount(address)

			const tx = new TransactionBuilder(sourceAccount, {
				fee: "100",
				networkPassphrase: networkPassphrase as string,
			})
				.addOperation(Operation.changeTrust({ asset: eurcAsset }))
				.setTimeout(180)
				.build()

			const { signedTxXdr } = await signTransaction(tx.toXDR(), {
				networkPassphrase,
			})
			const result = await horizon.submitTransaction(
				TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase as string),
			)
			if ((result as any).successful) {
				setClassicStatus("success")
			} else {
				setClassicError("Transaction failed")
				setClassicStatus("error")
			}
		} catch (e: any) {
			const extras = e?.response?.data?.extras
			const resultCodes = extras?.result_codes
			const msg =
				resultCodes?.operations?.[0] ||
				resultCodes?.transaction ||
				extras?.result_xdr ||
				(e instanceof Error ? e.message : String(e))
			setClassicError(String(msg))
			setClassicStatus("error")
		}
	}

	const handleSorobanAuthorize = async () => {
		const trimmed = account.trim()
		if (!trimmed || !address) return

		setSorobanStatus("loading")
		setSorobanError("")

		try {
			const tx = await eurcvAuth.authorize_trustline(
				{ account: trimmed },
				{ publicKey: address },
			)
			const { result } = await (tx as any).signAndSend({ signTransaction })

			if (result.isOk()) {
				setSorobanStatus("success")
			} else {
				setSorobanError(String(result.unwrapErr()))
				setSorobanStatus("error")
			}
		} catch (e) {
			setSorobanError(e instanceof Error ? e.message : String(e))
			setSorobanStatus("error")
		}
	}

	return (
		<div className="AuthorizeTrustline">
			<div className="AuthorizeTrustline__hero">
				<h1>EURCV Trustline Authorization</h1>
				<Text as="p" size="md">
					Authorize an account&apos;s EURCV trustline on Stellar mainnet.
				</Text>
			</div>

			<div className="AuthorizeTrustline__card">
				<Card>
					{!address ? (
						<div className="AuthorizeTrustline__connect">
							<Text as="p" size="md">
								Connect your wallet to get started.
							</Text>
							<Button
								variant="primary"
								size="lg"
								onClick={() => void connectWallet()}
							>
								<Icon.Wallet02 />
								Connect Wallet
							</Button>
						</div>
					) : (
						<>
							{isWrongNetwork && (
								<div className="AuthorizeTrustline__result AuthorizeTrustline__result--error">
									<Icon.AlertTriangle />
									<Text as="p" size="md">
										Your wallet is set to testnet. In Freighter, go to Settings
										&gt; Network &gt; select <strong>Mainnet</strong>, then
										reconnect.
									</Text>
								</div>
							)}
							<Input
								id="account"
								fieldSize="lg"
								label="Account address"
								placeholder="G..."
								value={account}
								onChange={(e) => setAccount(e.target.value)}
							/>
							{account !== address && (
								<Button
									variant="tertiary"
									size="sm"
									onClick={() => setAccount(address)}
								>
									Use my address
								</Button>
							)}

							<div className="AuthorizeTrustline__actions">
								<Button
									variant="secondary"
									size="lg"
									disabled={
										classicStatus === "loading" || hasTrustline || checking
									}
									onClick={() => void handleClassicTrustline()}
								>
									{hasTrustline
										? "Trustline Added"
										: classicStatus === "loading"
											? "Adding..."
											: "Add EURCV Trustline"}
								</Button>
								<Button
									variant="primary"
									size="lg"
									disabled={
										sorobanStatus === "loading" ||
										!account.trim() ||
										isAuthorized ||
										checking
									}
									onClick={() => void handleSorobanAuthorize()}
								>
									{isAuthorized
										? "Already Authorized"
										: sorobanStatus === "loading"
											? "Authorizing..."
											: "Authorize Trustline"}
								</Button>
							</div>

							{!checking && hasTrustline && isAuthorized ? (
								<div className="AuthorizeTrustline__result AuthorizeTrustline__result--success">
									<Icon.CheckCircle />
									<div>
										<Text as="p" size="md">
											This account has an authorized EURCV trustline.
										</Text>
										<a
											href={`https://stellar.expert/explorer/public/account/${account.trim()}`}
											target="_blank"
											rel="noopener noreferrer"
											style={{ fontSize: "0.875rem" }}
										>
											View on Stellar Expert
										</a>
									</div>
								</div>
							) : (
								<Text
									as="p"
									size="sm"
									style={{ marginTop: "0.75rem", opacity: 0.6 }}
								>
									Step 1: Add the classic EURCV trustline. Step 2: Authorize it
									on the admin contract.
								</Text>
							)}
						</>
					)}

					{classicStatus === "success" && (
						<div className="AuthorizeTrustline__result AuthorizeTrustline__result--success">
							<Icon.CheckCircle />
							<Text as="p" size="md">
								EURCV trustline added successfully.
							</Text>
						</div>
					)}
					{classicStatus === "error" && (
						<div className="AuthorizeTrustline__result AuthorizeTrustline__result--error">
							<Icon.XCircle />
							<Text as="p" size="md">
								{classicError}
							</Text>
						</div>
					)}
					{sorobanStatus === "success" && (
						<div className="AuthorizeTrustline__result AuthorizeTrustline__result--success">
							<Icon.CheckCircle />
							<Text as="p" size="md">
								Trustline authorized successfully.
							</Text>
						</div>
					)}
					{sorobanStatus === "error" && (
						<div className="AuthorizeTrustline__result AuthorizeTrustline__result--error">
							<Icon.XCircle />
							<Text as="p" size="md">
								{sorobanError}
							</Text>
						</div>
					)}
				</Card>
			</div>
		</div>
	)
}
