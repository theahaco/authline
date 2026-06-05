# Onboard Cleanup PR — Implementation Plan

> **For agentic workers:** Executed subagent-driven (implementer + review per
> task). Steps use `- [ ]`.

**Goal:** Land the still-applicable deferred review findings as a PR stacked on
`feature/p26-one-step-trustline`.

**Branch:** `feature/p26-onboard-cleanup` (already created, off the feature
work).

**Scope basis:** Re-scoped against current HEAD (the multi-asset rewrite mooted
~7 original FE findings). This plan covers the STILL-APPLIES / PARTIAL items
that are low-to-medium risk. Verification gates: `cargo test` (contracts),
`npm run typecheck && npm run lint && npm run build` (frontend),
`bash -n`/shellcheck reasoning (scripts).

**Explicitly EXCLUDED (with reason):**

- **Contract error-forwarding** (collapse → distinct authorizer codes / treat
  already-authorized as success): needs the real EURCV authorizer error spec,
  which is not in this repo. Defer until available.
- **Full removal of the dead `eurcv_auth.ts` binding + `eurcvAuthContractId`**:
  entangled — `packages/eurcv_auth` + `src/contracts/eurcv_auth.ts` are
  git-tracked AND `eurcv_auth` is pinned in
  `environments.toml [production.contracts]`, so `stellar scaffold` regenerates
  them. Durable removal needs dropping that pin + two `.gitignore` allow-lines —
  a scaffold-config decision for the human. Surfaced separately, not
  auto-applied.
- **`stellar-registry 0.0.4` → stale `stellar-xdr 23` bump** and **stub dedup**:
  build-graph risk disproportionate to a cleanup PR.
- **Dropping the redundant `holder.require_auth()` / `map_err` diagnostics
  rework**: touches contract auth semantics; opportunistic only.

---

## Task 1: Deploy/ops script hardening

**Files:** Modify `scripts/deploy-mainnet.sh`, `scripts/issue-test-asset.sh`

- [ ] **Step 1: Determine the actual optimized WASM artifact path.** If the
      `stellar` CLI is available, run `stellar contract build --optimize` and
      `ls target/wasm32v1-none/release/*.wasm` to see the real artifact name. If
      not available, use the documented optimized path
      `target/wasm32v1-none/release/trustline_onboard.optimized.wasm`. Either
      way the existence guard (Step 2) makes a wrong path fail loudly instead of
      shipping the wrong file.

- [ ] **Step 2: Fix `scripts/deploy-mainnet.sh`.**
  - Set the WASM var to the OPTIMIZED artifact produced by the current
    `stellar contract build --optimize` build step, i.e. change line ~21
    `WASM="target/wasm32v1-none/release/trustline_onboard.wasm"` to the
    optimized path determined in Step 1 (e.g.
    `WASM="target/wasm32v1-none/release/trustline_onboard.optimized.wasm"`).
  - If `stellar contract build` supports a package filter, scope it:
    `stellar contract build --optimize --package trustline-onboard` (verify the
    flag exists with `stellar contract build --help`; if not, leave the build
    as-is — it builds the whole workspace, which is acceptable).
  - Add an existence guard immediately after the build step, before the deploy:
    ```bash
    if [[ ! -f "$WASM" ]]; then
        echo "error: expected build artifact not found: $WASM" >&2
        exit 1
    fi
    ```

- [ ] **Step 3: Fix `scripts/issue-test-asset.sh`.**
  - Add a network guard near the top (after `NETWORK="${NETWORK:-testnet}"`):
    ```bash
    case "$NETWORK" in
        testnet|futurenet|local|standalone) ;;
        *)
            echo "error: refusing to run against network '$NETWORK' — test/dev networks only." >&2
            exit 1
            ;;
    esac
    ```
  - The funding line
    `stellar keys fund "$SOURCE" --network "$NETWORK" >/dev/null 2>&1 || true`
    keeps `|| true` (required under `set -e` for the already-funded case) but
    drop the stderr suppression so genuine errors are visible: change to
    `stellar keys fund "$SOURCE" --network "$NETWORK" >/dev/null || true`.

- [ ] **Step 4: Verify.** Run
      `bash -n scripts/deploy-mainnet.sh && bash -n scripts/issue-test-asset.sh`
      (syntax check). If `shellcheck` is installed, run it on both and confirm
      no new errors.

- [ ] **Step 5: Commit** (this also commits the previously-uncommitted
      `deploy-mainnet.sh` working-tree edit, now corrected):

  ```bash
  git add scripts/deploy-mainnet.sh scripts/issue-test-asset.sh
  git commit -m "fix(scripts): deploy the optimized wasm + guard; testnet-only guard for issue-test

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2: Frontend robustness

**Files:** Modify `src/components/AuthorizeTrustline.tsx`,
`src/hooks/useOnboard.ts`

- [ ] **Step 1: Gate action buttons on `isWrongNetwork`**
      (`AuthorizeTrustline.tsx`). Add `|| isWrongNetwork` to the `disabled`
      expression of each of the three action buttons (the one-step, classic, and
      authorize buttons). Example for the classic button:

  ```tsx
  disabled={
      ob.classic.status === "loading" ||
      ob.hasTrustline ||
      ob.checking ||
      isWrongNetwork
  }
  ```

  Do the same for the one-step button
  (`ob.oneStep.status === "loading" || ob.checking || isWrongNetwork`) and the
  authorize button (add `|| isWrongNetwork`). `isWrongNetwork` is
  `string | boolean | undefined`; coerce if the linter complains:
  `|| !!isWrongNetwork`.

- [ ] **Step 2: Distinguish 404 from transient errors in `refresh`**
      (`useOnboard.ts`, the `refresh` callback's `catch`). Replace the bare
      `catch { setHasTrustline(false); setIsAuthorized(false) }` with one that
      only resets on a genuine "account not found", and otherwise leaves prior
      state intact:

  ```ts
  } catch (e) {
      // 404 = account not funded / no such account → definitively no trustline.
      // Other (transient/network) errors: keep prior state rather than implying "no trustline".
      const status = (e as { response?: { status?: number } })?.response?.status
      if (status === 404) {
          setHasTrustline(false)
          setIsAuthorized(false)
      }
  } finally {
      setChecking(false)
  }
  ```

  (Keep the existing `finally { setChecking(false) }`.)

- [ ] **Step 3: Align the poll deadline with the tx timeout** (`useOnboard.ts`,
      `pollForSuccess`). The transactions use `.setTimeout(180)` but the poll
      deadline is `60_000`. Change the deadline to `180_000` so a slow-but-valid
      tx isn't reported failed prematurely:

  ```ts
  const deadline = Date.now() + 180_000
  ```

- [ ] **Step 4: Verify.** `npm run typecheck && npm run lint && npm run build` —
      all pass.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/components/AuthorizeTrustline.tsx src/hooks/useOnboard.ts
  git commit -m "fix(ui): gate buttons on wrong-network; 404-vs-transient status; 180s poll

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3: Env-config hardening

**Files:** Modify `src/contracts/util.ts`, `.env.example`

- [ ] **Step 1: Tighten the zod schema** (`util.ts`). Change the RPC/Horizon
      validators from `z.string()` to require a non-empty URL so an empty/blank
      value fails validation instead of producing `new Server("")`:

  ```ts
  PUBLIC_STELLAR_RPC_URL: z.string().url(),
  PUBLIC_STELLAR_HORIZON_URL: z.string().url(),
  ```

- [ ] **Step 2: Surface parse failure + default to LOCAL, not MAINNET**
      (`util.ts`). In the `parsed.success ? ... : {...}` fallback, (a) log the
      error, and (b) make the fallback target the LOCAL/standalone network
      rather than silently pointing at mainnet:

  ```ts
  if (!parsed.success) {
  	console.error(
  		"Invalid PUBLIC_* env configuration; falling back to LOCAL.",
  		parsed.error.flatten(),
  	)
  }
  const env: z.infer<typeof envSchema> = parsed.success
  	? parsed.data
  	: {
  			PUBLIC_STELLAR_NETWORK_PASSPHRASE: WalletNetwork.STANDALONE,
  			PUBLIC_STELLAR_RPC_URL: "http://localhost:8000/rpc",
  			PUBLIC_STELLAR_HORIZON_URL: "http://localhost:8000",
  		}
  ```

  (Confirm the correct enum member name for standalone/local in
  `@creit.tech/stellar-wallets-kit`'s `WalletNetwork` — it may be `STANDALONE`
  or `FUTURENET`/etc.; pick the standalone/local one. If none exists, keep the
  passphrase string `"Standalone Network ; February 2017"` cast appropriately.)

- [ ] **Step 3: Fill the mainnet block in `.env.example`** so the commented
      MAINNET section has real endpoints instead of empty values:

  ```
  # PUBLIC_STELLAR_RPC_URL="https://soroban-rpc.mainnet.stellar.gateway.fm"
  # PUBLIC_STELLAR_HORIZON_URL="https://horizon.stellar.org"
  ```

  (Replace the two empty `PUBLIC_STELLAR_RPC_URL=` /
  `PUBLIC_STELLAR_HORIZON_URL=` lines in the mainnet block.)

- [ ] **Step 4: Verify.** `npm run typecheck && npm run lint && npm run build` —
      all pass.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/contracts/util.ts .env.example
  git commit -m "fix(config): require URL env vars; fail to LOCAL not MAINNET; real mainnet example endpoints

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4: Config / repo hygiene

**Files:** Modify `environments.toml`, `Cargo.toml`, `CLAUDE.md`

- [ ] **Step 1: `environments.toml`.**
  - Replace the `production.network` placeholder
    `rpc-url = "https://our-custom-rpc-provider.cool"` with
    `rpc-url = "https://soroban-rpc.mainnet.stellar.gateway.fm"`.
  - Remove the leftover commented-out `[development.contracts.eurc]` "Coming
    Soon" block and the commented placeholder contract list in the staging
    section (the `# soroban-*-contract = ...` lines).
  - Add a one-line comment above the pinned `trustline_onboard = { id = "..." }`
    under `[production.contracts]`:
    `# Keep this id in sync with PUBLIC_TRUSTLINE_ONBOARD_CONTRACT_ID in the frontend .env.`

- [ ] **Step 2: `Cargo.toml` repository URL.** Derive the real repo from the git
      remote: run `git remote get-url origin`. Set the workspace
      `repository = "..."` to that URL (strip any trailing `.git` if you prefer
      the browse URL, but matching the remote is fine). If there is NO `origin`
      remote, leave the field unchanged and note it in the report.

- [ ] **Step 3: `CLAUDE.md` toolchain note.** Find the line stating the Rust
      toolchain is pinned to `1.89.0` and update it to `1.95.0` to match
      `rust-toolchain.toml`.

- [ ] **Step 4: Verify.** `cargo metadata --no-deps >/dev/null` (confirms
      `Cargo.toml` still parses) and `npm run build` is unaffected (toml/md
      changes don't affect it, but a quick `git diff --stat` sanity check is
      enough).

- [ ] **Step 5: Commit.**

  ```bash
  git add environments.toml Cargo.toml CLAUDE.md
  git commit -m "chore: real mainnet rpc in environments.toml; fix repo url + toolchain doc

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5: Contract docs + rollback test

**Files:** Modify `contracts/trustline-onboard/src/lib.rs`,
`contracts/trustline-onboard/src/test.rs`

- [ ] **Step 1: Add a failing-then-rolled-back assertion test (TDD: write
      first).** In `src/test.rs`, add a test that uses the existing
      `FailingAuthorizer` and asserts that after a failed `onboard`, the holder
      is NOT authorized (the whole tx — including `trust` — rolled back):

  ```rust
  #[test]
  fn onboard_failure_rolls_back_trustline() {
      let env = Env::default();
      env.mock_all_auths_allowing_non_root_auth();
      let holder = Address::generate(&env);
      let (sac_addr, onboard_addr) = setup(&env);

      let authorizer = env.register(FailingAuthorizer, ());
      let client = TrustlineOnboardClient::new(&env, &onboard_addr);

      assert_eq!(
          client.try_onboard(&sac_addr, &authorizer, &holder),
          Err(Ok(Error::AuthorizationFailed))
      );
      // The authorize step failed, so the whole call (including trust) rolled back:
      // the holder is not authorized on the SAC.
      assert!(!StellarAssetClient::new(&env, &sac_addr).authorized(&holder));
  }
  ```

- [ ] **Step 2: Run the test — it should PASS immediately** (it documents
      existing atomic behavior; no impl change needed):
      `RUSTC_WRAPPER="" cargo test -p trustline-onboard onboard_failure_rolls_back_trustline`.
      Expected: PASS. (If it unexpectedly fails, STOP and report — that would
      mean the rollback assumption is wrong.)

- [ ] **Step 3: Add doc comments to `onboard` in `lib.rs`** documenting (a) the
      atomic all-or-nothing semantics (a failed authorize rolls back the
      trustline; the holder pays fees but ends with no trustline), and (b) the
      immutable-by-design decision (no admin/upgrade entrypoint; a bug requires
      a fresh deploy + env/registry update). Add as a `///` doc block above
      `pub fn onboard`.

- [ ] **Step 4: Verify.** `RUSTC_WRAPPER="" cargo test -p trustline-onboard` —
      all 4 tests pass.

- [ ] **Step 5: Commit.**

  ```bash
  git add contracts/trustline-onboard/src/lib.rs contracts/trustline-onboard/src/test.rs
  git commit -m "docs(onboard): document atomic rollback + immutable design; add rollback test

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6: Discard the package-lock.json reformat noise

**Files:** `package-lock.json` (working-tree only)

- [ ] **Step 1: Confirm no dependency change.** Scoping verified the
      working-tree `package-lock.json` is a pure indentation reformat (tab →
      2-space), 0 dependency/version changes. Re-confirm quickly:
      `git stash show`-style or `git diff --numstat -- package-lock.json`
      (binary/0-0) plus a spot check that no `"version":` lines differ.

- [ ] **Step 2: Restore the committed version** (discard the unstaged reformat
      noise):
  ```bash
  git checkout -- package-lock.json
  git status --short package-lock.json   # expect: clean (no change)
  ```
  No commit needed — this reverts an unstaged change so the file matches HEAD.
  (If a formatter re-applies the 2-space style on the next `npm` run, that's a
  separate tooling decision for the human.)

---

## Final verification

- [ ] `RUSTC_WRAPPER="" cargo test` — all crates green.
- [ ] `npm run typecheck && npm run lint && npm run build` — all pass.
- [ ] `git log --oneline feature/p26-one-step-trustline..HEAD` — shows the
      cleanup commits only.
- [ ] Commit this plan doc.

## Done criteria

- Deploy script ships the optimized wasm with an existence guard; issue-test is
  testnet-guarded.
- Buttons disabled on wrong network; status refresh distinguishes 404 from
  transient; poll matches the 180s tx timeout.
- Env vars require URLs; misconfig fails to LOCAL with a logged error; example
  mainnet endpoints filled.
- environments.toml/Cargo.toml/CLAUDE.md hygiene fixed.
- Atomic-rollback + immutable design documented and covered by a test.
- package-lock.json reformat noise removed.
