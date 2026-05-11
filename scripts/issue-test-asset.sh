#!/usr/bin/env bash
#
# Issue a classic Stellar asset on testnet with AUTH_REQUIRED + AUTH_REVOCABLE,
# deploy its Stellar Asset Contract (SAC), then deploy the eurcv-auth-stub
# admin contract and hand SAC admin rights to it.
#
# Usage:
#     ./scripts/issue-test-asset.sh
#
# Env overrides:
#     SOURCE       stellar CLI key alias for the issuer (default: me)
#     ASSET_CODE   4-12 char asset code            (default: TESTV)
#     NETWORK      stellar network alias           (default: testnet)
#
# Prereqs: `stellar` CLI installed and on $PATH. Repo built once via
# `cargo build --release --target wasm32v1-none` (this script will run it).
#
# Output: prints the env vars you should paste into `.env` so the dApp can
# call `trustline_onboard.onboard(...)` against this asset on testnet.

set -euo pipefail

SOURCE="${SOURCE:-me}"
ASSET_CODE="${ASSET_CODE:-TESTV}"
NETWORK="${NETWORK:-testnet}"
WASM="target/wasm32v1-none/release/eurcv_auth_stub.wasm"

if ! command -v stellar >/dev/null 2>&1; then
    echo "error: stellar CLI not found on PATH" >&2
    exit 1
fi

# Ensure the source key exists in the local keystore.
if ! stellar keys public-key "$SOURCE" >/dev/null 2>&1; then
    echo ">> generating new key '$SOURCE'"
    stellar keys generate "$SOURCE" --network "$NETWORK" --fund
fi
SOURCE_ADDR="$(stellar keys public-key "$SOURCE")"
echo ">> source: $SOURCE = $SOURCE_ADDR"

# Top up just in case the account was created earlier without funding.
stellar keys fund "$SOURCE" --network "$NETWORK" >/dev/null 2>&1 || true

ASSET="$ASSET_CODE:$SOURCE_ADDR"
echo ">> asset: $ASSET"

# Set issuer flags so this asset requires explicit trustline authorization.
echo ">> setting issuer flags (auth_required, auth_revocable)"
stellar tx new set-options \
    --source "$SOURCE" \
    --network "$NETWORK" \
    --set-required \
    --set-revocable

# Build all workspace contracts (in particular eurcv-auth-stub).
echo ">> building contracts"
cargo build --release --target wasm32v1-none

# Deploy the Stellar Asset Contract for our classic asset.
echo ">> deploying SAC for $ASSET"
SAC="$(stellar contract asset deploy \
    --source "$SOURCE" \
    --network "$NETWORK" \
    --asset "$ASSET")"
echo ">> SAC: $SAC"

# Deploy the stub admin contract, passing the SAC as a constructor arg.
echo ">> deploying eurcv-auth-stub"
STUB="$(stellar contract deploy \
    --wasm "$WASM" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    -- \
    --sac "$SAC")"
echo ">> stub: $STUB"

# Hand SAC admin to the stub so its set_authorized calls succeed.
echo ">> transferring SAC admin to stub"
stellar contract invoke \
    --id "$SAC" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    -- set_admin --new_admin "$STUB"

cat <<EOF

==========================================================================
Done. Paste these into .env (overwriting any prior test-asset values):

PUBLIC_TEST_ASSET_CODE="$ASSET_CODE"
PUBLIC_TEST_ASSET_ISSUER="$SOURCE_ADDR"
PUBLIC_TEST_SAC="$SAC"
PUBLIC_EURCV_AUTH_CONTRACT_ID="$STUB"

(PUBLIC_TRUSTLINE_ONBOARD_CONTRACT_ID stays whatever you already deployed.)

Explorer: https://stellar.expert/explorer/testnet/contract/$STUB
==========================================================================
EOF
