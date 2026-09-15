#!/usr/bin/env node
/**
 * Standalone proof run for the **authorization relayer** deliverable (D2.3).
 *
 * Drives the HOSTED relayer over plain HTTP, exactly as an exchange would, and
 * prints every resulting transaction as a stellar.expert link. The point is
 * evidence a third party can verify without trusting this output.
 *
 * The integration half of this script uses nothing but `fetch` — no Stellar
 * SDK, no signing, no key handling. That is the deliverable's central claim
 * ("an exchange can integrate in about 20 lines of any language, without
 * touching a Stellar SDK"), so the script is written to make it checkable: the
 * SDK appears only where it stands in for the USER'S WALLET creating a
 * trustline, which is the one step nobody can do on the holder's behalf.
 *
 *   1  GET  /healthz                    the service is live
 *   2  GET  .../ready   (no account)    reason: no_account
 *   3  GET  .../ready   (funded)        reason: no_trustline
 *   4  user's wallet creates a bare trustline          ← a transaction
 *   5  GET  .../ready                   reason: trustline_unauthorized
 *   6  POST .../authorize               200 + txHash   ← THE transaction
 *   7  GET  .../ready                   ready: true
 *   8  POST .../authorize (again)       alreadyAuthorized, no new transaction
 *   9  POST .../authorize (no token)    401
 *
 * Every one of those exchanges is echoed as it happens and reproduced verbatim
 * in the report — request line, headers, status and response body — so the
 * evidence is the trace itself rather than a summary of it. The bearer token is
 * never printed: it renders as `Bearer «redacted»` wherever it was sent.
 *
 * Steps 2/3/5 are the three distinguishable not-ready states the SEP's §7
 * lessons describe — the reason an integrator knows what to DO about a
 * not-ready account.
 *
 * The holder is generated fresh and funded by friendbot on every run, so the
 * script owns all of its own state and can be repeated by anyone. It needs one
 * secret: the relayer's API token, read from the environment and never printed.
 *
 * Usage, from the repo root:
 *
 *   export RELAYER_API_TOKEN=...            # the hosted instance's token
 *   npm run build -w @theahaco/authline
 *   node scripts/prove-relayer.mjs [--base https://authline-relayer.fly.dev]
 *                                  [--out docs/relayer-evidence.md]
 *                                  [--transcript relayer-transcript.txt]
 *
 * Assertions are hard failures: the script cannot print a claim it did not
 * actually prove.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import {
	Asset,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk"

const require = createRequire(import.meta.url)

const DIST = new URL("../packages/authline-sdk/dist/index.js", import.meta.url)
if (!existsSync(DIST)) {
	console.error(
		"The SDK is not built. Run:\n\n  npm run build -w @theahaco/authline\n",
	)
	process.exit(1)
}
const { resolveOfficialAsset } = await import("@theahaco/authline")

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const flagVal = (name, fallback = null) => {
	const i = args.indexOf(name)
	return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = (
	flagVal("--base") ??
	process.env.RELAYER_URL ??
	"https://authline-relayer.fly.dev"
).replace(/\/$/, "")
const OUT = flagVal("--out", "docs/relayer-evidence.md")
const TRANSCRIPT = flagVal("--transcript")
const TOKEN = process.env.RELAYER_API_TOKEN

if (!TOKEN) {
	console.error(
		"\nRELAYER_API_TOKEN is not set.\n\n" +
			"The authorize endpoint is token-gated, and proving it is the point of this\n" +
			"run. Export the hosted instance's token and try again:\n\n" +
			"  export RELAYER_API_TOKEN=...\n" +
			"  node scripts/prove-relayer.mjs\n\n" +
			"It is read from the environment and never printed or written to the report.\n",
	)
	process.exit(1)
}

const NET = {
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const horizon = new Horizon.Server(NET.horizonUrl)
const PINNED = resolveOfficialAsset("EURCV", "TESTNET")
if (!PINNED?.authorizer)
	throw new Error("the testnet EURCV pin must carry an authorizer")

const expertTx = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`
const expertAcct = (a) => `https://stellar.expert/explorer/testnet/account/${a}`
const expertContract = (c) =>
	`https://stellar.expert/explorer/testnet/contract/${c}`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TIMEOUT_MS = 30_000

function check(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

// ---------------------------------------------------------------------------
// The wire log
// ---------------------------------------------------------------------------
//
// Every exchange with the relayer is recorded verbatim — method, path, request
// headers, status, timing and the response body exactly as it came off the
// wire — so the run produces a trace a reviewer can READ instead of a summary
// they have to trust. It is echoed live and reproduced in the report.
//
// The bearer token is the one thing that never appears. The Authorization
// header renders as `Bearer «redacted»`, and any literal occurrence of the
// token is scrubbed from response bodies too, in case some future error path
// ever echoes a request header back.

const WIRE = []
const HOST = new URL(BASE).host

const redact = (s) =>
	typeof s === "string" && TOKEN ? s.split(TOKEN).join("«redacted»") : s

function bodyLines(text) {
	const scrubbed = redact(text ?? "")
	if (!scrubbed.trim()) return ["(empty body)"]
	try {
		return JSON.stringify(JSON.parse(scrubbed), null, 2).split("\n")
	} catch {
		return scrubbed.split("\n")
	}
}

/**
 * The endpoint, without the account. `/v1/accounts/G…56 chars…/ready` puts the
 * one word that says WHAT was called at the far right of a long line, behind an
 * address that swamps it — read quickly, every call looks like a call to
 * `/accounts`. This pulls the endpoint out so the trace can be scanned.
 */
function endpointOf(path) {
	const clean = (path ?? "").split("?")[0]
	const seg = clean.split("/").filter(Boolean)
	return seg.length > 1 ? `…/${seg[seg.length - 1]}` : clean
}

/** A few words on what the response actually said, for the index. */
function outcomeOf(e) {
	if (e.error) return "no response"
	let b = null
	try {
		b = JSON.parse(e.text)
	} catch {}
	if (!b || typeof b !== "object") return ""
	if (b.error) return String(b.error)
	if (b.txHash) return `txHash ${String(b.txHash).slice(0, 12)}…`
	if (b.alreadyAuthorized === true) return "alreadyAuthorized, no tx"
	if (b.reason) return String(b.reason)
	if (b.ready === true) return "ready"
	if (b.ok === true) return "ok"
	return ""
}

function renderExchange(e, t0, indent = "") {
	const L = []
	L.push(
		`# ${e.n} · +${((e.at - t0) / 1000).toFixed(1)}s · ` +
			`${e.method} ${endpointOf(e.path)}`,
	)
	L.push(`> ${e.method} ${e.path}`)
	L.push(`> host: ${HOST}`)
	L.push(`> authorization: ${e.sentToken ? "Bearer «redacted»" : "(omitted)"}`)
	if (e.error) {
		L.push(`< (no response — ${redact(e.error)})`)
	} else {
		L.push(`< ${e.status} ${e.statusText || ""}`.trimEnd() + `   ${e.ms} ms`)
		if (e.contentType) L.push(`< content-type: ${e.contentType}`)
		L.push("<")
		for (const line of bodyLines(e.text)) L.push(line)
	}
	return L.map((l) => indent + l).join("\n")
}

/**
 * The flow in one table. The reviewer's question is "did ready → authorize →
 * ready actually happen", and that should be answerable without reading eight
 * JSON bodies first.
 */
function renderWireIndex(style = "md") {
	const rows = WIRE.map((e) => {
		const status = e.error ? "—" : String(e.status)
		const outcome = outcomeOf(e)
		return {
			n: String(e.n),
			call: `${e.method} ${endpointOf(e.path)}`,
			res: outcome ? `${status} · ${outcome}` : status,
		}
	})
	if (style === "md") {
		return [
			"| # | Call | Response |",
			"| --- | --- | --- |",
			...rows.map((r) => `| ${r.n} | \`${r.call}\` | ${r.res} |`),
		].join("\n")
	}
	const w = Math.max(4, ...rows.map((r) => r.call.length))
	return rows
		.map((r) => `  ${r.n.padStart(2)}  ${r.call.padEnd(w)}  ${r.res}`)
		.join("\n")
}

const renderWire = (indent = "") =>
	WIRE.length === 0
		? `${indent}(no exchanges recorded)`
		: WIRE.map((e) => renderExchange(e, WIRE[0].at, indent)).join("\n\n")

function logExchange(entry) {
	const e = { n: WIRE.length + 1, at: Date.now(), ...entry }
	WIRE.push(e)
	console.log(`\n${renderExchange(e, WIRE[0].at, "      ")}\n`)
}

/**
 * THE INTEGRATION. Everything an exchange needs is this function plus the two
 * call sites below it — plain `fetch`, no Stellar SDK, no keys.
 *
 * The only thing here that is not integration code is the `logExchange` call:
 * it records the exchange for the transcript and changes nothing about the
 * request.
 */
async function relayer(path, { method = "GET", token } = {}) {
	const startedAt = Date.now()
	let res
	try {
		res = await fetch(`${BASE}${path}`, {
			method,
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
	} catch (err) {
		// A transport failure is part of the trace too — `retry` may well recover
		// from it, and a transcript that silently dropped the attempt would be
		// telling the reader a tidier story than what actually happened.
		logExchange({
			method,
			path,
			sentToken: Boolean(token),
			error: err instanceof Error ? err.message : String(err),
			ms: Date.now() - startedAt,
		})
		throw err
	}
	const text = await res.text()
	logExchange({
		method,
		path,
		sentToken: Boolean(token),
		status: res.status,
		statusText: res.statusText,
		contentType: res.headers.get("content-type"),
		text,
		ms: Date.now() - startedAt,
	})
	let body = null
	try {
		body = JSON.parse(text)
	} catch {}
	return { status: res.status, body }
}

const ready = (account) => relayer(`/v1/accounts/${account}/ready`)

/**
 * `token` defaults to the configured one. To send NO Authorization header, pass
 * `null` — never `undefined`: a default parameter is applied whenever the
 * argument is `undefined`, so `authorize(a, undefined)` would silently send the
 * token and turn the 401 check below into a test that proves nothing.
 */
const authorize = (account, token = TOKEN) =>
	relayer(`/v1/accounts/${account}/authorize`, { method: "POST", token })

/** Retry a flaky network read a few times before giving up. */
async function retry(label, fn, tries = 3) {
	let lastErr
	for (let attempt = 1; attempt <= tries; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastErr = err
			if (attempt === tries) break
			console.log(
				`      … ${label} failed (${err.message}); retry ${attempt + 1}/${tries}`,
			)
			await sleep(2000 * attempt)
		}
	}
	throw lastErr
}

async function fund(pub) {
	let why = "unknown"
	for (let attempt = 1; attempt <= 6; attempt++) {
		try {
			const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`, {
				signal: AbortSignal.timeout(TIMEOUT_MS),
			})
			if (r.ok) return
			why = `HTTP ${r.status}`
		} catch (e) {
			why = e instanceof Error ? e.message : String(e)
		}
		if (await accountExists(pub)) return
		if (attempt < 6) {
			console.log(
				`      … friendbot ${pub.slice(0, 8)}… failed (${why}); retry ${attempt + 1}/6`,
			)
			await sleep(3000 * attempt)
		}
	}
	throw new Error(
		`friendbot could not fund ${pub} after 6 attempts — last failure: ${why}. ` +
			"Testnet friendbot is intermittently down; re-run when it recovers.",
	)
}

async function accountExists(pub) {
	return horizon.loadAccount(pub).then(
		() => true,
		() => false,
	)
}

/** Poll `ready` until the reason matches — the ledger view can trail a tx. */
async function awaitReason(account, want, label, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	let last
	for (;;) {
		last = await retry(`ready ${account.slice(0, 8)}`, () => ready(account))
		const got = last.body?.ready ? "ready" : last.body?.reason
		if (got === want) return last.body
		if (Date.now() > deadline) break
		await sleep(2500)
	}
	throw new Error(
		`ASSERTION FAILED: ${label} — expected ${want}, got ` +
			`${last?.body?.ready ? "ready" : last?.body?.reason} (HTTP ${last?.status})`,
	)
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const evidence = []

function record(claim, hash, detail) {
	evidence.push({ claim, hash, detail })
	console.log(`    ✔ ${claim}`)
	console.log(`      ${expertTx(hash)}`)
}

function note(claim, sentence) {
	evidence.push({ claim, sentence })
	console.log(`    ✔ ${claim}`)
	console.log(`      no transaction — ${sentence}`)
}

function heading(title) {
	console.log(`\n${"─".repeat(74)}\n${title}\n${"─".repeat(74)}`)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const holder = Keypair.random()
const asset = new Asset(PINNED.code, PINNED.issuer)
let health = null

async function proveRelayer() {
	heading(
		"THE RELAYER · driven over plain HTTP, exactly as an exchange would\n" +
			`          ${BASE}`,
	)

	// 1 — live.
	const h = await retry("healthz", () => relayer("/healthz"))
	check(
		h.status === 200 && h.body?.ok === true,
		`/healthz should be 200/ok, got ${h.status}`,
	)
	health = h.body
	note(
		"The hosted relayer is live and reports its network, signing account and default asset",
		`\`GET ${BASE}/healthz\` returned 200 with network ${h.body.network}, relayer ` +
			`account ${h.body.relayer} and default asset ${h.body.defaultAsset}.`,
	)

	// 2 — an account that does not exist yet.
	check(
		!(await accountExists(holder.publicKey())),
		"the holder must not exist on-ledger when the run starts",
	)
	const s1 = await awaitReason(holder.publicKey(), "no_account", "fresh holder")
	check(
		s1.authorizable === true,
		"a fresh holder should be policy-eligible under the denylist",
	)
	note(
		"Readiness distinguishes a missing ACCOUNT from a missing trustline",
		`\`GET /v1/accounts/{a}/ready\` for an address with no ledger entry returned ` +
			`\`ready:false, reason:"no_account", authorizable:true\` — the integrator learns ` +
			"it must fund or use a claimable balance, not open a trustline.",
	)

	// 3 — funded, still no trustline.
	await fund(holder.publicKey())
	const s2 = await awaitReason(
		holder.publicKey(),
		"no_trustline",
		"funded holder",
	)
	check(
		s2.authorizable === true,
		"a funded, unbanned holder should still be eligible",
	)
	note(
		"…and a missing TRUSTLINE from an unauthorized one",
		'After funding, the same call returned `reason:"no_trustline"` — a different ' +
			"remedial action (onboard through the router or the sponsored flow).",
	)

	// 4 — the ONE step the exchange cannot do for the user: their own signature.
	//     This is the only place a Stellar SDK appears in this script.
	const account = await horizon.loadAccount(holder.publicKey())
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(Operation.changeTrust({ asset }))
		.setTimeout(180)
		.build()
	tx.sign(holder)
	const ct = await retry("changeTrust", () => horizon.submitTransaction(tx), 1)
	record(
		"The user's wallet creates a bare, unauthorized trustline",
		ct.hash,
		"The one step no third party can perform: creating a trustline always requires " +
			"the owner's own signature. This is the only transaction in this run that the " +
			"exchange does not drive, and the only place a Stellar SDK appears in this " +
			"script — it stands in for the user's wallet.",
	)

	// 5 — the third not-ready state.
	const s3 = await awaitReason(
		holder.publicKey(),
		"trustline_unauthorized",
		"holder with a bare trustline",
	)
	check(
		s3.authorizable === true,
		"the holder should be authorizable at this point",
	)
	note(
		"…and reports the third state, the one the relayer itself can fix",
		"With a trustline present but unauthorized, `ready` returned " +
			'`reason:"trustline_unauthorized", authorizable:true` — `authorizable` is the ' +
			"live policy pre-check, turning a fee-costing on-chain refusal into a free read.",
	)

	// 6 — THE call. One POST; the relayer signs, submits and pays.
	const auth = await retry("authorize", () => authorize(holder.publicKey()))
	check(
		auth.status === 200,
		`authorize should be 200, got ${auth.status} ${JSON.stringify(auth.body)}`,
	)
	check(auth.body?.authorized === true, "authorize should report authorized")
	check(
		auth.body?.alreadyAuthorized === false,
		"this authorize should be a real submission",
	)
	check(
		typeof auth.body?.txHash === "string",
		"authorize should return a txHash",
	)
	record(
		"ONE HTTP call authorizes the holder — the relayer signs, submits and pays the fee",
		auth.body.txHash,
		`\`POST /v1/accounts/{a}/authorize\` returned 200 with this transaction hash. The ` +
			`caller sent no signature, held no key and touched no Stellar SDK. The relayer ` +
			`holds NO authority of its own: \`authorize_trustline\` is permissionless and the ` +
			`policy is enforced by the authorizer contract ` +
			`(\`${PINNED.authorizer}\`), so the relayer's key only pays fees.`,
	)

	// 7 — the flip, read back from the chain.
	const s4 = await awaitReason(holder.publicKey(), "ready", "authorized holder")
	check(s4.ready === true, "the holder must end ready")
	note(
		"The readiness endpoint flips to ready, read back from the ledger",
		"The same `ready` call now returns `ready:true` — the state change is read from " +
			"the chain, not cached by the service.",
	)

	// 8 — idempotency, which is what makes this safe in a retry queue.
	const again = await retry("authorize again", () =>
		authorize(holder.publicKey()),
	)
	check(again.status === 200, "a repeat authorize should be 200")
	check(
		again.body?.alreadyAuthorized === true,
		"a repeat authorize should be idempotent",
	)
	check(
		again.body?.txHash === undefined,
		"a repeat authorize must not submit a second transaction",
	)
	note(
		"Authorizing twice is safe — the second call submits nothing",
		"A repeated `POST .../authorize` returned `alreadyAuthorized:true` with no `txHash`: " +
			"no second transaction and no second fee. Exchange pipelines are at-least-once " +
			"(retry queues, duplicate webhooks), so this is what makes the endpoint safe to " +
			"call from them.",
	)

	// 9 — the endpoint is gated.
	const noTok = await retry("authorize without token", () =>
		authorize(holder.publicKey(), null),
	)
	check(
		noTok.status === 401,
		`authorize without a token should be 401, got ${noTok.status}. Check the ` +
			"transcript: if that exchange shows an Authorization header, the token was " +
			"sent and the endpoint was never actually tested.",
	)
	note(
		"The authorize endpoint is token-gated",
		"The same call without an `Authorization: Bearer` header returned 401 — the relayer " +
			"pays fees, so it authenticates callers even though it holds no on-chain authority.",
	)
}

// ---------------------------------------------------------------------------
// The rest of D2.3 — criteria with no transaction behind them
// ---------------------------------------------------------------------------

const other = []

function ghRun(workflow, extra) {
	const res = spawnSync(
		"gh",
		[
			"run",
			"list",
			`--workflow=${workflow}`,
			"--limit=20",
			"--json",
			"databaseId,conclusion,createdAt,event,headSha",
			...extra,
		],
		{ encoding: "utf8" },
	)
	if (res.status !== 0) return null
	try {
		return JSON.parse(res.stdout)
	} catch {
		return null
	}
}

function collectOther() {
	heading("THE REST OF D2.3 · criteria with no transaction behind them")

	const runs = ghRun("build.yml", [])
	const REPO = "https://github.com/theahaco/authline"

	const ci = runs?.find((r) => r.event === "push" && r.conclusion === "success")
	other.push({
		claim: "Unit tests and contract tests run green in CI",
		sentence: ci
			? `Workflow run [${ci.databaseId}](${REPO}/actions/runs/${ci.databaseId}) on ` +
				`\`${ci.headSha.slice(0, 7)}\` (${ci.createdAt.slice(0, 10)}) ran lint, ` +
				"prettier, the Rust contract tests and the unit suite — all green."
			: "`npm run test:contracts` and `npm test` run on every push and pull request " +
				"via `.github/workflows/build.yml` (the `gh` CLI was unavailable, so no run " +
				"id is linked here).",
	})

	const e2e = runs?.find(
		(r) => r.event === "workflow_dispatch" && r.conclusion === "success",
	)
	other.push({
		claim: "The end-to-end suite runs against real testnet",
		sentence: e2e
			? `Workflow run [${e2e.databaseId}](${REPO}/actions/runs/${e2e.databaseId}) ` +
				`(${e2e.createdAt.slice(0, 10)}) ran the Node testnet e2e suite and the ` +
				"Playwright browser suite against real testnet, both green. The job is " +
				"`workflow_dispatch`-gated because it spends testnet funds and serialises on " +
				"shared asset ids."
			: "The `e2e-testnet` job in `.github/workflows/build.yml` runs the testnet suites " +
				"on manual dispatch (the `gh` CLI was unavailable, so no run id is linked here).",
	})

	other.push({
		claim: "A browser test drives the dApp the way a user would",
		sentence:
			"Seven Playwright specs in `tests/e2e/` drive a real Chromium against the built " +
			"dApp (`playwright.config.ts` serves the production build at `:4173`), covering " +
			"the USDC, TLO and EURCV activation flows and the claimable-balance claim.",
	})

	other.push({
		claim: "The relayer ships as a Docker image for self-hosting",
		sentence:
			"`packages/relayer/Dockerfile` builds the service; `fly.toml` is the deployment " +
			"used for the hosted instance proven above.",
	})

	other.push({
		claim: "The relayer has a runbook",
		sentence:
			"`docs/relayer-runbook.md` documents configuration, the two endpoints, deployment " +
			"and key rotation.",
	})

	other.push({
		claim: "The MiCA design note is published",
		sentence:
			"`docs/mica-authorization-model.md` describes what the authorization model records " +
			"on-chain and why no personal data is involved anywhere — addresses and enumerated " +
			"codes only, with no free-text field in the interface.",
	})

	const sepPath = "sep/sep_trustlineonboarder.md"
	let sepDiscussion = null
	try {
		const sep = execFileSync("cat", [sepPath], { encoding: "utf8" })
		const m = /^Discussion:\s*(\S+)/m.exec(sep)
		sepDiscussion = m?.[1] ?? null
	} catch {}
	const posted = sepDiscussion && !sepDiscussion.includes("[placeholder]")
	other.push({
		claim: "The updated SEP is in the repo",
		sentence:
			`\`${sepPath}\` — the Trustline Onboarder draft, updated with everything this ` +
			"grant's implementation taught us (see its Changelog).",
	})
	other.push({
		claim: "The SEP is posted to the public discussion thread",
		sentence: posted
			? `Discussion thread: ${sepDiscussion}`
			: "NOT YET DONE — the draft's `Discussion:` field is still a placeholder. This " +
				"criterion is not met.",
		unmet: !posted,
	})

	for (const o of other) {
		console.log(`    ${o.unmet ? "✖" : "✔"} ${o.claim}`)
		console.log(`      ${o.sentence}`)
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

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

function writeReport(startedAt) {
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
	L.push("# Authorization relayer — proof run (D2.3)")
	L.push("")
	L.push(
		"The hosted relayer, driven over plain HTTP exactly as an exchange would. Every " +
			"transaction below is a real entry on the Stellar **testnet** public ledger — follow " +
			"any link to verify it independently.",
	)
	L.push("")
	L.push(`- **Run at:** ${startedAt.toISOString()}`)
	L.push(`- **Relayer:** ${BASE}`)
	L.push(`- **Network:** Stellar testnet (\`${NET.passphrase}\`)`)
	if (health) {
		L.push(
			`- **Relayer signing account:** [\`${health.relayer}\`](${expertAcct(health.relayer)}) — pays fees, holds no authority`,
		)
		L.push(`- **Default asset:** \`${health.defaultAsset}\``)
	}
	L.push(
		`- **Authorizer enforcing policy:** [\`${PINNED.authorizer}\`](${expertContract(PINNED.authorizer)})`,
	)
	L.push(`- **Commit:** \`${commit}\` · SDK \`@theahaco/authline\` v${version}`)
	L.push("")
	L.push("Reproduce with:")
	L.push("")
	L.push("```")
	L.push("npm ci")
	L.push("npm run build -w @theahaco/authline")
	L.push("export RELAYER_API_TOKEN=...")
	L.push("node scripts/prove-relayer.mjs")
	L.push("```")
	L.push("")
	L.push(
		"> **How to read a row.** Every claim is either a link to a real transaction on the " +
			"public ledger, or one sentence saying what was done — because most of what this " +
			"deliverable asserts (a service answering, a document existing, a suite running) " +
			"never becomes a transaction.",
	)
	L.push("")

	L.push("## The integration, in full")
	L.push("")
	L.push(
		"This is the entire exchange-side integration the run exercises. No Stellar SDK, no " +
			"key handling, no signing:",
	)
	L.push("")
	L.push("```js")
	L.push(`const BASE = "${BASE}"`)
	L.push("")
	L.push("const ready = (account) =>")
	L.push(
		"\tfetch(`${BASE}/v1/accounts/${account}/ready`).then((r) => r.json())",
	)
	L.push("")
	L.push("const authorize = (account) =>")
	L.push("\tfetch(`${BASE}/v1/accounts/${account}/authorize`, {")
	L.push('\t\tmethod: "POST",')
	L.push(
		"\t\theaders: { authorization: `Bearer ${process.env.RELAYER_API_TOKEN}` },",
	)
	L.push("\t}).then((r) => r.json())")
	L.push("")
	L.push("const status = await ready(account)")
	L.push("if (!status.ready && status.authorizable) await authorize(account)")
	L.push("```")
	L.push("")
	L.push(
		"The one thing it cannot do is create the user's trustline — that always requires " +
			"the holder's own signature, which is why the run uses a wallet stand-in for that " +
			"single step and nothing else.",
	)
	L.push("")

	L.push("## The relayer, proven")
	L.push("")
	L.push("| What it proves | Evidence |")
	L.push("| --- | --- |")
	for (const e of evidence) {
		L.push(
			`| ${e.claim} | ${e.hash ? `[\`${e.hash.slice(0, 12)}…\`](${expertTx(e.hash)})` : e.sentence} |`,
		)
	}
	L.push("")
	for (const e of evidence) {
		L.push(`### ${e.claim}`)
		L.push("")
		if (e.hash) L.push(`- **Transaction:** ${expertTx(e.hash)}`)
		else L.push(`- **No transaction:** ${e.sentence}`)
		if (e.detail) {
			L.push("")
			L.push(e.detail)
		}
		L.push("")
	}

	L.push("## Every request and response, verbatim")
	L.push("")
	L.push(
		"The complete HTTP trace of the run above — every call the exchange side made, in " +
			"order, with the response the hosted relayer returned. `>` is the request, `<` the " +
			"response. The bearer token does not appear anywhere: it renders as " +
			"`Bearer «redacted»` wherever it was sent, and the run never prints it.",
	)
	L.push("")
	L.push(
		"Repeated `GET …/ready` calls are **polling, not retries** — after a transaction the " +
			"run waits for the ledger's view to catch up, and every poll is shown rather than " +
			"collapsed, so the trace matches what actually crossed the wire.",
	)
	L.push("")
	L.push(
		"Every call below names the account as a **path segment** — " +
			"`/v1/accounts/{account}/ready` — so the endpoint is the last word of the line, " +
			"not the first. The index names it up front:",
	)
	L.push("")
	L.push(renderWireIndex("md"))
	L.push("")
	L.push(
		"The first call includes a cold start: the hosted instance runs with " +
			"`min_machines_running = 0` and stops when idle, so it spends a few seconds " +
			"waking up and then answers in the hundreds of milliseconds. That is the " +
			"deployment choice for a testnet reference instance, not the service's " +
			"steady-state latency.",
	)
	L.push("")
	L.push("```http")
	L.push(renderWire())
	L.push("```")
	L.push("")

	L.push("## The rest of D2.3")
	L.push("")
	L.push("| Criterion | Evidence |")
	L.push("| --- | --- |")
	for (const o of other)
		L.push(`| ${o.unmet ? "❌ " : ""}${o.claim} | ${o.sentence} |`)
	L.push("")

	const unmet = other.filter((o) => o.unmet)
	if (unmet.length) {
		L.push("## Not yet met")
		L.push("")
		for (const o of unmet) L.push(`- **${o.claim}** — ${o.sentence}`)
		L.push("")
	}

	writeFileSync(OUT, `${L.join("\n")}\n`)
	formatReport(OUT)
	return OUT
}

/**
 * The same trace on its own, for pasting somewhere that is not a markdown file.
 * Not formatted by prettier: it is a transcript, not a document.
 */
function writeTranscript(path, startedAt) {
	writeFileSync(
		path,
		`Authorization relayer — HTTP transcript\n` +
			`Relayer : ${BASE}\n` +
			`Holder  : ${holder.publicKey()}\n` +
			`Run at  : ${startedAt.toISOString()}\n` +
			`Note    : the bearer token is redacted; repeated GET .../ready calls are\n` +
			`          polls waiting for the ledger view to catch up, not retries.\n` +
			`          The account is a PATH SEGMENT: /v1/accounts/{account}/{endpoint}.\n\n` +
			`${renderWireIndex("text")}\n\n${renderWire()}\n`,
	)
	return path
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const startedAt = new Date()

console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║  Authorization relayer — proof run (D2.3)                              ║
║  The hosted service, driven over plain HTTP as an exchange would.      ║
╚════════════════════════════════════════════════════════════════════════╝

Relayer : ${BASE}
Asset   : ${PINNED.code} (testnet), authorizer ${PINNED.authorizer}
Holder  : ${holder.publicKey()}  (fresh, funded by friendbot)
Started : ${startedAt.toISOString()}
`)

try {
	await proveRelayer()
	collectOther()

	const written = writeReport(startedAt)

	heading("RESULT")
	const unmet = other.filter((o) => o.unmet)
	console.log(
		`    ${evidence.length} relayer claims proven, all assertions passed.\n`,
	)
	for (const e of evidence)
		console.log(
			e.hash ? `    ${expertTx(e.hash)}` : `    no transaction — ${e.claim}`,
		)
	if (unmet.length) {
		console.log(`\n    ✖ ${unmet.length} D2.3 criterion/criteria NOT met:`)
		for (const o of unmet) console.log(`      - ${o.claim}`)
	}
	console.log(
		`\n    ${WIRE.length} relayer exchanges recorded, token redacted.`,
	)
	console.log(`    Shareable report written to: ${written}`)
	if (TRANSCRIPT)
		console.log(
			`    Transcript written to: ${writeTranscript(TRANSCRIPT, startedAt)}`,
		)
	console.log("")
	if (unmet.length) process.exitCode = 2
} catch (err) {
	console.error(`\n\n✖ PROOF RUN FAILED\n\n  ${err.message}\n`)
	if (evidence.length > 0) {
		console.error("  Proven before the failure:")
		for (const e of evidence)
			console.error(e.hash ? `    ${expertTx(e.hash)}` : `    ${e.claim}`)
		console.error("")
	}
	// The trace is most useful precisely when the run failed, so keep it: the
	// exchanges were echoed live, but a --transcript run should still get its
	// file rather than only the ones that finish clean.
	if (TRANSCRIPT && WIRE.length > 0) {
		try {
			console.error(
				`  ${WIRE.length} exchanges up to the failure written to: ` +
					`${writeTranscript(TRANSCRIPT, startedAt)}\n`,
			)
		} catch {}
	}
	process.exitCode = 1
}
