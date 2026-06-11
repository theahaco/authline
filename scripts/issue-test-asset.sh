#!/usr/bin/env bash
#
# Issue a classic Stellar test asset and deploy its Stellar Asset Contract
# (SAC). Two modes:
#   REGULATED=1 (default): AUTH_REQUIRED + AUTH_REVOCABLE issuer, deploy the
#       authorizer-stub admin contract and hand SAC admin rights to it.
#   REGULATED=0: plain OPEN asset — issuer auth flags cleared, no authorizer.
#
# Usage:
#     ./scripts/issue-test-asset.sh
#
# Env overrides:
#     SOURCE       stellar CLI key alias for the issuer (default: me)
#     ASSET_CODE   4-12 char asset code            (default: TESTV)
#     NETWORK      stellar network alias           (default: testnet)
#     REGULATED    1 = AUTH_REQUIRED + authorizer-stub as SAC admin (default);
#                  0 = plain OPEN asset: no issuer auth flags, no authorizer —
#                      just the asset + its SAC (e.g. an EURC/BLND-style token)
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
REGULATED="${REGULATED:-1}"
case "$REGULATED" in
    0|1) ;;
    *)
        echo "error: REGULATED must be 0 or 1 (got '$REGULATED')" >&2
        exit 1
        ;;
esac
case "$NETWORK" in
    testnet|futurenet|local|standalone) ;;
    *)
        echo "error: refusing to run against network '$NETWORK' — test/dev networks only." >&2
        exit 1
        ;;
esac
WASM="target/wasm32v1-none/release/authorizer_stub.wasm"

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
stellar keys fund "$SOURCE" --network "$NETWORK" >/dev/null || true

ASSET="$ASSET_CODE:$SOURCE_ADDR"
echo ">> asset: $ASSET"

if [ "$REGULATED" = "1" ]; then
    # Set issuer flags so this asset requires explicit trustline authorization.
    echo ">> setting issuer flags (auth_required, auth_revocable)"
    stellar tx new set-options \
        --source "$SOURCE" \
        --network "$NETWORK" \
        --set-required \
        --set-revocable

    # Build all workspace contracts (in particular authorizer-stub).
    echo ">> building contracts"
    cargo build --release --target wasm32v1-none
else
    # Enforce, don't assume: a reused issuer alias may carry flags from an
    # earlier regulated run, which would make this "open" asset AUTH_REQUIRED.
    echo ">> REGULATED=0 — open asset: clearing issuer auth flags"
    stellar tx new set-options \
        --source "$SOURCE" \
        --network "$NETWORK" \
        --clear-required \
        --clear-revocable
fi

# Deploy the Stellar Asset Contract for our classic asset.
echo ">> deploying SAC for $ASSET"
SAC="$(stellar contract asset deploy \
    --source "$SOURCE" \
    --network "$NETWORK" \
    --asset "$ASSET")"
echo ">> SAC: $SAC"

STUB=""
if [ "$REGULATED" = "1" ]; then
    # Deploy the stub admin contract, passing the SAC as a constructor arg.
    echo ">> deploying authorizer-stub"
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
fi

cat <<EOF

==========================================================================
Done. Paste these into .env (overwriting any prior test-asset values):

PUBLIC_ASSET_CODE="$ASSET_CODE"
PUBLIC_ASSET_ISSUER="$SOURCE_ADDR"
PUBLIC_SAC="$SAC"
EOF
if [ "$REGULATED" = "1" ]; then
    cat <<EOF
PUBLIC_AUTHORIZER="$STUB"
PUBLIC_ASSET_REVOCABLE="true"
EOF
else
    # Explicit blanks: a previous regulated run's values must not survive in
    # .env (a blank PUBLIC_* counts as unset since the env() reader).
    cat <<EOF
PUBLIC_AUTHORIZER=""
PUBLIC_ASSET_REVOCABLE=""
EOF
fi
cat <<EOF

(PUBLIC_ROUTER stays unset — the pinned ROUTERS entry covers testnet. To make
the asset resolvable by PUBLIC_ASSET_CODE alone, pin it in
packages/authline-sdk/src/registry.ts instead.)
EOF
if [ "$NETWORK" = "testnet" ]; then
    cat <<EOF

Explorer: https://stellar.expert/explorer/testnet/contract/${STUB:-$SAC}
EOF
fi
echo "=========================================================================="
