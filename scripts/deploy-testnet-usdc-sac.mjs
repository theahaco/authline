/**
 * Idempotently ensure the testnet USDC Stellar Asset Contract (SAC) exists, so
 * the CAP-73 `SAC.trust(holder)` path can run on testnet.
 *
 * Requires the `stellar` CLI on PATH. A funded source is needed only if the SAC
 * is not yet deployed: pass SOURCE_SECRET=S... (a funded testnet secret), or the
 * script generates + friendbot-funds an ephemeral one.
 *
 * Run from the repo root:  node scripts/deploy-testnet-usdc-sac.mjs
 */
import { spawnSync } from "node:child_process"
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk"

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const EXPECTED_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
const ASSET_ARG = `USDC:${ISSUER}`

function sh(cmd, args) {
	return spawnSync(cmd, args, { encoding: "utf8" })
}

async function fund(pub) {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
	if (!r.ok && r.status !== 400) throw new Error("friendbot failed for " + pub)
}

async function main() {
	const computed = new Asset("USDC", ISSUER).contractId(Networks.TESTNET)
	if (computed !== EXPECTED_SAC) {
		throw new Error(
			`derived SAC ${computed} != pinned ${EXPECTED_SAC} — registry/issuer mismatch`,
		)
	}
	if (!StrKey.isValidContract(computed)) throw new Error("invalid SAC id")

	if (sh("stellar", ["--version"]).status !== 0) {
		throw new Error("`stellar` CLI not found on PATH")
	}

	let source = process.env.SOURCE_SECRET
	if (!source) {
		const kp = Keypair.random()
		console.log("• funding ephemeral deploy source via friendbot…")
		await fund(kp.publicKey())
		source = kp.secret()
	}

	console.log(`• ensuring SAC for ${ASSET_ARG} on testnet…`)
	const res = sh("stellar", [
		"contract",
		"asset",
		"deploy",
		"--asset",
		ASSET_ARG,
		"--source-account",
		source,
		"--network",
		"testnet",
	])
	const out = `${res.stdout}\n${res.stderr}`
	if (res.status === 0) {
		console.log(`✓ deployed testnet USDC SAC: ${EXPECTED_SAC}`)
	} else if (/already.*exist|AlreadyExist|exists/i.test(out)) {
		console.log(`✓ testnet USDC SAC already deployed: ${EXPECTED_SAC}`)
	} else {
		throw new Error("SAC deploy failed:\n" + out)
	}
}

main().catch((e) => {
	console.error("deploy-testnet-usdc-sac failed:", e?.message || e)
	process.exit(1)
})
