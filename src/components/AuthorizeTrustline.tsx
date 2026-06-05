import { Button, Card, Icon, Input, Text } from "@stellar/design-system"
import { useEffect, useMemo, useState } from "react"
import { assetsForNetwork, type OfficialAsset } from "../contracts/assets"
import {
	networkPassphrase,
	stellarNetwork,
	trustlineOnboardContractId,
} from "../contracts/util"
import { useOnboard } from "../hooks/useOnboard"
import { useWallet } from "../hooks/useWallet"
import { connectWallet } from "../util/wallet"
import { AssetSelector } from "./AssetSelector"

const EXPLORER_PATH: Record<string, string | null> = {
	PUBLIC: "public",
	TESTNET: "testnet",
	FUTURENET: null,
	LOCAL: null,
}

export const AuthorizeTrustline = () => {
	const {
		address,
		signTransaction,
		networkPassphrase: walletPassphrase,
	} = useWallet()
	const isWrongNetwork =
		address && walletPassphrase && walletPassphrase !== networkPassphrase

	const assets = useMemo(() => assetsForNetwork(), [])
	const [selected, setSelected] = useState<OfficialAsset | null>(
		assets[0] ?? null,
	)
	const [account, setAccount] = useState("")

	const ob = useOnboard(selected, address ?? null, signTransaction)

	useEffect(() => {
		if (address && !account) setAccount(address)
	}, [address, account])

	useEffect(() => {
		if (account.trim().length >= 56) void ob.refresh(account.trim())
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [account, selected])

	const isSelf = account.trim() === address
	const explorer = EXPLORER_PATH[stellarNetwork]
	const canOneStep =
		!!selected &&
		selected.capability === "permissionedOneStep" &&
		!!trustlineOnboardContractId &&
		isSelf &&
		!ob.hasTrustline &&
		!ob.isAuthorized
	const isPermissioned = selected?.capability !== "open"

	return (
		<div className="AuthorizeTrustline">
			<div className="AuthorizeTrustline__hero">
				<h1>Stellar Asset Onboarding</h1>
				<Text as="p" size="md">
					Add a trustline to an official Stellar asset — and authorize it in one
					step where required.
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
										Your wallet is on the wrong network. Switch it to match the
										app, then reconnect.
									</Text>
								</div>
							)}

							<AssetSelector
								assets={assets}
								selected={selected}
								onSelect={setSelected}
							/>

							{selected && (
								<>
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
										{canOneStep && (
											<Button
												variant="primary"
												size="lg"
												disabled={
													ob.oneStep.status === "loading" ||
													ob.checking ||
													!!isWrongNetwork
												}
												onClick={() => void ob.runOneStep()}
											>
												{ob.oneStep.status === "loading"
													? "Onboarding..."
													: `Add & Authorize ${selected.code} (1 signature)`}
											</Button>
										)}
										<Button
											variant={canOneStep ? "secondary" : "primary"}
											size="lg"
											disabled={
												ob.classic.status === "loading" ||
												ob.hasTrustline ||
												ob.checking ||
												!!isWrongNetwork
											}
											onClick={() => void ob.runClassic()}
										>
											{ob.hasTrustline
												? "Trustline Added"
												: ob.classic.status === "loading"
													? "Adding..."
													: `Add ${selected.code} Trustline`}
										</Button>
										{isPermissioned && selected.authorizer && (
											<Button
												variant="secondary"
												size="lg"
												disabled={
													ob.authorize.status === "loading" ||
													!account.trim() ||
													ob.isAuthorized ||
													ob.checking ||
													!!isWrongNetwork
												}
												onClick={() => void ob.runAuthorize(account.trim())}
											>
												{ob.isAuthorized
													? "Already Authorized"
													: ob.authorize.status === "loading"
														? "Authorizing..."
														: "Authorize Trustline"}
											</Button>
										)}
									</div>

									{!ob.checking &&
									ob.hasTrustline &&
									(isPermissioned ? ob.isAuthorized : true) ? (
										<div className="AuthorizeTrustline__result AuthorizeTrustline__result--success">
											<Icon.CheckCircle />
											<div>
												<Text as="p" size="md">
													{isPermissioned
														? `This account has an authorized ${selected.code} trustline.`
														: `This account holds a ${selected.code} trustline.`}
												</Text>
												{explorer && (
													<a
														href={`https://stellar.expert/explorer/${explorer}/account/${account.trim()}`}
														target="_blank"
														rel="noopener noreferrer"
														style={{ fontSize: "0.875rem" }}
													>
														View on Stellar Expert
													</a>
												)}
											</div>
										</div>
									) : (
										<Text
											as="p"
											size="sm"
											style={{ marginTop: "0.75rem", opacity: 0.6 }}
										>
											{selected.capability === "open"
												? `Add the ${selected.code} trustline — it's usable immediately.`
												: selected.capability === "permissionedManual"
													? `Add the trustline, then the issuer must approve it before you can hold ${selected.code}.`
													: `One step adds & authorizes ${selected.code}; or add the trustline then authorize it.`}
										</Text>
									)}
								</>
							)}
						</>
					)}

					<FlowResult
						label={`${selected?.code ?? "Asset"} trustline added successfully.`}
						state={ob.classic}
					/>
					<FlowResult
						label="Trustline authorized successfully."
						state={ob.authorize}
					/>
					<FlowResult
						label="Trustline added and authorized in one step."
						state={ob.oneStep}
					/>
				</Card>
			</div>
		</div>
	)
}

const FlowResult = ({
	label,
	state,
}: {
	label: string
	state: { status: string; error: string }
}) => {
	if (state.status === "success") {
		return (
			<div className="AuthorizeTrustline__result AuthorizeTrustline__result--success">
				<Icon.CheckCircle />
				<Text as="p" size="md">
					{label}
				</Text>
			</div>
		)
	}
	if (state.status === "error") {
		return (
			<div className="AuthorizeTrustline__result AuthorizeTrustline__result--error">
				<Icon.XCircle />
				<Text as="p" size="md">
					{state.error}
				</Text>
			</div>
		)
	}
	return null
}
