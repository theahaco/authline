import { Button, Card, Icon, Input, Text } from "@stellar/design-system"
import { useState } from "react"
import { assetKey, popularAssets } from "../data/popularAssets"
import { useTrustline } from "../hooks/useTrustline"
import { type MappedBalances } from "../util/wallet"
import "./AddTrustline.css"

export const AddTrustline = ({ balances }: { balances: MappedBalances }) => {
	const { addTrustline, status, error, reset } = useTrustline()
	const [customCode, setCustomCode] = useState("")
	const [customIssuer, setCustomIssuer] = useState("")
	const [activeAsset, setActiveAsset] = useState<string | null>(null)

	const handlePopularAdd = async (code: string, issuer: string) => {
		reset()
		setActiveAsset(assetKey(code, issuer))
		await addTrustline(code, issuer)
	}

	const handleCustomAdd = async () => {
		const code = customCode.trim()
		const issuer = customIssuer.trim()
		if (!code || !issuer) return
		reset()
		setActiveAsset(`custom:${code}:${issuer}`)
		await addTrustline(code, issuer)
	}

	const codeValid =
		customCode.trim().length > 0 &&
		customCode.trim().length <= 12 &&
		/^[a-zA-Z0-9]+$/.test(customCode.trim())
	const issuerValid =
		customIssuer.trim().length === 56 && customIssuer.trim().startsWith("G")
	const customValid = codeValid && issuerValid

	return (
		<div className="AddTrustline">
			<Text as="h2" size="lg" weight="semi-bold">
				Add Trustline
			</Text>

			<Card>
				<div className="AddTrustline__section">
					<Text as="h3" size="md" weight="semi-bold">
						Popular Assets
					</Text>
					<div className="AddTrustline__grid">
						{popularAssets.map((asset) => {
							const key = assetKey(asset.code, asset.issuer)
							const held = key in balances
							const isLoading =
								status === "loading" && activeAsset === key

							return (
								<button
									type="button"
									key={key}
									className={`AddTrustline__asset ${held ? "AddTrustline__asset--held" : ""}`}
									disabled={held || isLoading}
									onClick={() =>
										void handlePopularAdd(asset.code, asset.issuer)
									}
								>
									<span className="AddTrustline__asset-code">
										{asset.code}
									</span>
									<span className="AddTrustline__asset-name">
										{asset.name}
									</span>
									{held && (
										<span className="AddTrustline__asset-check">
											<Icon.CheckCircle />
										</span>
									)}
									{isLoading && (
										<span className="AddTrustline__asset-loading">
											Adding...
										</span>
									)}
								</button>
							)
						})}
					</div>
				</div>

				<div className="AddTrustline__divider">
					<span>or add custom</span>
				</div>

				<div className="AddTrustline__section">
					<div className="AddTrustline__form">
						<Input
							id="asset-code"
							fieldSize="md"
							label="Asset Code"
							placeholder="e.g. USDC"
							value={customCode}
							onChange={(e) => setCustomCode(e.target.value)}
							error={
								customCode.trim() && !codeValid
									? "1-12 alphanumeric characters"
									: undefined
							}
						/>
						<Input
							id="asset-issuer"
							fieldSize="md"
							label="Issuer Address"
							placeholder="G..."
							value={customIssuer}
							onChange={(e) => setCustomIssuer(e.target.value)}
							error={
								customIssuer.trim() && !issuerValid
									? "Must be a 56-character G... address"
									: undefined
							}
						/>
						<Button
							variant="primary"
							size="md"
							disabled={!customValid || status === "loading"}
							onClick={() => void handleCustomAdd()}
						>
							{status === "loading" &&
							activeAsset?.startsWith("custom:")
								? "Adding..."
								: "Add Trustline"}
						</Button>
					</div>
				</div>

				{status === "success" && (
					<div className="AddTrustline__result AddTrustline__result--success">
						<Icon.CheckCircle />
						<Text as="p" size="sm">
							Trustline added successfully.
						</Text>
					</div>
				)}
				{status === "error" && (
					<div className="AddTrustline__result AddTrustline__result--error">
						<Icon.XCircle />
						<Text as="p" size="sm">
							{error}
						</Text>
					</div>
				)}
			</Card>
		</div>
	)
}
