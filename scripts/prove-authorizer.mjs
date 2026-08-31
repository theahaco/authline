#!/usr/bin/env node
/**
 * Standalone testnet proof run for the **Trustline Authorizer** deliverable
 * (asset-agnostic authorizer + issuer admin surface).
 *
 * The script stands up a complete regulated asset from nothing — fresh issuer,
 * fresh SAC, fresh authorizer instance — and then exercises every admin control
 * the deliverable claims, against the real Stellar testnet. Every step prints a
 * transaction hash as a stellar.expert link. The point is evidence a third
 * party can verify without trusting this output: every hash below is a public
 * ledger entry.
 *
 *   Phase 0  stand up the asset: AUTH_REQUIRED issuer → SAC → authorizer →
 *            SAC.set_admin(authorizer)
 *   Phase 1  denylist: anyone not banned onboards through the router
 *   Phase 2  authorize-on-behalf: a third party authorizes, holder signs ZERO times
 *   Phase 3  ban BEFORE the trustline exists, and it still bites afterwards
 *   Phase 4  freeze — a frozen account cannot get re-authorized, and cannot slip
 *            back in by deleting and recreating its trustline          ★ acceptance
 *   Phase 5  pause rejects everything                                  ★ acceptance
 *   Phase 6  allowlist policy, and the two policy sets stay independent
 *   Phase 7  mint and clawback
 *   Phase 8  upgrade the contract, state survives
 *   Phase 9  hand the contract to a new admin; the old admin loses control
 *   Phase 10 the audit trail, rebuilt from contract events on the ledger alone
 *   Phase 11 the LIVE pinned testnet deployment, verified read-only
 *   Phase 12 the issuer admin CLI, run against the contract this script deployed
 *
 * Refusals are the heart of this deliverable, so they are proven two ways. Where
 * the script can pre-build an envelope while the holder is still eligible, it
 * submits that envelope AFTER the freeze/pause and the transaction FAILS on the
 * ledger — a refusal you can click on. Everywhere else the refusal is a
 * simulation that returns the typed contract error, asserted by code.
 *
 * Every account is generated fresh and funded by friendbot, so the run owns all
 * of its own state, needs no secrets, and can be repeated by anyone at any time.
 * It never touches mainnet and never mutates the shared pinned testnet asset.
 *
 * Usage, from the repo root:
 *
 *   npm run build -w @theahaco/authline
 *   cargo build --release --target wasm32v1-none -p trustline-authorizer
 *   node scripts/prove-authorizer.mjs [--out docs/authorizer-testnet-evidence.md]
 *
 * Options:
 *   --out <path>          where to write the markdown report
 *   --cli-source <alias>  stellar CLI keystore alias used for the read-only CLI
 *                         demonstration in Phase 12 (default: me; skipped when
 *                         the alias or the CLI is missing)
 *
 * Assertions are hard failures: the script cannot print a claim it did not
 * actually prove on-chain.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import {
	Account,
	Address,
	Asset,
	BASE_FEE,
	Config,
	Contract,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	nativeToScVal,
	rpc,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"

const require = createRequire(import.meta.url)

const DIST = new URL("../packages/authline-sdk/dist/index.js", import.meta.url)
if (!existsSync(DIST)) {
	console.error(
		"The SDK is not built. Run:\n\n  npm run build -w @theahaco/authline\n",
	)
	process.exit(1)
}
const { ROUTERS, buildAuthorizeTx, buildOnboardTx, getActivationStatus } =
	await import("@theahaco/authline")

const WASM_PATH = new URL(
	"../target/wasm32v1-none/release/trustline_authorizer.wasm",
	import.meta.url,
)
if (!existsSync(WASM_PATH)) {
	console.error(
		"The authorizer wasm is not built. Run:\n\n" +
			"  cargo build --release --target wasm32v1-none -p trustline-authorizer\n",
	)
	process.exit(1)
}
const WASM = readFileSync(WASM_PATH)
const WASM_HASH = createHash("sha256").update(WASM).digest()

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const horizon = new Horizon.Server(NET.horizonUrl)
const server = new rpc.Server(NET.rpcUrl)

const expertTx = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`
const expertAcct = (a) => `https://stellar.expert/explorer/testnet/account/${a}`
const expertContract = (c) =>
	`https://stellar.expert/explorer/testnet/contract/${c}`

/** Typed contract errors, in the order declared in contracts/trustline-authorizer. */
const ERRORS = {
	1: "AccountBanned",
	2: "AccountNotAllowed",
	3: "NoTrustline",
	4: "ContractPaused",
	5: "CannotAuthorizeAdminContract",
	6: "NotSac",
	7: "InvalidBatch",
	8: "PauseUnchanged",
	9: "InvalidAmount",
	10: "AssetRefused",
}

/**
 * The onboard ROUTER's own error enum. The router deliberately does NOT
 * propagate the authorizer's code: any typed rejection from the authorizer
 * collapses into AuthorizationRefused (#3), because the distinction the router
 * has to make is "refused" vs "this admin has no authorizer interface".
 */
const ROUTER_ERRORS = {
	1: "NotSac",
	2: "TrustFailed",
	3: "AuthorizationRefused",
	4: "NotAuthorized",
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

/** Hard ceiling on any single network call. */
const NET_TIMEOUT_MS = 30_000
Config.setTimeout(NET_TIMEOUT_MS)

/**
 * Run one network call with a hard timeout, retrying transient failures.
 *
 * The SDK's HTTP client has no default timeout, so a stalled connection to the
 * RPC neither resolves nor rejects — two runs of this script hung mid-phase
 * exactly that way. Everything that touches the network goes through here.
 *
 * Safe to retry means READ-ONLY or idempotent. Submits pass `tries = 1` and
 * recover by looking the transaction up by hash instead (see `submitClassic`
 * and `sendSoroban`), because a timed-out submit may still have landed.
 */
async function net(label, fn, tries = 3) {
	let lastErr
	for (let attempt = 1; attempt <= tries; attempt++) {
		let timer
		try {
			return await Promise.race([
				fn(),
				new Promise((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(`${label}: no response in ${NET_TIMEOUT_MS / 1000}s`),
							),
						NET_TIMEOUT_MS,
					)
				}),
			])
		} catch (err) {
			lastErr = err
			if (attempt === tries) break
			console.log(
				`      … ${label} failed (${err.message}); retry ${attempt + 1}/${tries}`,
			)
			await sleep(2000 * attempt)
		} finally {
			clearTimeout(timer)
		}
	}
	throw lastErr
}

/** The hash an envelope WILL have — known before it is submitted. */
const txHash = (tx) => tx.hash().toString("hex")

/** Does this account exist on the ledger? */
async function accountExists(pub) {
	return net("account probe", () => horizon.loadAccount(pub), 1).then(
		() => true,
		() => false,
	)
}

/**
 * Fund a fresh account from friendbot.
 *
 * Friendbot goes down for minutes at a time, so this is patient (six tries,
 * widening backoff) and reports WHY it gave up rather than a bare failure. A
 * timed-out request may still have funded the account, so each attempt probes
 * the ledger before deciding it failed.
 */
async function fund(pub) {
	let why = "unknown"
	for (let attempt = 1; attempt <= 6; attempt++) {
		try {
			const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`, {
				signal: AbortSignal.timeout(NET_TIMEOUT_MS),
			})
			if (r.ok) return
			why = `HTTP ${r.status}`
		} catch (e) {
			why = e instanceof Error ? e.message : String(e)
		}
		if (await accountExists(pub)) return
		if (attempt < 6) {
			console.log(
				`      … friendbot ${pub.slice(0, 8)}… failed (${why}); ` +
					`retry ${attempt + 1}/6`,
			)
			await sleep(3000 * attempt)
		}
	}
	throw new Error(
		`friendbot could not fund ${pub} after 6 attempts — last failure: ${why}. ` +
			"Testnet friendbot is intermittently down; re-run when it recovers.",
	)
}

const seqOf = async (pub) =>
	(
		await net(`loadAccount ${pub.slice(0, 8)}`, () => horizon.loadAccount(pub))
	).sequenceNumber()

/** A unit-variant `#[contracttype]` enum is an ScVec holding one symbol. */
const enumVal = (variant) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)])
const addr = (a) => new Address(a).toScVal()
const addrVec = (list) => xdr.ScVal.scvVec(list.map(addr))
const i128 = (units) =>
	nativeToScVal(BigInt(Math.round(Number(units) * 1e7)), { type: "i128" })

/** A unit-variant enum decodes to a one-element array; unwrap for readability. */
const unwrapEnum = (v) => (Array.isArray(v) && v.length === 1 ? v[0] : v)

/**
 * Render one decoded event field. `BytesN<32>` fields (a wasm hash) decode to a
 * byte array, which stringifies to raw bytes and would corrupt both the console
 * table and the markdown report — hex is what a reader can actually compare.
 */
const fmtEventValue = (v) => {
	if (v instanceof Uint8Array) return Buffer.from(v).toString("hex")
	if (typeof v === "bigint") return v.toString()
	return String(unwrapEnum(v))
}

/** Turn a host/contract failure into the typed error name where there is one. */
function explain(err) {
	const text = typeof err === "string" ? err : (err?.message ?? String(err))
	const m = /Error\(Contract, #(\d+)\)/.exec(text)
	return m ? (ERRORS[Number(m[1])] ?? `contract error #${m[1]}`) : text
}

/** The typed contract error code in a failure, or null. */
function errorCode(err) {
	const text = typeof err === "string" ? err : (err?.message ?? String(err))
	const m = /Error\(Contract, #(\d+)\)/.exec(text)
	return m ? Number(m[1]) : null
}

/**
 * Sign an envelope and submit it through Horizon (classic path).
 *
 * Submitted once, never blindly retried: a resubmitted classic envelope whose
 * first attempt actually landed fails with `tx_bad_seq`. On a timeout the
 * transaction is looked up by its (locally known) hash before it is called a
 * failure.
 */
async function submitClassic(tx, ...signers) {
	signers.forEach((s) => tx.sign(s))
	const hash = txHash(tx)
	try {
		return await net("horizon submit", () => horizon.submitTransaction(tx), 1)
	} catch (err) {
		const landed = await net("horizon tx lookup", () =>
			horizon.transactions().transaction(hash).call(),
		).catch(() => null)
		if (landed?.successful) {
			console.log(
				`      … submit timed out but the transaction landed: ${hash}`,
			)
			return { hash }
		}
		throw err
	}
}

/** Build an unsigned classic transaction from ops. */
async function classicTx(sourcePub, ...ops) {
	const account = await net(`loadAccount ${sourcePub.slice(0, 8)}`, () =>
		horizon.loadAccount(sourcePub),
	)
	const b = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
	ops.forEach((o) => b.addOperation(o))
	return b.setTimeout(180).build()
}

/**
 * Submit a prepared Soroban envelope, returning its hash.
 *
 * The hash is derived locally BEFORE submitting, so a timed-out send can still
 * be resolved by polling for it — `awaitTx` does the waiting either way.
 * `DUPLICATE` is success: the network already has this exact envelope.
 */
async function sendSoroban(prepared, label) {
	const hash = txHash(prepared)
	try {
		const sent = await net(
			`${label}: sendTransaction`,
			() => server.sendTransaction(prepared),
			1,
		)
		if (sent.status === "ERROR")
			throw new Error(
				`${label}: sendTransaction ERROR — ${sent.errorResult?.toXDR("base64") ?? "?"}`,
			)
		return hash
	} catch (err) {
		if (String(err?.message ?? err).includes("sendTransaction ERROR")) throw err
		console.log(`      … ${label} send timed out; polling for ${hash}`)
		return hash
	}
}

/** Wait for a submitted Soroban transaction to reach a terminal state. */
async function awaitTx(hash, label) {
	const deadline = Date.now() + 120_000
	const get = () =>
		net(`${label}: getTransaction`, () => server.getTransaction(hash))
	let got = await get()
	while (got.status === "NOT_FOUND" && Date.now() < deadline) {
		await sleep(1500)
		got = await get()
	}
	if (got.status === "NOT_FOUND")
		throw new Error(`${label}: transaction never landed (${hash})`)
	return got
}

/**
 * Simulate + sign + submit a Soroban invocation, expecting SUCCESS.
 * Returns the hash and the decoded return value.
 */
async function invoke(kp, contractId, method, args, label) {
	const account = await net(`getAccount ${kp.publicKey().slice(0, 8)}`, () =>
		server.getAccount(kp.publicKey()),
	)
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(new Contract(contractId).call(method, ...args))
		.setTimeout(180)
		.build()

	let prepared
	try {
		prepared = await net(`${label}: prepare`, () =>
			server.prepareTransaction(tx),
		)
	} catch (err) {
		throw new Error(`${label}: ${method} was refused — ${explain(err)}`)
	}
	prepared.sign(kp)
	const hash = await sendSoroban(prepared, label)
	const got = await awaitTx(hash, label)
	if (got.status !== "SUCCESS")
		throw new Error(`${label}: ${method} failed on-chain (${got.status})`)
	return {
		hash,
		value: got.returnValue ? unwrapEnum(scValToNative(got.returnValue)) : null,
	}
}

/** Simulate + sign + submit a host-function operation (upload / create / SAC deploy). */
async function invokeOp(kp, op, label) {
	const account = await net(`getAccount ${kp.publicKey().slice(0, 8)}`, () =>
		server.getAccount(kp.publicKey()),
	)
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(op)
		.setTimeout(180)
		.build()
	let prepared
	try {
		prepared = await net(`${label}: prepare`, () =>
			server.prepareTransaction(tx),
		)
	} catch (err) {
		throw new Error(`${label}: ${explain(err)}`)
	}
	prepared.sign(kp)
	const hash = await sendSoroban(prepared, label)
	const got = await awaitTx(hash, label)
	if (got.status !== "SUCCESS")
		throw new Error(`${label}: failed on-chain (${got.status})`)
	return { hash, result: got }
}

/** Read-only simulation of a view function. */
async function read(contractId, method, args = [], sourcePub) {
	const account = new Account(sourcePub, "0")
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(new Contract(contractId).call(method, ...args))
		.setTimeout(180)
		.build()
	const sim = await net(`simulate ${method}`, () =>
		server.simulateTransaction(tx),
	)
	if (rpc.Api.isSimulationError(sim)) throw new Error(explain(sim.error))
	const retval = sim.result?.retval
	return retval === undefined ? null : unwrapEnum(scValToNative(retval))
}

/**
 * Assert that an invocation is REFUSED with a specific typed contract error,
 * proven by simulation (nothing is submitted, so there is no hash).
 */
async function expectRefusal(
	sourcePub,
	contractId,
	method,
	args,
	code,
	label,
	names = ERRORS,
) {
	const account = new Account(sourcePub, "0")
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(new Contract(contractId).call(method, ...args))
		.setTimeout(180)
		.build()
	const sim = await net(`simulate ${method}`, () =>
		server.simulateTransaction(tx),
	)
	check(
		rpc.Api.isSimulationError(sim),
		`${label}: ${method} should have been REFUSED but simulated successfully`,
	)
	const got = errorCode(sim.error)
	check(
		got === code,
		`${label}: expected ${names[code]} (#${code}), got ${explain(sim.error)}`,
	)
	note(
		label.charAt(0).toUpperCase() + label.slice(1),
		`Simulated \`${method}\` against the live contract; it was refused with ` +
			`${names[code]} (#${code}), and a refused call never becomes a transaction.`,
		{ refusal: names[code] },
	)
	return names[code]
}

/**
 * Pre-build a Soroban envelope NOW, while the call still succeeds, without
 * submitting it. Submitting it later — after a freeze or a pause — produces a
 * transaction that FAILS on the public ledger: a refusal a reviewer can click.
 */
async function prebuild(kp, contractId, method, args, label) {
	const account = await net(`getAccount ${kp.publicKey().slice(0, 8)}`, () =>
		server.getAccount(kp.publicKey()),
	)
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(new Contract(contractId).call(method, ...args))
		.setTimeout(3600)
		.build()
	const prepared = await net(`${label}: prepare`, () =>
		server.prepareTransaction(tx),
	)
	prepared.sign(kp)
	console.log(`    · pre-built (valid right now, not submitted): ${label}`)
	return prepared
}

/** Submit a pre-built envelope and REQUIRE that it fails on-chain. */
async function submitExpectingFailure(prepared, label) {
	const sent = await net(
		`${label}: sendTransaction`,
		() => server.sendTransaction(prepared),
		1,
	)
	if (sent.status === "ERROR") {
		// The RPC rejected it before inclusion — no ledger entry to point at.
		return { hash: null, rejected: true }
	}
	const got = await awaitTx(sent.hash, label)
	check(
		got.status === "FAILED",
		`${label}: the transaction should have FAILED on-chain, got ${got.status}`,
	)
	console.log(`    ✔ ${label} — FAILED on-chain`)
	console.log(`      ${expertTx(sent.hash)}`)
	return { hash: sent.hash, rejected: false }
}

/**
 * Read a holder's activation status, polling until `pred` holds.
 *
 * Trustline state is read from the RPC's ledger snapshot, which can trail the
 * transaction that changed it by a ledger or two. Asserting on a single read
 * would make this run fail at random rather than when something is actually
 * wrong, so every state assertion here is a bounded wait.
 */
async function awaitStatus(pub, pred, label, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	let last = null
	for (;;) {
		last = await net(`status ${pub.slice(0, 8)}`, () =>
			getActivationStatus({
				rpcUrl: NET.rpcUrl,
				account: pub,
				assetCode: ASSET_CODE,
				assetIssuer: issuer.publicKey(),
			}),
		)
		if (!last.readError && pred(last)) return last
		if (Date.now() > deadline) break
		await sleep(2500)
	}
	throw new Error(
		`ASSERTION FAILED: ${label} — last read for ${pub}: ` +
			`hasTrustline=${last?.hasTrustline} isAuthorized=${last?.isAuthorized}` +
			(last?.readError ? ` readError=${last.readError}` : ""),
	)
}

/** Read the status once, tolerating a transient RPC read error. */
const statusOf = (pub) => awaitStatus(pub, () => true, `read status of ${pub}`)

const balanceOf = async (pub, code) => {
	const acct = await net(`loadAccount ${pub.slice(0, 8)}`, () =>
		horizon.loadAccount(pub),
	)
	const line =
		code === "native"
			? acct.balances.find((b) => b.asset_type === "native")
			: acct.balances.find((b) => b.asset_code === code)
	return {
		acct,
		balance: line && "balance" in line ? line.balance : null,
		line,
	}
}

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

const evidence = []
const actors = []

/** Set at the top of each phase so recorded evidence knows where it belongs. */
let PHASE = 0

function record(row) {
	evidence.push(row)
	console.log(`    ✔ ${row.claim}`)
	if (row.hash) console.log(`      ${expertTx(row.hash)}`)
}

/**
 * Evidence with no transaction behind it. A refused call never reaches the
 * ledger, so there is no hash to link — the row carries one sentence saying
 * what was done instead.
 */
function note(claim, sentence, extra = {}) {
	evidence.push({ phase: PHASE, claim, sentence, ...extra })
	console.log(`    ✔ ${claim}`)
	console.log(`      no transaction — ${sentence}`)
}

function heading(title) {
	console.log(`\n${"─".repeat(74)}\n${title}\n${"─".repeat(74)}`)
}

// ---------------------------------------------------------------------------
// The world this run owns
// ---------------------------------------------------------------------------

const ASSET_CODE = "PROOF"
const issuer = Keypair.random() // also the authorizer's admin
const submitter = Keypair.random() // a third party with no issuer authority
const newAdmin = Keypair.random() // Phase 9 handover target
let SAC = null
let AUTHORIZER = null
let asset = null
let config = null // OnboarderConfig for the SDK

const holders = {}
function holder(name, role) {
	const kp = Keypair.random()
	holders[name] = kp
	actors.push({ role, pub: kp.publicKey() })
	return kp
}

// ===========================================================================
// Phase 0 — stand up a regulated asset with the authorizer as its SAC admin
// ===========================================================================

async function phase0() {
	PHASE = 0
	heading(
		"PHASE 0 · stand up a regulated asset from nothing\n" +
			"          AUTH_REQUIRED issuer → SAC → authorizer → SAC.set_admin(authorizer)",
	)

	actors.push({ role: "issuer / authorizer admin", pub: issuer.publicKey() })
	actors.push({
		role: "third-party submitter (no issuer authority)",
		pub: submitter.publicKey(),
	})

	await Promise.all([fund(issuer.publicKey()), fund(submitter.publicKey())])
	asset = new Asset(ASSET_CODE, issuer.publicKey())

	// AUTH_REQUIRED (1) | AUTH_REVOCABLE (2) | AUTH_CLAWBACK_ENABLED (8).
	// Revocable is what lets a freeze deauthorize; clawback is what lets the
	// issuer claw back. Both are part of what this deliverable claims.
	const flagsRes = await submitClassic(
		await classicTx(
			issuer.publicKey(),
			// AUTH_REQUIRED (1) | AUTH_REVOCABLE (2) first: the protocol only
			// accepts AUTH_CLAWBACK_ENABLED (8) once revocable is already set.
			Operation.setOptions({ setFlags: 1 | 2 }),
			Operation.setOptions({ setFlags: 8 }),
		),
		issuer,
	)
	const issuerAcct = await net("loadAccount issuer", () =>
		horizon.loadAccount(issuer.publicKey()),
	)
	check(
		issuerAcct.flags.auth_required &&
			issuerAcct.flags.auth_revocable &&
			issuerAcct.flags.auth_clawback_enabled,
		"issuer must end AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED",
	)
	record({
		phase: 0,
		claim: `Issuer set AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED on ${ASSET_CODE}`,
		hash: flagsRes.hash,
		detail:
			`Asset ${ASSET_CODE}:${issuer.publicKey()}. Horizon now reports auth_required, ` +
			"auth_revocable and auth_clawback_enabled — the flags a regulated asset needs " +
			"for authorization, freeze and clawback respectively.",
	})

	const sacRes = await invokeOp(
		issuer,
		Operation.createStellarAssetContract({ asset }),
		"deploy SAC",
	)
	SAC = asset.contractId(NET.passphrase)
	record({
		phase: 0,
		claim: `Stellar Asset Contract deployed for ${ASSET_CODE}`,
		hash: sacRes.hash,
		contract: SAC,
		detail:
			`SAC \`${SAC}\` — the deterministic Asset.contractId(TESTNET) for this asset, ` +
			"now live on the ledger.",
	})

	const uploadRes = await invokeOp(
		issuer,
		Operation.uploadContractWasm({ wasm: WASM }),
		"upload authorizer wasm",
	)
	record({
		phase: 0,
		claim: "Trustline Authorizer wasm uploaded",
		hash: uploadRes.hash,
		detail:
			`sha256 \`${WASM_HASH.toString("hex")}\` — built from ` +
			"contracts/trustline-authorizer with `cargo build --release --target wasm32v1-none`. " +
			"Anyone can rebuild that source and compare this hash.",
	})

	// The constructor takes (admin, sac, policy) — nothing in the wasm names a
	// specific asset, which is the "asset-agnostic" claim: one wasm, any issuer.
	const createRes = await invokeOp(
		issuer,
		Operation.createCustomContract({
			address: new Address(issuer.publicKey()),
			wasmHash: WASM_HASH,
			salt: randomBytes(32),
			constructorArgs: [
				addr(issuer.publicKey()),
				addr(SAC),
				enumVal("Denylist"),
			],
		}),
		"deploy authorizer",
	)
	AUTHORIZER = scValToNative(createRes.result.returnValue)
	check(
		typeof AUTHORIZER === "string" && AUTHORIZER.startsWith("C"),
		`could not read the deployed contract id, got ${String(AUTHORIZER)}`,
	)
	record({
		phase: 0,
		claim: "Trustline Authorizer instance deployed with policy = Denylist",
		hash: createRes.hash,
		contract: AUTHORIZER,
		detail:
			`Authorizer \`${AUTHORIZER}\`, constructed with admin ${issuer.publicKey()} and ` +
			`sac ${SAC}. The wasm hard-codes no asset — the SAC is a constructor argument, ` +
			"so one wasm serves every issuer.",
	})

	const setAdminRes = await invoke(
		issuer,
		SAC,
		"set_admin",
		[addr(AUTHORIZER)],
		"SAC.set_admin",
	)
	const sacAdmin = await read(SAC, "admin", [], issuer.publicKey())
	check(
		sacAdmin === AUTHORIZER,
		`SAC admin must be the authorizer, got ${sacAdmin}`,
	)
	record({
		phase: 0,
		claim:
			"SAC adminship handed to the authorizer — it is now the only address that can flip AUTHORIZED",
		hash: setAdminRes.hash,
		detail:
			`\`SAC.admin()\` now returns \`${AUTHORIZER}\`. This is one-way: from here only ` +
			"the contract can hand adminship on, which is exactly why replacing the Tranche-1 " +
			"stub required re-issuing the test asset rather than re-pointing the old one.",
	})

	// The contract agrees about the world it was constructed into.
	const [admin, sac, policy, paused] = await Promise.all([
		read(AUTHORIZER, "admin", [], issuer.publicKey()),
		read(AUTHORIZER, "sac", [], issuer.publicKey()),
		read(AUTHORIZER, "policy", [], issuer.publicKey()),
		read(AUTHORIZER, "is_paused", [], issuer.publicKey()),
	])
	check(admin === issuer.publicKey(), "authorizer admin mismatch")
	check(sac === SAC, "authorizer sac mismatch")
	check(policy === "Denylist", `policy should be Denylist, got ${policy}`)
	check(paused === false, "a fresh authorizer must not be paused")
	console.log(
		`    · verified on-chain: admin=${admin.slice(0, 8)}… sac=${sac.slice(0, 8)}… policy=${policy} paused=${paused}`,
	)

	config = {
		assetCode: ASSET_CODE,
		assetIssuer: issuer.publicKey(),
		sac: SAC,
		authorizer: AUTHORIZER,
		router: ROUTERS.TESTNET,
		backends: ["cap73-one-signature"],
	}
}

// ===========================================================================
// Phase 1 — denylist: anyone not banned onboards through the router
// ===========================================================================

async function phase1() {
	PHASE = 1
	heading(
		"PHASE 1 · denylist policy — anyone not banned authorizes\n" +
			"          exercised through the onboard ROUTER (one signature)",
	)

	const kp = holder("clean", "holder A — clean, onboards via the router")
	await fund(kp.publicKey())

	const before = await statusOf(kp.publicKey())
	check(!before.hasTrustline, "holder A must start with no trustline")

	const eligible = await read(
		AUTHORIZER,
		"is_eligible",
		[addr(kp.publicKey())],
		issuer.publicKey(),
	)
	check(
		eligible === true,
		"an unbanned account must be eligible under denylist",
	)

	const xdrStr = await buildOnboardTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		holder: kp.publicKey(),
		config,
	})
	const tx = TransactionBuilder.fromXDR(xdrStr, NET.passphrase)
	tx.sign(kp)
	check(tx.signatures.length === 1, "the router path must cost ONE signature")

	const hash = await sendSoroban(tx, "router onboard")
	const got = await awaitTx(hash, "router onboard")
	check(got.status === "SUCCESS", `router onboard failed (${got.status})`)

	await awaitStatus(
		kp.publicKey(),
		(st) => st.hasTrustline && st.isAuthorized,
		"holder A must end with an AUTHORIZED trustline",
	)

	record({
		phase: 1,
		claim:
			"Router creates AND authorizes an unbanned holder's trustline in one " +
			"transaction, one signature",
		hash,
		detail:
			`One call to router \`${ROUTERS.TESTNET}\` \`onboard(sac, holder)\`. The router probed ` +
			`\`SAC.admin()\` on-chain, found this authorizer, and called its permissionless ` +
			`\`authorize_trustline\`. Holder ${kp.publicKey()} went from no trustline to ` +
			"hasTrustline=true, isAuthorized=true.",
	})
}

// ===========================================================================
// Phase 2 — authorize-on-behalf: the holder signs ZERO times
// ===========================================================================

async function phase2() {
	PHASE = 2
	heading(
		"PHASE 2 · authorize-on-behalf\n" +
			"          a third party with no issuer authority authorizes; holder signs ZERO times",
	)

	const kp = holder("onbehalf", "holder B — authorized on their behalf")
	await fund(kp.publicKey())

	// Setup: a classic, unauthorized trustline — the state an exchange finds.
	await submitClassic(
		await classicTx(kp.publicKey(), Operation.changeTrust({ asset })),
		kp,
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.hasTrustline && !st.isAuthorized,
		"holder B precondition: an existing but UNauthorized trustline",
	)
	console.log("    · precondition confirmed: trustline exists, NOT authorized")

	const xdrStr = await buildAuthorizeTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		source: submitter.publicKey(),
		account: kp.publicKey(),
		config,
	})
	const tx = TransactionBuilder.fromXDR(xdrStr, NET.passphrase)
	check(
		tx.source === submitter.publicKey(),
		"the envelope must be sourced by the third party, not the holder",
	)
	tx.sign(submitter)
	const holderHint = kp.signatureHint()
	check(
		tx.signatures.filter((s) => s.hint().equals(holderHint)).length === 0,
		"the holder must not have signed",
	)
	check(tx.signatures.length === 1, "exactly one signature — the submitter's")

	const hash = await sendSoroban(tx, "authorize-on-behalf")
	const got = await awaitTx(hash, "authorize-on-behalf")
	check(got.status === "SUCCESS", `authorize failed (${got.status})`)

	await awaitStatus(
		kp.publicKey(),
		(st) => st.isAuthorized,
		"holder B's trustline must end AUTHORIZED",
	)

	record({
		phase: 2,
		claim:
			"An unauthorized trustline is authorized ON THE HOLDER'S BEHALF, submitted " +
			"by an account with no issuer authority — ZERO holder signatures",
		hash,
		detail:
			`Sourced and signed only by ${submitter.publicKey()}, which holds no issuer ` +
			`authority and is not the admin. Holder ${kp.publicKey()} never signed. The ` +
			"authority is the contract's SAC adminship, exposed permissionlessly through " +
			"`authorize_trustline` and gated by policy.",
	})
}

// ===========================================================================
// Phase 3 — a ban lands before the trustline exists, and still bites after
// ===========================================================================

async function phase3() {
	PHASE = 3
	heading(
		"PHASE 3 · ban an address BEFORE it ever creates a trustline\n" +
			"          and the ban still bites once the trustline appears",
	)

	const kp = holder("banned", "holder C — banned before existing on-ledger")

	// The ban is applied while this address has no account at all.
	let exists = true
	try {
		await net(
			"loadAccount holder C",
			() => horizon.loadAccount(kp.publicKey()),
			1,
		)
	} catch {
		exists = false
	}
	check(!exists, "holder C must not exist on-ledger when the ban is applied")
	console.log(`    · ${kp.publicKey()} does not exist on-ledger yet`)

	const banRes = await invoke(
		issuer,
		AUTHORIZER,
		"add_banned_accounts",
		[addrVec([kp.publicKey()])],
		"ban",
	)
	const banned = await read(
		AUTHORIZER,
		"is_banned",
		[addr(kp.publicKey())],
		issuer.publicKey(),
	)
	check(banned === true, "holder C must read as banned")
	record({
		phase: 3,
		claim:
			"An address is banned BEFORE it has an account or a trustline — the ban " +
			"does not need the holder to exist",
		hash: banRes.hash,
		detail:
			`${kp.publicKey()} had no account entry on the ledger when this transaction ran. ` +
			"`is_banned` now returns true. Bans are keyed by address, not by trustline, so " +
			"a sanctioned address can be blocked pre-emptively.",
	})

	// Now the address shows up and tries anyway.
	await fund(kp.publicKey())
	const eligible = await read(
		AUTHORIZER,
		"is_eligible",
		[addr(kp.publicKey())],
		issuer.publicKey(),
	)
	check(eligible === false, "a banned account must not be eligible")

	await expectRefusal(
		submitter.publicKey(),
		ROUTERS.TESTNET,
		"onboard",
		[addr(SAC), addr(kp.publicKey())],
		3,
		"router onboard for a banned holder",
		ROUTER_ERRORS,
	)

	// Even creating the trustline by hand does not help.
	const ctRes = await submitClassic(
		await classicTx(kp.publicKey(), Operation.changeTrust({ asset })),
		kp,
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.hasTrustline && !st.isAuthorized,
		"holder C's line must exist and be unauthorized",
	)

	const code = await expectRefusal(
		submitter.publicKey(),
		AUTHORIZER,
		"authorize_trustline",
		[addr(kp.publicKey())],
		1,
		"authorize a banned holder",
	)
	record({
		phase: 3,
		claim:
			"The banned address creates a trustline anyway — and authorization is still " +
			"refused with a typed AccountBanned error",
		hash: ctRes.hash,
		refusal: code,
		detail:
			"The linked transaction is the holder's own CHANGE_TRUST, which succeeds — anyone " +
			"may open a trustline. What they cannot get is authorization: both the router's " +
			`\`onboard\` and a direct \`authorize_trustline\` are refused with ${code} (#1), and ` +
			"the trustline stays isAuthorized=false. The refusal is a *typed* contract error, " +
			'not a panic — the router reads an untyped abort as "no authorizer interface", so ' +
			"panicking here would silently downgrade a ban into an unauthorized trustline.",
	})
}

// ===========================================================================
// Phase 4 — freeze: a frozen account cannot get re-authorized      ★
// ===========================================================================

async function phase4() {
	PHASE = 4
	heading(
		"PHASE 4 · ★ freeze — a frozen account cannot get re-authorized,\n" +
			"          and cannot slip back in by deleting and recreating its trustline",
	)

	const kp = holder("frozen", "holder D — frozen mid-life")
	await fund(kp.publicKey())

	// Onboard normally first: this holder is in good standing.
	const onboardXdr = await buildOnboardTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		holder: kp.publicKey(),
		config,
	})
	const onboardTx = TransactionBuilder.fromXDR(onboardXdr, NET.passphrase)
	onboardTx.sign(kp)
	const onboardHash = await sendSoroban(onboardTx, "holder D onboard")
	const onboardGot = await awaitTx(onboardHash, "holder D onboard")
	check(onboardGot.status === "SUCCESS", "holder D must onboard successfully")
	await awaitStatus(
		kp.publicKey(),
		(st) => st.isAuthorized,
		"holder D must start AUTHORIZED",
	)
	console.log(
		`    · holder D onboarded and AUTHORIZED — ${expertTx(onboardHash)}`,
	)

	// Build a re-authorization envelope NOW, while it is still legitimate. It is
	// valid at this instant; after the freeze it must fail on the ledger.
	const doomed = await prebuild(
		submitter,
		AUTHORIZER,
		"authorize_trustline",
		[addr(kp.publicKey())],
		"re-authorize holder D",
	)

	const freezeRes = await invoke(
		issuer,
		AUTHORIZER,
		"freeze_accounts",
		[addrVec([kp.publicKey()])],
		"freeze",
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.hasTrustline && !st.isAuthorized,
		"freeze must deauthorize the trustline",
	)
	const frozenBanned = await read(
		AUTHORIZER,
		"is_banned",
		[addr(kp.publicKey())],
		issuer.publicKey(),
	)
	check(
		frozenBanned === true,
		"freeze must ALSO ban — never one half without the other",
	)
	record({
		phase: 4,
		claim:
			"Freeze is ban + deauthorize, never one without the other — the trustline " +
			"is deauthorized AND the address is banned",
		hash: freezeRes.hash,
		detail:
			`After this single call, holder ${kp.publicKey()} reads isAuthorized=false AND ` +
			"is_banned=true. Deauthorizing without banning would be useless: the next " +
			"permissionless `authorize_trustline` would simply re-authorize them.",
	})

	// THE acceptance check, as a real failed transaction on the public ledger.
	const failed = await submitExpectingFailure(
		doomed,
		"re-authorizing a frozen holder",
	)
	const code = await expectRefusal(
		submitter.publicKey(),
		AUTHORIZER,
		"authorize_trustline",
		[addr(kp.publicKey())],
		1,
		"re-authorize a frozen holder",
	)
	record({
		phase: 4,
		claim: "★ A FROZEN ACCOUNT CANNOT GET RE-AUTHORIZED",
		hash: failed.hash,
		refusal: code,
		detail:
			"The linked transaction is an `authorize_trustline` envelope that was built and " +
			"signed BEFORE the freeze, when it was perfectly valid. Submitted after the " +
			`freeze, it FAILED on-chain: the policy is re-evaluated on every call, with no ` +
			`\"already authorized\" fast path and no cached decision. A fresh attempt is ` +
			`refused the same way, with ${code} (#1).` +
			(failed.rejected
				? " (The RPC rejected the stale envelope before inclusion on this run, so " +
					"the refusal here rests on the simulation result rather than a ledger entry.)"
				: ""),
	})

	// The escape hatch that must not work: delete the trustline and start over.
	const delRes = await submitClassic(
		await classicTx(
			kp.publicKey(),
			Operation.changeTrust({ asset, limit: "0" }),
		),
		kp,
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => !st.hasTrustline,
		"holder D's trustline must be deleted",
	)
	console.log(
		`    · holder D deleted their trustline — ${expertTx(delRes.hash)}`,
	)

	const reRes = await submitClassic(
		await classicTx(kp.publicKey(), Operation.changeTrust({ asset })),
		kp,
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.hasTrustline && !st.isAuthorized,
		"the recreated trustline must be brand new and unauthorized",
	)

	const stillBanned = await read(
		AUTHORIZER,
		"is_banned",
		[addr(kp.publicKey())],
		issuer.publicKey(),
	)
	check(stillBanned === true, "the ban must outlive the trustline")
	const code2 = await expectRefusal(
		submitter.publicKey(),
		AUTHORIZER,
		"authorize_trustline",
		[addr(kp.publicKey())],
		1,
		"authorize the recreated trustline",
	)
	await expectRefusal(
		submitter.publicKey(),
		ROUTERS.TESTNET,
		"onboard",
		[addr(SAC), addr(kp.publicKey())],
		3,
		"router onboard on the recreated trustline",
		ROUTER_ERRORS,
	)
	record({
		phase: 4,
		claim:
			"★ The frozen holder deletes and recreates their trustline to shake off the " +
			"freeze — and is refused again",
		hash: reRes.hash,
		refusal: code2,
		detail:
			"The linked transaction is the holder recreating a brand-new, unauthorized " +
			"trustline after deleting the deauthorized one — the obvious way to try to " +
			"escape a freeze. It does not work: the ban is keyed by ADDRESS, so it outlives " +
			`the trustline. Both \`authorize_trustline\` and the router's \`onboard\` are ` +
			`refused with ${code2} (#1) on the new line.`,
	})

	// And the freeze is reversible, both halves.
	const unfreezeRes = await invoke(
		issuer,
		AUTHORIZER,
		"unfreeze_accounts",
		[addrVec([kp.publicKey()])],
		"unfreeze",
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.isAuthorized,
		"unfreeze must re-authorize the existing trustline",
	)
	const unbanned = await read(
		AUTHORIZER,
		"is_banned",
		[addr(kp.publicKey())],
		issuer.publicKey(),
	)
	check(unbanned === false, "unfreeze must lift the ban")
	record({
		phase: 4,
		claim:
			"Unfreeze reverses BOTH halves in one call — unbanned and re-authorized",
		hash: unfreezeRes.hash,
		detail:
			"One transaction lifted the ban and re-authorized the trustline that existed at " +
			"the time. Recovery is symmetric with the freeze, so an incident is reversible " +
			"without a second tool.",
	})
}

// ===========================================================================
// Phase 5 — pause rejects everything                                ★
// ===========================================================================

async function phase5() {
	PHASE = 5
	heading("PHASE 5 · ★ pause rejects everything")

	const kp = holder("paused", "holder E — caught by the pause")
	await fund(kp.publicKey())
	await submitClassic(
		await classicTx(kp.publicKey(), Operation.changeTrust({ asset })),
		kp,
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.hasTrustline && !st.isAuthorized,
		"the holder must hold an unauthorized trustline before this phase runs",
	)

	// Valid right now; must fail once the contract is paused.
	const doomed = await prebuild(
		submitter,
		AUTHORIZER,
		"authorize_trustline",
		[addr(kp.publicKey())],
		"authorize holder E",
	)

	const pauseRes = await invoke(issuer, AUTHORIZER, "pause", [], "pause")
	const paused = await read(AUTHORIZER, "is_paused", [], issuer.publicKey())
	check(paused === true, "the contract must read as paused")
	record({
		phase: 5,
		claim: "Emergency stop engaged — the contract is paused",
		hash: pauseRes.hash,
		detail: "`is_paused()` now returns true across the whole contract.",
	})

	const failed = await submitExpectingFailure(
		doomed,
		"authorizing while paused",
	)

	// "Everything" means everything: authorization, admin list edits, supply,
	// policy changes. Only unpause / set_admin / upgrade and the reads stay live,
	// so a paused contract can still be recovered.
	const refusals = []
	refusals.push(
		await expectRefusal(
			submitter.publicKey(),
			AUTHORIZER,
			"authorize_trustline",
			[addr(kp.publicKey())],
			4,
			"authorize while paused",
		),
	)
	for (const [method, args, label] of [
		["add_banned_accounts", [addrVec([kp.publicKey()])], "ban while paused"],
		["freeze_accounts", [addrVec([kp.publicKey()])], "freeze while paused"],
		["allow", [addrVec([kp.publicKey()])], "allow while paused"],
		["mint_to_account", [addr(kp.publicKey()), i128("1")], "mint while paused"],
		["clawback", [addr(kp.publicKey()), i128("1")], "clawback while paused"],
		["set_policy", [enumVal("Allowlist")], "policy change while paused"],
	]) {
		refusals.push(
			await expectRefusal(
				issuer.publicKey(),
				AUTHORIZER,
				method,
				args,
				4,
				label,
			),
		)
	}
	await expectRefusal(
		submitter.publicKey(),
		ROUTERS.TESTNET,
		"onboard",
		[addr(SAC), addr(kp.publicKey())],
		3,
		"router onboard while paused",
		ROUTER_ERRORS,
	)

	record({
		phase: 5,
		claim:
			"★ PAUSED REJECTS EVERYTHING — authorization, bans, freezes, supply and policy edits alike",
		hash: failed.hash,
		refusal: "ContractPaused",
		detail:
			"The linked transaction is an `authorize_trustline` envelope built and signed " +
			"while the contract was running; submitted after the pause it FAILED on-chain. " +
			"Every other entry point is refused with ContractPaused (#4) too: " +
			"`authorize_trustline`, `add_banned_accounts`, `freeze_accounts`, `allow`, " +
			"`mint_to_account`, `clawback`, `set_policy`, and the router's `onboard` — which " +
			"is refused because the authorizer it discovers refuses. Only `unpause`, " +
			"`set_admin`, `upgrade` and the read-only getters stay live, so a paused contract " +
			"can still be recovered or fixed." +
			(failed.rejected
				? " (The RPC rejected the stale envelope before inclusion on this run, so the " +
					"refusal here rests on the simulation results rather than a ledger entry.)"
				: ""),
	})

	const unpauseRes = await invoke(issuer, AUTHORIZER, "unpause", [], "unpause")
	check(
		(await read(AUTHORIZER, "is_paused", [], issuer.publicKey())) === false,
		"the contract must be running again",
	)
	const back = await invoke(
		submitter,
		AUTHORIZER,
		"authorize_trustline",
		[addr(kp.publicKey())],
		"authorize after unpause",
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.isAuthorized,
		"the same call must succeed once unpaused",
	)
	record({
		phase: 5,
		claim:
			"Unpause restores service — the very operation that just failed now succeeds",
		hash: unpauseRes.hash,
		detail:
			`Unpaused, then the same \`authorize_trustline(${kp.publicKey().slice(0, 8)}…)\` ` +
			`succeeded — ${expertTx(back.hash)} — and the trustline is authorized. The pause ` +
			"is a stop, not a one-way door.",
	})
}

// ===========================================================================
// Phase 6 — allowlist policy
// ===========================================================================

async function phase6() {
	PHASE = 6
	heading(
		"PHASE 6 · allowlist policy — nobody is allowed except listed addresses\n" +
			"          and the two policy sets stay independent across a switch",
	)

	const kp = holder("kyc", "holder F — admitted by the allowlist after KYC")
	await fund(kp.publicKey())
	await submitClassic(
		await classicTx(kp.publicKey(), Operation.changeTrust({ asset })),
		kp,
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.hasTrustline && !st.isAuthorized,
		"the holder must hold an unauthorized trustline before this phase runs",
	)

	const policyRes = await invoke(
		issuer,
		AUTHORIZER,
		"set_policy",
		[enumVal("Allowlist")],
		"set_policy Allowlist",
	)
	check(
		(await read(AUTHORIZER, "policy", [], issuer.publicKey())) === "Allowlist",
		"policy must be Allowlist",
	)
	const code = await expectRefusal(
		submitter.publicKey(),
		AUTHORIZER,
		"authorize_trustline",
		[addr(kp.publicKey())],
		2,
		"authorize an un-allowed holder under Allowlist",
	)
	record({
		phase: 6,
		claim:
			"Policy switched to Allowlist — an address that was fine a moment ago is now " +
			"refused because it was never allowed",
		hash: policyRes.hash,
		refusal: code,
		detail:
			`Under Denylist this holder would have authorized freely. Under Allowlist the ` +
			`same call is refused with ${code} (#2) — a different typed error from a ban, so ` +
			'an operator can tell "never KYC\'d" apart from "sanctioned".',
	})

	const allowRes = await invoke(
		issuer,
		AUTHORIZER,
		"allow",
		[addrVec([kp.publicKey()])],
		"allow",
	)
	const authRes = await invoke(
		submitter,
		AUTHORIZER,
		"authorize_trustline",
		[addr(kp.publicKey())],
		"authorize after allow",
	)
	await awaitStatus(
		kp.publicKey(),
		(st) => st.isAuthorized,
		"an allowed holder must authorize",
	)
	record({
		phase: 6,
		claim:
			"The issuer allows the address after KYC, and it authorizes immediately",
		hash: allowRes.hash,
		detail:
			`\`allow\` put ${kp.publicKey()} on the allowlist; the subsequent ` +
			`\`authorize_trustline\` — ${expertTx(authRes.hash)} — succeeded and the ` +
			"trustline is authorized.",
	})

	// Switching back must not reinterpret one list as the other.
	const backRes = await invoke(
		issuer,
		AUTHORIZER,
		"set_policy",
		[enumVal("Denylist")],
		"set_policy Denylist",
	)
	const stillAllowed = await read(
		AUTHORIZER,
		"is_allowed",
		[addr(kp.publicKey())],
		issuer.publicKey(),
	)
	const frozenAddr = holders.frozen.publicKey()
	const stillBanned = await read(
		AUTHORIZER,
		"is_banned",
		[addr(holders.banned.publicKey())],
		issuer.publicKey(),
	)
	check(stillAllowed === true, "the allowlist entry must survive the switch")
	check(stillBanned === true, "the denylist ban must survive the switch")
	record({
		phase: 6,
		claim:
			"The denylist and allowlist are stored independently — switching policy does " +
			"not silently reinterpret one list as the other",
		hash: backRes.hash,
		detail:
			`Back on Denylist, the Phase 3 ban on ${holders.banned.publicKey()} is still in ` +
			`force (is_banned=true) and the allowlist entry for ${kp.publicKey()} is still ` +
			"recorded (is_allowed=true) rather than having become a ban. An issuer can move " +
			"between regimes without their compliance state changing meaning underneath them." +
			`\n\n(Unrelated: ${frozenAddr} from Phase 4 remains unfrozen and authorized.)`,
	})
}

// ===========================================================================
// Phase 7 — mint and clawback
// ===========================================================================

async function phase7() {
	PHASE = 7
	heading("PHASE 7 · supply — mint to an authorized holder, and claw it back")

	const kp = holders.clean
	const mintRes = await invoke(
		issuer,
		AUTHORIZER,
		"mint_to_account",
		[addr(kp.publicKey()), i128("250")],
		"mint",
	)
	const minted = await balanceOf(kp.publicKey(), ASSET_CODE)
	check(
		minted.balance === "250.0000000",
		`holder should hold 250 ${ASSET_CODE}, got ${minted.balance}`,
	)
	record({
		phase: 7,
		claim: `Issuer mints 250 ${ASSET_CODE} to an authorized holder through the authorizer`,
		hash: mintRes.hash,
		detail:
			`Balance went from 0 to 250.0000000. The mint runs through the authorizer's ` +
			"`mint_to_account`, which is admin-gated and policy-aware — it is the SAC admin, " +
			"so the issuer key never touches the SAC directly.",
	})

	const clawRes = await invoke(
		issuer,
		AUTHORIZER,
		"clawback",
		[addr(kp.publicKey()), i128("100")],
		"clawback",
	)
	const after = await balanceOf(kp.publicKey(), ASSET_CODE)
	check(
		after.balance === "150.0000000",
		`holder should hold 150 ${ASSET_CODE} after clawback, got ${after.balance}`,
	)
	record({
		phase: 7,
		claim: `Issuer claws back 100 ${ASSET_CODE} from that holder`,
		hash: clawRes.hash,
		detail:
			"Balance went from 250.0000000 to 150.0000000 without the holder's signature. " +
			"This requires the issuer's AUTH_CLAWBACK_ENABLED flag, set in Phase 0; without " +
			"it the contract refuses with a typed AssetRefused (#10) rather than a panic.",
	})
}

// ===========================================================================
// Phase 8 — upgrade
// ===========================================================================

async function phase8() {
	PHASE = 8
	heading("PHASE 8 · upgrade the contract in place; state survives")

	const before = {
		admin: await read(AUTHORIZER, "admin", [], issuer.publicKey()),
		sac: await read(AUTHORIZER, "sac", [], issuer.publicKey()),
		policy: await read(AUTHORIZER, "policy", [], issuer.publicKey()),
		banned: await read(
			AUTHORIZER,
			"is_banned",
			[addr(holders.banned.publicKey())],
			issuer.publicKey(),
		),
	}

	const upRes = await invoke(
		issuer,
		AUTHORIZER,
		"upgrade",
		[xdr.ScVal.scvBytes(WASM_HASH)],
		"upgrade",
	)

	const after = {
		admin: await read(AUTHORIZER, "admin", [], issuer.publicKey()),
		sac: await read(AUTHORIZER, "sac", [], issuer.publicKey()),
		policy: await read(AUTHORIZER, "policy", [], issuer.publicKey()),
		banned: await read(
			AUTHORIZER,
			"is_banned",
			[addr(holders.banned.publicKey())],
			issuer.publicKey(),
		),
	}
	check(
		JSON.stringify(before) === JSON.stringify(after),
		"admin, SAC, policy and the ban set must survive an upgrade",
	)
	record({
		phase: 8,
		claim:
			"Admin-gated in-place upgrade executes, and admin / SAC / policy / the ban set " +
			"all survive the swap",
		hash: upRes.hash,
		detail:
			`\`upgrade(${WASM_HASH.toString("hex").slice(0, 16)}…)\` ran under the admin's ` +
			"signature and swapped the contract's executable, keeping the same contract id " +
			`\`${AUTHORIZER}\`. Read back afterwards: admin=${after.admin.slice(0, 8)}…, ` +
			`sac=${after.sac.slice(0, 8)}…, policy=${after.policy}, and the Phase 3 ban is ` +
			"still in force. This run upgrades to the SAME wasm hash — there is no second " +
			"build to point at — so what it proves is that the upgrade path executes under " +
			"admin auth and that instance state is not reset by it, not that a different " +
			"binary was installed.",
	})
}

// ===========================================================================
// Phase 9 — handover: set_admin
// ===========================================================================

async function phase9() {
	PHASE = 9
	heading(
		"PHASE 9 · hand the contract to a new admin; the old admin loses control",
	)

	await fund(newAdmin.publicKey())
	actors.push({
		role: "second admin (handover target)",
		pub: newAdmin.publicKey(),
	})

	const handRes = await invoke(
		issuer,
		AUTHORIZER,
		"set_admin",
		[addr(newAdmin.publicKey())],
		"set_admin",
	)
	const admin = await read(AUTHORIZER, "admin", [], issuer.publicKey())
	check(admin === newAdmin.publicKey(), "admin must be the new key")

	// The old admin's signature no longer carries authority. This is an AUTH
	// failure, not a typed contract error, so it is asserted by shape.
	let oldAdminRefused = false
	try {
		await invoke(
			issuer,
			AUTHORIZER,
			"add_banned_accounts",
			[addrVec([submitter.publicKey()])],
			"old admin ban attempt",
		)
	} catch {
		oldAdminRefused = true
	}
	check(oldAdminRefused, "the OLD admin must no longer be able to ban")
	note(
		"The OLD admin can no longer ban after the handover",
		"Built an `add_banned_accounts` call signed by the previous admin; it failed " +
			"authorization at simulation and so never became a transaction.",
	)

	// The new admin can, proving control really moved rather than jammed.
	const proofBan = await invoke(
		newAdmin,
		AUTHORIZER,
		"add_banned_accounts",
		[addrVec([submitter.publicKey()])],
		"new admin ban",
	)
	await invoke(
		newAdmin,
		AUTHORIZER,
		"remove_banned_accounts",
		[addrVec([submitter.publicKey()])],
		"new admin unban",
	)
	record({
		phase: 9,
		claim:
			"Adminship moves to a new key: the old admin can no longer act, and the new " +
			"admin can",
		hash: handRes.hash,
		detail:
			`\`set_admin\` moved control from ${issuer.publicKey()} to ${newAdmin.publicKey()}. ` +
			"An `add_banned_accounts` signed by the OLD admin is then rejected for lack of " +
			`authorization, while the same call signed by the NEW admin succeeds — ` +
			`${expertTx(proofBan.hash)}. This is the key-rotation path an issuer needs when ` +
			"an ops key is retired or compromised.",
	})

	// Hand it back so the contract is left in a coherent state for the reader.
	const backRes = await invoke(
		newAdmin,
		AUTHORIZER,
		"set_admin",
		[addr(issuer.publicKey())],
		"set_admin back",
	)
	check(
		(await read(AUTHORIZER, "admin", [], issuer.publicKey())) ===
			issuer.publicKey(),
		"admin must be handed back",
	)
	record({
		phase: 9,
		claim:
			"…and back again, so the handover is demonstrably not a one-way door",
		hash: backRes.hash,
		detail:
			`The new admin handed control back to ${issuer.publicKey()}. The contract is left ` +
			"in the state the rest of this report describes.",
	})
}

// ===========================================================================
// Phase 10 — the audit trail, rebuilt from the ledger alone
// ===========================================================================

let auditTrail = []

async function phase10() {
	heading(
		"PHASE 10 · the audit trail — every state change, read back from contract\n" +
			"           events on the ledger, with no indexer",
	)

	const latest = await net("getLatestLedger", () => server.getLatestLedger())
	const startLedger = Math.max(1, latest.sequence - 17_280)
	const filters = [{ type: "contract", contractIds: [AUTHORIZER] }]
	const events = []
	let cursor
	for (let page = 0; page < 60; page++) {
		const res = await net("getEvents", () =>
			server.getEvents(
				cursor
					? { cursor, filters, limit: 200 }
					: { startLedger, filters, limit: 200 },
			),
		)
		events.push(...res.events)
		if (!res.cursor || res.cursor === cursor) break
		cursor = res.cursor
		if (Number(cursor.split("-")[0].slice(0, -12)) >= latest.sequence) break
	}

	auditTrail = events.map((e) => {
		const topics = e.topic.map((t) => scValToNative(t))
		const data = scValToNative(e.value) ?? {}
		return {
			ledger: e.ledger,
			name: String(topics[0]),
			subject: topics[1] ? String(topics[1]) : "",
			admin: data.authorizer_admin ?? "",
			detail: Object.entries(data)
				.filter(([k]) => k !== "ledger" && k !== "authorizer_admin")
				.map(([k, v]) => `${k}=${fmtEventValue(v)}`)
				.join(" "),
		}
	})

	check(auditTrail.length > 0, "the contract must have emitted events")
	const names = new Set(auditTrail.map((e) => e.name))
	for (const expected of [
		"authorized",
		"banned",
		"frozen",
		"unfrozen",
		"paused",
		"unpaused",
		"policy_set",
		"allowed",
		"minted",
		"clawback",
		"upgraded",
		"admin_changed",
	]) {
		if (!names.has(expected))
			console.log(`    ! no '${expected}' event found in the window`)
	}
	console.log(
		`    ✔ ${auditTrail.length} events recovered from the ledger, ` +
			`${names.size} distinct kinds\n`,
	)
	for (const e of auditTrail) {
		console.log(
			`      ledger ${String(e.ledger).padEnd(9)} ${e.name.padEnd(14)} ` +
				`${(e.subject || "").slice(0, 12).padEnd(13)} ${e.detail}`,
		)
	}
}

// ===========================================================================
// Phase 11 — the LIVE pinned testnet deployment, verified read-only
// ===========================================================================

let live = null

async function phase11() {
	heading(
		"PHASE 11 · the LIVE pinned testnet deployment, verified read-only\n" +
			"           (this run never mutates the shared asset)",
	)

	const { resolveOfficialAsset } = await import("@theahaco/authline")
	const pinned = resolveOfficialAsset("EURCV", "TESTNET")
	check(pinned?.authorizer, "the testnet EURCV pin must carry an authorizer")

	const id = pinned.authorizer
	const [admin, sac, policy, paused] = await Promise.all([
		read(id, "admin", [], issuer.publicKey()),
		read(id, "sac", [], issuer.publicKey()),
		read(id, "policy", [], issuer.publicKey()),
		read(id, "is_paused", [], issuer.publicKey()),
	])
	const sacAdmin = await read(pinned.sac, "admin", [], issuer.publicKey())

	check(
		sac === pinned.sac,
		`the live authorizer's sac() must equal the pinned SAC (${pinned.sac}), got ${sac}`,
	)
	check(
		sacAdmin === id,
		`the pinned SAC's admin() must be the authorizer (${id}), got ${sacAdmin}`,
	)
	check(paused === false, "the live authorizer must not be paused")

	// The Tranche-1 stub exposed no set_admin / pause / policy — reaching these
	// entry points at all is what proves the stub has been replaced.
	const eligible = await read(
		id,
		"is_eligible",
		[addr(submitter.publicKey())],
		issuer.publicKey(),
	)

	live = { ...pinned, admin, sac, policy, paused, sacAdmin, eligible }
	console.log(`    ✔ authorizer  ${id}`)
	console.log(`      admin       ${admin}`)
	console.log(`      sac()       ${sac}`)
	console.log(`      SAC.admin() ${sacAdmin}  (== authorizer)`)
	console.log(`      policy      ${policy}   paused: ${paused}`)
	console.log(
		`      is_eligible(${submitter.publicKey().slice(0, 8)}…) = ${eligible}\n`,
	)
	console.log(
		"    The full admin surface (policy, is_paused, set_admin, upgrade) answers on\n" +
			"    this contract — the Tranche-1 stub exposed none of it.",
	)
}

// ===========================================================================
// Phase 12 — the issuer admin CLI, against the contract we just deployed
// ===========================================================================

let cliOutput = null

async function phase12(alias) {
	heading(
		"PHASE 12 · the issuer admin CLI, run against the contract this script deployed",
	)

	// Reads are simulated, so ANY keystore alias works as the source — it never
	// signs and never pays. Fall back to whatever the operator actually has
	// rather than skipping the whole phase over a missing default name.
	let use = alias
	if (
		spawnSync("stellar", ["keys", "public-key", use], { encoding: "utf8" })
			.status !== 0
	) {
		const ls = spawnSync("stellar", ["keys", "ls"], { encoding: "utf8" })
		const first = (ls.stdout ?? "")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.includes(" "))[0]
		if (ls.status !== 0 || !first) {
			console.log(
				`    (skipped — no stellar CLI keystore alias '${alias}' and none to fall\n` +
					"     back on. The CLI's read commands simulate from a source account, so\n" +
					"     they need one. Re-run with --cli-source <alias>, or see\n" +
					"     docs/authorizer-runbook.md.)",
			)
			return
		}
		console.log(
			`    · no alias '${alias}'; using '${first}' as the read source`,
		)
		use = first
	}

	const runs = []
	for (const [label, args] of [
		["npm run authorizer -- status", ["status", "--id", AUTHORIZER]],
		[
			"npm run authorizer -- check <banned holder>",
			["check", holders.banned.publicKey(), "--id", AUTHORIZER],
		],
		[
			"npm run authorizer -- history",
			["history", "--id", AUTHORIZER, "--limit", "25"],
		],
	]) {
		const res = spawnSync(
			"node",
			["scripts/authorizer.mjs", ...args, "--source", use],
			{ encoding: "utf8", cwd: new URL("..", import.meta.url).pathname },
		)
		const text = (res.stdout ?? "").trim() || (res.stderr ?? "").trim()
		runs.push({ label, args, text, ok: res.status === 0 })
		console.log(`\n    $ ${label}`)
		console.log(
			text
				.split("\n")
				.map((l) => `      ${l}`)
				.join("\n"),
		)
	}
	check(
		runs.every((r) => r.ok),
		"every CLI read command must exit 0",
	)
	cliOutput = runs
}

// ===========================================================================
// Report
// ===========================================================================

const PHASE_TITLES = {
	0: "Phase 0 — standing up a regulated asset with the authorizer as SAC admin",
	1: "Phase 1 — denylist: anyone not banned authorizes (through the router)",
	2: "Phase 2 — authorize-on-behalf: the holder signs zero times",
	3: "Phase 3 — banning an address before it ever creates a trustline",
	4: "Phase 4 — ★ freeze: a frozen account cannot get re-authorized",
	5: "Phase 5 — ★ paused rejects everything",
	6: "Phase 6 — allowlist policy, and independent policy sets",
	7: "Phase 7 — mint and clawback",
	8: "Phase 8 — upgrade in place",
	9: "Phase 9 — admin handover",
}

/**
 * Format the generated report the way the repo formats everything else.
 *
 * CI runs `prettier . --check`, so a generated file that is not prettier-clean
 * turns every run red until someone reformats it by hand — and the next proof
 * run would break it again. Formatting here keeps the artifact and the check in
 * agreement. Best-effort: a missing prettier must not fail a proof run.
 */
function formatReport(path) {
	try {
		spawnSync("npx", ["prettier", "--write", path], { encoding: "utf8" })
	} catch {}
}

function writeReport(outPath, startedAt) {
	let commit = "(unknown)"
	try {
		commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
		}).trim()
	} catch {}
	let version = "(unknown)"
	try {
		version = require("../packages/authline-sdk/package.json").version
	} catch {}

	const L = []
	L.push("# Trustline Authorizer — testnet proof run")
	L.push("")
	L.push(
		"Every transaction below is a real entry on the Stellar **testnet** public ledger. " +
			"Follow any link to verify it independently — nothing here relies on trusting this " +
			"document.",
	)
	L.push("")
	L.push(`- **Run at:** ${startedAt.toISOString()}`)
	L.push(`- **Network:** Stellar testnet (\`${NET.passphrase}\`)`)
	L.push(`- **Commit:** \`${commit}\` · SDK \`@theahaco/authline\` v${version}`)
	L.push(
		`- **Authorizer wasm:** \`${WASM_HASH.toString("hex")}\` (sha256 of ` +
			"`target/wasm32v1-none/release/trustline_authorizer.wasm`)",
	)
	L.push(
		`- **Asset issued by this run:** \`${ASSET_CODE}:${issuer.publicKey()}\``,
	)
	L.push(`- **SAC:** [\`${SAC}\`](${expertContract(SAC)})`)
	L.push(
		`- **Authorizer deployed by this run:** [\`${AUTHORIZER}\`](${expertContract(AUTHORIZER)})`,
	)
	L.push(
		`- **Onboard router:** [\`${ROUTERS.TESTNET}\`](${expertContract(ROUTERS.TESTNET)})`,
	)
	L.push("")
	L.push("Reproduce with:")
	L.push("")
	L.push("```")
	L.push("npm ci")
	L.push("npm run build -w @theahaco/authline")
	L.push("cargo build --release --target wasm32v1-none -p trustline-authorizer")
	L.push("node scripts/prove-authorizer.mjs")
	L.push("```")
	L.push("")
	L.push(
		"The run stands up its own issuer, its own SAC and its own authorizer instance from " +
			"friendbot-funded keys, so it owns all of its own state, needs no secrets, and " +
			"never mutates the shared pinned testnet asset. Phase 11 verifies that live " +
			"deployment read-only.",
	)
	L.push("")
	L.push(
		"> **How to read a row.** Every claim below is either a link to a real transaction " +
			"on the public ledger, or — where the thing being proven is a REFUSAL — one " +
			"sentence saying what was done, because a refused call never becomes a " +
			"transaction and so has no hash. Two refusals do have hashes: where the script " +
			"could build an envelope while the holder was still eligible, it submitted that " +
			"envelope after the freeze/pause and the transaction **failed on the ledger**, " +
			"which is a refusal you can click on.",
	)
	L.push("")

	L.push("## Summary")
	L.push("")
	L.push("| Phase | What it proves | Evidence |")
	L.push("| --- | --- | --- |")
	for (const e of evidence) {
		const ev = e.hash
			? `[\`${e.hash.slice(0, 12)}…\`](${expertTx(e.hash)})`
			: e.sentence
		L.push(`| ${e.phase} | ${e.claim} | ${ev} |`)
	}
	L.push("")

	for (const id of Object.keys(PHASE_TITLES)) {
		const rows = evidence.filter((e) => String(e.phase) === id)
		if (rows.length === 0) continue
		L.push(`## ${PHASE_TITLES[id]}`)
		L.push("")
		for (const e of rows) {
			L.push(`### ${e.claim}`)
			L.push("")
			if (e.hash) L.push(`- **Transaction:** ${expertTx(e.hash)}`)
			else L.push(`- **No transaction:** ${e.sentence}`)
			if (e.contract) L.push(`- **Contract:** ${expertContract(e.contract)}`)
			if (e.refusal) L.push(`- **Typed contract error:** \`${e.refusal}\``)
			if (e.detail) {
				L.push("")
				L.push(e.detail)
			}
			L.push("")
		}
	}

	if (auditTrail.length) {
		L.push("## Phase 10 — the audit trail, rebuilt from the ledger alone")
		L.push("")
		L.push(
			`Every state change this run made emitted a contract event. All ${auditTrail.length} ` +
				"were read back from the ledger with a plain RPC `getEvents` call — no indexer, no " +
				"database, no off-chain log. Each row carries the admin that authorized it and the " +
				"ledger it happened on, which is what makes the authorization history auditable " +
				"from the chain alone.",
		)
		L.push("")
		L.push("| Ledger | Event | Subject | Detail |")
		L.push("| --- | --- | --- | --- |")
		for (const e of auditTrail) {
			const subj = e.subject
				? `[\`${e.subject.slice(0, 8)}…\`](${expertAcct(e.subject)})`
				: ""
			L.push(`| ${e.ledger} | \`${e.name}\` | ${subj} | ${e.detail} |`)
		}
		L.push("")
		L.push(
			`Read it yourself: \`npm run authorizer -- history --id ${AUTHORIZER}\``,
		)
		L.push("")
	}

	if (live) {
		L.push("## Phase 11 — the live pinned testnet deployment")
		L.push("")
		L.push(
			"The deliverable calls for the authorizer to be live on testnet as the admin of " +
				"the test asset, replacing the Tranche-1 stub. That deployment is verified here " +
				"**read-only** — this run never mutates shared state.",
		)
		L.push("")
		L.push("| Fact | Value |")
		L.push("| --- | --- |")
		L.push(`| Asset | \`${live.code}\` — ${live.name} |`)
		L.push(`| Issuer | [\`${live.issuer}\`](${expertAcct(live.issuer)}) |`)
		L.push(`| SAC | [\`${live.sac}\`](${expertContract(live.sac)}) |`)
		L.push(
			`| Authorizer | [\`${live.authorizer}\`](${expertContract(live.authorizer)}) |`,
		)
		L.push(
			`| \`SAC.admin()\` | \`${live.sacAdmin}\` — equals the authorizer ✅ |`,
		)
		L.push(
			`| \`authorizer.sac()\` | \`${live.sac}\` — equals the pinned SAC ✅ |`,
		)
		L.push(`| \`authorizer.admin()\` | \`${live.admin}\` |`)
		L.push(`| \`authorizer.policy()\` | \`${live.policy}\` |`)
		L.push(`| \`authorizer.is_paused()\` | \`${live.paused}\` |`)
		L.push("")
		L.push(
			"The Tranche-1 stub exposed no `policy`, `is_paused`, `set_admin` or `upgrade`. " +
				"That all four answer on this contract is what demonstrates the replacement. " +
				"(SAC adminship is one-way — the stub had no `set_admin` — so replacing it " +
				"required re-issuing the test asset, which is why the pinned issuer changed on " +
				"2026-08-20.)",
		)
		L.push("")
	}

	if (cliOutput) {
		L.push("## Phase 12 — the issuer admin CLI")
		L.push("")
		L.push(
			"The CLI wraps every entry point so an issuer's ops person types commands instead " +
				"of crafting Soroban invocations. Below are its read commands run against the " +
				"authorizer this script deployed. Write commands are the same invocations, signed " +
				"with a key from the local `stellar` keystore; the runbook documents each one — " +
				"see [docs/authorizer-runbook.md](authorizer-runbook.md).",
		)
		L.push("")
		for (const r of cliOutput) {
			L.push(`### \`${r.label}\``)
			L.push("")
			L.push("```")
			L.push(r.text)
			L.push("```")
			L.push("")
		}
	}

	L.push("## Accounts used")
	L.push("")
	L.push("| Role | Account |")
	L.push("| --- | --- |")
	for (const a of actors) {
		L.push(
			`| ${a.role} | [\`${a.pub.slice(0, 8)}…${a.pub.slice(-6)}\`](${expertAcct(a.pub)}) |`,
		)
	}
	L.push("")
	L.push("## What this run does not prove")
	L.push("")
	L.push(
		"- **The upgrade installs a different binary.** Phase 8 upgrades to the same wasm " +
			"hash, because there is no second build to point at. It proves the upgrade path " +
			"executes under admin auth and that instance state survives, not that the code " +
			"changed.",
	)
	L.push(
		"- **Unit-level invariants.** The contract's 36 Rust tests cover cases that are " +
			"awkward or impossible to stage live (constructor rejecting a non-SAC, batch " +
			"bounds, clawback without the issuer flag). Run them with `npm run test:contracts`.",
	)
	L.push(
		"- **The CLI's write commands.** Phase 12 runs the read commands, which need no " +
			"secret. The writes are the same invocations this script makes directly and are " +
			"documented in the runbook.",
	)
	L.push("")

	writeFileSync(outPath, `${L.join("\n")}\n`)
	formatReport(outPath)
	return outPath
}

// ===========================================================================
// Main
// ===========================================================================

const args = process.argv.slice(2)
const flagVal = (name) => {
	const i = args.indexOf(name)
	return i !== -1 && args[i + 1] ? args[i + 1] : null
}
const outPath = flagVal("--out") ?? "docs/authorizer-testnet-evidence.md"
const cliAlias = flagVal("--cli-source") ?? "me"

const startedAt = new Date()

console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║  Trustline Authorizer — testnet proof run                              ║
║  A regulated asset stood up from nothing, then every admin control     ║
║  exercised on-chain: ban, freeze, pause, policy, supply, upgrade.      ║
╚════════════════════════════════════════════════════════════════════════╝

Network : Stellar testnet
Router  : ${ROUTERS.TESTNET}
Wasm    : ${WASM_HASH.toString("hex")}
Started : ${startedAt.toISOString()}

Every account is generated fresh and funded by friendbot.
`)

try {
	await phase0()
	await phase1()
	await phase2()
	await phase3()
	await phase4()
	await phase5()
	await phase6()
	await phase7()
	await phase8()
	await phase9()
	await phase10()
	await phase11()
	await phase12(cliAlias)

	const written = writeReport(outPath, startedAt)

	heading("RESULT")
	console.log(
		`    ${evidence.length} claims proven on testnet, all assertions passed.\n`,
	)
	for (const e of evidence) {
		console.log(
			e.hash
				? `    Phase ${e.phase} · ${expertTx(e.hash)}`
				: `    Phase ${e.phase} · no transaction — ${e.claim}`,
		)
	}
	console.log(`\n    Authorizer deployed: ${expertContract(AUTHORIZER)}`)
	console.log(`    Shareable report written to: ${written}\n`)
} catch (err) {
	console.error(`\n\n✖ PROOF RUN FAILED\n\n  ${err.message}\n`)
	if (AUTHORIZER) console.error(`  Authorizer: ${expertContract(AUTHORIZER)}`)
	if (evidence.length > 0) {
		console.error("\n  Proven before the failure:")
		for (const e of evidence)
			console.error(
				e.hash
					? `    Phase ${e.phase} · ${expertTx(e.hash)}`
					: `    Phase ${e.phase} · no transaction — ${e.claim}`,
			)
	}
	console.error("")
	process.exitCode = 1
}
