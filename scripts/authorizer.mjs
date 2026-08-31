/**
 * Issuer admin CLI for the asset-agnostic **Trustline Authorizer**.
 *
 * The contract is the asset's SAC admin; this wraps every one of its entry
 * points so an issuer's ops person types commands instead of hand-crafting
 * Soroban invocations. Reads are simulated (free, no signature); writes are
 * simulated, signed with a key from the local `stellar` CLI keystore, and
 * submitted.
 *
 * Usage (from the repo root):
 *     npm run authorizer -- <command> [args] [--asset EURCV | --id C...] [--source me]
 *
 * Commands
 *     status                      admin, SAC, policy, pause state
 *     check     <G...>            banned / allowed / eligible / authorized
 *     history   [--limit 50]      the on-chain audit trail (contract events)
 *
 *     authorize <G...>            authorize a holder's trustline (permissionless)
 *     deauthorize <G...> [--reason sanctions|kyc_expired|issuer_request|unspecified]
 *
 *     ban       <G...> [G... …]   denylist: block, even before a trustline exists
 *     unban     <G...> [G... …]
 *     allow     <G...> [G... …]   allowlist: admit after KYC
 *     disallow  <G...> [G... …]
 *
 *     freeze    <G...> [G... …]   ban/disallow AND deauthorize (durable stop)
 *     unfreeze  <G...> [G... …]
 *
 *     mint      <G...> <amount>   mint to an authorized holder
 *     clawback  <G...> <amount>   claw back (needs AUTH_CLAWBACK_ENABLED)
 *
 *     pause | unpause             emergency stop / resume
 *     policy    <denylist|allowlist>
 *     set-admin <G...>            hand the contract to another admin
 *     upgrade   <64-hex wasm hash> | --wasm <path>
 *
 * Options
 *     --asset <CODE>    resolve the authorizer from the pinned registry (default EURCV)
 *     --id <C...>       target this authorizer contract directly (overrides --asset)
 *     --source <alias>  stellar CLI key that signs writes            (default: me)
 *     --network <net>   testnet | public                             (default: testnet)
 *     --stroops         read amounts as raw stroops, not decimal units
 *     --dry-run         simulate and print the outcome, submit nothing
 *     --json            machine-readable output
 *
 * The signing secret is read from the local keystore for this one transaction;
 * it is never printed or stored. See docs/authorizer-runbook.md.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
	Account,
	Address,
	BASE_FEE,
	Contract,
	Keypair,
	Networks,
	StrKey,
	TransactionBuilder,
	nativeToScVal,
	rpc,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import { resolveOfficialAsset } from "@theahaco/authline"

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
function opt(name, fallback) {
	const i = argv.indexOf(`--${name}`)
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
}
/** Positional arguments — everything that is not a flag or a flag's value. */
function positionals() {
	const out = []
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (!a.startsWith("--")) {
			out.push(a)
			continue
		}
		// Boolean flags take no value; the rest consume the next token.
		if (!BOOL_FLAGS.has(a.slice(2))) i++
	}
	return out
}
const BOOL_FLAGS = new Set(["stroops", "dry-run", "json", "help", "h"])

const NETWORKS = {
	testnet: {
		passphrase: Networks.TESTNET,
		rpcUrl: "https://soroban-testnet.stellar.org",
		explorer: "https://stellar.expert/explorer/testnet",
		tag: "TESTNET",
	},
	public: {
		passphrase: Networks.PUBLIC,
		rpcUrl: "https://mainnet.sorobanrpc.com",
		explorer: "https://stellar.expert/explorer/public",
		tag: "PUBLIC",
	},
}

const NET_NAME = opt("network", "testnet")
const NET = NETWORKS[NET_NAME]
const SOURCE_ALIAS = opt("source", "me")
const DRY_RUN = flag("dry-run")
const JSON_OUT = flag("json")

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const out = { lines: [], data: {} }
const say = (line = "") => {
	if (!JSON_OUT) console.log(line)
	out.lines.push(line)
}
function die(message, hint) {
	if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: message }))
	else {
		console.error(`error: ${message}`)
		if (hint) console.error(hint)
	}
	process.exit(1)
}

// ---------------------------------------------------------------------------
// Contract vocabulary
// ---------------------------------------------------------------------------

/** Typed contract errors, in the order declared in contracts/trustline-authorizer. */
const CONTRACT_ERRORS = {
	1: [
		"AccountBanned",
		"the account is on the denylist — `unban` it first, or `unfreeze` if it was frozen",
	],
	2: [
		"AccountNotAllowed",
		"allowlist policy: the account was never allowed — run `allow <G...>` after KYC",
	],
	3: [
		"NoTrustline",
		"the account has no trustline for this asset yet — it must create one first (the onboard router does this in the same transaction)",
	],
	4: ["ContractPaused", "the authorizer is paused — run `unpause` first"],
	5: ["CannotAuthorizeAdminContract", "the authorizer cannot authorize itself"],
	6: ["NotSac", "the configured address is not a Stellar Asset Contract"],
	7: ["InvalidBatch", "pass between 1 and 50 addresses"],
	8: ["PauseUnchanged", "the contract is already in that state"],
	9: ["InvalidAmount", "amount must be greater than zero"],
	10: [
		"AssetRefused",
		"the asset refused: check the issuer flags (clawback needs AUTH_CLAWBACK_ENABLED, freeze needs AUTH_REVOCABLE) and that the holder is authorized",
	],
}

const REASONS = {
	sanctions: "Sanctions",
	kyc_expired: "KycExpired",
	issuer_request: "IssuerRequest",
	unspecified: "Unspecified",
}

const DECIMALS = 7n

const addr = (g) => {
	if (!StrKey.isValidEd25519PublicKey(g) && !StrKey.isValidContract(g))
		die(`'${g}' is not a valid Stellar address`)
	return new Address(g).toScVal()
}
/** A unit-variant `#[contracttype]` enum is an ScVec holding one symbol. */
const enumVal = (variant) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)])

function addressVec(list) {
	if (list.length === 0) die("pass at least one address")
	if (list.length > 50) die("at most 50 addresses per call (contract limit)")
	return xdr.ScVal.scvVec(list.map(addr))
}

function amountVal(raw) {
	if (raw === undefined) die("pass an amount")
	if (flag("stroops")) {
		if (!/^\d+$/.test(raw)) die(`'${raw}' is not a whole number of stroops`)
		return nativeToScVal(BigInt(raw), { type: "i128" })
	}
	if (!/^\d+(\.\d{1,7})?$/.test(raw))
		die(
			`'${raw}' is not a valid amount (up to 7 decimal places, or pass --stroops)`,
		)
	const [whole, frac = ""] = raw.split(".")
	const stroops =
		BigInt(whole) * 10n ** DECIMALS + BigInt(frac.padEnd(7, "0") || "0")
	if (stroops <= 0n) die("amount must be greater than zero")
	return nativeToScVal(stroops, { type: "i128" })
}

const formatAmount = (stroops) => {
	const s = BigInt(stroops)
	const whole = s / 10n ** DECIMALS
	const frac = (s % 10n ** DECIMALS).toString().padStart(7, "0")
	return `${whole}.${frac}`.replace(/\.?0+$/, "")
}

/**
 * Render one decoded event field for the audit trail. A `BytesN<32>` field (the
 * wasm hash on an `upgraded` event) decodes to a byte array, which stringifies
 * to raw bytes and makes the row unreadable — hex is what an operator can
 * actually compare against a build.
 */
function formatEventValue(v) {
	if (v instanceof Uint8Array) return Buffer.from(v).toString("hex")
	if (typeof v === "bigint") return formatAmount(v)
	return String(unwrapEnum(v))
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

function resolveTarget() {
	const id = opt("id")
	if (id) {
		if (!StrKey.isValidContract(id))
			die(`--id '${id}' is not a valid contract address`)
		return { id, asset: null }
	}
	const code = opt("asset", "EURCV")
	const asset = resolveOfficialAsset(code, NET.tag)
	if (!asset)
		die(
			`'${code}' is not pinned for ${NET.tag}`,
			"pass --id C... to target an authorizer directly, or add the asset to " +
				"packages/authline-sdk/src/registry.ts",
		)
	if (!asset.authorizer)
		die(
			`${code} on ${NET.tag} is an open asset — it has no authorizer contract`,
			"only AUTH_REQUIRED assets delegate authorization to a contract",
		)
	return { id: asset.authorizer, asset }
}

// ---------------------------------------------------------------------------
// Keystore + RPC
// ---------------------------------------------------------------------------

function keystore(sub, alias) {
	const res = spawnSync("stellar", ["keys", sub, alias], { encoding: "utf8" })
	const value = (res.stdout ?? "").trim()
	if (res.status !== 0 || !value)
		die(
			`could not read the ${sub === "secret" ? "secret" : "public key"} for '${alias}' ` +
				"from the stellar CLI keystore",
			"run `stellar keys ls` to see what you have, or pass --source <alias>",
		)
	return value
}

const server = new rpc.Server(NET.rpcUrl)

/** Turn a host/contract failure into the operator-facing explanation. */
function explain(err) {
	const text = typeof err === "string" ? err : (err?.message ?? String(err))
	const m = /Error\(Contract, #(\d+)\)/.exec(text)
	if (m) {
		const [name, hint] = CONTRACT_ERRORS[Number(m[1])] ?? [
			`contract error #${m[1]}`,
			"",
		]
		return hint ? `${name} — ${hint}` : name
	}
	return text
}

async function buildTx(sourcePub, contractId, method, args) {
	// The sequence is irrelevant for simulation and re-fetched before submit.
	const account = new Account(sourcePub, "0")
	return new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(new Contract(contractId).call(method, ...args))
		.setTimeout(180)
		.build()
}

/**
 * A unit-variant `#[contracttype]` enum decodes to a one-element array; unwrap
 * it so `Policy` reads as "Denylist" in text and in --json alike.
 */
const unwrapEnum = (v) => (Array.isArray(v) && v.length === 1 ? v[0] : v)

/** Simulate only — for reads and for `--dry-run`. Returns the native result. */
async function simulate(contractId, method, args, sourcePub) {
	const tx = await buildTx(sourcePub, contractId, method, args)
	const sim = await server.simulateTransaction(tx)
	if (rpc.Api.isSimulationError(sim)) throw new Error(explain(sim.error))
	const retval = sim.result?.retval
	return retval === undefined ? null : unwrapEnum(scValToNative(retval))
}

async function submit(contractId, method, args) {
	const secret = keystore("secret", SOURCE_ALIAS)
	if (!StrKey.isValidEd25519SecretSeed(secret))
		die(
			`the keystore returned something that is not a secret for '${SOURCE_ALIAS}'`,
		)
	const signer = Keypair.fromSecret(secret)

	if (DRY_RUN) {
		await simulate(contractId, method, args, signer.publicKey())
		say(`dry run: ${method} simulated successfully — nothing submitted.`)
		out.data.dryRun = true
		return null
	}

	const account = await server.getAccount(signer.publicKey())
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(new Contract(contractId).call(method, ...args))
		.setTimeout(180)
		.build()

	let prepared
	try {
		prepared = await server.prepareTransaction(tx)
	} catch (err) {
		die(explain(err))
	}
	prepared.sign(signer)

	const sent = await server.sendTransaction(prepared)
	if (sent.status === "ERROR") die(explain(JSON.stringify(sent.errorResult)))

	let result = await server.getTransaction(sent.hash)
	const deadline = Date.now() + 60_000
	while (result.status === "NOT_FOUND" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1000))
		result = await server.getTransaction(sent.hash)
	}
	if (result.status !== "SUCCESS")
		die(`transaction ${sent.hash} failed: ${explain(JSON.stringify(result))}`)

	out.data.hash = sent.hash
	say(`✅ ${method} — ${sent.hash}`)
	say(`   ${NET.explorer}/tx/${sent.hash}`)
	return result
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = {
	async status({ id, asset, sourcePub }) {
		const read = (m, ...a) => simulate(id, m, a, sourcePub)
		const [admin, sac, policy, paused] = await Promise.all([
			read("admin"),
			read("sac"),
			read("policy"),
			read("is_paused"),
		])
		out.data = { id, admin, sac, policy, paused }
		say(`\n━━━ Trustline Authorizer · ${NET_NAME} ━━━`)
		if (asset) say(`Asset    : ${asset.code} (${asset.name})`)
		if (asset) say(`Issuer   : ${asset.issuer}`)
		say(`Contract : ${id}`)
		say(`SAC      : ${sac}`)
		say(`Admin    : ${admin}`)
		say(`Policy   : ${String(policy)}`)
		say(
			`State    : ${paused ? "⛔ PAUSED — every operation is refused" : "running"}`,
		)
		say(`\n${NET.explorer}/contract/${id}\n`)
	},

	async check({ id, sourcePub, args }) {
		const account = args[0]
		if (!account) die("usage: check <G...>")
		addr(account) // validation
		const read = (m) => simulate(id, m, [addr(account)], sourcePub)
		const [banned, allowed, eligible, authorized, policy] = await Promise.all([
			read("is_banned"),
			read("is_allowed"),
			read("is_eligible"),
			read("is_authorized"),
			simulate(id, "policy", [], sourcePub),
		])
		out.data = { account, banned, allowed, eligible, authorized, policy }
		say(`\n━━━ ${account} ━━━`)
		say(`Policy in force : ${String(policy)}`)
		say(`On denylist     : ${banned ? "yes" : "no"}`)
		say(`On allowlist    : ${allowed ? "yes" : "no"}`)
		say(
			`Trustline authorized (live from the SAC): ${authorized ? "yes" : "no"}`,
		)
		say(
			`\n→ authorize_trustline would ${eligible ? "be PERMITTED" : "be REFUSED"} ` +
				`by policy right now${eligible && !authorized ? " (assuming a trustline exists)" : ""}.\n`,
		)
	},

	async history({ id }) {
		const limit = Number(opt("limit", "50"))
		const latest = await server.getLatestLedger()
		// A day of ledgers by default. RPC scans a bounded number of ledgers per
		// request and hands back a cursor, so a window this wide needs paging —
		// without it a quiet contract looks like it has no history at all.
		const startLedger = Math.max(
			1,
			Number(opt("start-ledger", String(latest.sequence - 17_280))),
		)
		const filters = [{ type: "contract", contractIds: [id] }]
		const events = []
		let cursor
		let truncated = true
		for (let page = 0; page < 40 && events.length < limit; page++) {
			const res = await server.getEvents(
				cursor ? { cursor, filters, limit } : { startLedger, filters, limit },
			)
			events.push(...res.events)
			if (!res.cursor || res.cursor === cursor) break
			cursor = res.cursor
			// The cursor encodes the ledger scanning reached; once it is at the
			// tip there is nothing left to page through.
			if (Number(cursor.split("-")[0].slice(0, -12)) >= latest.sequence) {
				truncated = false
				break
			}
		}

		out.data = { events: events.length }
		say(`\n━━━ Audit trail · ${id} ━━━`)
		say(`(ledgers ${startLedger}…${latest.sequence}, newest last)\n`)
		if (events.length === 0) {
			say(
				"No events in this window." +
					(truncated
						? " Scanning stopped early — narrow it with --start-ledger <n>."
						: ""),
			)
			return
		}
		for (const e of events.slice(0, limit)) {
			const topics = e.topic.map((t) => scValToNative(t))
			const data = scValToNative(e.value)
			const [name, subject] = topics
			const detail = Object.entries(data ?? {})
				.filter(([k]) => k !== "ledger" && k !== "authorizer_admin")
				.map(([k, v]) => `${k}=${formatEventValue(v)}`)
				.join(" ")
			say(
				`ledger ${String(e.ledger).padEnd(8)} ${String(name).padEnd(13)} ` +
					`${subject ?? "".padEnd(56)} ${detail}`,
			)
		}
		say(
			`\nEvery row is signed off by the admin in force at the time; add --json`,
		)
		say(`for the full records including authorizer_admin and ledger.\n`)
	},

	authorize: write(
		"authorize_trustline",
		(args) => [addr(args[0])],
		"usage: authorize <G...>",
	),

	async deauthorize({ id, args }) {
		if (!args[0])
			die(
				"usage: deauthorize <G...> [--reason sanctions|kyc_expired|issuer_request|unspecified]",
			)
		const key = opt("reason", "unspecified")
		const variant = REASONS[key]
		if (!variant)
			die(
				`unknown --reason '${key}'`,
				`known reasons: ${Object.keys(REASONS).join(", ")}`,
			)
		await submit(id, "deauthorize_trustline", [addr(args[0]), enumVal(variant)])
	},

	ban: write(
		"add_banned_accounts",
		(args) => [addressVec(args)],
		"usage: ban <G...> [G... …]",
	),
	unban: write(
		"remove_banned_accounts",
		(args) => [addressVec(args)],
		"usage: unban <G...> [G... …]",
	),
	allow: write(
		"allow",
		(args) => [addressVec(args)],
		"usage: allow <G...> [G... …]",
	),
	disallow: write(
		"disallow",
		(args) => [addressVec(args)],
		"usage: disallow <G...> [G... …]",
	),
	freeze: write(
		"freeze_accounts",
		(args) => [addressVec(args)],
		"usage: freeze <G...> [G... …]",
	),
	unfreeze: write(
		"unfreeze_accounts",
		(args) => [addressVec(args)],
		"usage: unfreeze <G...> [G... …]",
	),

	mint: write(
		"mint_to_account",
		(args) => [addr(args[0]), amountVal(args[1])],
		"usage: mint <G...> <amount>",
	),
	clawback: write(
		"clawback",
		(args) => [addr(args[0]), amountVal(args[1])],
		"usage: clawback <G...> <amount>",
	),

	pause: write("pause", () => []),
	unpause: write("unpause", () => []),

	async policy({ id, args }) {
		const choice = (args[0] ?? "").toLowerCase()
		const variant = { denylist: "Denylist", allowlist: "Allowlist" }[choice]
		if (!variant) die("usage: policy <denylist|allowlist>")
		await submit(id, "set_policy", [enumVal(variant)])
	},

	"set-admin": write(
		"set_admin",
		(args) => [addr(args[0])],
		"usage: set-admin <G...>",
	),

	async upgrade({ id, args }) {
		const wasmPath = opt("wasm")
		let hash = args[0]
		if (wasmPath) {
			hash = createHash("sha256").update(readFileSync(wasmPath)).digest("hex")
			say(`wasm ${wasmPath} → hash ${hash}`)
			say(
				"NOTE: the wasm must already be installed on the network " +
					"(`stellar contract upload --wasm <path>`).",
			)
		}
		if (!hash || !/^[0-9a-f]{64}$/i.test(hash))
			die("usage: upgrade <64-hex wasm hash> | --wasm <path>")
		await submit(id, "upgrade", [xdr.ScVal.scvBytes(Buffer.from(hash, "hex"))])
	},
}

/** A plain write command: validate positionals, then submit. */
function write(method, toArgs, usage) {
	return async ({ id, args }) => {
		if (usage && args.length === 0) die(usage)
		await submit(id, method, toArgs(args))
	}
}

// ---------------------------------------------------------------------------

async function main() {
	const pos = positionals()
	const name = pos[0]
	if (!name || flag("help") || flag("h")) {
		// The file header IS the help text — one place to keep current.
		console.log(
			readFileSync(new URL(import.meta.url))
				.toString()
				.split("*/")[0]
				.split("\n")
				.slice(1)
				.map((l) => l.replace(/^ \* ?/, ""))
				.join("\n"),
		)
		process.exit(name ? 0 : 1)
	}
	const command = commands[name]
	if (!command)
		die(
			`unknown command '${name}'`,
			`known commands: ${Object.keys(commands).join(", ")}`,
		)
	if (!NET) die(`unknown --network '${NET_NAME}' (testnet | public)`)

	const { id, asset } = resolveTarget()
	const sourcePub = keystore("public-key", SOURCE_ALIAS)

	await command({ id, asset, sourcePub, args: pos.slice(1) })
	if (JSON_OUT) console.log(JSON.stringify({ ok: true, ...out.data }, null, 2))
}

main().catch((err) => die(explain(err)))
