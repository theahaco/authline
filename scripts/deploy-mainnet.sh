#!/usr/bin/env bash
#
# Build trustline_onboard.wasm and deploy it to Stellar mainnet.
# Prints the deployed contract ID and the .env diff you need to apply.
#
# Usage:
#     ./scripts/deploy-mainnet.sh
#
# Env overrides:
#     SOURCE   stellar CLI key alias for the deployer (default: me)
#     RPC_URL  mainnet Soroban RPC               (default: gateway.fm)
#
# Prereqs: `stellar` CLI on $PATH; the source key must exist locally
# and be funded with mainnet XLM (deploy costs ~real funds).

set -euo pipefail

SOURCE="${SOURCE:-me}"
RPC_URL="${RPC_URL:-https://soroban-rpc.mainnet.stellar.gateway.fm}"
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
WASM="target/wasm32v1-none/release/trustline_onboard.wasm"

if ! command -v stellar >/dev/null 2>&1; then
    echo "error: stellar CLI not found on PATH" >&2
    exit 1
fi

# Confirm the source key exists. We do NOT auto-generate or auto-fund
# on mainnet — fail loudly so the operator picks an intentional key.
if ! stellar keys public-key "$SOURCE" >/dev/null 2>&1; then
    echo "error: stellar key '$SOURCE' not found." >&2
    echo "       Create one with: stellar keys generate $SOURCE" >&2
    echo "       Then fund it from your own mainnet XLM source." >&2
    exit 1
fi
SOURCE_ADDR="$(stellar keys public-key "$SOURCE")"

echo "============================================================"
echo "About to deploy trustline_onboard to Stellar MAINNET."
echo "  Source key : $SOURCE ($SOURCE_ADDR)"
echo "  RPC URL    : $RPC_URL"
echo "  WASM       : $WASM"
echo "============================================================"
read -r -p "Type 'deploy' to proceed: " confirm
if [[ "$confirm" != "deploy" ]]; then
    echo "aborted." >&2
    exit 1
fi

echo ">> building contracts"
cargo build --release --target wasm32v1-none

echo ">> deploying trustline_onboard"
CONTRACT_ID="$(stellar contract deploy \
    --wasm "$WASM" \
    --source "$SOURCE" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE")"

cat <<EOF

==========================================================================
Done. Deployed trustline_onboard at:

  $CONTRACT_ID

Update .env:
  1. Switch network block to PUBLIC (uncomment mainnet, comment testnet).
  2. Set:
       PUBLIC_TRUSTLINE_ONBOARD_CONTRACT_ID="$CONTRACT_ID"
  3. Remove the four PUBLIC_TEST_* / PUBLIC_EURCV_AUTH_CONTRACT_ID
     lines so the app falls back to the mainnet EURCV defaults.

(Optional) Pin in environments.toml [production.contracts]:
  trustline_onboard = { id = "$CONTRACT_ID" }

Explorer: https://stellar.expert/explorer/public/contract/$CONTRACT_ID
==========================================================================
EOF
