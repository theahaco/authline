#!/usr/bin/env bash
#
# Sync the Nido stellar-wallets-kit module source from theahaco/nido at a
# PINNED commit into packages/nido-wallet-kit/src (gitignored — this script is
# the dependency, the source never lands in this repo's history).
#
# Why not a plain npm git dependency: the module lives in a subdirectory of
# the nido monorepo workspace, which npm git deps cannot install. The module's
# only runtime import, @g2c/passkey-sdk (isContractId), is satisfied by the
# committed packages/g2c-passkey-shim so the synced source stays byte-identical.
#
# Upstream: https://github.com/theahaco/nido (Apache-2.0)
# Re-pin by bumping NIDO_REF and re-running with --force.

set -euo pipefail

NIDO_REF="${NIDO_REF:-7281d96ba5c16635f857d81b56ad49e63f8a7e0e}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/packages/nido-wallet-kit"
SRC_DIR="$DEST/src"

# The pin is ENFORCED, not just recorded: a synced tree from a different ref
# (e.g. after bumping NIDO_REF) is re-synced automatically.
if [ -d "$SRC_DIR" ] && [ "${1:-}" != "--force" ]; then
    if [ "$(cat "$DEST/.upstream-ref" 2>/dev/null)" = "$NIDO_REF" ]; then
        echo ">> nido module source already synced at $NIDO_REF — use --force to re-sync"
        exit 0
    fi
    echo ">> synced ref differs from pin — re-syncing"
fi

echo ">> syncing @g2c/stellar-wallets-kit-module from theahaco/nido@${NIDO_REF:0:12}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://codeload.github.com/theahaco/nido/tar.gz/$NIDO_REF" -o "$TMP/nido.tar.gz"
tar -xzf "$TMP/nido.tar.gz" -C "$TMP" \
    "nido-$NIDO_REF/packages/stellar-wallets-kit-module/src" \
    "nido-$NIDO_REF/LICENSE"

rm -rf "$SRC_DIR"
mkdir -p "$DEST"
cp -R "$TMP/nido-$NIDO_REF/packages/stellar-wallets-kit-module/src" "$SRC_DIR"
cp "$TMP/nido-$NIDO_REF/LICENSE" "$DEST/LICENSE.upstream"
# Tests ship in src/ upstream; they need vitest + jsdom we don't carry here.
rm -f "$SRC_DIR"/*.test.ts
echo "$NIDO_REF" > "$DEST/.upstream-ref"
echo ">> synced to $SRC_DIR (upstream ref recorded in .upstream-ref)"
