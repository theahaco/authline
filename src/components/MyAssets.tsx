import { Button, Card, Icon, Text } from "@stellar/design-system"
import { type Horizon } from "@stellar/stellar-sdk"
import { useEurcvAuth } from "../hooks/useEurcvAuth"
import { useTrustline } from "../hooks/useTrustline"
import { type MappedBalances } from "../util/wallet"
import "./MyAssets.css"

const EURCV_ISSUER =
	"GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G"

function truncateAddress(addr: string): string {
	return `${addr.slice(0, 4)}...${addr.slice(-4)}`
}

function isZeroBalance(balance: string): boolean {
	return Number(balance.replace(/,/g, "")) === 0
}

interface AssetRowProps {
	balance: Horizon.HorizonApi.BalanceLine
	onAuthorizeEurcv: () => void
	eurcvAuthStatus: string
	onRemove: (code: string, issuer: string) => void
	removeStatus: string
}

const AssetRow = ({
	balance,
	onAuthorizeEurcv,
	eurcvAuthStatus,
	onRemove,
	removeStatus,
}: AssetRowProps) => {
	const isNative = balance.asset_type === "native"
	const isLiquidityPool = balance.asset_type === "liquidity_pool_shares"

	const assetBalance = balance as Horizon.HorizonApi.BalanceLineAsset

	const code = isNative
		? "XLM"
		: isLiquidityPool
			? "LP"
			: assetBalance.asset_code
	const issuer = isNative
		? null
		: isLiquidityPool
			? null
			: assetBalance.asset_issuer

	const isEurcvUnauthorized =
		!isNative &&
		!isLiquidityPool &&
		assetBalance.asset_code === "EURCV" &&
		assetBalance.asset_issuer === EURCV_ISSUER &&
		!assetBalance.is_authorized

	const showAuthStatus =
		!isNative &&
		!isLiquidityPool &&
		"is_authorized" in balance

	const canRemove =
		!isNative &&
		!isLiquidityPool &&
		isZeroBalance(balance.balance)

	return (
		<div className="MyAssets__row">
			<div className="MyAssets__row-info">
				<div className="MyAssets__row-code">
					<Text as="span" size="md" weight="semi-bold">
						{code}
					</Text>
					{issuer && (
						<Text as="span" size="xs" className="MyAssets__row-issuer">
							{truncateAddress(issuer)}
						</Text>
					)}
				</div>
				<div className="MyAssets__row-balance">
					<Text as="span" size="md">
						{balance.balance}
					</Text>
				</div>
			</div>
			<div className="MyAssets__row-actions">
				{showAuthStatus && (
					<span
						className={`MyAssets__badge ${assetBalance.is_authorized ? "MyAssets__badge--authorized" : "MyAssets__badge--unauthorized"}`}
					>
						{assetBalance.is_authorized ? (
							<>
								<Icon.CheckCircle /> Authorized
							</>
						) : (
							<>
								<Icon.AlertTriangle /> Unauthorized
							</>
						)}
					</span>
				)}
				{isEurcvUnauthorized && (
					<Button
						variant="primary"
						size="sm"
						disabled={eurcvAuthStatus === "loading"}
						onClick={onAuthorizeEurcv}
					>
						{eurcvAuthStatus === "loading" ? "Authorizing..." : "Authorize"}
					</Button>
				)}
				{canRemove && (
					<Button
						variant="tertiary"
						size="sm"
						disabled={removeStatus === "loading"}
						onClick={() => onRemove(code, issuer!)}
					>
						Remove
					</Button>
				)}
			</div>
		</div>
	)
}

export const MyAssets = ({ balances }: { balances: MappedBalances }) => {
	const eurcvAuth = useEurcvAuth()
	const trustline = useTrustline()

	const entries = Object.entries(balances)

	if (entries.length === 0) {
		return (
			<div className="MyAssets">
				<Text as="h2" size="lg" weight="semi-bold">
					My Assets
				</Text>
				<Card>
					<div className="MyAssets__empty">
						<Text as="p" size="md">
							No assets found. Your account may be unfunded.
						</Text>
					</div>
				</Card>
			</div>
		)
	}

	return (
		<div className="MyAssets">
			<Text as="h2" size="lg" weight="semi-bold">
				My Assets
			</Text>
			<Card>
				<div className="MyAssets__list">
					{entries.map(([key, bal]) => (
						<AssetRow
							key={key}
							balance={bal}
							onAuthorizeEurcv={eurcvAuth.authorize}
							eurcvAuthStatus={eurcvAuth.status}
							onRemove={trustline.removeTrustline}
							removeStatus={trustline.status}
						/>
					))}
				</div>
				{eurcvAuth.status === "success" && (
					<div className="MyAssets__result MyAssets__result--success">
						<Icon.CheckCircle />
						<Text as="p" size="sm">
							EURCV trustline authorized successfully.
						</Text>
					</div>
				)}
				{eurcvAuth.status === "error" && (
					<div className="MyAssets__result MyAssets__result--error">
						<Icon.XCircle />
						<Text as="p" size="sm">
							{eurcvAuth.error}
						</Text>
					</div>
				)}
				{trustline.status === "success" && (
					<div className="MyAssets__result MyAssets__result--success">
						<Icon.CheckCircle />
						<Text as="p" size="sm">
							Trustline removed successfully.
						</Text>
					</div>
				)}
				{trustline.status === "error" && (
					<div className="MyAssets__result MyAssets__result--error">
						<Icon.XCircle />
						<Text as="p" size="sm">
							{trustline.error}
						</Text>
					</div>
				)}
			</Card>
		</div>
	)
}
