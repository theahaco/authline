# Trustline Authorizer — issuer runbook

Everything an issuer's operations team does with a regulated Stellar asset, as
commands. The contract is
[`contracts/trustline-authorizer`](../contracts/trustline-authorizer); the CLI
is [`scripts/authorizer.mjs`](../scripts/authorizer.mjs), run as
`npm run authorizer -- …`.

---

## 1. What this thing is

A classic Stellar asset marked `AUTH_REQUIRED` is unusable until the issuer
authorizes each holder's trustline. Doing that by hand means the issuer's key
signs a `SetTrustLineFlags` for every user, forever.

Instead, the issuer hands **SAC adminship** to the Trustline Authorizer once.
From then on the contract is the only address the protocol lets flip those
flags, and it exposes that authority through one permissionless entry point —
`authorize_trustline(account)` — gated by a policy the issuer controls:

| Policy        | Meaning                                               | Fits                                 |
| ------------- | ----------------------------------------------------- | ------------------------------------ |
| **Denylist**  | everyone is allowed except accounts you ban           | frictionless stablecoins (EURCV)     |
| **Allowlist** | nobody is allowed except accounts you admit after KYC | securities, RWA, per-holder approval |

Because the check is permissionless, an exchange, a wallet, or the
[onboard router](../contracts/trustline-onboard) can authorize a user **on the
user's behalf** in the same transaction that creates their trustline. The
issuer's key never appears in the flow — it appears only here, in the commands
below.

Everything in this runbook emits an on-chain event, so the authorization history
of the asset is reconstructable from the ledger alone
(`npm run authorizer -- history`).

### Three facts that will save you an incident

1. **SAC adminship is one-way.** Once the SAC's admin is a contract, only that
   contract can pass it on. Deploy an authorizer that has `set_admin` (this one
   does) — a stub without it strands the asset permanently.
2. **`freeze` is the durable stop, `deauthorize` is not.** `deauthorize` clears
   the flag but leaves the policy alone, so under a denylist the holder
   re-authorizes themselves on the next call. Reach for `freeze`.
3. **Pause stops the admin console too.** Only `unpause`, `set-admin` and
   `upgrade` survive a pause. That is deliberate — a paused contract stays
   recoverable — but it means you cannot `ban` during an incident without
   unpausing first. Ban first, then pause.

---

## 2. Setup

```bash
# Once: build the contracts and the SDK the CLI reads its pins from.
npm install
npm run build:contracts
npm run build -w @theahaco/authline
```

The CLI signs with a key from the local `stellar` CLI keystore — the secret is
read for one transaction and never printed or stored.

```bash
stellar keys ls                      # what you already have
stellar keys generate ops --network testnet --fund
```

Every command takes:

| Flag               | Meaning                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `--asset <CODE>`   | resolve the authorizer from the pinned registry (default `EURCV`) |
| `--id <C…>`        | target an authorizer contract directly (overrides `--asset`)      |
| `--source <alias>` | keystore key that signs writes (default `me`)                     |
| `--network`        | `testnet` (default) or `public`                                   |
| `--dry-run`        | simulate and report, submit nothing                               |
| `--json`           | machine-readable output                                           |

`npm run authorizer -- --help` prints the full command list.

---

## 3. Standing up a new regulated asset

```bash
SOURCE=my-issuer ASSET_CODE=EURCV POLICY=Denylist CLAWBACK=1 \
  ./scripts/issue-test-asset.sh
```

That one script sets the issuer flags (`AUTH_REQUIRED`, `AUTH_REVOCABLE`, and
`AUTH_CLAWBACK_ENABLED` when `CLAWBACK=1`), deploys the SAC, deploys the
authorizer with your key as its admin, and transfers SAC adminship to it. It
prints the ids to pin.

Confirm the handover landed before you rely on it:

```bash
npm run authorizer -- status --id C… --source my-issuer
```

`Admin` must be your key and `SAC` must be your asset's contract. Then pin the
asset in
[`packages/authline-sdk/src/registry.ts`](../packages/authline-sdk/src/registry.ts)
so `--asset <CODE>` resolves it and the dApp can offer it.

> The script refuses to run against mainnet. A production deployment is the same
> three steps done deliberately, with the issuer key in whatever custody your
> organisation uses.

---

## 4. Day-to-day

### Look something up

```bash
npm run authorizer -- status                      # policy, admin, pause state
npm run authorizer -- check GABC…                 # one holder, every angle
npm run authorizer -- history --limit 100         # the audit trail
```

`check` answers the question support actually gets — _why can't this user
receive the asset?_ — in one read: denylist membership, allowlist membership,
the live authorized bit from the SAC, and whether `authorize_trustline` would be
permitted right now.

### Let someone in

Under a **denylist** you do nothing: any account that is not banned authorizes
itself through the router or through an exchange's onboarding.

Under an **allowlist**, admit them after KYC:

```bash
npm run authorizer -- allow GABC… GDEF…           # up to 50 per call
```

To authorize a holder directly — they already have a trustline and you want to
flip it now, without waiting for them to run anything:

```bash
npm run authorizer -- authorize GABC…
```

This one is permissionless: **any** funded account can submit it, not just the
admin. That is the whole point — it is what lets an exchange complete a
withdrawal without your key.

### Stop someone

| Situation                                                     | Command                                  |
| ------------------------------------------------------------- | ---------------------------------------- |
| Sanctioned address, no trustline yet — block it pre-emptively | `ban GABC…`                              |
| Existing holder must be stopped now                           | `freeze GABC…`                           |
| Allowlist: withdraw admission, leave current holdings alone   | `disallow GABC…`                         |
| Temporary hold you intend to lift within the hour             | `deauthorize GABC… --reason kyc_expired` |

`freeze` does both halves — it bans (or disallows) **and** deauthorizes — so the
holder cannot re-authorize by retrying, and cannot get back in by deleting and
recreating the trustline: the ban is stored against their **address**, not
against the trustline, and outlives it. Proven on-chain in §6.

Reversing:

```bash
npm run authorizer -- unfreeze GABC…    # un-ban AND re-authorize
npm run authorizer -- unban GABC…       # eligible again, but not re-authorized
```

If `freeze` reports `deauthorized=false` in the event, the SAC half did not run
— either the holder has no trustline (the ban still landed, which is fine) or
the issuer is missing `AUTH_REVOCABLE`.

### Supply

```bash
npm run authorizer -- mint GABC… 250.5
npm run authorizer -- clawback GABC… 40
```

Mint requires the recipient's trustline to exist and be authorized — onboard
first, mint second. Clawback requires `AUTH_CLAWBACK_ENABLED` on the issuer;
without it you get `AssetRefused`.

Amounts are decimal units (7 decimal places, like the classic asset). Pass
`--stroops` to give raw stroops instead.

---

## 5. Incidents and changes

### Emergency stop

```bash
npm run authorizer -- pause
```

Every authorization, freeze, list edit, mint and clawback is refused while
paused — including through the router, so onboarding stops network-wide for this
asset. Recovery paths stay open on purpose: `unpause`, `set-admin`, `upgrade`.

```bash
npm run authorizer -- unpause
```

### Switching policy

```bash
npm run authorizer -- policy allowlist
```

The two sets are stored independently, so switching to allowlist does not
reinterpret your bans as admissions, and switching back restores them intact.
Note what this means operationally: **switching to allowlist locks everyone out
immediately** — existing authorized holders keep their flag, but no new
authorization succeeds until you `allow` them.

### Handing over the admin key

```bash
npm run authorizer -- set-admin GNEW…
```

Irreversible from your side once submitted — the new admin is the only one who
can hand it back.

### Upgrading the contract

```bash
stellar contract upload --wasm target/wasm32v1-none/release/trustline_authorizer.wasm \
  --source my-issuer --network testnet          # prints the wasm hash
npm run authorizer -- upgrade <64-hex hash>
```

Or let the CLI compute the hash from the file (it still has to be uploaded
first):
`npm run authorizer -- upgrade --wasm target/…/trustline_authorizer.wasm`.

Storage layout is preserved across upgrades — bans, allowlist entries, admin,
policy and pause state all survive. Verify with `status` and a `check` on a
known-banned address immediately after.

### Reading the audit trail

```bash
npm run authorizer -- history --limit 200 --json > audit.json
```

Every state transition emits one event carrying the account, the policy in
force, the admin that authorized the change, and the ledger:

| Event                        | Emitted on                                                      |
| ---------------------------- | --------------------------------------------------------------- |
| `authorized`                 | successful `authorize_trustline`                                |
| `deauthorized`               | `deauthorize_trustline` (carries `reason`)                      |
| `banned` / `unbanned`        | denylist edits                                                  |
| `allowed` / `disallowed`     | allowlist edits                                                 |
| `frozen` / `unfrozen`        | freeze lifecycle (`deauthorized` says whether the SAC half ran) |
| `minted` / `clawback`        | supply changes                                                  |
| `paused` / `unpaused`        | emergency stop                                                  |
| `policy_set`                 | policy switch                                                   |
| `admin_changed` / `upgraded` | governance                                                      |

RPC keeps a rolling window of events. For a permanent record, export
periodically, or index the contract from a history archive.

---

## 6. Errors you will actually see

| Error               | What to do                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AccountBanned`     | the denylist is doing its job — `unban`, or `unfreeze` if they were frozen                                                           |
| `AccountNotAllowed` | allowlist policy: `allow` them after KYC                                                                                             |
| `NoTrustline`       | they have no trustline yet — onboarding creates one; a bare `authorize` cannot                                                       |
| `ContractPaused`    | `unpause` first                                                                                                                      |
| `AssetRefused`      | issuer flags or holder state: clawback needs `AUTH_CLAWBACK_ENABLED`, freeze needs `AUTH_REVOCABLE`, mint needs an authorized holder |
| `InvalidBatch`      | 1–50 addresses per call                                                                                                              |
| `PauseUnchanged`    | already in that state                                                                                                                |

Every one of these is a **typed** contract error. That matters beyond
readability: the onboard router treats an untyped panic as "this asset has no
authorizer" and quietly leaves the user with an unauthorized trustline, whereas
a typed error is a refusal that rolls the whole onboarding back.

---

## 7. Reference deployment (testnet)

The pinned testnet EURCV test token, replacing the Tranche-1 `authorizer-stub`:

| Piece      | Id                                                                      |
| ---------- | ----------------------------------------------------------------------- |
| Authorizer | `CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM`              |
| SAC        | `CCST65QNIHUJ3V2JK5SDTXUXYSGQZI6MSSXDMNRA55ECJEWU4UFDLQHR`              |
| Issuer     | `GC66PIMV4S2WEQYG3UFOGG7Z4OIAQAKJLEKX6C5ZQ6AZT4FUXUPOGIKL`              |
| Policy     | Denylist · `AUTH_REQUIRED` + `AUTH_REVOCABLE` + `AUTH_CLAWBACK_ENABLED` |
| Wasm hash  | `d0e37e28897868a0ed1d4aea5cfe8bd7849828467d2ba4bf5044fc170e0f7f29`      |

The Tranche-1 stub (`CCRKMAOBTP43QRFZR6A62OPNJNQFNHFEY6APAAI2ABHTFOQ4HTDL3D4X`)
had no `set_admin`, so its asset could not be upgraded in place — see fact 1.
The test asset was re-issued instead, and the registry pin moved.

### The freeze invariant, on-chain

The sequence that matters, run against this deployment on 2026-08-20:

| Step                                                        | Transaction                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holder onboards through the router — one signature          | [`26508a57…1e32`](https://stellar.expert/explorer/testnet/tx/26508a57895a9e2879412e0849e0b0dd4d7dc185896ea572e1af120040441e32) → `Authorized`                                                                                                                                 |
| Issuer mints 100, claws back 40                             | [`de1bfee1…7919`](https://stellar.expert/explorer/testnet/tx/de1bfee172542dddda20bb2ff1b9009fd7bf3b6a419ac87ddd69d8aee9937919) · [`83c6291d…0293`](https://stellar.expert/explorer/testnet/tx/83c6291d36889b0d3ca5220359084718910e03576d15654754f9736bee860293)               |
| Issuer freezes the holder — ban + deauthorize               | [`ae94a3af…5245`](https://stellar.expert/explorer/testnet/tx/ae94a3afc8fd65e744ac3e9837f1e40a6ac96ce0fcf1589bfa771fc8da2e5245)                                                                                                                                                |
| Holder **deletes** the trustline (`ChangeTrust` limit 0)    | [`b33187c4…f073`](https://stellar.expert/explorer/testnet/tx/b33187c4c86c9e9d4098b4ea645665290149ee2fa36bb4cba6d04297a422f073)                                                                                                                                                |
| Holder replays the one-signature onboard on a clean slate   | **refused** — `Error(Contract, #3)` (`AuthorizationRefused`), no trustline created                                                                                                                                                                                            |
| Issuer unfreezes; the holder onboards again                 | [`8a4ad600…fcc7`](https://stellar.expert/explorer/testnet/tx/8a4ad60045a1749bb2490924052baf0dd511916e70539e8caa1bb59ce92fccc7) · [`e336c3c4…3c2`](https://stellar.expert/explorer/testnet/tx/e336c3c41a9718be5956a03bef264b8d22d6e56dc95bf629bd56e3e3d45a23c2) → `Authorized` |
| Pause refuses everything, including `ban`; unpause restores | [`5e207c88…efa5`](https://stellar.expert/explorer/testnet/tx/5e207c88a29356e6e69c1a402512fa987937da06d01a3e1d9a35e5856204efa5) · [`5b6caa47…1cd98`](https://stellar.expert/explorer/testnet/tx/5b6caa47a63d7f14e5f13a9df5d95cfc6516134fc9d47e85c53ed6849b21cd98)              |

The fourth and fifth rows are the point: a frozen holder who destroys and
recreates their trustline is still refused, because the ban is bound to the
address.

Reproduce the router and authorize-on-behalf paths with
`RUN_TESTNET_E2E=1 npx vitest run tests/e2e/testnet-eurcv.e2e.test.ts`.
