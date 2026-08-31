# Trustline Authorizer — testnet proof run

Every transaction below is a real entry on the Stellar **testnet** public
ledger. Follow any link to verify it independently — nothing here relies on
trusting this document.

- **Run at:** 2026-08-31T13:11:10.829Z
- **Network:** Stellar testnet (`Test SDF Network ; September 2015`)
- **Commit:** `28cc2bf` · SDK `@theahaco/authline` v0.5.0
- **Authorizer wasm:**
  `d0e37e28897868a0ed1d4aea5cfe8bd7849828467d2ba4bf5044fc170e0f7f29` (sha256 of
  `target/wasm32v1-none/release/trustline_authorizer.wasm`)
- **Asset issued by this run:**
  `PROOF:GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU`
- **SAC:**
  [`CD4CUKHVUG336L5QJK6XEV3IRGXWAB5K3S55FIGIKUXDIMUO7O75DPF2`](https://stellar.expert/explorer/testnet/contract/CD4CUKHVUG336L5QJK6XEV3IRGXWAB5K3S55FIGIKUXDIMUO7O75DPF2)
- **Authorizer deployed by this run:**
  [`CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH`](https://stellar.expert/explorer/testnet/contract/CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH)
- **Onboard router:**
  [`CABVVUYHXS6UVN2VYYXKEUO2XEJIAGMTEYF2BOWGUUJVOO2IGPRWZAX4`](https://stellar.expert/explorer/testnet/contract/CABVVUYHXS6UVN2VYYXKEUO2XEJIAGMTEYF2BOWGUUJVOO2IGPRWZAX4)

Reproduce with:

```
npm ci
npm run build -w @theahaco/authline
cargo build --release --target wasm32v1-none -p trustline-authorizer
node scripts/prove-authorizer.mjs
```

The run stands up its own issuer, its own SAC and its own authorizer instance
from friendbot-funded keys, so it owns all of its own state, needs no secrets,
and never mutates the shared pinned testnet asset. Phase 11 verifies that live
deployment read-only.

> **How to read a row.** Every claim below is either a link to a real
> transaction on the public ledger, or — where the thing being proven is a
> REFUSAL — one sentence saying what was done, because a refused call never
> becomes a transaction and so has no hash. Two refusals do have hashes: where
> the script could build an envelope while the holder was still eligible, it
> submitted that envelope after the freeze/pause and the transaction **failed on
> the ledger**, which is a refusal you can click on.

## Summary

| Phase | What it proves                                                                                                                            | Evidence                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Issuer set AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED on PROOF                                                                | [`f8f78344a269…`](https://stellar.expert/explorer/testnet/tx/f8f78344a269284f410c292854e09c70f26576bb08f15a5665445982aeaf644b)                         |
| 0     | Stellar Asset Contract deployed for PROOF                                                                                                 | [`24a41cd99ee3…`](https://stellar.expert/explorer/testnet/tx/24a41cd99ee313b5190e14a7581a402c2dfd1769393177b2429585ab534d8831)                         |
| 0     | Trustline Authorizer wasm uploaded                                                                                                        | [`40517398faf3…`](https://stellar.expert/explorer/testnet/tx/40517398faf32220019f41b179546c6b7adeb2f3e16a315e8c92ff82dd6313f0)                         |
| 0     | Trustline Authorizer instance deployed with policy = Denylist                                                                             | [`ce31f1b45690…`](https://stellar.expert/explorer/testnet/tx/ce31f1b45690d96c025955003575e226952e106b06d1b14d49fe86b787061cf7)                         |
| 0     | SAC adminship handed to the authorizer — it is now the only address that can flip AUTHORIZED                                              | [`846c9318c039…`](https://stellar.expert/explorer/testnet/tx/846c9318c0396a230cb79dbad650420d1587661de28fb982f0c4f43a4263519a)                         |
| 1     | Router creates AND authorizes an unbanned holder's trustline in one transaction, one signature                                            | [`160955943117…`](https://stellar.expert/explorer/testnet/tx/160955943117ba2f01ad7629b3404bc0e6577f11192ee78729c562a76996501a)                         |
| 2     | An unauthorized trustline is authorized ON THE HOLDER'S BEHALF, submitted by an account with no issuer authority — ZERO holder signatures | [`e58b6e82f84d…`](https://stellar.expert/explorer/testnet/tx/e58b6e82f84d30bb60bd201aa8c574980d1e3583a0c5289744b3348440015ca8)                         |
| 3     | An address is banned BEFORE it has an account or a trustline — the ban does not need the holder to exist                                  | [`d9db4ca97d48…`](https://stellar.expert/explorer/testnet/tx/d9db4ca97d4828bc09f0305b103030e931cc7b2b349e96b0b6edc79d5d50a66a)                         |
| 3     | Router onboard for a banned holder                                                                                                        | Simulated `onboard` against the live contract; it was refused with AuthorizationRefused (#3), and a refused call never becomes a transaction.          |
| 3     | Authorize a banned holder                                                                                                                 | Simulated `authorize_trustline` against the live contract; it was refused with AccountBanned (#1), and a refused call never becomes a transaction.     |
| 3     | The banned address creates a trustline anyway — and authorization is still refused with a typed AccountBanned error                       | [`9ec8c42f707d…`](https://stellar.expert/explorer/testnet/tx/9ec8c42f707d596e775e553a9a96a9fabeeaf1795951cd9cc45b0fb0c1bbe55f)                         |
| 4     | Freeze is ban + deauthorize, never one without the other — the trustline is deauthorized AND the address is banned                        | [`50040973a013…`](https://stellar.expert/explorer/testnet/tx/50040973a0139f163844bb824691d3c7715096cac8614f53a1c44b12a4dfc9bd)                         |
| 4     | Re-authorize a frozen holder                                                                                                              | Simulated `authorize_trustline` against the live contract; it was refused with AccountBanned (#1), and a refused call never becomes a transaction.     |
| 4     | ★ A FROZEN ACCOUNT CANNOT GET RE-AUTHORIZED                                                                                               | [`9411cf06328e…`](https://stellar.expert/explorer/testnet/tx/9411cf06328ea055dc94a49f3af47feece87bd56dae1e3db3a66f82444b77fde)                         |
| 4     | Authorize the recreated trustline                                                                                                         | Simulated `authorize_trustline` against the live contract; it was refused with AccountBanned (#1), and a refused call never becomes a transaction.     |
| 4     | Router onboard on the recreated trustline                                                                                                 | Simulated `onboard` against the live contract; it was refused with AuthorizationRefused (#3), and a refused call never becomes a transaction.          |
| 4     | ★ The frozen holder deletes and recreates their trustline to shake off the freeze — and is refused again                                  | [`f37b469aec66…`](https://stellar.expert/explorer/testnet/tx/f37b469aec66a4b9a8b6f858a094dd9da5208fd0ef3ff6d573cf6ab1497df80f)                         |
| 4     | Unfreeze reverses BOTH halves in one call — unbanned and re-authorized                                                                    | [`0ba660894d91…`](https://stellar.expert/explorer/testnet/tx/0ba660894d913f25e52788d05ab8b837e6c7da8b67faaa8547c01cc8ac0853e2)                         |
| 5     | Emergency stop engaged — the contract is paused                                                                                           | [`57312b6727af…`](https://stellar.expert/explorer/testnet/tx/57312b6727af3619e97376d1961904d3b375724474fd922a12484d4b5e472c17)                         |
| 5     | Authorize while paused                                                                                                                    | Simulated `authorize_trustline` against the live contract; it was refused with ContractPaused (#4), and a refused call never becomes a transaction.    |
| 5     | Ban while paused                                                                                                                          | Simulated `add_banned_accounts` against the live contract; it was refused with ContractPaused (#4), and a refused call never becomes a transaction.    |
| 5     | Freeze while paused                                                                                                                       | Simulated `freeze_accounts` against the live contract; it was refused with ContractPaused (#4), and a refused call never becomes a transaction.        |
| 5     | Allow while paused                                                                                                                        | Simulated `allow` against the live contract; it was refused with ContractPaused (#4), and a refused call never becomes a transaction.                  |
| 5     | Mint while paused                                                                                                                         | Simulated `mint_to_account` against the live contract; it was refused with ContractPaused (#4), and a refused call never becomes a transaction.        |
| 5     | Clawback while paused                                                                                                                     | Simulated `clawback` against the live contract; it was refused with ContractPaused (#4), and a refused call never becomes a transaction.               |
| 5     | Policy change while paused                                                                                                                | Simulated `set_policy` against the live contract; it was refused with ContractPaused (#4), and a refused call never becomes a transaction.             |
| 5     | Router onboard while paused                                                                                                               | Simulated `onboard` against the live contract; it was refused with AuthorizationRefused (#3), and a refused call never becomes a transaction.          |
| 5     | ★ PAUSED REJECTS EVERYTHING — authorization, bans, freezes, supply and policy edits alike                                                 | [`0d2066864381…`](https://stellar.expert/explorer/testnet/tx/0d206686438169e47fa42c02057edf5481f87cfb4861f0480097fcd20aac13a3)                         |
| 5     | Unpause restores service — the very operation that just failed now succeeds                                                               | [`87f245656306…`](https://stellar.expert/explorer/testnet/tx/87f245656306fe3c3508f3dd8a7cfb164e60aa67892f8535557cb09583be5198)                         |
| 6     | Authorize an un-allowed holder under Allowlist                                                                                            | Simulated `authorize_trustline` against the live contract; it was refused with AccountNotAllowed (#2), and a refused call never becomes a transaction. |
| 6     | Policy switched to Allowlist — an address that was fine a moment ago is now refused because it was never allowed                          | [`50606ada9868…`](https://stellar.expert/explorer/testnet/tx/50606ada9868a4065d06746d52352cbe4d7de71ada34c71b38038e6d77c8d9e0)                         |
| 6     | The issuer allows the address after KYC, and it authorizes immediately                                                                    | [`cf7ef4578c3f…`](https://stellar.expert/explorer/testnet/tx/cf7ef4578c3f034f9a7cdc97d8898304c33eee5d618e2e0b451d774eda16e23a)                         |
| 6     | The denylist and allowlist are stored independently — switching policy does not silently reinterpret one list as the other                | [`00ce407494bd…`](https://stellar.expert/explorer/testnet/tx/00ce407494bd7b457516ebfb8d2c327b1278a5a6694b871849570f65048a4ef2)                         |
| 7     | Issuer mints 250 PROOF to an authorized holder through the authorizer                                                                     | [`fd43465f037c…`](https://stellar.expert/explorer/testnet/tx/fd43465f037c86824dac4b7a00f7a716b216c701b3f0916bdc045ff1c965dbd9)                         |
| 7     | Issuer claws back 100 PROOF from that holder                                                                                              | [`45186cc1c3f1…`](https://stellar.expert/explorer/testnet/tx/45186cc1c3f1b232404b86b23b70ead70366b63370bd338e1da35cc27b8beadb)                         |
| 8     | Admin-gated in-place upgrade executes, and admin / SAC / policy / the ban set all survive the swap                                        | [`6a4227634057…`](https://stellar.expert/explorer/testnet/tx/6a422763405775a2f765021089dab46b2510587cafa9db3bf362c0121d734ae6)                         |
| 9     | The OLD admin can no longer ban after the handover                                                                                        | Built an `add_banned_accounts` call signed by the previous admin; it failed authorization at simulation and so never became a transaction.             |
| 9     | Adminship moves to a new key: the old admin can no longer act, and the new admin can                                                      | [`b9631237b07e…`](https://stellar.expert/explorer/testnet/tx/b9631237b07edb387e138bb4af4651d898b46e9f343f72a27008808afae1d9ae)                         |
| 9     | …and back again, so the handover is demonstrably not a one-way door                                                                       | [`df03f01a3c62…`](https://stellar.expert/explorer/testnet/tx/df03f01a3c6287b757600bcf1b175f0c978e245129508120f20b57feac83cfdc)                         |

## Phase 0 — standing up a regulated asset with the authorizer as SAC admin

### Issuer set AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED on PROOF

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/f8f78344a269284f410c292854e09c70f26576bb08f15a5665445982aeaf644b

Asset PROOF:GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU. Horizon
now reports auth_required, auth_revocable and auth_clawback_enabled — the flags
a regulated asset needs for authorization, freeze and clawback respectively.

### Stellar Asset Contract deployed for PROOF

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/24a41cd99ee313b5190e14a7581a402c2dfd1769393177b2429585ab534d8831
- **Contract:**
  https://stellar.expert/explorer/testnet/contract/CD4CUKHVUG336L5QJK6XEV3IRGXWAB5K3S55FIGIKUXDIMUO7O75DPF2

SAC `CD4CUKHVUG336L5QJK6XEV3IRGXWAB5K3S55FIGIKUXDIMUO7O75DPF2` — the
deterministic Asset.contractId(TESTNET) for this asset, now live on the ledger.

### Trustline Authorizer wasm uploaded

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/40517398faf32220019f41b179546c6b7adeb2f3e16a315e8c92ff82dd6313f0

sha256 `d0e37e28897868a0ed1d4aea5cfe8bd7849828467d2ba4bf5044fc170e0f7f29` —
built from contracts/trustline-authorizer with
`cargo build --release --target wasm32v1-none`. Anyone can rebuild that source
and compare this hash.

### Trustline Authorizer instance deployed with policy = Denylist

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/ce31f1b45690d96c025955003575e226952e106b06d1b14d49fe86b787061cf7
- **Contract:**
  https://stellar.expert/explorer/testnet/contract/CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH

Authorizer `CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH`,
constructed with admin GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU
and sac CD4CUKHVUG336L5QJK6XEV3IRGXWAB5K3S55FIGIKUXDIMUO7O75DPF2. The wasm
hard-codes no asset — the SAC is a constructor argument, so one wasm serves
every issuer.

### SAC adminship handed to the authorizer — it is now the only address that can flip AUTHORIZED

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/846c9318c0396a230cb79dbad650420d1587661de28fb982f0c4f43a4263519a

`SAC.admin()` now returns
`CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH`. This is one-way:
from here only the contract can hand adminship on, which is exactly why
replacing the Tranche-1 stub required re-issuing the test asset rather than
re-pointing the old one.

## Phase 1 — denylist: anyone not banned authorizes (through the router)

### Router creates AND authorizes an unbanned holder's trustline in one transaction, one signature

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/160955943117ba2f01ad7629b3404bc0e6577f11192ee78729c562a76996501a

One call to router `CABVVUYHXS6UVN2VYYXKEUO2XEJIAGMTEYF2BOWGUUJVOO2IGPRWZAX4`
`onboard(sac, holder)`. The router probed `SAC.admin()` on-chain, found this
authorizer, and called its permissionless `authorize_trustline`. Holder
GBMCUGU7ZEIZYLZHJCSOGXOLIQKNMHRIQRJRIZ62ZQY3B55PZ4HOR7K2 went from no trustline
to hasTrustline=true, isAuthorized=true.

## Phase 2 — authorize-on-behalf: the holder signs zero times

### An unauthorized trustline is authorized ON THE HOLDER'S BEHALF, submitted by an account with no issuer authority — ZERO holder signatures

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/e58b6e82f84d30bb60bd201aa8c574980d1e3583a0c5289744b3348440015ca8

Sourced and signed only by
GCCAXX6KAPKHAKRR23GMWND3TYUR2IE27GM2AAVYX4VI7XC6JWFAS4Z5, which holds no issuer
authority and is not the admin. Holder
GA3U5EIDBDGHFOGEL3QKNYP52KUMIOCEZIUPFLWCSQEKK3SRROVLGY5P never signed. The
authority is the contract's SAC adminship, exposed permissionlessly through
`authorize_trustline` and gated by policy.

## Phase 3 — banning an address before it ever creates a trustline

### An address is banned BEFORE it has an account or a trustline — the ban does not need the holder to exist

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/d9db4ca97d4828bc09f0305b103030e931cc7b2b349e96b0b6edc79d5d50a66a

GBQZRSPNLSM5B2SGXRA6AGDLXDFXZEPZNIOTL6YJ4B6DRJFXXIYQNTKU had no account entry on
the ledger when this transaction ran. `is_banned` now returns true. Bans are
keyed by address, not by trustline, so a sanctioned address can be blocked
pre-emptively.

### Router onboard for a banned holder

- **No transaction:** Simulated `onboard` against the live contract; it was
  refused with AuthorizationRefused (#3), and a refused call never becomes a
  transaction.
- **Typed contract error:** `AuthorizationRefused`

### Authorize a banned holder

- **No transaction:** Simulated `authorize_trustline` against the live contract;
  it was refused with AccountBanned (#1), and a refused call never becomes a
  transaction.
- **Typed contract error:** `AccountBanned`

### The banned address creates a trustline anyway — and authorization is still refused with a typed AccountBanned error

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/9ec8c42f707d596e775e553a9a96a9fabeeaf1795951cd9cc45b0fb0c1bbe55f
- **Typed contract error:** `AccountBanned`

The linked transaction is the holder's own CHANGE_TRUST, which succeeds — anyone
may open a trustline. What they cannot get is authorization: both the router's
`onboard` and a direct `authorize_trustline` are refused with AccountBanned
(#1), and the trustline stays isAuthorized=false. The refusal is a _typed_
contract error, not a panic — the router reads an untyped abort as "no
authorizer interface", so panicking here would silently downgrade a ban into an
unauthorized trustline.

## Phase 4 — ★ freeze: a frozen account cannot get re-authorized

### Freeze is ban + deauthorize, never one without the other — the trustline is deauthorized AND the address is banned

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/50040973a0139f163844bb824691d3c7715096cac8614f53a1c44b12a4dfc9bd

After this single call, holder
GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG reads
isAuthorized=false AND is_banned=true. Deauthorizing without banning would be
useless: the next permissionless `authorize_trustline` would simply re-authorize
them.

### Re-authorize a frozen holder

- **No transaction:** Simulated `authorize_trustline` against the live contract;
  it was refused with AccountBanned (#1), and a refused call never becomes a
  transaction.
- **Typed contract error:** `AccountBanned`

### ★ A FROZEN ACCOUNT CANNOT GET RE-AUTHORIZED

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/9411cf06328ea055dc94a49f3af47feece87bd56dae1e3db3a66f82444b77fde
- **Typed contract error:** `AccountBanned`

The linked transaction is an `authorize_trustline` envelope that was built and
signed BEFORE the freeze, when it was perfectly valid. Submitted after the
freeze, it FAILED on-chain: the policy is re-evaluated on every call, with no
"already authorized" fast path and no cached decision. A fresh attempt is
refused the same way, with AccountBanned (#1).

### Authorize the recreated trustline

- **No transaction:** Simulated `authorize_trustline` against the live contract;
  it was refused with AccountBanned (#1), and a refused call never becomes a
  transaction.
- **Typed contract error:** `AccountBanned`

### Router onboard on the recreated trustline

- **No transaction:** Simulated `onboard` against the live contract; it was
  refused with AuthorizationRefused (#3), and a refused call never becomes a
  transaction.
- **Typed contract error:** `AuthorizationRefused`

### ★ The frozen holder deletes and recreates their trustline to shake off the freeze — and is refused again

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/f37b469aec66a4b9a8b6f858a094dd9da5208fd0ef3ff6d573cf6ab1497df80f
- **Typed contract error:** `AccountBanned`

The linked transaction is the holder recreating a brand-new, unauthorized
trustline after deleting the deauthorized one — the obvious way to try to escape
a freeze. It does not work: the ban is keyed by ADDRESS, so it outlives the
trustline. Both `authorize_trustline` and the router's `onboard` are refused
with AccountBanned (#1) on the new line.

### Unfreeze reverses BOTH halves in one call — unbanned and re-authorized

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/0ba660894d913f25e52788d05ab8b837e6c7da8b67faaa8547c01cc8ac0853e2

One transaction lifted the ban and re-authorized the trustline that existed at
the time. Recovery is symmetric with the freeze, so an incident is reversible
without a second tool.

## Phase 5 — ★ paused rejects everything

### Emergency stop engaged — the contract is paused

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/57312b6727af3619e97376d1961904d3b375724474fd922a12484d4b5e472c17

`is_paused()` now returns true across the whole contract.

### Authorize while paused

- **No transaction:** Simulated `authorize_trustline` against the live contract;
  it was refused with ContractPaused (#4), and a refused call never becomes a
  transaction.
- **Typed contract error:** `ContractPaused`

### Ban while paused

- **No transaction:** Simulated `add_banned_accounts` against the live contract;
  it was refused with ContractPaused (#4), and a refused call never becomes a
  transaction.
- **Typed contract error:** `ContractPaused`

### Freeze while paused

- **No transaction:** Simulated `freeze_accounts` against the live contract; it
  was refused with ContractPaused (#4), and a refused call never becomes a
  transaction.
- **Typed contract error:** `ContractPaused`

### Allow while paused

- **No transaction:** Simulated `allow` against the live contract; it was
  refused with ContractPaused (#4), and a refused call never becomes a
  transaction.
- **Typed contract error:** `ContractPaused`

### Mint while paused

- **No transaction:** Simulated `mint_to_account` against the live contract; it
  was refused with ContractPaused (#4), and a refused call never becomes a
  transaction.
- **Typed contract error:** `ContractPaused`

### Clawback while paused

- **No transaction:** Simulated `clawback` against the live contract; it was
  refused with ContractPaused (#4), and a refused call never becomes a
  transaction.
- **Typed contract error:** `ContractPaused`

### Policy change while paused

- **No transaction:** Simulated `set_policy` against the live contract; it was
  refused with ContractPaused (#4), and a refused call never becomes a
  transaction.
- **Typed contract error:** `ContractPaused`

### Router onboard while paused

- **No transaction:** Simulated `onboard` against the live contract; it was
  refused with AuthorizationRefused (#3), and a refused call never becomes a
  transaction.
- **Typed contract error:** `AuthorizationRefused`

### ★ PAUSED REJECTS EVERYTHING — authorization, bans, freezes, supply and policy edits alike

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/0d206686438169e47fa42c02057edf5481f87cfb4861f0480097fcd20aac13a3
- **Typed contract error:** `ContractPaused`

The linked transaction is an `authorize_trustline` envelope built and signed
while the contract was running; submitted after the pause it FAILED on-chain.
Every other entry point is refused with ContractPaused (#4) too:
`authorize_trustline`, `add_banned_accounts`, `freeze_accounts`, `allow`,
`mint_to_account`, `clawback`, `set_policy`, and the router's `onboard` — which
is refused because the authorizer it discovers refuses. Only `unpause`,
`set_admin`, `upgrade` and the read-only getters stay live, so a paused contract
can still be recovered or fixed.

### Unpause restores service — the very operation that just failed now succeeds

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/87f245656306fe3c3508f3dd8a7cfb164e60aa67892f8535557cb09583be5198

Unpaused, then the same `authorize_trustline(GAITUUDI…)` succeeded —
https://stellar.expert/explorer/testnet/tx/28c5154f0b88ed5426b9e389e06f7f390097a8f869a75a6df720b524cec99422
— and the trustline is authorized. The pause is a stop, not a one-way door.

## Phase 6 — allowlist policy, and independent policy sets

### Authorize an un-allowed holder under Allowlist

- **No transaction:** Simulated `authorize_trustline` against the live contract;
  it was refused with AccountNotAllowed (#2), and a refused call never becomes a
  transaction.
- **Typed contract error:** `AccountNotAllowed`

### Policy switched to Allowlist — an address that was fine a moment ago is now refused because it was never allowed

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/50606ada9868a4065d06746d52352cbe4d7de71ada34c71b38038e6d77c8d9e0
- **Typed contract error:** `AccountNotAllowed`

Under Denylist this holder would have authorized freely. Under Allowlist the
same call is refused with AccountNotAllowed (#2) — a different typed error from
a ban, so an operator can tell "never KYC'd" apart from "sanctioned".

### The issuer allows the address after KYC, and it authorizes immediately

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/cf7ef4578c3f034f9a7cdc97d8898304c33eee5d618e2e0b451d774eda16e23a

`allow` put GBIGURLZXMAVTATRJK3G5QLWVGEZZ65ZH5LI5HGRHR5VG5UOG3BPMGIY on the
allowlist; the subsequent `authorize_trustline` —
https://stellar.expert/explorer/testnet/tx/51342abc68313426baf33d694a8b360fd53bd9eeac5391e1fad443ea6e3e619e
— succeeded and the trustline is authorized.

### The denylist and allowlist are stored independently — switching policy does not silently reinterpret one list as the other

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/00ce407494bd7b457516ebfb8d2c327b1278a5a6694b871849570f65048a4ef2

Back on Denylist, the Phase 3 ban on
GBQZRSPNLSM5B2SGXRA6AGDLXDFXZEPZNIOTL6YJ4B6DRJFXXIYQNTKU is still in force
(is_banned=true) and the allowlist entry for
GBIGURLZXMAVTATRJK3G5QLWVGEZZ65ZH5LI5HGRHR5VG5UOG3BPMGIY is still recorded
(is_allowed=true) rather than having become a ban. An issuer can move between
regimes without their compliance state changing meaning underneath them.

(Unrelated: GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG from Phase
4 remains unfrozen and authorized.)

## Phase 7 — mint and clawback

### Issuer mints 250 PROOF to an authorized holder through the authorizer

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/fd43465f037c86824dac4b7a00f7a716b216c701b3f0916bdc045ff1c965dbd9

Balance went from 0 to 250.0000000. The mint runs through the authorizer's
`mint_to_account`, which is admin-gated and policy-aware — it is the SAC admin,
so the issuer key never touches the SAC directly.

### Issuer claws back 100 PROOF from that holder

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/45186cc1c3f1b232404b86b23b70ead70366b63370bd338e1da35cc27b8beadb

Balance went from 250.0000000 to 150.0000000 without the holder's signature.
This requires the issuer's AUTH_CLAWBACK_ENABLED flag, set in Phase 0; without
it the contract refuses with a typed AssetRefused (#10) rather than a panic.

## Phase 8 — upgrade in place

### Admin-gated in-place upgrade executes, and admin / SAC / policy / the ban set all survive the swap

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/6a422763405775a2f765021089dab46b2510587cafa9db3bf362c0121d734ae6

`upgrade(d0e37e28897868a0…)` ran under the admin's signature and swapped the
contract's executable, keeping the same contract id
`CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH`. Read back
afterwards: admin=GD4M65HH…, sac=CD4CUKHV…, policy=Denylist, and the Phase 3 ban
is still in force. This run upgrades to the SAME wasm hash — there is no second
build to point at — so what it proves is that the upgrade path executes under
admin auth and that instance state is not reset by it, not that a different
binary was installed.

## Phase 9 — admin handover

### The OLD admin can no longer ban after the handover

- **No transaction:** Built an `add_banned_accounts` call signed by the previous
  admin; it failed authorization at simulation and so never became a
  transaction.

### Adminship moves to a new key: the old admin can no longer act, and the new admin can

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/b9631237b07edb387e138bb4af4651d898b46e9f343f72a27008808afae1d9ae

`set_admin` moved control from
GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU to
GD7BG7FDDCUVKCZK5IYRK3OOPT63HSBAKJZZ2M4VJ4KRN2P3FJZRBR46. An
`add_banned_accounts` signed by the OLD admin is then rejected for lack of
authorization, while the same call signed by the NEW admin succeeds —
https://stellar.expert/explorer/testnet/tx/eddb67b051b31017f5565cda20279912565027c7871eace8c05cf7d5e8365f6a.
This is the key-rotation path an issuer needs when an ops key is retired or
compromised.

### …and back again, so the handover is demonstrably not a one-way door

- **Transaction:**
  https://stellar.expert/explorer/testnet/tx/df03f01a3c6287b757600bcf1b175f0c978e245129508120f20b57feac83cfdc

The new admin handed control back to
GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU. The contract is left
in the state the rest of this report describes.

## Phase 10 — the audit trail, rebuilt from the ledger alone

Every state change this run made emitted a contract event. All 20 were read back
from the ledger with a plain RPC `getEvents` call — no indexer, no database, no
off-chain log. Each row carries the admin that authorized it and the ledger it
happened on, which is what makes the authorization history auditable from the
chain alone.

| Ledger  | Event           | Subject                                                                                                                 | Detail                                                                     |
| ------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 4431670 | `authorized`    | [`GBMCUGU7…`](https://stellar.expert/explorer/testnet/account/GBMCUGU7ZEIZYLZHJCSOGXOLIQKNMHRIQRJRIZ62ZQY3B55PZ4HOR7K2) | policy=Denylist                                                            |
| 4431673 | `authorized`    | [`GA3U5EID…`](https://stellar.expert/explorer/testnet/account/GA3U5EIDBDGHFOGEL3QKNYP52KUMIOCEZIUPFLWCSQEKK3SRROVLGY5P) | policy=Denylist                                                            |
| 4431681 | `banned`        | [`GBQZRSPN…`](https://stellar.expert/explorer/testnet/account/GBQZRSPNLSM5B2SGXRA6AGDLXDFXZEPZNIOTL6YJ4B6DRJFXXIYQNTKU) |                                                                            |
| 4431686 | `authorized`    | [`GB3VFOWG…`](https://stellar.expert/explorer/testnet/account/GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG) | policy=Denylist                                                            |
| 4431687 | `frozen`        | [`GB3VFOWG…`](https://stellar.expert/explorer/testnet/account/GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG) | deauthorized=true policy=Denylist                                          |
| 4431691 | `unfrozen`      | [`GB3VFOWG…`](https://stellar.expert/explorer/testnet/account/GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG) | policy=Denylist reauthorized=true                                          |
| 4431694 | `paused`        |                                                                                                                         |                                                                            |
| 4431696 | `unpaused`      |                                                                                                                         |                                                                            |
| 4431697 | `authorized`    | [`GAITUUDI…`](https://stellar.expert/explorer/testnet/account/GAITUUDIDRPUZHS4EG3FKTIUWOVXWKKNQEDAGT3BCZCDWQATBYN7AGX4) | policy=Denylist                                                            |
| 4431700 | `policy_set`    |                                                                                                                         | policy=Allowlist                                                           |
| 4431701 | `allowed`       | [`GBIGURLZ…`](https://stellar.expert/explorer/testnet/account/GBIGURLZXMAVTATRJK3G5QLWVGEZZ65ZH5LI5HGRHR5VG5UOG3BPMGIY) |                                                                            |
| 4431702 | `authorized`    | [`GBIGURLZ…`](https://stellar.expert/explorer/testnet/account/GBIGURLZXMAVTATRJK3G5QLWVGEZZ65ZH5LI5HGRHR5VG5UOG3BPMGIY) | policy=Allowlist                                                           |
| 4431703 | `policy_set`    |                                                                                                                         | policy=Denylist                                                            |
| 4431704 | `minted`        | [`GBMCUGU7…`](https://stellar.expert/explorer/testnet/account/GBMCUGU7ZEIZYLZHJCSOGXOLIQKNMHRIQRJRIZ62ZQY3B55PZ4HOR7K2) | amount=2500000000                                                          |
| 4431705 | `clawback`      | [`GBMCUGU7…`](https://stellar.expert/explorer/testnet/account/GBMCUGU7ZEIZYLZHJCSOGXOLIQKNMHRIQRJRIZ62ZQY3B55PZ4HOR7K2) | amount=1000000000                                                          |
| 4431706 | `upgraded`      |                                                                                                                         | wasm_hash=d0e37e28897868a0ed1d4aea5cfe8bd7849828467d2ba4bf5044fc170e0f7f29 |
| 4431708 | `admin_changed` | [`GD7BG7FD…`](https://stellar.expert/explorer/testnet/account/GD7BG7FDDCUVKCZK5IYRK3OOPT63HSBAKJZZ2M4VJ4KRN2P3FJZRBR46) |                                                                            |
| 4431710 | `banned`        | [`GCCAXX6K…`](https://stellar.expert/explorer/testnet/account/GCCAXX6KAPKHAKRR23GMWND3TYUR2IE27GM2AAVYX4VI7XC6JWFAS4Z5) |                                                                            |
| 4431711 | `unbanned`      | [`GCCAXX6K…`](https://stellar.expert/explorer/testnet/account/GCCAXX6KAPKHAKRR23GMWND3TYUR2IE27GM2AAVYX4VI7XC6JWFAS4Z5) |                                                                            |
| 4431712 | `admin_changed` | [`GD4M65HH…`](https://stellar.expert/explorer/testnet/account/GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU) |                                                                            |

Read it yourself:
`npm run authorizer -- history --id CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH`

## Phase 11 — the live pinned testnet deployment

The deliverable calls for the authorizer to be live on testnet as the admin of
the test asset, replacing the Tranche-1 stub. That deployment is verified here
**read-only** — this run never mutates shared state.

| Fact                     | Value                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset                    | `EURCV` — EUR CoinVertible (testnet test token)                                                                                                                         |
| Issuer                   | [`GC66PIMV4S2WEQYG3UFOGG7Z4OIAQAKJLEKX6C5ZQ6AZT4FUXUPOGIKL`](https://stellar.expert/explorer/testnet/account/GC66PIMV4S2WEQYG3UFOGG7Z4OIAQAKJLEKX6C5ZQ6AZT4FUXUPOGIKL)  |
| SAC                      | [`CCST65QNIHUJ3V2JK5SDTXUXYSGQZI6MSSXDMNRA55ECJEWU4UFDLQHR`](https://stellar.expert/explorer/testnet/contract/CCST65QNIHUJ3V2JK5SDTXUXYSGQZI6MSSXDMNRA55ECJEWU4UFDLQHR) |
| Authorizer               | [`CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM`](https://stellar.expert/explorer/testnet/contract/CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM) |
| `SAC.admin()`            | `CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM` — equals the authorizer ✅                                                                                   |
| `authorizer.sac()`       | `CCST65QNIHUJ3V2JK5SDTXUXYSGQZI6MSSXDMNRA55ECJEWU4UFDLQHR` — equals the pinned SAC ✅                                                                                   |
| `authorizer.admin()`     | `GC66PIMV4S2WEQYG3UFOGG7Z4OIAQAKJLEKX6C5ZQ6AZT4FUXUPOGIKL`                                                                                                              |
| `authorizer.policy()`    | `Denylist`                                                                                                                                                              |
| `authorizer.is_paused()` | `false`                                                                                                                                                                 |

The Tranche-1 stub exposed no `policy`, `is_paused`, `set_admin` or `upgrade`.
That all four answer on this contract is what demonstrates the replacement. (SAC
adminship is one-way — the stub had no `set_admin` — so replacing it required
re-issuing the test asset, which is why the pinned issuer changed on
2026-08-20.)

## Phase 12 — the issuer admin CLI

The CLI wraps every entry point so an issuer's ops person types commands instead
of crafting Soroban invocations. Below are its read commands run against the
authorizer this script deployed. Write commands are the same invocations, signed
with a key from the local `stellar` keystore; the runbook documents each one —
see [docs/authorizer-runbook.md](authorizer-runbook.md).

### `npm run authorizer -- status`

```
━━━ Trustline Authorizer · testnet ━━━
Contract : CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH
SAC      : CD4CUKHVUG336L5QJK6XEV3IRGXWAB5K3S55FIGIKUXDIMUO7O75DPF2
Admin    : GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU
Policy   : Denylist
State    : running

https://stellar.expert/explorer/testnet/contract/CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH
```

### `npm run authorizer -- check <banned holder>`

```
━━━ GBQZRSPNLSM5B2SGXRA6AGDLXDFXZEPZNIOTL6YJ4B6DRJFXXIYQNTKU ━━━
Policy in force : Denylist
On denylist     : yes
On allowlist    : no
Trustline authorized (live from the SAC): no

→ authorize_trustline would be REFUSED by policy right now.
```

### `npm run authorizer -- history`

```
━━━ Audit trail · CASBDC2SQXGZX3URTA25NGNAR2PQWQJDJFUF4FNB7MKJSEZOYORMRPEH ━━━
(ledgers 4414432…4431712, newest last)

ledger 4431670  authorized    GBMCUGU7ZEIZYLZHJCSOGXOLIQKNMHRIQRJRIZ62ZQY3B55PZ4HOR7K2 policy=Denylist
ledger 4431673  authorized    GA3U5EIDBDGHFOGEL3QKNYP52KUMIOCEZIUPFLWCSQEKK3SRROVLGY5P policy=Denylist
ledger 4431681  banned        GBQZRSPNLSM5B2SGXRA6AGDLXDFXZEPZNIOTL6YJ4B6DRJFXXIYQNTKU
ledger 4431686  authorized    GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG policy=Denylist
ledger 4431687  frozen        GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG deauthorized=true policy=Denylist
ledger 4431691  unfrozen      GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG policy=Denylist reauthorized=true
ledger 4431694  paused
ledger 4431696  unpaused
ledger 4431697  authorized    GAITUUDIDRPUZHS4EG3FKTIUWOVXWKKNQEDAGT3BCZCDWQATBYN7AGX4 policy=Denylist
ledger 4431700  policy_set                                                             policy=Allowlist
ledger 4431701  allowed       GBIGURLZXMAVTATRJK3G5QLWVGEZZ65ZH5LI5HGRHR5VG5UOG3BPMGIY
ledger 4431702  authorized    GBIGURLZXMAVTATRJK3G5QLWVGEZZ65ZH5LI5HGRHR5VG5UOG3BPMGIY policy=Allowlist
ledger 4431703  policy_set                                                             policy=Denylist
ledger 4431704  minted        GBMCUGU7ZEIZYLZHJCSOGXOLIQKNMHRIQRJRIZ62ZQY3B55PZ4HOR7K2 amount=250
ledger 4431705  clawback      GBMCUGU7ZEIZYLZHJCSOGXOLIQKNMHRIQRJRIZ62ZQY3B55PZ4HOR7K2 amount=100
ledger 4431706  upgraded                                                               wasm_hash=d0e37e28897868a0ed1d4aea5cfe8bd7849828467d2ba4bf5044fc170e0f7f29
ledger 4431708  admin_changed GD7BG7FDDCUVKCZK5IYRK3OOPT63HSBAKJZZ2M4VJ4KRN2P3FJZRBR46
ledger 4431710  banned        GCCAXX6KAPKHAKRR23GMWND3TYUR2IE27GM2AAVYX4VI7XC6JWFAS4Z5
ledger 4431711  unbanned      GCCAXX6KAPKHAKRR23GMWND3TYUR2IE27GM2AAVYX4VI7XC6JWFAS4Z5
ledger 4431712  admin_changed GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU

Every row is signed off by the admin in force at the time; add --json
for the full records including authorizer_admin and ledger.
```

## Accounts used

| Role                                           | Account                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| issuer / authorizer admin                      | [`GD4M65HH…RIUEJU`](https://stellar.expert/explorer/testnet/account/GD4M65HHWWYDVHG7OFHYPEUYFWZDKFCFQPJGWMUNKJ3ISICG27RIUEJU) |
| third-party submitter (no issuer authority)    | [`GCCAXX6K…FAS4Z5`](https://stellar.expert/explorer/testnet/account/GCCAXX6KAPKHAKRR23GMWND3TYUR2IE27GM2AAVYX4VI7XC6JWFAS4Z5) |
| holder A — clean, onboards via the router      | [`GBMCUGU7…HOR7K2`](https://stellar.expert/explorer/testnet/account/GBMCUGU7ZEIZYLZHJCSOGXOLIQKNMHRIQRJRIZ62ZQY3B55PZ4HOR7K2) |
| holder B — authorized on their behalf          | [`GA3U5EID…VLGY5P`](https://stellar.expert/explorer/testnet/account/GA3U5EIDBDGHFOGEL3QKNYP52KUMIOCEZIUPFLWCSQEKK3SRROVLGY5P) |
| holder C — banned before existing on-ledger    | [`GBQZRSPN…YQNTKU`](https://stellar.expert/explorer/testnet/account/GBQZRSPNLSM5B2SGXRA6AGDLXDFXZEPZNIOTL6YJ4B6DRJFXXIYQNTKU) |
| holder D — frozen mid-life                     | [`GB3VFOWG…P4GFXG`](https://stellar.expert/explorer/testnet/account/GB3VFOWGCNQSGFHFENPXR24ZBFUIB5AIBUXPGRVIQSNYMFKN4HP4GFXG) |
| holder E — caught by the pause                 | [`GAITUUDI…N7AGX4`](https://stellar.expert/explorer/testnet/account/GAITUUDIDRPUZHS4EG3FKTIUWOVXWKKNQEDAGT3BCZCDWQATBYN7AGX4) |
| holder F — admitted by the allowlist after KYC | [`GBIGURLZ…BPMGIY`](https://stellar.expert/explorer/testnet/account/GBIGURLZXMAVTATRJK3G5QLWVGEZZ65ZH5LI5HGRHR5VG5UOG3BPMGIY) |
| second admin (handover target)                 | [`GD7BG7FD…ZRBR46`](https://stellar.expert/explorer/testnet/account/GD7BG7FDDCUVKCZK5IYRK3OOPT63HSBAKJZZ2M4VJ4KRN2P3FJZRBR46) |

## What this run does not prove

- **The upgrade installs a different binary.** Phase 8 upgrades to the same wasm
  hash, because there is no second build to point at. It proves the upgrade path
  executes under admin auth and that instance state survives, not that the code
  changed.
- **Unit-level invariants.** The contract's 36 Rust tests cover cases that are
  awkward or impossible to stage live (constructor rejecting a non-SAC, batch
  bounds, clawback without the issuer flag). Run them with
  `npm run test:contracts`.
- **The CLI's write commands.** Phase 12 runs the read commands, which need no
  secret. The writes are the same invocations this script makes directly and are
  documented in the runbook.
