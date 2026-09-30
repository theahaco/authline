# Trustline Onboarder SEP — testnet evidence

The testnet runs backing the draft
[Trustline Onboarder SEP](../sep/sep_trustlineonboarder.md). They were moved out
of the SEP because testnet is reset periodically: the contract ids and
transaction links below will stop resolving after a reset, and a standard should
not carry links that expire.

## Testnet deployments

| Component                                                | Testnet id                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| Trustline Authorizer (SAC admin of the EURCV test token) | `CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM` |
| Trustline Onboard router                                 | `CABVVUYHXS6UVN2VYYXKEUO2XEJIAGMTEYF2BOWGUUJVOO2IGPRWZAX4` |
| Test asset **TLO** (`AUTH_REQUIRED`) — SAC               | `CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3` |
| Test asset **TLO** — issuer                              | `GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U` |

## Transactions

All transactions below are on testnet and verifiable on Stellar Expert.

**Default path — classic `ChangeTrust`, then authorize-on-behalf (Case B, then
A).** A brand-new **zero-XLM** holder obtains an authorized TLO trustline in two
transactions: (1) a sponsored `ChangeTrust` (the exchange pays the reserve, the
holder signs once) —
[`b001cc0f…64e8`](https://stellar.expert/explorer/testnet/tx/b001cc0f183b5a554b2abb004f0f424227e728354917aafae5aa0fee390464e8)
— and (2) a separate authorize-on-behalf with no holder or issuer signature —
[`2a1257b2…6479`](https://stellar.expert/explorer/testnet/tx/2a1257b2eac34114e0face7f07080bb602c85d573deddd59401a29f55eca6479).

**Case A — authorize-on-behalf.**
[`91f03714…47b9`](https://stellar.expert/explorer/testnet/tx/91f037142a0e3dae7776748f2a4faa4c1809023ad8bff2fe8a594af8658847b9):
one signature, from the exchange, sourced by the exchange account, with the
holder appearing only as the call argument.

**One-signature `onboard()` (Case C).** A brand-new holder establishes an
**authorized** trustline to the `AUTH_REQUIRED` test asset TLO in a single
transaction with one signature: the router runs CAP-73 `trust()`, discovers the
SAC admin's `authorize_trustline` on-chain (CAP-68) and calls it in the same
transaction. The final state read back over RPC is `hasTrustline = true`,
`isAuthorized = true`; the authorized bit proves the discovered authorize step
ran, since `trust()` alone leaves an `AUTH_REQUIRED` line unauthorized. One
onboarding of each asset class through the testnet router, each a single
transaction signed only by the holder:

| Asset class                 | Asset                             | Holder          | `onboard` transaction                                                                                                                                                                        |
| --------------------------- | --------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regulated (`AUTH_REQUIRED`) | **TLO** (SAC admin = Authorizer)  | `GDI7RTZM…X2RE` | [`dd80eacc…8488`](https://stellar.expert/explorer/testnet/tx/dd80eaccb5db273836517565843a712353e314182cdba9ad25015a3d60fc8488) — discovery ran: `hasTrustline = true`, `isAuthorized = true` |
| Open (not `AUTH_REQUIRED`)  | **USDC** (testnet, Circle issuer) | `GABGK323…5KK3` | [`1c00ce17…20c9`](https://stellar.expert/explorer/testnet/tx/1c00ce17b99dde1a27970b0804c8edc220bd7f3a72aadf9099490099be8620c9) — `trust()` only, returns `Authorized`                        |

**Claimable-balance delivery.** A withdrawal to a recipient with no trustline,
completed as a claimable balance and collected later by the user.

| Asset class                 | Step                                       | Transaction                                                                                                                    | User signatures                                             |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Open (not `AUTH_REQUIRED`)  | Exchange delivers the claimable balance    | [`df5ffa36…b7f6`](https://stellar.expert/explorer/testnet/tx/df5ffa36f04816ff4aa325ef63e0863939be6599b3ec6a540e07b5ef1fa6b7f6) | **0** — the user is not involved at all                     |
| Open (not `AUTH_REQUIRED`)  | User claims; the claim opens the trustline | [`3c9bb5e6…faf9`](https://stellar.expert/explorer/testnet/tx/3c9bb5e615e72c24f8e3ef328d6b6d46248b524e5159e68861b5351dda86faf9) | **1** — 4 ops, 2 signatures, exactly one of them the user's |
| Regulated (`AUTH_REQUIRED`) | Final claim of the three-step plan         | [`c6dda920…1347`](https://stellar.expert/explorer/testnet/tx/c6dda9203db3bcccb571ef71a8e3b0f8521c1490b65413c18d1727d49ca41347) | **1** (2 across the plan; the authorize step costs none)    |

In the open-asset claim the recipient ends holding the full delivered amount
with their XLM untouched at the 1 XLM they were created with: the sender was
both fee source and sponsor, so the user paid neither the fee nor the 0.5 XLM
reserve. The reference test suite also asserts the two negative results this
design rests on: a plain payment to a trustline-less recipient is rejected, and
the _fused_ one-signature claim is rejected by the network for an
`AUTH_REQUIRED` asset because the trustline created inside the claim envelope is
still unauthorized when `ClaimClaimableBalance` runs.

**Authorization lifecycle.** Exercised against the testnet EURCV test token,
whose SAC admin is the reference Trustline Authorizer (`CDTDC7PM…ZZSM`),
including the freeze invariant this SEP rests on:

| Step                                                            | Result                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-signature `onboard()` through the pinned router             | [`26508a57…1e32`](https://stellar.expert/explorer/testnet/tx/26508a57895a9e2879412e0849e0b0dd4d7dc185896ea572e1af120040441e32) — `Authorized`; the authorizer was discovered from `SAC.admin()`, not configured                                                               |
| `mint_to_account` 100, `clawback` 40                            | [`de1bfee1…7919`](https://stellar.expert/explorer/testnet/tx/de1bfee172542dddda20bb2ff1b9009fd7bf3b6a419ac87ddd69d8aee9937919) · [`83c6291d…0293`](https://stellar.expert/explorer/testnet/tx/83c6291d36889b0d3ca5220359084718910e03576d15654754f9736bee860293)               |
| `freeze_accounts` — ban **and** deauthorize                     | [`ae94a3af…5245`](https://stellar.expert/explorer/testnet/tx/ae94a3afc8fd65e744ac3e9837f1e40a6ac96ce0fcf1589bfa771fc8da2e5245) — event `frozen{deauthorized:true}`                                                                                                            |
| Frozen holder **deletes** the trustline (`ChangeTrust` limit 0) | [`b33187c4…f073`](https://stellar.expert/explorer/testnet/tx/b33187c4c86c9e9d4098b4ea645665290149ee2fa36bb4cba6d04297a422f073)                                                                                                                                                |
| …then replays `onboard()` on a clean slate                      | **refused** — router `AuthorizationRefused`, no trustline created: the ban is bound to the address, not the trustline                                                                                                                                                         |
| `unfreeze_accounts`, then onboard again                         | [`8a4ad600…fcc7`](https://stellar.expert/explorer/testnet/tx/8a4ad60045a1749bb2490924052baf0dd511916e70539e8caa1bb59ce92fccc7) · [`e336c3c4…3c2`](https://stellar.expert/explorer/testnet/tx/e336c3c41a9718be5956a03bef264b8d22d6e56dc95bf629bd56e3e3d45a23c2) — `Authorized` |
| `pause` refuses `authorize_trustline` **and** `ban`; `unpause`  | [`5e207c88…efa5`](https://stellar.expert/explorer/testnet/tx/5e207c88a29356e6e69c1a402512fa987937da06d01a3e1d9a35e5856204efa5) · [`5b6caa47…1cd98`](https://stellar.expert/explorer/testnet/tx/5b6caa47a63d7f14e5f13a9df5d95cfc6516134fc9d47e85c53ed6849b21cd98)              |

The §8 audit trail for the whole run is readable from the ledger.
