#!/usr/bin/env node
/**
 * Read-only on-chain evidence for the adoption milestone: real onboardings
 * THROUGH THE STANDARD, each one a transaction anyone can open on Stellar
 * Expert.
 *
 * "Through the standard" means a holder's trustline to a regulated
 * (AUTH_REQUIRED) asset was authorized by the asset's on-chain Authorizer —
 * its SAC admin — in a Soroban transaction invoking either
 *
 *   Case A  authorize_trustline(holder) on the Authorizer — authorize-on-behalf,
 *           typically paid by a third party (an exchange's relayer) with the
 *           holder only an argument; also the second transaction of the
 *           default path, after a classic ChangeTrust (Case B)
 *   Case C  onboard(sac, holder) on the onboard router — one holder-signed
 *           transaction; the router discovers the Authorizer on-chain and calls
 *           authorize_trustline inside it
 *
 * as opposed to the issuer's classic set_trust_line_flags / allow_trust (or a
 * direct SAC set_authorized by the admin), reported as NON-standard.
 *
 * How the transactions are found — each rule checked against the known testnet
 * transactions under "Testnet evidence" in sep/sep_trustlineonboarder.md:
 *
 *   1  Every current trustline: Horizon /accounts?asset=CODE:ISSUER.
 *   2  Each holder's /operations, newest first, from the trustline's
 *      last_modified_ledger (an authorization modifies the line, so none can be
 *      later) back to the issuer account's creation (no line can be older) —
 *      so an earlier create → authorize → freeze → delete cycle is found too,
 *      not only the current line's. Horizon lists a Soroban call among the
 *      operations of every account whose entries it touched, so a
 *      relayer-sourced authorize_trustline naming the holder only as an
 *      argument still shows up here. Horizon EFFECTS do not: a SAC
 *      authorization produces no trustline_flags_updated effect at all, so
 *      effects are not used to find authorizations.
 *   3  The issuer's /operations: every classic set_trust_line_flags /
 *      allow_trust, including for holders who have since removed the line.
 *   4  With --submitter, that account's /operations: every authorization it
 *      paid for, including for holders who have since removed the line.
 *   5  Stellar RPC getEvents on the SAC for `set_authorized` — a cross-check,
 *      limited to the RPC's retention window (~7 days).
 *
 * Each hit is classified by decoding the invoke_host_function parameters
 * (contract id, function name, arguments) or reading the classic operation's
 * asset, trustor and flags.
 *
 * Strictly read-only: no keys, no signing, no submission — Horizon GETs and
 * RPC reads only, at most 4 requests in flight, backing off on 429.
 *
 * Usage, from the repo root:
 *
 *   npm run build -w @theahaco/authline
 *   node scripts/adoption-evidence.mjs [--network PUBLIC|TESTNET]   (default PUBLIC)
 *                                      [--asset EURCV]              (registry-pinned code)
 *                                      [--router C…[,C…]]           (default: pinned router)
 *                                      [--holders G…,G…]            (only these holders)
 *                                      [--submitter G…]             (only txs it sourced/paid)
 *                                      [--since YYYY-MM-DD]
 *                                      [--label "Platform X · Tier 0"]
 *                                      [--format md|json]           (default md)
 *
 * The report goes to stdout (redirect it to a file); progress goes to stderr.
 */
import { existsSync } from "node:fs"
import { StrKey, scValToNative, xdr } from "@stellar/stellar-sdk"

const DIST = new URL("../packages/authline-sdk/dist/index.js", import.meta.url)
if (!existsSync(DIST)) {
	console.error(
		"The SDK is not built. Run:\n\n  npm run build -w @theahaco/authline\n",
	)
	process.exit(1)
}
const { OFFICIAL_ASSETS, ROUTERS, resolveOfficialAsset } =
	await import("@theahaco/authline")

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const flagVal = (name, fallback = null) => {
	const i = args.indexOf(name)
	return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const list = (s) =>
	(s ?? "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean)

function fail(msg) {
	console.error(`error: ${msg}`)
	process.exit(1)
}

const NETS = {
	PUBLIC: {
		horizon: "https://horizon.stellar.org",
		rpc: "https://soroban-rpc.mainnet.stellar.gateway.fm",
		expert: "public",
	},
	TESTNET: {
		horizon: "https://horizon-testnet.stellar.org",
		rpc: "https://soroban-testnet.stellar.org",
		expert: "testnet",
	},
}

const NETWORK = flagVal("--network", "PUBLIC").toUpperCase()
const NET = NETS[NETWORK]
if (!NET) fail(`--network must be PUBLIC or TESTNET, got ${NETWORK}`)

const CODE = flagVal("--asset", "EURCV")
const ASSET = resolveOfficialAsset(CODE, NETWORK)
if (!ASSET) {
	const codes = OFFICIAL_ASSETS.filter((a) => a.network === NETWORK)
		.map((a) => a.code)
		.join(", ")
	fail(`${CODE} is not pinned for ${NETWORK}. Pinned: ${codes}`)
}
// Only a regulated asset has an Authorizer to onboard through; an open asset
// needs no authorization, so there is nothing for this script to measure.
if (!ASSET.authorizer)
	fail(`${CODE} on ${NETWORK} is ${ASSET.capability}: it has no Authorizer`)

const ROUTER_IDS = flagVal("--router")
	? list(flagVal("--router"))
	: [ROUTERS[NETWORK]].filter(Boolean)
for (const r of ROUTER_IDS)
	if (!StrKey.isValidContract(r)) fail(`--router is not a C-address: ${r}`)

const HOLDERS = list(flagVal("--holders"))
for (const h of HOLDERS)
	if (!StrKey.isValidEd25519PublicKey(h))
		fail(`--holders entry is not a G-address: ${h}`)

const SUBMITTER = flagVal("--submitter")
if (SUBMITTER && !StrKey.isValidEd25519PublicKey(SUBMITTER))
	fail(`--submitter is not a G-address: ${SUBMITTER}`)

const SINCE = flagVal("--since")
if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE))
	fail(`--since must be YYYY-MM-DD, got ${SINCE}`)
const SINCE_ISO = SINCE ? `${SINCE}T00:00:00Z` : null
if (SINCE_ISO && Number.isNaN(Date.parse(SINCE_ISO)))
	fail(`--since is not a date: ${SINCE}`)

const LABEL = flagVal("--label")
const FORMAT = flagVal("--format", "md")
if (FORMAT !== "md" && FORMAT !== "json")
	fail(`--format must be md or json, got ${FORMAT}`)

const log = (msg) => console.error(msg)
const WARNINGS = []

// ---------------------------------------------------------------------------
// Polite HTTP: at most 4 requests in flight, backoff on 429 / 5xx
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_IN_FLIGHT = 4
const MAX_ATTEMPTS = 6
let inFlight = 0
const waiting = []

/** Run `fn` holding one of the MAX_IN_FLIGHT slots (handed over directly on release). */
async function withSlot(fn) {
	if (inFlight < MAX_IN_FLIGHT) inFlight++
	else await new Promise((r) => waiting.push(r))
	try {
		return await fn()
	} finally {
		const next = waiting.shift()
		if (next) next()
		else inFlight--
	}
}

/** GET (or POST with `init`) JSON. 404 → null; 429/5xx/network errors retry with backoff. */
function request(url, init) {
	return withSlot(async () => {
		for (let attempt = 1; ; attempt++) {
			let res = null
			let err = null
			try {
				res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
			} catch (e) {
				err = e.message
			}
			if (res?.status === 404) return null
			if (res?.ok) return res.json()
			if (res && res.status !== 429 && res.status < 500)
				throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`)
			if (attempt >= MAX_ATTEMPTS)
				throw new Error(`${url}: ${err ?? `HTTP ${res.status}`} (gave up)`)
			// Honour Retry-After when the server sends one; otherwise 2s, 4s, 8s…
			const after = Number(res?.headers.get("retry-after"))
			await sleep(after > 0 ? after * 1000 : 1000 * 2 ** attempt)
		}
	})
}

// ---------------------------------------------------------------------------
// Horizon and RPC reads
// ---------------------------------------------------------------------------

const PAGE = 200 // Horizon's maximum page size
const MAX_PAGES = 100 // per scan: 20,000 records, then stop and say so

/**
 * Yield every record of a Horizon collection, following paging tokens (not
 * `_links.next`, which does not reliably carry `join=`). Warns when it stops at
 * MAX_PAGES with history left unscanned.
 */
async function* horizonRecords(
	path,
	what,
	cursor = null,
	maxPages = MAX_PAGES,
) {
	const sep = path.includes("?") ? "&" : "?"
	for (let page = 0; page < maxPages; page++) {
		const c = cursor ? `&cursor=${cursor}` : ""
		const body = await request(`${NET.horizon}${path}${sep}limit=${PAGE}${c}`)
		const recs = body?._embedded?.records ?? []
		yield* recs
		if (recs.length < PAGE) return
		cursor = recs[recs.length - 1].paging_token
	}
	WARNINGS.push(
		`${what}: stopped after ${maxPages * PAGE} records; older history was not scanned`,
	)
}

/** Operations of an account, newest first, each with its transaction embedded (fee payer). */
const opsPath = (account) =>
	`/accounts/${account}/operations?order=desc&join=transactions&include_failed=false`

async function rpc(method, params) {
	const body = await request(NET.rpc, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
	if (!body || body.error)
		throw new Error(`${method}: ${body?.error?.message ?? "no response"}`)
	return body.result
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const isG = (s) => typeof s === "string" && StrKey.isValidEd25519PublicKey(s)
const decode = (b64) => {
	try {
		return scValToNative(xdr.ScVal.fromXDR(b64, "base64"))
	} catch {
		return undefined
	}
}
const ofAsset = (op) =>
	op.asset_code === ASSET.code && op.asset_issuer === ASSET.issuer

/** Decode an invoke_host_function contract call → { contract, fn, argv }, else null. */
function contractCall(op) {
	const p = op.type === "invoke_host_function" ? (op.parameters ?? []) : []
	if (p.length < 2 || p[0].type !== "Address" || p[1].type !== "Sym")
		return null
	return {
		contract: decode(p[0].value),
		fn: decode(p[1].value),
		argv: p.slice(2).map((a) => decode(a.value)),
	}
}

const STANDARD = new Set(["authorize", "onboard"])
const PATH_LABEL = {
	authorize: "Case A authorize",
	onboard: "Case C onboard",
	"issuer-flags": "non-standard issuer flags",
	"sac-admin": "non-standard SAC set_authorized",
}

/**
 * Does this operation authorize a trustline to ASSET? → { holder, path,
 * contract? } or null. The SAC id is the first `onboard` argument in both the
 * v0.3 router signature onboard(sac, holder) and the pre-v0.3 wrapper's
 * onboard(sac, authorizer, holder); the holder is the last in both.
 */
function classify(op) {
	const call = contractCall(op)
	if (call) {
		const { contract, fn, argv } = call
		const last = argv[argv.length - 1]
		if (
			contract === ASSET.authorizer &&
			fn === "authorize_trustline" &&
			isG(argv[0])
		)
			return { holder: argv[0], path: "authorize", contract }
		if (fn === "onboard" && argv[0] === ASSET.sac && isG(last))
			return {
				holder: last,
				path: ROUTER_IDS.includes(contract) ? "onboard" : "onboard-unpinned",
				contract,
			}
		if (
			contract === ASSET.sac &&
			fn === "set_authorized" &&
			isG(argv[0]) &&
			argv[1] === true
		)
			return { holder: argv[0], path: "sac-admin", contract }
		return null
	}
	if (op.type === "set_trust_line_flags" && ofAsset(op)) {
		const set = op.set_flags ?? []
		if (set.includes(1) || (op.set_flags_s ?? []).includes("authorized"))
			return { holder: op.trustor, path: "issuer-flags" }
	}
	if (op.type === "allow_trust" && ofAsset(op) && op.authorize === true)
		return { holder: op.trustor, path: "issuer-flags" }
	return null
}

/**
 * Did this operation create `holder`'s trustline? A ChangeTrust is confirmed by
 * its `trustline_created` effect (the same operation also changes or deletes a
 * limit); a CAP-73 SAC trust() or an onboard() creates one by definition.
 */
async function createsLine(op, holder) {
	if (op.type === "change_trust") {
		if (op.trustor !== holder || !ofAsset(op) || Number(op.limit) === 0)
			return false
		const fx = await request(`${NET.horizon}/operations/${op.id}/effects`)
		return (fx?._embedded?.records ?? []).some(
			(e) => e.type === "trustline_created" && e.account === holder,
		)
	}
	const call = contractCall(op)
	if (!call) return false
	if (call.contract === ASSET.sac && call.fn === "trust")
		return call.argv[0] === holder
	return call.fn === "onboard" && call.argv[0] === ASSET.sac
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** Authorization rows keyed by `${tx}:${holder}`; `foundBy` records which scans saw each. */
const ROWS = new Map()

async function addRow(op, hit, foundBy) {
	const key = `${op.transaction_hash}:${hit.holder}`
	const existing = ROWS.get(key)
	if (existing) {
		existing.foundBy.add(foundBy)
		return existing
	}
	const tx =
		op.transaction ??
		(await request(`${NET.horizon}/transactions/${op.transaction_hash}`))
	const row = {
		date: op.created_at,
		ledger: tx?.ledger ?? null,
		holder: hit.holder,
		path: hit.path,
		standard: STANDARD.has(hit.path),
		contract: hit.contract ?? null,
		tx: op.transaction_hash,
		txSource: tx?.source_account ?? op.source_account,
		feeAccount: tx?.fee_account ?? tx?.source_account ?? op.source_account,
		trustlineTx: null,
		foundBy: new Set([foundBy]),
	}
	ROWS.set(key, row)
	return row
}

function lineOf(account) {
	const b = account?.balances?.find(
		(x) => x.asset_code === ASSET.code && x.asset_issuer === ASSET.issuer,
	)
	if (!b) return null
	return {
		authorized: b.is_authorized === true,
		maintainOnly:
			b.is_authorized !== true && b.is_authorized_to_maintain_liabilities,
		lastModifiedLedger: b.last_modified_ledger,
	}
}

/** Holders in scope: --holders as given, else every current trustline. */
async function loadScope() {
	if (HOLDERS.length)
		return Promise.all(
			HOLDERS.map(async (id) => ({
				id,
				line: lineOf(await request(`${NET.horizon}/accounts/${id}`)),
			})),
		)
	const scope = []
	const path = `/accounts?asset=${ASSET.code}:${ASSET.issuer}`
	for await (const acct of horizonRecords(
		path,
		"trustline listing",
		null,
		1000,
	))
		scope.push({ id: acct.id, line: lineOf(acct) })
	return scope
}

/**
 * Scan one holder's operations newest-first from the trustline's
 * last_modified_ledger down to FLOOR. Each authorization is linked to the
 * operation below it that created the line it authorized (`trustlineTx`) —
 * for the default path, the Case B ChangeTrust.
 */
async function scanHolder({ id, line }) {
	// TOID of the first operation of the ledger after last_modified_ledger:
	// a descending cursor there starts at that ledger's last operation.
	const cursor = line
		? ((BigInt(line.lastModifiedLedger) + 1n) << 32n).toString()
		: null
	let unlinked = []
	for await (const op of horizonRecords(opsPath(id), `holder ${id}`, cursor)) {
		if (op.created_at < FLOOR) break
		const hit = classify(op)
		if (hit?.holder === id) {
			const row = await addRow(op, hit, "holder")
			if (!hit.path.startsWith("onboard")) unlinked.push(row)
		}
		if (unlinked.length && (await createsLine(op, id))) {
			for (const row of unlinked)
				if (row.tx !== op.transaction_hash)
					row.trustlineTx = op.transaction_hash
			unlinked = []
		}
	}
}

/** Every authorization among an account's own operations (issuer, submitter). */
async function scanAccount(account, foundBy) {
	for await (const op of horizonRecords(opsPath(account), foundBy)) {
		if (op.created_at < FLOOR) break
		const hit = classify(op)
		if (hit) await addRow(op, hit, foundBy)
	}
}

/**
 * RPC cross-check: every SAC `set_authorized(true)` event in the retention
 * window. The authorized address is the topic just before the asset string
 * (CAP-67 dropped the admin from the topics; the older 4-topic form still
 * parses). Post-CAP-67 classic flag changes emit the same event, so this sees
 * standard and non-standard authorizations alike.
 */
async function rpcEvents() {
	const health = await rpc("getHealth")
	// Start a little inside the window: it slides forward while we page.
	const startLedger = health.oldestLedger + 120
	const window = {
		fromLedger: startLedger,
		toLedger: health.latestLedger,
		from: new Date((Number(health.oldestLedgerCloseTime) + 600) * 1000),
	}
	const topic = xdr.ScVal.scvSymbol("set_authorized").toXDR("base64")
	const filters = [
		{ type: "contract", contractIds: [ASSET.sac], topics: [[topic, "**"]] },
	]
	const events = []
	let cursor = null
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await rpc(
			"getEvents",
			cursor
				? { filters, pagination: { cursor, limit: 100 } }
				: { startLedger, filters, pagination: { limit: 100 } },
		)
		for (const ev of res.events ?? []) {
			const topics = ev.topic.map(decode)
			const value = decode(
				typeof ev.value === "string" ? ev.value : ev.value?.xdr,
			)
			const holder = topics[topics.length - 2]
			if (
				value === true &&
				isG(holder) &&
				ev.inSuccessfulContractCall !== false
			)
				events.push({ tx: ev.txHash, holder, ledger: ev.ledger })
		}
		if ((res.events ?? []).length < 100) break
		cursor = res.cursor
	}
	return { window, events }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

log(
	`${NETWORK} ${ASSET.code}:${ASSET.issuer}\n` +
		`  SAC ${ASSET.sac} · Authorizer ${ASSET.authorizer}\n` +
		`  router ${ROUTER_IDS.join(", ") || "(none pinned — pass --router C… to count Case C)"}`,
)

// No trustline to the asset can be older than its issuer account: every scan
// stops there (or at --since).
const first = await request(
	`${NET.horizon}/accounts/${ASSET.issuer}/operations?order=asc&limit=1`,
)
const INCEPTION = first?._embedded?.records?.[0]?.created_at ?? ""
const FLOOR = SINCE_ISO && SINCE_ISO > INCEPTION ? SINCE_ISO : INCEPTION
// Accounts that can sign for the issuer: an authorization they paid for is the
// issuer's own operation, not a platform's, whichever path it took.
const ISSUER_SIGNERS = new Set(
	((await request(`${NET.horizon}/accounts/${ASSET.issuer}`))?.signers ?? [])
		.filter((sg) => sg.weight > 0)
		.map((sg) => sg.key),
)

const scope = await loadScope()
const lines = scope.filter((h) => h.line)
log(
	`• ${lines.length} ${ASSET.code} trustlines in scope — scanning each holder`,
)
await Promise.all(scope.map(scanHolder))

log(`• scanning the issuer's operations for classic flag changes`)
await scanAccount(ASSET.issuer, "issuer")

if (SUBMITTER) {
	log(`• scanning the submitter's operations`)
	await scanAccount(SUBMITTER, "submitter")
}

log(`• RPC cross-check: set_authorized events on the SAC`)
let rpcCheck = null
try {
	rpcCheck = await rpcEvents()
	const unexplained = []
	for (const ev of rpcCheck.events) {
		if (ROWS.has(`${ev.tx}:${ev.holder}`)) {
			ROWS.get(`${ev.tx}:${ev.holder}`).foundBy.add("rpc-event")
			continue
		}
		// An authorization the Horizon scans missed (e.g. a holder who has since
		// removed the line): classify it from its own operations.
		let matched = false
		const ops = await request(
			`${NET.horizon}/transactions/${ev.tx}/operations?join=transactions&limit=${PAGE}`,
		)
		for (const op of ops?._embedded?.records ?? []) {
			const hit = classify(op)
			if (hit?.holder === ev.holder) {
				await addRow(op, hit, "rpc-event")
				matched = true
			}
		}
		if (!matched) unexplained.push(ev)
	}
	rpcCheck.unexplained = unexplained
} catch (e) {
	WARNINGS.push(`RPC cross-check skipped: ${e.message}`)
}

// Current state of every holder that appears in a row but not in the scope
// (a removed line, or a holder outside --holders found by another scan).
const STATE = new Map(scope.map((h) => [h.id, h.line]))
const missing = [...new Set([...ROWS.values()].map((r) => r.holder))].filter(
	(h) => !STATE.has(h),
)
await Promise.all(
	missing.map(async (h) =>
		STATE.set(h, lineOf(await request(`${NET.horizon}/accounts/${h}`))),
	),
)
const nowOf = (h) => {
	const l = STATE.get(h)
	if (!l) return "no trustline"
	if (l.authorized) return "authorized"
	return l.maintainOnly ? "maintain-liabilities" : "unauthorized"
}

// ---------------------------------------------------------------------------
// Filter and summarise
// ---------------------------------------------------------------------------

const all = [...ROWS.values()].sort((a, b) => a.date.localeCompare(b.date))
const inWindow = (r) =>
	rpcCheck && r.ledger != null && r.ledger >= rpcCheck.window.fromLedger
const rows = all
	.filter((r) => !HOLDERS.length || HOLDERS.includes(r.holder))
	.filter(
		(r) => !SUBMITTER || r.feeAccount === SUBMITTER || r.txSource === SUBMITTER,
	)
	.filter((r) => !SINCE_ISO || r.date >= SINCE_ISO)
	.map((r) => ({
		...r,
		label: PATH_LABEL[r.path] ?? `onboard via unpinned ${r.contract}`,
		submitter: r.feeAccount === r.holder ? "holder" : r.feeAccount,
		submitterRole:
			r.feeAccount === r.holder
				? "holder"
				: r.feeAccount === ASSET.issuer
					? "issuer"
					: ISSUER_SIGNERS.has(r.feeAccount)
						? "issuer-signer"
						: "third-party",
		now: nowOf(r.holder),
		rpcEvent: inWindow(r) ? r.foundBy.has("rpc-event") : null,
		foundBy: [...r.foundBy],
	}))

const count = (p) => rows.filter((r) => r.path === p).length
const standard = rows.filter((r) => r.standard)
const summary = {
	standard: standard.length,
	caseA: count("authorize"),
	caseC: count("onboard"),
	standardHolders: new Set(standard.map((r) => r.holder)).size,
	nonStandard: count("issuer-flags") + count("sac-admin"),
	unpinnedOnboard: count("onboard-unpinned"),
	unpinnedRouters: [
		...new Set(
			rows.filter((r) => r.path === "onboard-unpinned").map((r) => r.contract),
		),
	],
	trustlines: lines.length,
	stillUnauthorized: lines.filter((h) => !h.line.authorized).length,
	noTrustline: scope.length - lines.length,
	// Authorized now, yet no authorization transaction found by any scan —
	// authorized by a route this script does not recognise (only meaningful
	// when the scan was not cut short by --since).
	unexplainedAuthorized: SINCE_ISO
		? null
		: lines
				.filter((h) => h.line.authorized)
				.filter((h) => !all.some((r) => r.holder === h.id))
				.map((h) => h.id),
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const EXPERT = `https://stellar.expert/explorer/${NET.expert}`
const short = (s) => `${s.slice(0, 4)}…${s.slice(-4)}`
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`
const acct = (a) => `[\`${short(a)}\`](${EXPERT}/account/${a})`
const contract = (c) => `[\`${short(c)}\`](${EXPERT}/contract/${c})`
const txLink = (h) => `[\`${h.slice(0, 8)}…${h.slice(-4)}\`](${EXPERT}/tx/${h})`

function submitterCell(r) {
	const role = { issuer: " (issuer)", "issuer-signer": " (issuer signer)" }
	const payer =
		r.submitter === "holder"
			? "holder"
			: acct(r.feeAccount) + (role[r.submitterRole] ?? "")
	if (r.txSource === r.feeAccount) return payer
	return `${payer} (fee-bump for ${r.txSource === r.holder ? "holder" : acct(r.txSource)})`
}

function pathCell(r) {
	if (r.path === "onboard-unpinned")
		return `onboard via unpinned ${contract(r.contract)}`
	return r.standard ? `**${r.label}**` : r.label
}

function markdown() {
	const L = []
	const title = `${ASSET.code} onboardings on ${NETWORK === "PUBLIC" ? "mainnet" : "testnet"}`
	L.push(`### ${LABEL ? `${title} — ${LABEL}` : title}`)
	L.push("")
	L.push(
		`Asset [\`${ASSET.code}:${short(ASSET.issuer)}\`](${EXPERT}/asset/${ASSET.code}-${ASSET.issuer}) · ` +
			`SAC ${contract(ASSET.sac)} · Authorizer ${contract(ASSET.authorizer)} · ` +
			`router ${ROUTER_IDS.length ? ROUTER_IDS.map(contract).join(", ") : "none pinned"}`,
	)
	const filters = [
		HOLDERS.length && `${HOLDERS.length} listed holders`,
		SUBMITTER && `submitter ${acct(SUBMITTER)}`,
		SINCE && `since ${SINCE}`,
	].filter(Boolean)
	if (filters.length) L.push(`Filtered to: ${filters.join(" · ")}.`)
	L.push(
		`Generated ${new Date().toISOString().slice(0, 16)}Z from Horizon ` +
			`(full history) and Stellar RPC events (last ~7 days).`,
	)
	L.push("")
	L.push("| Date (UTC) | Holder | Path | Tx | Submitter | Now |")
	L.push("| --- | --- | --- | --- | --- | --- |")
	for (const r of rows)
		L.push(
			`| ${r.date.replace("T", " ").replace("Z", "")} | ${acct(r.holder)} | ` +
				`${pathCell(r)} | ${txLink(r.tx)} | ` +
				`${submitterCell(r)} | ${r.now} |`,
		)
	if (!rows.length) L.push("| — | — | — | — | — | — |")
	L.push("")
	const s = summary
	L.push(
		`**${plural(s.standard, "standard onboarding")}** ` +
			`(${s.caseA} Case A authorize, ${s.caseC} Case C onboard; ` +
			`${plural(s.standardHolders, "holder")}) · ` +
			`**${s.nonStandard} non-standard** · ` +
			`**${plural(s.stillUnauthorized, "holder")} still unauthorized** ` +
			`(of ${plural(s.trustlines, `${ASSET.code} trustline`)} in scope` +
			(s.noTrustline
				? `; ${plural(s.noTrustline, "listed holder")} without one`
				: "") +
			").",
	)
	if (s.unpinnedOnboard)
		L.push(
			"",
			`${plural(s.unpinnedOnboard, "onboard() call")} ` +
				`went through a contract that is not the pinned router, not counted ` +
				`as standard (${s.unpinnedRouters.map(contract).join(", ")}); pass ` +
				`\`--router <id>\` to count them.`,
		)
	if (s.unexplainedAuthorized?.length)
		L.push(
			"",
			`Authorized now with no authorization transaction found: ` +
				`${s.unexplainedAuthorized.map(acct).join(", ")}.`,
		)
	if (rpcCheck) {
		const w = rpcCheck.window
		const n = rpcCheck.events.length
		L.push(
			"",
			`RPC cross-check (ledgers ${w.fromLedger}–${w.toLedger}, since ` +
				`${w.from.toISOString().slice(0, 10)}): ` +
				`${plural(n, "`set_authorized` event")} on the SAC` +
				(rpcCheck.unexplained.length
					? `, ${rpcCheck.unexplained.length} not matched to a row: ` +
						rpcCheck.unexplained.map((e) => txLink(e.tx)).join(", ")
					: n
						? ", all matched to rows above"
						: ""),
		)
	}
	for (const w of WARNINGS) L.push("", `> Warning: ${w}`)
	return L.join("\n")
}

if (FORMAT === "json")
	console.log(
		JSON.stringify(
			{
				network: NETWORK,
				label: LABEL,
				generatedAt: new Date().toISOString(),
				asset: {
					code: ASSET.code,
					issuer: ASSET.issuer,
					sac: ASSET.sac,
					authorizer: ASSET.authorizer,
				},
				routers: ROUTER_IDS,
				filters: { holders: HOLDERS, submitter: SUBMITTER, since: SINCE },
				summary,
				rpcWindow: rpcCheck?.window ?? null,
				warnings: WARNINGS,
				rows: rows.map((r) => ({
					...r,
					txUrl: `${EXPERT}/tx/${r.tx}`,
					holderUrl: `${EXPERT}/account/${r.holder}`,
				})),
			},
			null,
			2,
		),
	)
else console.log(markdown())
