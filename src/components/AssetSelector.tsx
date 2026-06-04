import { Badge, Card, Icon, Text } from "@stellar/design-system"
import { type OfficialAsset } from "../contracts/assets"

const CAPABILITY_LABEL: Record<OfficialAsset["capability"], string> = {
	open: "Open",
	permissionedOneStep: "Permissioned · one-step",
	permissionedManual: "Permissioned · issuer-approved",
}

export const AssetSelector = ({
	assets,
	selected,
	onSelect,
}: {
	assets: OfficialAsset[]
	selected: OfficialAsset | null
	onSelect: (a: OfficialAsset) => void
}) => {
	if (assets.length === 0) {
		return (
			<Text as="p" size="sm">
				No official assets are configured for this network.
			</Text>
		)
	}
	return (
		<div className="AssetSelector">
			{assets.map((a) => {
				const isSelected =
					selected?.code === a.code && selected?.issuer === a.issuer
				return (
					<Card key={`${a.code}-${a.issuer}`}>
						<button
							type="button"
							onClick={() => onSelect(a)}
							aria-pressed={isSelected}
							style={{
								width: "100%",
								textAlign: "left",
								cursor: "pointer",
								border: isSelected
									? "2px solid var(--sds-clr-lilac-09, #6e56cf)"
									: "1px solid transparent",
								background: "transparent",
								padding: "0.5rem",
								borderRadius: "0.5rem",
							}}
						>
							<div
								style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
							>
								<Text as="span" size="md" weight="medium">
									{a.code}
								</Text>
								<Text as="span" size="sm" style={{ opacity: 0.7 }}>
									{a.name}
								</Text>
								<Badge
									variant={a.capability === "open" ? "secondary" : "primary"}
								>
									{CAPABILITY_LABEL[a.capability]}
								</Badge>
							</div>
							{a.authClawback && (
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: "0.25rem",
										marginTop: "0.25rem",
										opacity: 0.7,
									}}
								>
									<Icon.AlertTriangle />
									<Text as="span" size="xs">
										Issuer can freeze or claw back this asset.
									</Text>
								</div>
							)}
						</button>
					</Card>
				)
			})}
		</div>
	)
}
