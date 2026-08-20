# Authline relayer — integration guide and runbook

A small HTTP service that answers the two questions an exchange has about a
regulated Stellar asset, so integration takes ~20 lines of any language and **no
Stellar SDK**:

1. **Is this account ready to receive the asset?** —
   `GET /v1/accounts/{account}/ready`
2. **Authorize this account.** — `POST /v1/accounts/{account}/authorize`

The service is [`packages/relayer`](../packages/relayer); it wraps the
[`@theahaco/authline`](authline-sdk.md) SDK. On-chain, authorization is the
permissionless `authorize_trustline` entry point of the asset's
[Trustline Authorizer](authorizer-runbook.md) — the relayer just signs and pays
the fee, it holds **no authority**. The issuer's policy (denylist / allowlist /
pause) is enforced by the contract, not by this service.

---

## 1. The whole integration

Before paying out a withdrawal of a regulated asset (e.g. EURCV):

```python
import requests

RELAYER = "https://relayer.example.com"          # or your self-hosted instance

def ensure_ready(account: str, asset: str = "EURCV") -> bool:
    r = requests.get(f"{RELAYER}/v1/accounts/{account}/ready",
                     params={"asset": asset}).json()
    if r["ready"]:
        return True
    if r["reason"] == "trustline_unauthorized" and r.get("authorizable"):
        auth = requests.post(f"{RELAYER}/v1/accounts/{account}/authorize",
                             params={"asset": asset})
        return auth.status_code == 200
    # no_account → fund it (or use claimable-balance delivery);
    # no_trustline → the user onboards via the router / your sponsored flow;
    # authorizable == False → the issuer's policy refuses this account.
    return False
```

That is the entire client. Everything else in this document is operating the
service itself.

## 2. API

### `GET /healthz`

```json
{ "ok": true, "network": "TESTNET", "relayer": "G...", "defaultAsset": "EURCV" }
```

### `GET /v1/accounts/{account}/ready?asset=CODE`

`account` is a classic `G...` account or a `C...` contract holder (e.g. a
passkey smart account). `asset` defaults to the instance's `DEFAULT_ASSET`.
Always `200` for a valid address:

```json
{
	"account": "G...",
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
```

- **`ready`** — a payment of this asset to this account will succeed right now.
- **`reason`** (when not ready): `no_account` · `no_trustline` ·
  `trustline_unauthorized` · `not_authorized` (contract holders).
- **`authorizable`** — whether `POST /authorize` would fix it, read live from
  the issuer's policy (`is_eligible`). Omitted when the policy could not be read
  — absence means "unknown", never "yes".

### `POST /v1/accounts/{account}/authorize?asset=CODE`

Submits `authorize_trustline(account)` signed by the relayer's account and waits
for confirmation. No request body. Idempotent — authorizing a ready account is a
cheap success:

```json
{
	"account": "G...",
	"asset": "EURCV",
	"authorized": true,
	"alreadyAuthorized": false,
	"txHash": "9f2c…"
}
```

Refusals are typed, straight from the authorizer contract:

| HTTP | `error`               | Meaning / what to do                                                         |
| ---- | --------------------- | ---------------------------------------------------------------------------- |
| 400  | `asset_not_regulated` | open asset (USDC…): holders need no authorization                            |
| 400  | `invalid_account`     | not a Stellar address                                                        |
| 401  | `unauthorized`        | instance requires `Authorization: Bearer <token>`                            |
| 403  | `account_banned`      | issuer denylist — only the issuer can `unban`                                |
| 403  | `account_not_allowed` | allowlist policy: issuer has not admitted this account (KYC pending?)        |
| 404  | `unknown_asset`       | code not pinned for this network in the SDK registry                         |
| 409  | `no_trustline`        | create the trustline first (the onboard router does both in one transaction) |
| 503  | `authorizer_paused`   | issuer emergency stop — retry later                                          |
| 502  | `chain_error`         | RPC / network trouble — safe to retry                                        |

## 3. Configuration

Environment variables, read once at boot (the process refuses to start
half-configured):

| Variable            | Required | Meaning                                                              |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `RELAYER_SECRET`    | yes      | `S...` secret of a **funded, low-privilege** operations account      |
| `STELLAR_NETWORK`   | no       | `TESTNET` (default) or `PUBLIC`                                      |
| `RPC_URL`           | no       | Stellar RPC override (defaults per network)                          |
| `RELAYER_API_TOKEN` | no       | when set, `POST /authorize` requires `Authorization: Bearer <token>` |
| `DEFAULT_ASSET`     | no       | asset code when `?asset=` is omitted (default `EURCV`)               |
| `PORT`              | no       | listen port (default `8787`)                                         |

**The key.** `authorize_trustline` is permissionless, so the relayer's account
has exactly one job: paying transaction fees. Use a dedicated operations account
holding a few XLM — **never** the authorizer admin key and never the asset
issuer key. If the key leaks, the attacker can spend your fee balance; they gain
no authority over the asset.

**The token.** Reads are free; writes cost you fees. On a public instance set
`RELAYER_API_TOKEN` so strangers cannot drain the fee balance by spamming
`/authorize`. (Each spam authorize is harmless on-chain — it is your XLM they
spend.)

## 4. Running it

### From the repo

```bash
npm install
npm run build -w @theahaco/authline-relayer
RELAYER_SECRET=S... node packages/relayer/dist/server.js
```

### Docker (self-hosting)

The image is published on every relayer change as
`ghcr.io/theahaco/authline-relayer:latest` (and a commit-pinned tag), or build
it yourself from the repo root:

```bash
docker build -f packages/relayer/Dockerfile -t authline-relayer .
docker run -p 8787:8787 \
  -e RELAYER_SECRET=S... \
  -e STELLAR_NETWORK=TESTNET \
  -e RELAYER_API_TOKEN=change-me \
  authline-relayer
```

The container is stateless — every answer comes from the ledger via RPC — so run
as many replicas as you like behind any HTTP load balancer; no shared state, no
sticky sessions. Concurrent authorizes for the same account are safe: the second
lands as `alreadyAuthorized` or as a same-ledger no-op.

### Smoke test

```bash
curl -s localhost:8787/healthz
curl -s localhost:8787/v1/accounts/GBVAULTVXWDWDPTNCFXWU5JYJ25MYAJKBM7DGSXZWLHQK6XLLAJZQBPS/ready
```

## 5. Operations

- **Fee balance.** The relayer account pays ~0.00001 XLM per authorize plus
  Soroban resource fees. Alert when its balance drops below ~5 XLM
  (`GET /healthz` names the account; watch it in Horizon/RPC).
- **Failure modes.** `503 authorizer_paused` means the issuer pulled the
  emergency brake — that is policy working, not an outage. `502 chain_error` is
  RPC trouble; the service holds no state, so restart/retry freely.
- **Logs and privacy.** The service logs nothing per-request by default and
  holds no databases. Everything it knows is already public chain state — see
  the [MiCA design note](mica-authorization-model.md).
- **Tests.** Unit tests: `npx vitest run packages/relayer` (mocked chain, run in
  CI). End-to-end against real testnet, including the full ready → authorize →
  ready flip driven over HTTP:
  `RUN_TESTNET_E2E=1 npx vitest run tests/e2e/testnet-relayer.e2e.test.ts`.
