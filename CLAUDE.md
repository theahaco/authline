# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

Scaffold Stellar frontend dApp — a Vite + React + TypeScript app that interacts
with Soroban smart contracts on the Stellar network. Includes three example
Rust/Soroban contracts with auto-generated TypeScript clients.

## Commands

- **Dev server:** `npm run dev` (runs `stellar scaffold watch --build-clients`
  and `vite` concurrently)
- **Build:** `npm run build` (tsc + vite build)
- **Lint:** `npm run lint` (eslint)
- **Format:** `npm run format` (prettier)
- **Typecheck:** `npm run typecheck`
- **Rebuild contract clients:** `npm run install:contracts`
- **Run Rust contract tests:** `cargo test` (all contracts) or
  `cargo test -p guess-the-number` (single contract)
- **Build contracts to WASM:** `cargo build --release --target wasm32v1-none`

## Architecture

### Frontend (src/)

- **Entry:** `main.tsx` → wraps `App` in `NotificationProvider` >
  `QueryClientProvider` > `WalletProvider` > `BrowserRouter`
- **Routing:** `App.tsx` — `/` (Home), `/debug` and `/debug/:contractName`
  (Contract Explorer)
- **Providers:** `WalletProvider` manages wallet connection state via
  `@creit.tech/stellar-wallets-kit`, polls wallet state every 1s, persists
  wallet ID/address/network in localStorage. `NotificationProvider` handles
  toast notifications.
- **contracts/**: Auto-generated contract client instantiations (do NOT
  hand-edit except `util.ts`). The eslint config explicitly ignores
  `src/contracts/*` except `util.ts`.
- **contracts/util.ts**: Env config via Zod validation of `PUBLIC_*` env vars,
  network helpers, Stellar Lab URL builder.
- **hooks/**: `useWallet` (context consumer), `useSubscription` (contract event
  subscriptions), `useNotification`.
- **util/**: `wallet.ts` (StellarWalletsKit setup, balance fetching),
  `contract.ts` (ID formatting), `friendbot.ts` (testnet funding), `storage.ts`
  (localStorage wrapper).

### Smart Contracts (contracts/)

Three Soroban contracts in a Cargo workspace:

- **guess-the-number**: Game contract (soroban-sdk 23.0.3 + stellar-registry)
- **fungible-allowlist**: Token with allowlist (OpenZeppelin stellar-contracts
  v0.5.1)
- **nft-enumerable**: NFT with enumeration (OpenZeppelin stellar-contracts
  v0.5.1)

Each contract has `src/lib.rs`, `src/contract.rs` (or inline), and
`src/test.rs`.

### Contract Clients (packages/)

Auto-generated NPM workspace packages created by
`stellar scaffold watch --build-clients`. These are generated from deployed
contract instances and should not be manually edited. Exceptions — hand-written
workspace packages that ARE first-class source: `packages/authline-sdk` (the
`@theahaco/authline` integrator SDK) and `packages/relayer` (the authorization
relayer HTTP service; see `docs/relayer-runbook.md`, Docker image via
`packages/relayer/Dockerfile`).

### Environment Configuration

- `.env` / `.env.example`: `PUBLIC_*` prefixed vars exposed to Vite frontend
  (network, RPC URL, passphrase, Horizon URL)
- `environments.toml`: Scaffold Stellar config defining
  development/staging/production networks, accounts, contract deployment args,
  and post-deploy scripts
- `envPrefix: "PUBLIC_"` in vite.config.ts — only env vars with this prefix are
  available in frontend code via `import.meta.env`
- Rust toolchain pinned to 1.95.0 with `wasm32v1-none` target

## Key Dependencies

- `@stellar/stellar-sdk` for Stellar/Soroban interaction
- `@creit.tech/stellar-wallets-kit` for multi-wallet support (Freighter, etc.)
- `@stellar/design-system` for UI components
- `@tanstack/react-query` for async state management
- `@theahaco/contract-explorer` for the debug/contract explorer page
- `soroban-sdk` 23.x for contract development
- OpenZeppelin `stellar-contracts` v0.5.1 for token/NFT standards
