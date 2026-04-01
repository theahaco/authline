import { Button, Card, Icon, Input } from "@stellar/design-system"
import { useState } from "react"
import eurcvAuth from "../contracts/eurcv_auth"
import { useWallet } from "../hooks/useWallet"

export const AuthorizeTrustline = () => {
	const { address, signTransaction } = useWallet()
	const [status, setStatus] = useState<
		"idle" | "loading" | "success" | "error"
	>("idle")
	const [error, setError] = useState("")

	const handleSubmit = async (formData: FormData) => {
		const account = (formData.get("account") as string)?.trim()
		if (!account) return

		if (!address) {
			setError("Connect your wallet first")
			setStatus("error")
			return
		}

		setStatus("loading")
		setError("")

		try {
			const tx = await eurcvAuth.authorize_trustline(
				{ account },
				// @ts-expect-error publicKey is allowed at runtime
				{ publicKey: address },
			)
			const { result } = await tx.signAndSend({ signTransaction })

			if (result.isOk()) {
				setStatus("success")
			} else {
				setError(String(result.unwrapErr()))
				setStatus("error")
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
			setStatus("error")
		}
	}

	return (
		<div style={{ maxWidth: 480, margin: "2rem auto" }}>
			<h2>Authorize Trustline</h2>
			<p style={{ marginBottom: "1rem", opacity: 0.7 }}>
				Authorize an account&apos;s EURC trustline on the SAC admin contract.
			</p>

			<form action={handleSubmit}>
				<Input
					id="account"
					fieldSize="lg"
					placeholder="G... account address"
					defaultValue={address ?? ""}
				/>

				<div style={{ marginTop: "1rem" }}>
					<Button
						type="submit"
						variant="primary"
						size="lg"
						disabled={status === "loading"}
					>
						{status === "loading" ? "Submitting..." : "Authorize"}
					</Button>
				</div>
			</form>

			{status === "success" && (
				<Card style={{ marginTop: "1rem" }}>
					<Icon.CheckCircle />
					<p>Trustline authorized successfully.</p>
				</Card>
			)}
			{status === "error" && (
				<Card style={{ marginTop: "1rem" }}>
					<Icon.XCircle />
					<p>{error}</p>
				</Card>
			)}
		</div>
	)
}
