import { Button, Card, Text } from "@stellar/design-system"
import "./AboutPage.css"

export const AboutPage = ({ onBack }: { onBack: () => void }) => {
	return (
		<div className="AboutPage">
			<div className="AboutPage__back">
				<Button variant="tertiary" size="sm" onClick={onBack}>
					&larr; Back to Dashboard
				</Button>
			</div>

			<h1 className="AboutPage__title">How Trustlines Work</h1>
			<Text as="p" size="md" className="AboutPage__subtitle">
				Understanding trustlines, assets, and authorization on Stellar.
			</Text>

			<div className="AboutPage__section">
				<h2>What is a trustline?</h2>
				<p>
					On Stellar, your account cannot hold a token unless you explicitly opt
					in. This opt-in is called a <strong>trustline</strong>. When you
					create a trustline to an asset, you tell the network: &ldquo;I want my
					account to be able to hold this asset.&rdquo; Without one, tokens
					simply cannot enter your account.
				</p>
				<p>
					Think of it like opening a foreign-currency account at a bank &mdash;
					you have to request it before the bank can deposit that currency for
					you.
				</p>
			</div>

			<div className="AboutPage__section">
				<h2>Adding a trustline</h2>
				<p>
					To add a trustline, you need the <strong>asset code</strong> (e.g.
					USDC, EURCV) and the <strong>issuer address</strong> (the Stellar
					account that issues the token). You can pick from popular assets or
					enter any asset manually.
				</p>
				<p>
					Each trustline increases your account&apos;s minimum XLM reserve by
					0.5 XLM. You can remove trustlines you no longer need (as long as the
					balance is zero) to reclaim that reserve.
				</p>
			</div>

			<div className="AboutPage__section">
				<h2>What about authorization?</h2>
				<p>
					Some regulated assets (like EURCV) require an extra{" "}
					<strong>authorization</strong> step. The issuer sets{" "}
					<strong>AUTH_REQUIRED</strong> on their account, meaning your
					trustline starts in a frozen state until the issuer approves it.
				</p>
				<p>
					For most assets, creating a trustline is all you need. For
					auth-required assets, this app handles the authorization
					automatically.
				</p>
			</div>

			<div className="AboutPage__blocklist">
				<p>
					<strong>EURCV authorization:</strong> EURCV is a regulated euro
					stablecoin issued by Societe Generale (via SG-Forge). It uses a
					block-list model &mdash; by default, any account that requests
					authorization is approved. The issuer only intervenes to block
					specific accounts that fail regulatory requirements.
				</p>
			</div>

			<div className="AboutPage__steps">
				<div className="AboutPage__step">
					<Card>
						<div className="AboutPage__step-number">1</div>
						<h3>Add Trustline</h3>
						<p>
							Pick a popular asset or enter a custom one. Sign the transaction
							with your wallet. For most assets, you&apos;re done &mdash; you
							can now send and receive that token.
						</p>
					</Card>
				</div>
				<div className="AboutPage__step">
					<Card>
						<div className="AboutPage__step-number">2</div>
						<h3>Authorize (if needed)</h3>
						<p>
							For auth-required assets like EURCV, click the Authorize button in
							your asset list. The authorization contract is called
							automatically and your trustline becomes active.
						</p>
					</Card>
				</div>
			</div>

			<div className="AboutPage__cta">
				<Button variant="primary" size="lg" onClick={onBack}>
					Get Started
				</Button>
			</div>
		</div>
	)
}
