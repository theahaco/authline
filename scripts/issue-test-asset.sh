#!/usr/bin/env bash
#
# Issue a classic Stellar test asset and deploy its Stellar Asset Contract
# (SAC). Two modes:
#   REGULATED=1 (default): AUTH_REQUIRED + AUTH_REVOCABLE issuer, deploy the
#       asset-agnostic Trustline Authorizer and hand SAC admin rights to it.
#   REGULATED=0: plain OPEN asset — issuer auth flags cleared, no authorizer.
#
# Usage:
#     ./scripts/issue-test-asset.sh
#
# Env overrides:
#     SOURCE       stellar CLI key alias for the issuer (default: me)
#     ASSET_CODE   4-12 char asset code            (default: TESTV)
#     NETWORK      stellar network alias           (default: testnet)
#     REGULATED    1 = AUTH_REQUIRED + Trustline Authorizer as SAC admin (default);
#                  0 = plain OPEN asset: no issuer auth flags, no authorizer —
#                      just the asset + its SAC (e.g. an EURC/BLND-style token)
#     POLICY       Denylist (default, open-by-default) | Allowlist (KYC-gated)
#     CLAWBACK     1 = also set AUTH_CLAWBACK_ENABLED so `clawback` works
#
# NOTE: SAC adminship is one-way. Once the SAC admin is a contract, only that
# contract can hand it on, so an asset whose admin is a stub with no `set_admin`
# is stuck with it forever — which is why replacing the Tranche-1 stub means
# re-issuing the test asset rather than re-pointing the old one.
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
POLICY="${POLICY:-Denylist}"
CLAWBACK="${CLAWBACK:-0}"
case "$POLICY" in
    Denylist|Allowlist) ;;
    *)
        echo "error: POLICY must be Denylist or Allowlist (got '$POLICY')" >&2
        exit 1
        ;;
esac
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
WASM="target/wasm32v1-none/release/trustline_authorizer.wasm"

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
    # AUTH_REVOCABLE is what makes `freeze` able to deauthorize; without it the
    # authorizer can still ban, but the SAC half of a freeze is refused.
    CLAWBACK_FLAG=""
    if [ "$CLAWBACK" = "1" ]; then CLAWBACK_FLAG="--set-clawback-enabled"; fi
    echo ">> setting issuer flags (auth_required, auth_revocable${CLAWBACK_FLAG:+, clawback})"
    # shellcheck disable=SC2086
    stellar tx new set-options \
        --source "$SOURCE" \
        --network "$NETWORK" \
        --set-required \
        --set-revocable \
        $CLAWBACK_FLAG

    echo ">> building contracts"
    cargo build --release --target wasm32v1-none -p trustline-authorizer
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

AUTHORIZER=""
if [ "$REGULATED" = "1" ]; then
    # Deploy the authorizer. The issuer key becomes its admin, so the same
    # person who controls the asset controls bans, freezes and the pause.
    echo ">> deploying trustline-authorizer (policy: $POLICY)"
    AUTHORIZER="$(stellar contract deploy \
        --wasm "$WASM" \
        --source "$SOURCE" \
        --network "$NETWORK" \
        -- \
        --admin "$SOURCE_ADDR" \
        --sac "$SAC" \
        --policy "$POLICY")"
    echo ">> authorizer: $AUTHORIZER"

    # Hand SAC admin over — this is what gives the contract the authority to
    # flip trustline flags, and it is irreversible from the issuer's side.
    echo ">> transferring SAC admin to the authorizer"
    stellar contract invoke \
        --id "$SAC" \
        --source "$SOURCE" \
        --network "$NETWORK" \
        -- set_admin --new_admin "$AUTHORIZER"
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
PUBLIC_AUTHORIZER="$AUTHORIZER"
PUBLIC_ASSET_REVOCABLE="true"
EOF
    cat <<EOF

Admin it with the issuer key:
    npm run authorizer -- status --id $AUTHORIZER --source $SOURCE
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

Explorer: https://stellar.expert/explorer/testnet/contract/${AUTHORIZER:-$SAC}
EOF
fi
echo "=========================================================================="
