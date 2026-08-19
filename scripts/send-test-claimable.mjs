/**
 * Send a claimable balance to a wallet, so the activation page's claim screen
 * has something real to show.
 *
 * Uses a REGISTRY-PINNED testnet asset (USDC by default — Circle's official
 * testnet issuer) paid out of an account you already hold, exactly as an
 * exchange would when a withdrawal recipient has no trustline. No throwaway
 * asset, and no dApp config changes: the pinned assets are already in the
 * directory.
 *
 * Usage (from the repo root):
 *     npm run send:claimable -- --to G...YOUR_WALLET
 *
 * Options:
 *     --to      <G...>   recipient — the wallet you connect to the dApp
 *     --new-wallet       instead of --to, mint + fund a fresh testnet wallet and
 *                        print its secret to import into Freighter (best demo:
 *                        it has no trustline, so the claim opens one)
 *     --from    <alias>  stellar CLI key holding the asset   (default: me)
 *     --asset   <CODE>   pinned testnet asset to send        (default: USDC)
 *     --amount  <num>    amount to send                      (default: 25)
 *
 * The sender's secret is read from the local `stellar` CLI keystore and used
 * only to sign this testnet transaction; it is never printed or stored.
 */
import { spawnSync } from "node:child_process"
import {
	Account,
	Asset,
	BASE_FEE,
	Horizon,
	Networks,
	Operation,
	StrKey,
	TransactionBuilder,
	Keypair,
} from "@stellar/stellar-sdk"
import {
	buildClaimableBalanceDelivery,
	getActivationStatus,
	resolveOfficialAsset,
} from "@theahaco/authline"

const NET = {
	horizonUrl: "https://horizon-testnet.stellar.org",
	rpcUrl: "https://soroban-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const horizon = new Horizon.Server(NET.horizonUrl)

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`)
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const NEW_WALLET = process.argv.includes("--new-wallet")
// --new-wallet mints a throwaway TESTNET recipient so the claim can show the
// trustline being opened; its secret is printed for import into Freighter.
const NEW_KP = NEW_WALLET ? Keypair.random() : null
const TO = NEW_KP ? NEW_KP.publicKey() : arg("to")
const FROM = arg("from", "me")
const CODE = arg("asset", "USDC")
const AMOUNT = arg("amount", "25")

if (!TO || !StrKey.isValidEd25519PublicKey(TO)) {
	console.error(
		"error: pass the wallet you will connect to the dApp, e.g.\n" +
			"    npm run send:claimable -- --to GABC...\n" +
			"or let the script make one for you:\n" +
			"    npm run send:claimable -- --new-wallet\n" +
			"(a claimable balance can only name a classic G-address as claimant)",
	)
	process.exit(1)
}

const pinned = resolveOfficialAsset(CODE, "TESTNET")
if (!pinned) {
	console.error(
		`error: ${CODE} is not pinned for testnet. Pinned assets: ` +
			"USDC, EURC, BLND (open) · TLO, EURCV (AUTH_REQUIRED).",
	)
	process.exit(1)
}

function secretFor(alias) {
	const res = spawnSync("stellar", ["keys", "secret", alias], {
		encoding: "utf8",
	})
	const s = (res.stdout ?? "").trim()
	if (res.status !== 0 || !StrKey.isValidEd25519SecretSeed(s)) {
		throw new Error(
			`could not read the secret for key '${alias}' from the stellar CLI ` +
				`keystore (\`stellar keys ls\` to see what you have)`,
		)
	}
	return s
}

async function main() {
	const sender = Keypair.fromSecret(secretFor(FROM))
	const asset = new Asset(pinned.code, pinned.issuer)
	const canonical = `${pinned.code}:${pinned.issuer}`

	console.log(
		`\n━━━ Sending ${AMOUNT} ${pinned.code} as a claimable balance ━━━`,
	)
	console.log(`From : ${FROM} (${sender.publicKey()})`)
	console.log(`To   : ${TO}`)
	console.log(`Asset: ${canonical}`)
	console.log(`       ${pinned.name} · ${pinned.capability}\n`)

	// The sender must actually hold the asset.
	const from = await horizon.loadAccount(sender.publicKey())
	const held = from.balances.find(
		(b) => b.asset_code === pinned.code && b.asset_issuer === pinned.issuer,
	)
	if (!held || Number(held.balance) < Number(AMOUNT)) {
		throw new Error(
			`'${FROM}' holds ${held?.balance ?? 0} ${pinned.code}, need ${AMOUNT}. ` +
				`Pick another key with --from, or lower --amount.`,
		)
	}
	console.log(`• sender holds ${held.balance} ${pinned.code} ✓`)

	// Self-delivery is legal and does exercise the claim — but only if this is
	// the account you actually connect with, and it can never show the trustline
	// being opened BY the claim (a sender necessarily already holds the asset).
	if (TO === sender.publicKey()) {
		console.log(
			`\n• note: --to is the same account as --from ('${FROM}').\n` +
				"  That works only if this is the wallet you connect to the dApp, and\n" +
				"  since the sender already holds the asset it cannot demonstrate the\n" +
				"  trustline being opened by the claim. For the full flow, run with\n" +
				"  --new-wallet to get a fresh wallet you can import into Freighter.\n",
		)
	}

	// The recipient must exist to be able to source their own claim later.
	try {
		await horizon.loadAccount(TO)
	} catch {
		console.log("• recipient not on-ledger yet — funding via friendbot…")
		const r = await fetch(`https://friendbot.stellar.org/?addr=${TO}`)
		if (!r.ok && r.status !== 400) throw new Error(`friendbot failed for ${TO}`)
	}

	// Tell the user which flow they are about to see.
	const st = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: TO,
		assetCode: pinned.code,
		assetIssuer: pinned.issuer,
	})
	if (st.hasTrustline) {
		console.log(
			`• note: ${TO.slice(0, 6)}…${TO.slice(-6)} ALREADY has a ${pinned.code} ` +
				"trustline, so the claim will be a plain 1-signature claim — it will\n" +
				"  not demonstrate the trustline being opened by the claim itself.\n" +
				"  Use a wallet without this trustline to see the fused flow.",
		)
	} else {
		console.log(
			`• recipient has no ${pinned.code} trustline — the claim will OPEN it ` +
				"and collect the funds in one signature ✓",
		)
	}
	if (pinned.capability !== "open") {
		console.log(
			`• note: ${pinned.code} is AUTH_REQUIRED — the dApp will ask you to ` +
				"activate first,\n  then offer the claim (a Soroban authorize cannot " +
				"share a transaction with\n  the classic claim). Use USDC to see the " +
				"single-signature flow.",
		)
	}

	console.log(`\n• delivering ${AMOUNT} ${pinned.code}…`)
	const delivery = buildClaimableBalanceDelivery({
		networkPassphrase: NET.passphrase,
		sender: sender.publicKey(),
		senderSequence: (
			await horizon.loadAccount(sender.publicKey())
		).sequenceNumber(),
		recipient: TO,
		amount: Number(AMOUNT).toFixed(7),
		config: { assetCode: pinned.code, assetIssuer: pinned.issuer },
		// Sweep it back if it is never claimed.
		reclaimAfterSeconds: 30 * 24 * 3600,
	})
	const tx = TransactionBuilder.fromXDR(delivery.xdr, NET.passphrase)
	tx.sign(sender)
	const res = await horizon.submitTransaction(tx)

	console.log(
		`\n✅ delivered: https://stellar.expert/explorer/testnet/tx/${res.hash}`,
	)
	console.log(`   balance id: ${delivery.balanceId}\n`)
	if (NEW_KP) {
		console.log("━━━ Import this throwaway TESTNET wallet into Freighter ━━━")
		console.log(`  address: ${NEW_KP.publicKey()}`)
		console.log(`  secret : ${NEW_KP.secret()}`)
		console.log(
			"  (freshly generated, testnet only, holds nothing else — never reuse\n" +
				"   it or fund it on mainnet)\n",
		)
	}
	console.log("━━━ Now see it in the dApp ━━━")
	console.log(`  1. npm run dev:testnet`)
	console.log(
		`  2. open /app.html and connect the wallet for ${TO.slice(0, 6)}…${TO.slice(-6)}`,
	)
	console.log(
		`  3. the ${pinned.code} tile shows "1 to claim" — click it to claim\n`,
	)
	console.log(
		`No .env changes needed: ${pinned.code} is registry-pinned, so it is already`,
	)
	console.log("in the dApp's asset directory on testnet.\n")
}
main().catch((e) => {
	console.error("failed:", e?.response?.data ?? e?.message ?? e)
	process.exit(1)
})
