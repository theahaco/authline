# Stellar Trustline

A Stellar dApp for managing asset trustlines and handling EURCV authorization.
Built with [Scaffold Stellar](https://github.com/theahaco/scaffold-stellar).

**[Live App](https://theahaco.github.io/stellar-trustline/)**

## Features

- **Add trustlines** for popular Stellar assets (USDC, EURCV, AQUA, yXLM, etc.)
  or any custom asset code + issuer
- **Remove trustlines** with zero balance to reclaim XLM reserves
- **EURCV authorization** -- automatically calls the on-chain authorization
  contract for auth-required assets
- **View your assets** with balance, authorization status, and issuer info
- **Explainer page** covering how trustlines, reserves, and issuer authorization
  work on Stellar
- **Network-aware** -- detects wallet/network mismatch and warns the user
- **Multi-wallet support** via Stellar Wallets Kit (Freighter, etc.)

## Quick Start

```bash
cp .env.example .env   # configure network, RPC, Horizon
npm install
npm run dev            # starts Vite + contract client watcher
```

Open the dev server URL in your browser, connect a Stellar wallet, and start
managing trustlines.

## Stack

| Layer      | Tech                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Framework  | Vite + React 19 + TypeScript                                                                        |
| UI         | [@stellar/design-system](https://github.com/nicholasgasior/stellar-design-system)                   |
| Wallet     | [@creit.tech/stellar-wallets-kit](https://github.com/nicholasgasior/stellar-wallets-kit)            |
| Blockchain | [@stellar/stellar-sdk](https://github.com/nicholasgasior/js-stellar-sdk) + Soroban contract clients |
| State      | @tanstack/react-query                                                                               |

## Project Structure

```
src/
  components/
    Dashboard.tsx       # Main view -- hero, wallet gate, asset list, add form
    MyAssets.tsx         # Lists held assets with auth status + remove button
    AddTrustline.tsx    # Popular asset grid + custom asset form
    AboutPage.tsx       # Trustline explainer
    ConnectAccount.tsx  # Wallet connect button
  hooks/
    useTrustline.ts     # Add/remove trustline transactions
    useEurcvAuth.ts     # EURCV authorization contract call
    useWallet.ts        # Wallet context consumer
  data/
    popularAssets.ts    # Curated list of popular Stellar assets
  contracts/            # Auto-generated Soroban contract clients
contracts/              # Soroban smart contracts (Rust)
```

## Scripts

| Command                     | Description                          |
| --------------------------- | ------------------------------------ |
| `npm run dev`               | Dev server + contract client watcher |
| `npm run build`             | Production build (tsc + vite)        |
| `npm run lint`              | ESLint                               |
| `npm run format`            | Prettier                             |
| `npm run typecheck`         | TypeScript type check                |
| `npm run install:contracts` | Rebuild contract clients             |

## Deployment

Pushes to `main` deploy automatically to GitHub Pages via the
`.github/workflows/dapp-pages.yml` workflow. Pull requests get preview deploys.

## License

MIT
