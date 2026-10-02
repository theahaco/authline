# Adoption — one wallet and one exchange (D3.2)

**The deliverable.** One wallet and one exchange or broker actually use the
standard. The wallet comes in through Stellar Wallets Kit, the exchange through
the EURCV work already under way. Integration counts from
[Tier 0](integration-tiers.md) up. At Tier 0 the platform sends users from its
"withdrawal failed" screen to the activation page. That is the redirect flow the
RFP itself describes, and a platform can climb from there to a relayer call,
claimable balances, or the full SDK.

**Done when:** two independent platforms are integrated and documented at Tier 0
or higher (the wallet plus the exchange, or the wallet plus a second wallet if
the exchange is blocked), with real onboardings through the standard on mainnet,
each visible on Stellar Expert.

## Status — 2026-09-28

| Requirement                                                         | Status                  | Evidence                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tiers defined, with Tier 0 needing only a link                      | **Done**                | [integration-tiers.md](integration-tiers.md)                                                                                                                                                                                                                                                                                              |
| Tier 0 link supported by the activation page                        | **Done**                | `app.html` reads `asset`, `address`, `return_url`. It names the return host and shows **Return to &lt;host&gt;** on success and on "already set up". It refuses non-https and credentialed return links. The emitter and the page share one check (`activationLink` / `safeReturnUrl` in `@theahaco/authline`), covered by 11 unit tests. |
| Tier 0 reference exchange screen                                    | **Done**                | `withdraw.html?tier=0`: **Withdrawal failed** → **Set up your wallet** → back to the prefilled form, which retries on its own.                                                                                                                                                                                                            |
| Tier 0 round trip proven in a browser                               | **Done** (testnet)      | `tests/e2e/tier0-redirect.spec.ts`. Two tests passed on 2026-09-28: the full round trip with one signature, and the refusal of a spoofed return link.                                                                                                                                                                                     |
| Tier 1 / 2 / 3 surfaces                                             | **Done** (earlier work) | Relayer ([relayer-evidence.md](relayer-evidence.md)), SEP-7 handoff and claimable balances ([sep7-handoff.md](sep7-handoff.md)), SDK ([authline-sdk.md](authline-sdk.md))                                                                                                                                                                 |
| Mainnet: authorize an existing unauthorized trustline from the page | **Available**           | Uses `eurcv_auth` `authorize_trustline`; needs no router. Simulated read-only on mainnet on 2026-09-28: it succeeds for 5 of 5 sampled unauthorized EURCV holders. 23 of the 34 EURCV trustlines on mainnet are unauthorized today.                                                                                                       |
| Mainnet: create a trustline from the page                           | **Blocked**             | Needs the onboard router on mainnet ([#25](https://github.com/theahaco/authline/issues/25)). Until then the page says so, and still lets holders with a trustline connect.                                                                                                                                                                |
| The hosted activation page serves mainnet                           | **To confirm**          | The Pages build takes its network from repo variables (`PUBLIC_STELLAR_NETWORK_PASSPHRASE`, `PUBLIC_STELLAR_RPC_URL`).                                                                                                                                                                                                                    |
| Wallet integrated (via Stellar Wallets Kit)                         | **Not yet**             | Needs the partner to ship. See [Integration records](#integration-records).                                                                                                                                                                                                                                                               |
| Exchange integrated (EURCV), or a second wallet                     | **Not yet**             | Needs the partner to ship. See [Integration records](#integration-records).                                                                                                                                                                                                                                                               |
| Real onboardings through the standard on mainnet, per platform      | **Not yet**             | The standard already has 8 mainnet onboardings, but none from a third-party platform: 5 were paid by the issuer's operator, 3 by holders. See [Mainnet evidence](#mainnet-evidence).                                                                                                                                                      |

## Integration records

One row per platform, filled in when its integration is live in production.

| Platform   | Kind     | Tier | Live since | What shipped (screen, PR, release note) | Mainnet onboardings |
| ---------- | -------- | ---- | ---------- | --------------------------------------- | ------------------- |
| _Wallet_   | Wallet   | —    | —          | —                                       | —                   |
| _Exchange_ | Exchange | —    | —          | —                                       | —                   |

What each tier asks of the platform is in
[integration-tiers.md](integration-tiers.md). For Tier 0 it is the link on the
failure screen: nothing to deploy on our side, and nothing to install on theirs.

## Mainnet evidence

`scripts/adoption-evidence.mjs` lists, from the public ledger, every
authorization of an asset that went through the standard: its Authorizer's
`authorize_trustline`, or the router's `onboard`. It lists issuer flag changes
separately, since those are not the standard. Each row links the transaction on
Stellar Expert. The script is read-only.

```bash
npm ci && npm run build -w @theahaco/authline

# Everything, for mainnet EURCV
node scripts/adoption-evidence.mjs --asset EURCV

# One platform at Tier 0: the addresses it confirms it sent to the page
node scripts/adoption-evidence.mjs --asset EURCV --holders G…,G… --label "Exchange · Tier 0"

# One platform at Tier 1+: authorizations its relayer account paid for
node scripts/adoption-evidence.mjs --asset EURCV --submitter G… --label "Exchange · Tier 1"
```

**Attribution.** At Tier 1 and above, the platform's relayer account pays for
the authorization, so the onboarding carries its account on-chain. At Tier 0 the
user's own transaction carries nothing that names the platform, by design: a tag
linking a self-custody address to an exchange would be personal data on a public
ledger. A Tier 0 onboarding is therefore attributed by the addresses the
platform confirms it sent (`--holders`).

### Snapshot — mainnet EURCV, 2026-09-28

`node scripts/adoption-evidence.mjs --asset EURCV`, run against Horizon (full
history) and Stellar RPC (last ~7 days):

| Date (UTC)          | Holder                                                                                                                 | Path                                                                                                                                         | Tx                                                                                                                            | Submitter                                                                                                                              | Now        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2025-12-18 12:53:40 | [`GCYY…652D`](https://stellar.expert/explorer/public/account/GCYYFR4SR4RDSWTN64LSE4BGF2UQEDYZ32QTD7TMQXO6TXSGEDWP652D) | non-standard issuer flags                                                                                                                    | [`2fc4da01…f2bf`](https://stellar.expert/explorer/public/tx/2fc4da01fba6380fe0b57c193b4a72e017d2e1ba8e6fee8349f5fc580a32f2bf) | [`GCEY…XW3G`](https://stellar.expert/explorer/public/account/GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G) (issuer)        | authorized |
| 2025-12-22 11:30:12 | [`GDZN…PNGK`](https://stellar.expert/explorer/public/account/GDZNVBVU5XWE3GIDVWSYLWL3LTW3OIOTQKEE6DPUWEEKCOKWDHYTPNGK) | **Case A authorize**                                                                                                                         | [`5255c06a…31b5`](https://stellar.expert/explorer/public/tx/5255c06a43009bf07d2e085e09475a6d8f10717f8e58a3e8398693a6f71831b5) | [`GCYY…652D`](https://stellar.expert/explorer/public/account/GCYYFR4SR4RDSWTN64LSE4BGF2UQEDYZ32QTD7TMQXO6TXSGEDWP652D) (issuer signer) | authorized |
| 2026-03-24 14:27:45 | [`GBQ3…I6GM`](https://stellar.expert/explorer/public/account/GBQ3QJIXRF7T4WKBN6JNVVLMACM6C6SOENL4FXQNSFUH6BJMQSNJI6GM) | **Case A authorize**                                                                                                                         | [`e0010763…55b2`](https://stellar.expert/explorer/public/tx/e0010763b2b40df738cc16186916b2af274bcc62653788d1b62ff781439d55b2) | [`GCYY…652D`](https://stellar.expert/explorer/public/account/GCYYFR4SR4RDSWTN64LSE4BGF2UQEDYZ32QTD7TMQXO6TXSGEDWP652D) (issuer signer) | authorized |
| 2026-03-30 09:46:36 | [`GAJM…QQOK`](https://stellar.expert/explorer/public/account/GAJMSPEVWNZ52NHZWH6TV4FBN7BZRFMDBQ6LEXU3EW2KJKFACNJCQQOK) | **Case A authorize**                                                                                                                         | [`0cf2e76a…a04a`](https://stellar.expert/explorer/public/tx/0cf2e76a1cc0b8ef77c3f5e67e8e959382e715e63adf3fdc7b1ed9f84964a04a) | [`GCYY…652D`](https://stellar.expert/explorer/public/account/GCYYFR4SR4RDSWTN64LSE4BGF2UQEDYZ32QTD7TMQXO6TXSGEDWP652D) (issuer signer) | authorized |
| 2026-03-30 10:06:05 | [`GABR…F4SL`](https://stellar.expert/explorer/public/account/GABRNO3RCFT5VS3JZ5K6A5PBVI47BKKNO6SH3XFQQHIPCW5AWIU3F4SL) | **Case A authorize**                                                                                                                         | [`fac712e6…2111`](https://stellar.expert/explorer/public/tx/fac712e6112ee09ebe6fa0adb1218f6e5327022f0f5a0cef2f660326d4762111) | [`GCYY…652D`](https://stellar.expert/explorer/public/account/GCYYFR4SR4RDSWTN64LSE4BGF2UQEDYZ32QTD7TMQXO6TXSGEDWP652D) (issuer signer) | authorized |
| 2026-04-01 19:33:30 | [`GDE7…LUSU`](https://stellar.expert/explorer/public/account/GDE7BA4UWAEPTAMJRTNHAD7PHNR3JCA543L5ZSME54QM67DJPDXGLUSU) | **Case A authorize**                                                                                                                         | [`d0553f92…239b`](https://stellar.expert/explorer/public/tx/d0553f92aa4240dddd1593f0794e16babb018d657666a8a0547e7d0ca97c239b) | holder                                                                                                                                 | authorized |
| 2026-04-01 23:24:06 | [`GBU7…KKC5`](https://stellar.expert/explorer/public/account/GBU764PFZXKZUORAUK3IG36Y6OXSLYM6ZERLJA2BZ2Y2GSKNKWL4KKC5) | **Case A authorize**                                                                                                                         | [`14399065…2421`](https://stellar.expert/explorer/public/tx/14399065f943e7183c7c1562fe7db2a431fef48e17d189f4528f2cbb9cc22421) | holder                                                                                                                                 | authorized |
| 2026-04-02 09:07:05 | [`GBHD…36EA`](https://stellar.expert/explorer/public/account/GBHD3V2XKX6DXHYZDSHA2UYZTO4MKB2R6QNSCDT4XEKNGTLPXT7A36EA) | **Case A authorize**                                                                                                                         | [`6abe262e…d1d3`](https://stellar.expert/explorer/public/tx/6abe262edd065adbb9faf72dac91733924ef04ee8184ff8b0e75ccab9724d1d3) | holder                                                                                                                                 | authorized |
| 2026-05-12 16:31:19 | [`GCSL…LUPG`](https://stellar.expert/explorer/public/account/GCSLN7ZOKMOQ3UD7RXSWWCZOUTEIXQ4UDIPLWVA7FPHDKF7WH36TLUPG) | onboard via unpinned [`CDH2…AGLC`](https://stellar.expert/explorer/public/contract/CDH2Z3PMBEL2T3EBM3VW5ENDPURYUY7YIKX3XMU3TK5AP4P3LXMPAGLC) | [`141636c0…2a17`](https://stellar.expert/explorer/public/tx/141636c04cfcd01b04ac85d8225fb4be80b7c4a384f8f2a49bcbb6551cbc2a17) | holder                                                                                                                                 | authorized |
| 2026-05-12 16:39:23 | [`GCLQ…C2EU`](https://stellar.expert/explorer/public/account/GCLQ6PD52GYWDIABTNBVWBSNAPXE55AL3C7444OHOEPSVXZRFQ6TC2EU) | onboard via unpinned [`CDH2…AGLC`](https://stellar.expert/explorer/public/contract/CDH2Z3PMBEL2T3EBM3VW5ENDPURYUY7YIKX3XMU3TK5AP4P3LXMPAGLC) | [`197c743e…24fa`](https://stellar.expert/explorer/public/tx/197c743e4fbe7d7dadef8447dd501a7236c28eabd966969638104917400b24fa) | holder                                                                                                                                 | authorized |
| 2026-05-21 17:30:01 | [`GA54…CFWB`](https://stellar.expert/explorer/public/account/GA54CIPRHVHY6DRGTJKQMF43HOG3WR5STVZQ3KMDHIFXHSETNVN4CFWB) | **Case A authorize**                                                                                                                         | [`20d0d537…ea82`](https://stellar.expert/explorer/public/tx/20d0d53772ee00af39ed0ac14991eb8ed00749f93c3ec417b10f3ac39144ea82) | [`GCYY…652D`](https://stellar.expert/explorer/public/account/GCYYFR4SR4RDSWTN64LSE4BGF2UQEDYZ32QTD7TMQXO6TXSGEDWP652D) (issuer signer) | authorized |

**8 standard onboardings**, all Case A `authorize_trustline` through
`eurcv_auth` · **1 non-standard** (the issuer setting flags on its own operator
account) · **23 trustlines still unauthorized** out of 34. All 11 authorized
trustlines are accounted for.

What this means for D3.2:

- **The standard already runs on mainnet.** The table shows eight authorizations
  through the on-chain Authorizer, each linked on Stellar Expert.
- **None of them is a platform integration yet.** Five were paid by `GCYY…652D`,
  a signer on the EURCV issuer account, so they are the issuer's own operations.
  The other three were paid by the holders themselves and cannot be attributed.
  The per-platform evidence D3.2 asks for is therefore still zero.
- **Two `onboard` calls went through `CDH2…AGLC`, the pre-v0.3 mainnet router**
  with the old `onboard(sac, authorizer, holder)` interface. They are not
  counted, because that router is not the pinned one. Passing
  `--router CDH2Z3PMBEL2T3EBM3VW5ENDPURYUY7YIKX3XMU3TK5AP4P3LXMPAGLC` counts
  them, for a total of 10.
- **The 23 unauthorized holders can complete Case A from a Tier 0 link today.**
  They are the most direct source of the first attributable onboardings.

### Limits of the evidence

- A holder who has since deleted their trustline is found only through
  `--holders`, `--submitter`, the issuer's classic operations, or the RPC
  window.
- A successful `authorize_trustline` / `onboard` is read as having authorized
  the line. The "Now" column shows the current state as a check.
- Only top-level calls are classified. Case B and Case A look the same on-chain:
  the JSON output links the preceding `ChangeTrust` as `trustlineTx`.
