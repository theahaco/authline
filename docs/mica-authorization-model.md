# The Authline authorization model under MiCA

**How on-chain trustline authorization supports an issuer's MiCA obligations,
what gets recorded on the ledger, and why no personal data is involved anywhere
in the system.**

Status: design note accompanying the Trustline Onboarder SEP draft
([`sep/SEP-XXXX-trustline-onboarder.md`](../sep/SEP-XXXX-trustline-onboarder.md)).
This is an engineering document, not legal advice; it describes what the system
records and enforces so that an issuer's compliance function can map it onto
their own obligations.

---

## 1. Context

MiCA — Regulation (EU) 2023/1114 — is the frame an EU issuer of asset-referenced
tokens (Title III) or e-money tokens (Title IV) operates in: authorization,
redemption rights, governance and record-keeping duties. It does not stand
alone. The same issuer is simultaneously subject to the EU sanctions regimes and
the AML/CFT framework, which is where the duty to act against a specific holder
(a sanctioned address, a court order, a lapsed KYC file) and to demonstrate that
action afterwards actually comes from. Taken together, the operational needs
are: know that holders were admitted under the issuer's own policy, be able to
stop a specific holder, be able to halt all onboarding in an emergency, and be
able to prove all of this later.

On Stellar, the native mechanism is a classic asset issued with
`AUTH_REQUIRED` + `AUTH_REVOCABLE`: every holder's trustline starts unauthorized
and the issuer flips it per holder. Authline's contribution is **who** does the
flipping. The issuer hands SAC adminship to one auditable contract — the
[Trustline Authorizer](authorizer-runbook.md) — that enforces the issuer's
policy mechanically and emits an event for every state change. The issuer's key
leaves the hot path entirely; the policy stays under the issuer's exclusive
control.

## 2. The model in one page

| Role                  | Holds                            | Can                                                                       |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| Issuer (admin key)    | admin of the Authorizer contract | set policy, ban/allow, freeze, pause, mint, claw back, hand over, upgrade |
| Authorizer (contract) | SAC adminship of the asset       | flip trustline authorization — but only as its policy permits             |
| Relayer / integrator  | an ordinary funded account       | _request_ authorization for a holder (permissionless entry point)         |
| Holder                | their own key(s)                 | sign their own `ChangeTrust`; nothing else                                |

Two policies cover the regulated spectrum:

- **Denylist** — everyone may hold except accounts the issuer bans (frictionless
  e-money-token model: EURCV-style stablecoins).
- **Allowlist** — nobody may hold except accounts the issuer admits after its
  off-chain KYC (securities / per-holder admission).

Enforcement is protocol-level: an unauthorized trustline cannot receive the
asset, and `AUTH_REVOCABLE` lets the Authorizer withdraw authorization from an
existing holder. `freeze` binds the ban to the **address**, so deleting and
recreating the trustline does not evade it (proven on-chain — see the
[freeze evidence](authorizer-runbook.md#the-freeze-invariant-on-chain)).

## 3. What is recorded on-chain

Every state transition emits one contract event. The complete vocabulary:

| Event                        | Data recorded (all of it)                                             |
| ---------------------------- | --------------------------------------------------------------------- |
| `authorized`                 | holder **address**, policy in force, admin in force, ledger number    |
| `deauthorized`               | address, **reason code**, admin, ledger                               |
| `banned` / `unbanned`        | address (one event per account in a batch), admin, ledger             |
| `allowed` / `disallowed`     | address (one event per account in a batch), admin, ledger             |
| `frozen`                     | address, whether the SAC flag was also cleared, policy, admin, ledger |
| `unfrozen`                   | address, whether the holder was re-authorized, policy, admin, ledger  |
| `minted` / `clawback`        | address, amount, admin, ledger                                        |
| `paused` / `unpaused`        | admin, ledger                                                         |
| `policy_set`                 | new policy, admin, ledger                                             |
| `admin_changed` / `upgraded` | new admin / new wasm hash, admin, ledger                              |

Three properties of this record matter for compliance:

1. **It is complete for the delegated path — and nothing leaves the ledger.**
   The Authorizer holds SAC adminship, so every authorization decision routed
   through it (which is every decision in normal operation: the issuer's
   console, the router, the relayer, any exchange) lands in this event stream —
   `npm run authorizer -- history` reconstructs it from the ledger alone. One
   caveat belongs in the open: SAC adminship governs the Soroban layer, and the
   issuer's own account keeps the classic `SetTrustLineFlags` capability
   regardless. That residual path cannot act silently — a classic flag change is
   itself a public ledger operation signed by the issuer key — so the _ledger_
   remains a complete record either way; but an issuer that wants the event
   stream to be the single operational history should keep the issuer key in
   cold custody (or lock it down to threshold signers) and operate exclusively
   through the Authorizer, which is the deployment model this design assumes.
2. **It is attributable.** Every event carries the admin under which it
   happened, so a hand-over of governance is visible in the same trail.
3. **It is closed-vocabulary.** The `deauthorized` reason is an enumerated code
   (`Sanctions`, `KycExpired`, `IssuerRequest`, `Unspecified`) — there is
   deliberately **no free-text field anywhere** in the contract interface, so an
   operator cannot leak a name, a case number, or any other identifying detail
   into the permanent record even by mistake.

## 4. Why no personal data is involved

**On-chain there are only account addresses.** A Stellar address is a public key
generated by the holder's wallet. The chain records that _an address_ was
authorized, frozen, or banned under _a policy_ — never who controls the address,
and never why beyond the enumerated codes.

**The identity link lives off-chain, with the party that already has it.** KYC —
mapping an address to a person — is performed by the issuer or the exchange
under their existing obligations. That mapping stays in their systems, subject
to GDPR (Regulation (EU) 2016/679) like any other customer record:
access-controlled, retention-limited, erasable. Nothing in Authline asks for it,
transports it, or stores it:

- The **contracts** accept addresses and amounts only.
- The **relayer** ([runbook](relayer-runbook.md)) takes an address in the URL,
  answers from public chain state, keeps no database and writes no per-request
  logs of its own. (An operator's reverse proxy or load balancer may still keep
  access logs, and client IP addresses in those logs are personal data — that is
  ordinary web-service GDPR hygiene for whoever hosts an instance, not a
  property of the protocol.)
- The **dApp and SDK** hold keys and build transactions; there is no user
  account system anywhere in the stack.

**Immutability and erasure do not collide.** The tension between an append-only
ledger and GDPR erasure rights arises when personal data is written on-chain.
Here the permanent record is pseudonymous by construction: if the off-chain
identity link is erased, the on-chain events revert to statements about an
unattributable public key. This is exactly the data-minimization posture — the
ledger keeps what compliance needs to _prove_ (policy was enforced, when, under
whose authority), the issuer keeps what compliance needs to _know_ (who). To be
precise about the GDPR boundary: for a party that holds the linking table, a
pseudonymous address can itself qualify as personal data (Recital 26 turns on
linkability) — but that qualification attaches to the party holding the link,
lives in their erasable systems, and adds no identifying content to the chain.
What the system itself records and transports is never more than an address.

**Sanctions screening stays where the data is.** Deciding _that_ an address
should be banned requires off-chain intelligence (attribution, list-matching).
The issuer runs that wherever appropriate and writes only the conclusion —
`ban G…` — to the chain.

**Travel-rule data flows around, not through.** Originator/beneficiary
information under Regulation (EU) 2023/1113 is exchanged between service
providers in their own channels. The onboarding and authorization path carries
none of it.

## 5. Obligation → mechanism map

| Compliance need                                  | Mechanism                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admit holders only under the issuer's policy     | `AUTH_REQUIRED` + Authorizer policy (denylist / allowlist), enforced by the protocol                                                                                                                          |
| Act against a specific holder (sanctions, order) | `freeze` — durable, address-bound, survives trustline deletion; `clawback` where enabled                                                                                                                      |
| Pre-emptively block a known-bad address          | `ban` works before any trustline exists                                                                                                                                                                       |
| Emergency halt of onboarding and admin actions   | `pause` — every Authorizer operation refused, so no new holder can be authorized anywhere; transfers between already-authorized holders continue until they are individually frozen; recovery paths stay open |
| Demonstrate enforcement afterwards               | attributable on-chain event trail, complete for the delegated path (§3); exportable via `history --json`                                                                                                      |
| Governance changes under control                 | `set_admin` / `upgrade`, both evented; storage (bans, policy) survives upgrades                                                                                                                               |
| Data minimization                                | addresses and enumerated codes only; no free text, no identity data, on-chain or in the relayer                                                                                                               |
| Supply control (issuance / redemption support)   | `mint` to authorized holders; `clawback` under `AUTH_CLAWBACK_ENABLED`                                                                                                                                        |

## 6. Residual considerations

- **Pseudonymity is not anonymity.** If a third party independently links an
  address to a person, the on-chain history becomes attributable to them. That
  linkage risk is inherent to every public-ledger asset, not introduced by this
  design; the design's job is to add nothing that makes linkage easier, which is
  why the vocabulary is closed (§3.3).
- **Event retention.** RPC nodes keep a rolling event window; issuers who need
  the full trail for their retention period should export it periodically or
  index from history archives (see the
  [authorizer runbook](authorizer-runbook.md#reading-the-audit-trail)).
- **The relayer is not a gatekeeper.** It cannot admit anyone the policy
  refuses, and refusing to serve someone only forces them to another submitter —
  the contract is the single enforcement point. Treat relayer API tokens as
  fee-abuse protection, never as a compliance control.
