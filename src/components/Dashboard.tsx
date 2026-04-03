import { Button, Card, Icon, Text } from "@stellar/design-system"
import { networkPassphrase } from "../contracts/util"
import { useWallet } from "../hooks/useWallet"
import { connectWallet } from "../util/wallet"
import { AddTrustline } from "./AddTrustline"
import "./Dashboard.css"
import { MyAssets } from "./MyAssets"

export const Dashboard = ({ onShowAbout }: { onShowAbout: () => void }) => {
	const {
		address,
		balances,
		networkPassphrase: walletPassphrase,
	} = useWallet()
	const isWrongNetwork =
		address && walletPassphrase && walletPassphrase !== networkPassphrase

	return (
		<div className="Dashboard">
			<div className="Dashboard__hero">
				<h1>Stellar Assets</h1>
				<Text as="p" size="md">
					Manage your assets and trustlines on Stellar.
				</Text>
				<button
					type="button"
					onClick={onShowAbout}
					className="Dashboard__about-link"
				>
					How does this work?
				</button>
			</div>

			{!address ? (
				<div className="Dashboard__card">
					<Card>
						<div className="Dashboard__connect">
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
					</Card>
				</div>
			) : (
				<>
					{isWrongNetwork && (
						<div className="Dashboard__warning">
							<Icon.AlertTriangle />
							<Text as="p" size="md">
								Your wallet is set to a different network. Please switch to the
								correct network in your wallet settings, then reconnect.
							</Text>
						</div>
					)}
					<MyAssets balances={balances} />
					<AddTrustline balances={balances} />
				</>
			)}
		</div>
	)
}
