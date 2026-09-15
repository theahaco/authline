# Authorization relayer — proof run (D2.3)

The hosted relayer, driven over plain HTTP exactly as an exchange would. Every
transaction below is a real entry on the Stellar **testnet** public ledger —
follow any link to verify it independently.

- **Run at:** 2026-09-07T07:54:39.146Z
- **Relayer:** https://authline-relayer.fly.dev
- **Network:** Stellar testnet (`Test SDF Network ; September 2015`)
- **Relayer signing account:**
  [`GCB6N27Y6GTTMRBUQNYROIB5C37PWAJKLFRL7U3JXFZF7NQIJL2NS2TQ`](https://stellar.expert/explorer/testnet/account/GCB6N27Y6GTTMRBUQNYROIB5C37PWAJKLFRL7U3JXFZF7NQIJL2NS2TQ)
  — pays fees, holds no authority
- **Default asset:** `EURCV`
- **Authorizer enforcing policy:**
  [`CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM`](https://stellar.expert/explorer/testnet/contract/CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM)
- **Commit:** `1a56b57` · SDK `@theahaco/authline` v0.5.0

Reproduce with:

```
npm ci
npm run build -w @theahaco/authline
export RELAYER_API_TOKEN=...
node scripts/prove-relayer.mjs
```

> **How to read a row.** Every claim is either a link to a real transaction on
> the public ledger, or one sentence saying what was done — because most of what
> this deliverable asserts (a service answering, a document existing, a suite
> running) never becomes a transaction.

## The integration, in full

This is the entire exchange-side integration the run exercises. No Stellar SDK,
no key handling, no signing:

```js
const BASE = "https://authline-relayer.fly.dev"

const ready = (account) =>
	fetch(`${BASE}/v1/accounts/${account}/ready`).then((r) => r.json())

const authorize = (account) =>
	fetch(`${BASE}/v1/accounts/${account}/authorize`, {
		method: "POST",
		headers: { authorization: `Bearer ${process.env.RELAYER_API_TOKEN}` },
	}).then((r) => r.json())

const status = await ready(account)
if (!status.ready && status.authorizable) await authorize(account)
```

The one thing it cannot do is create the user's trustline — that always requires
the holder's own signature, which is why the run uses a wallet stand-in for that
single step and nothing else.

## The relayer, proven

| What it proves                                                                        | Evidence                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The hosted relayer is live and reports its network, signing account and default asset | `GET https://authline-relayer.fly.dev/healthz` returned 200 with network TESTNET, relayer account GCB6N27Y6GTTMRBUQNYROIB5C37PWAJKLFRL7U3JXFZF7NQIJL2NS2TQ and default asset EURCV.                                                                              |
| Readiness distinguishes a missing ACCOUNT from a missing trustline                    | `GET /v1/accounts/{a}/ready` for an address with no ledger entry returned `ready:false, reason:"no_account", authorizable:true` — the integrator learns it must fund or use a claimable balance, not open a trustline.                                           |
| …and a missing TRUSTLINE from an unauthorized one                                     | After funding, the same call returned `reason:"no_trustline"` — a different remedial action (onboard through the router or the sponsored flow).                                                                                                                  |
| The user's wallet creates a bare, unauthorized trustline                              | [`5f761a49ab51…`](https://stellar.expert/explorer/testnet/tx/5f761a49ab5146784f4c557d0c514b4a3f1cdfec2a42557216a1ccb971b85378)                                                                                                                                   |
| …and reports the third state, the one the relayer itself can fix                      | With a trustline present but unauthorized, `ready` returned `reason:"trustline_unauthorized", authorizable:true` — `authorizable` is the live policy pre-check, turning a fee-costing on-chain refusal into a free read.                                         |
| ONE HTTP call authorizes the holder — the relayer signs, submits and pays the fee     | [`b8aa776c13c1…`](https://stellar.expert/explorer/testnet/tx/b8aa776c13c1f1c179b5c4a70120cf1f56098ecf200aaf9ae24abe6fba391f7b)                                                                                                                                   |
| The readiness endpoint flips to ready, read back from the ledger                      | The same `ready` call now returns `ready:true` — the state change is read from the chain, not cached by the service.                                                                                                                                             |
| Authorizing twice is safe — the second call submits nothing                           | A repeated `POST .../authorize` returned `alreadyAuthorized:true` with no `txHash`: no second transaction and no second fee. Exchange pipelines are at-least-once (retry queues, duplicate webhooks), so this is what makes the endpoint safe to call from them. |
| The authorize endpoint is token-gated                                                 | The same call without an `Authorization: Bearer` header returned 401 — the relayer pays fees, so it authenticates callers even though it holds no on-chain authority.                                                                                            |

### The hosted relayer is live and reports its network, signing account and default asset

- **No transaction:** `GET https://authline-relayer.fly.dev/healthz` returned
  200 with network TESTNET, relayer account
  GCB6N27Y6GTTMRBUQNYROIB5C37PWAJKLFRL7U3JXFZF7NQIJL2NS2TQ and default asset
  EURCV.

### Readiness distinguishes a missing ACCOUNT from a missing trustline

- **No transaction:** `GET /v1/accounts/{a}/ready` for an address with no ledger
  entry returned `ready:false, reason:"no_account", authorizable:true` — the
  integrator learns it must fund or use a claimable balance, not open a
  trustline.

### …and a missing TRUSTLINE from an unauthorized one

- **No transaction:** After funding, the same call returned
  `reason:"no_trustline"` — a different remedial action (onboard through the
  router or the sponsored flow).

### The user's wallet creates a bare, unauthorized trustline

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/5f761a49ab5146784f4c557d0c514b4a3f1cdfec2a42557216a1ccb971b85378

The one step no third party can perform: creating a trustline always requires
the owner's own signature. This is the only transaction in this run that the
exchange does not drive, and the only place a Stellar SDK appears in this script
— it stands in for the user's wallet.

### …and reports the third state, the one the relayer itself can fix

- **No transaction:** With a trustline present but unauthorized, `ready`
  returned `reason:"trustline_unauthorized", authorizable:true` — `authorizable`
  is the live policy pre-check, turning a fee-costing on-chain refusal into a
  free read.

### ONE HTTP call authorizes the holder — the relayer signs, submits and pays the fee

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/b8aa776c13c1f1c179b5c4a70120cf1f56098ecf200aaf9ae24abe6fba391f7b

`POST /v1/accounts/{a}/authorize` returned 200 with this transaction hash. The
caller sent no signature, held no key and touched no Stellar SDK. The relayer
holds NO authority of its own: `authorize_trustline` is permissionless and the
policy is enforced by the authorizer contract
(`CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM`), so the relayer's
key only pays fees.

### The readiness endpoint flips to ready, read back from the ledger

- **No transaction:** The same `ready` call now returns `ready:true` — the state
  change is read from the chain, not cached by the service.

### Authorizing twice is safe — the second call submits nothing

- **No transaction:** A repeated `POST .../authorize` returned
  `alreadyAuthorized:true` with no `txHash`: no second transaction and no second
  fee. Exchange pipelines are at-least-once (retry queues, duplicate webhooks),
  so this is what makes the endpoint safe to call from them.

### The authorize endpoint is token-gated

- **No transaction:** The same call without an `Authorization: Bearer` header
  returned 401 — the relayer pays fees, so it authenticates callers even though
  it holds no on-chain authority.

## Every request and response, verbatim

The complete HTTP trace of the run above — every call the exchange side made, in
order, with the response the hosted relayer returned. `>` is the request, `<`
the response. The bearer token does not appear anywhere: it renders as
`Bearer «redacted»` wherever it was sent, and the run never prints it.

Repeated `GET …/ready` calls are **polling, not retries** — after a transaction
the run waits for the ledger's view to catch up, and every poll is shown rather
than collapsed, so the trace matches what actually crossed the wire.

Every call below names the account as a **path segment** —
`/v1/accounts/{account}/ready` — so the endpoint is the last word of the line,
not the first. The index names it up front:

| #   | Call               | Response                       |
| --- | ------------------ | ------------------------------ |
| 1   | `GET /healthz`     | 200 · ok                       |
| 2   | `GET …/ready`      | 200 · no_account               |
| 3   | `GET …/ready`      | 200 · no_trustline             |
| 4   | `GET …/ready`      | 200 · trustline_unauthorized   |
| 5   | `POST …/authorize` | 200 · txHash b8aa776c13c1…     |
| 6   | `GET …/ready`      | 200 · ready                    |
| 7   | `POST …/authorize` | 200 · alreadyAuthorized, no tx |
| 8   | `POST …/authorize` | 401 · unauthorized             |

The first call includes a cold start: the hosted instance runs with
`min_machines_running = 0` and stops when idle, so it spends a few seconds
waking up and then answers in the hundreds of milliseconds. That is the
deployment choice for a testnet reference instance, not the service's
steady-state latency.

```http
# 1 · +0.0s · GET /healthz
> GET /healthz
> host: authline-relayer.fly.dev
> authorization: (omitted)
< 200 OK   152 ms
< content-type: application/json
<
{
  "ok": true,
  "network": "TESTNET",
  "relayer": "GCB6N27Y6GTTMRBUQNYROIB5C37PWAJKLFRL7U3JXFZF7NQIJL2NS2TQ",
  "defaultAsset": "EURCV",
  "sep7Callback": "/v1/sep7/callback"
}

# 2 · +0.8s · GET …/ready
> GET /v1/accounts/GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX/ready
> host: authline-relayer.fly.dev
> authorization: (omitted)
< 200 OK   351 ms
< content-type: application/json
<
{
  "account": "GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX",
  "asset": "EURCV",
  "network": "TESTNET",
  "regulated": true,
  "ready": false,
  "reason": "no_account",
  "authorizable": true,
  "status": {
    "holderKind": "account",
    "accountExists": false,
    "hasTrustline": false,
    "isAuthorized": false,
    "sacAuthorized": false
  }
}

# 3 · +3.2s · GET …/ready
> GET /v1/accounts/GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX/ready
> host: authline-relayer.fly.dev
> authorization: (omitted)
< 200 OK   343 ms
< content-type: application/json
<
{
  "account": "GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX",
  "asset": "EURCV",
  "network": "TESTNET",
  "regulated": true,
  "ready": false,
  "reason": "no_trustline",
  "authorizable": true,
  "status": {
    "holderKind": "account",
    "accountExists": true,
    "hasTrustline": false,
    "isAuthorized": false,
    "sacAuthorized": false
  }
}

# 4 · +9.3s · GET …/ready
> GET /v1/accounts/GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX/ready
> host: authline-relayer.fly.dev
> authorization: (omitted)
< 200 OK   556 ms
< content-type: application/json
<
{
  "account": "GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX",
  "asset": "EURCV",
  "network": "TESTNET",
  "regulated": true,
  "ready": false,
  "reason": "trustline_unauthorized",
  "authorizable": true,
  "status": {
    "holderKind": "account",
    "accountExists": true,
    "hasTrustline": true,
    "isAuthorized": false,
    "sacAuthorized": false
  }
}

# 5 · +14.0s · POST …/authorize
> POST /v1/accounts/GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX/authorize
> host: authline-relayer.fly.dev
> authorization: Bearer «redacted»
< 200 OK   4680 ms
< content-type: application/json
<
{
  "account": "GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX",
  "asset": "EURCV",
  "authorized": true,
  "alreadyAuthorized": false,
  "txHash": "b8aa776c13c1f1c179b5c4a70120cf1f56098ecf200aaf9ae24abe6fba391f7b"
}

# 6 · +14.4s · GET …/ready
> GET /v1/accounts/GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX/ready
> host: authline-relayer.fly.dev
> authorization: (omitted)
< 200 OK   361 ms
< content-type: application/json
<
{
  "account": "GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX",
  "asset": "EURCV",
  "network": "TESTNET",
  "regulated": true,
  "ready": true,
  "status": {
    "holderKind": "account",
    "accountExists": true,
    "hasTrustline": true,
    "isAuthorized": true,
    "sacAuthorized": true
  }
}

# 7 · +14.7s · POST …/authorize
> POST /v1/accounts/GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX/authorize
> host: authline-relayer.fly.dev
> authorization: Bearer «redacted»
< 200 OK   324 ms
< content-type: application/json
<
{
  "account": "GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX",
  "asset": "EURCV",
  "authorized": true,
  "alreadyAuthorized": true
}

# 8 · +14.7s · POST …/authorize
> POST /v1/accounts/GACYVYJTVMYK3E4SPXKT22XGV5VFF26AGV7PLP76GMCRVXGOBZ3FPRTX/authorize
> host: authline-relayer.fly.dev
> authorization: (omitted)
< 401 Unauthorized   35 ms
< content-type: application/json
<
{
  "error": "unauthorized",
  "detail": "pass Authorization: Bearer <token>"
}
```

## The rest of D2.3

| Criterion                                            | Evidence                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests and contract tests run green in CI        | Workflow run [33401112710](https://github.com/theahaco/authline/actions/runs/33401112710) on `6833212` (2026-08-31) ran lint, prettier, the Rust contract tests and the unit suite — all green.                                                                                                                   |
| The end-to-end suite runs against real testnet       | Workflow run [32359752614](https://github.com/theahaco/authline/actions/runs/32359752614) (2026-08-20) ran the Node testnet e2e suite and the Playwright browser suite against real testnet, both green. The job is `workflow_dispatch`-gated because it spends testnet funds and serialises on shared asset ids. |
| A browser test drives the dApp the way a user would  | Seven Playwright specs in `tests/e2e/` drive a real Chromium against the built dApp (`playwright.config.ts` serves the production build at `:4173`), covering the USDC, TLO and EURCV activation flows and the claimable-balance claim.                                                                           |
| The relayer ships as a Docker image for self-hosting | `packages/relayer/Dockerfile` builds the service; `fly.toml` is the deployment used for the hosted instance proven above.                                                                                                                                                                                         |
| The relayer has a runbook                            | `docs/relayer-runbook.md` documents configuration, the two endpoints, deployment and key rotation.                                                                                                                                                                                                                |
| The MiCA design note is published                    | `docs/mica-authorization-model.md` describes what the authorization model records on-chain and why no personal data is involved anywhere — addresses and enumerated codes only, with no free-text field in the interface.                                                                                         |
| The updated SEP is in the repo                       | `sep/sep_trustlineonboarder.md` — the Trustline Onboarder draft, updated with everything this grant's implementation taught us (see its Changelog).                                                                                                                                                               |
| The SEP is posted to the public discussion thread    | Discussion thread: https://github.com/orgs/stellar/discussions/2008                                                                                                                                                                                                                                               |
