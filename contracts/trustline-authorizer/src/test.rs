#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events, IssuerFlags, StellarAssetContract};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{vec, Address, Env, Event};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

struct Fixture {
    env: Env,
    admin: Address,
    sac: StellarAssetContract,
    authorizer: Address,
}

impl Fixture {
    /// An `AUTH_REQUIRED` + `AUTH_REVOCABLE` asset whose SAC admin is the
    /// authorizer under test — the exact on-chain shape of a regulated asset.
    fn new(policy: Policy) -> Self {
        Self::with_flags(policy, true)
    }

    fn with_flags(policy: Policy, revocable: bool) -> Self {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let issuer = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(issuer);
        sac.issuer().set_flag(IssuerFlags::RequiredFlag);
        if revocable {
            sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        }

        let admin = Address::generate(&env);
        let authorizer = env.register(
            TrustlineAuthorizer,
            (admin.clone(), sac.address(), policy),
        );
        StellarAssetClient::new(&env, &sac.address()).set_admin(&authorizer);

        Self {
            env,
            admin,
            sac,
            authorizer,
        }
    }

    fn client(&self) -> TrustlineAuthorizerClient<'_> {
        TrustlineAuthorizerClient::new(&self.env, &self.authorizer)
    }

    fn sac_client(&self) -> StellarAssetClient<'_> {
        StellarAssetClient::new(&self.env, &self.sac.address())
    }

    /// A real on-ledger `G`-account. `Address::generate` yields C-addresses,
    /// for which CAP-73 `trust()` is a no-op and no classic trustline exists —
    /// so anything asserting on trustline state needs one of these. The issuer
    /// of an unrelated asset is the cheapest G-account the test env offers.
    fn g_account(&self) -> Address {
        self.env
            .register_stellar_asset_contract_v2(Address::generate(&self.env))
            .issuer()
            .address()
    }

    /// A `G`-account holding an (unauthorized) trustline to the asset.
    fn holder_with_trustline(&self) -> Address {
        let holder = self.g_account();
        self.sac_client().trust(&holder);
        holder
    }

    /// Topic-0 symbols of the events this contract published **during the most
    /// recent top-level invocation** — the test env resets the buffer on every
    /// call, so assert right after the call you care about.
    fn event_names(&self) -> std::vec::Vec<std::string::String> {
        self.env
            .events()
            .all()
            .filter_by_contract(&self.authorizer)
            .events()
            .iter()
            .map(|e| {
                let soroban_sdk::xdr::ContractEventBody::V0(body) = &e.body;
                match body.topics.first() {
                    Some(soroban_sdk::xdr::ScVal::Symbol(s)) => {
                        std::string::String::from_utf8_lossy(s.0.as_slice()).into_owned()
                    }
                    _ => std::string::String::new(),
                }
            })
            .collect()
    }

    /// Does `holder` have a classic trustline? Probed with the admin-only
    /// `set_authorized`, which the SAC rejects outright when the trustline is
    /// missing — `authorized()` cannot discriminate, since it reads false both
    /// for "no trustline" and "trustline, not authorized".
    ///
    /// Side effect: on success the holder ends up authorized — call it last.
    fn has_trustline(&self, holder: &Address) -> bool {
        matches!(
            self.sac_client().try_set_authorized(holder, &true),
            Ok(Ok(()))
        )
    }

    fn assert_emitted(&self, name: &str) {
        let names = self.event_names();
        assert!(
            names.iter().any(|n| n == name),
            "expected a `{name}` event, saw {names:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

#[test]
fn constructor_records_admin_sac_and_policy() {
    let f = Fixture::new(Policy::Denylist);
    let c = f.client();
    assert_eq!(c.admin(), f.admin);
    assert_eq!(c.sac(), f.sac.address());
    assert_eq!(c.policy(), Policy::Denylist);
    assert!(!c.is_paused());
    // The SAC really did hand over adminship — otherwise nothing below works.
    assert_eq!(f.sac_client().admin(), f.authorizer);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // NotSac
fn constructor_rejects_a_non_sac_address() {
    let env = Env::default();
    // A wasm contract is not a built-in Stellar Asset Contract, so it can never
    // grant this contract authorization authority.
    let not_a_sac = env.register(TrustlineAuthorizer, {
        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        (Address::generate(&env), sac.address(), Policy::Denylist)
    });
    env.register(
        TrustlineAuthorizer,
        (Address::generate(&env), not_a_sac, Policy::Denylist),
    );
}

// ---------------------------------------------------------------------------
// Denylist policy — open by default
// ---------------------------------------------------------------------------

#[test]
fn denylist_authorizes_anyone_not_banned() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    assert!(!f.sac_client().authorized(&holder));

    f.client().authorize_trustline(&holder);
    f.assert_emitted("authorized");

    assert!(f.sac_client().authorized(&holder));
}

#[test]
fn denylist_rejects_a_banned_account_with_a_typed_error() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    f.client().add_banned_accounts(&vec![&f.env, holder.clone()]);

    assert_eq!(
        f.client().try_authorize_trustline(&holder),
        Err(Ok(Error::AccountBanned))
    );
    assert!(!f.sac_client().authorized(&holder));
}

#[test]
fn a_ban_lands_before_the_trustline_exists_and_still_bites_afterwards() {
    // The issuer's pre-emptive control: ban an address that has never touched
    // the asset. This is also the "delete and recreate the trustline" defence —
    // a recreated trustline is indistinguishable from a first one, and the ban
    // lives in contract storage keyed by ADDRESS, not by trustline.
    let f = Fixture::new(Policy::Denylist);
    let never_seen = f.g_account();
    f.client()
        .add_banned_accounts(&vec![&f.env, never_seen.clone()]);
    assert!(f.client().is_banned(&never_seen));

    // Now the banned address opens a brand-new trustline and tries to onboard.
    f.sac_client().trust(&never_seen);
    assert_eq!(
        f.client().try_authorize_trustline(&never_seen),
        Err(Ok(Error::AccountBanned))
    );
    assert!(!f.sac_client().authorized(&never_seen));
}

#[test]
fn unban_restores_eligibility() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.add_banned_accounts(&vec![&f.env, holder.clone()]);
    c.remove_banned_accounts(&vec![&f.env, holder.clone()]);

    assert!(!c.is_banned(&holder));
    c.authorize_trustline(&holder);
    assert!(f.sac_client().authorized(&holder));
}

// ---------------------------------------------------------------------------
// Allowlist policy — gated
// ---------------------------------------------------------------------------

#[test]
fn allowlist_rejects_everyone_until_allowed() {
    let f = Fixture::new(Policy::Allowlist);
    let holder = f.holder_with_trustline();
    let c = f.client();

    assert_eq!(
        c.try_authorize_trustline(&holder),
        Err(Ok(Error::AccountNotAllowed))
    );

    c.allow(&vec![&f.env, holder.clone()]);
    c.authorize_trustline(&holder);
    assert!(f.sac_client().authorized(&holder));
}

#[test]
fn disallow_blocks_the_next_authorization() {
    let f = Fixture::new(Policy::Allowlist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.allow(&vec![&f.env, holder.clone()]);
    c.authorize_trustline(&holder);

    c.disallow(&vec![&f.env, holder.clone()]);

    // The policy is re-evaluated on every call — a prior success is not cached.
    assert_eq!(
        c.try_authorize_trustline(&holder),
        Err(Ok(Error::AccountNotAllowed))
    );
}

#[test]
fn the_two_policy_sets_are_independent_across_a_switch() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.add_banned_accounts(&vec![&f.env, holder.clone()]);

    c.set_policy(&Policy::Allowlist);
    assert_eq!(
        c.try_authorize_trustline(&holder),
        Err(Ok(Error::AccountNotAllowed))
    );

    // Switching back must not have quietly reinterpreted the allowlist as bans.
    c.set_policy(&Policy::Denylist);
    assert!(c.is_banned(&holder));
    assert_eq!(
        c.try_authorize_trustline(&holder),
        Err(Ok(Error::AccountBanned))
    );
}

// ---------------------------------------------------------------------------
// Freeze lifecycle — the headline invariant
// ---------------------------------------------------------------------------

#[test]
fn a_frozen_account_cannot_get_re_authorized() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.authorize_trustline(&holder);
    assert!(f.sac_client().authorized(&holder));

    c.freeze_accounts(&vec![&f.env, holder.clone()]);

    // Freeze is ban + deauthorize, both halves.
    assert!(!f.sac_client().authorized(&holder));
    assert!(c.is_banned(&holder));

    // …and the retry — the replayed `onboard()` an attacker would try — is
    // refused with a typed error, not silently re-authorized.
    assert_eq!(
        c.try_authorize_trustline(&holder),
        Err(Ok(Error::AccountBanned))
    );
    assert!(!f.sac_client().authorized(&holder));
}

#[test]
fn a_frozen_account_cannot_get_re_authorized_under_the_allowlist_either() {
    let f = Fixture::new(Policy::Allowlist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.allow(&vec![&f.env, holder.clone()]);
    c.authorize_trustline(&holder);

    c.freeze_accounts(&vec![&f.env, holder.clone()]);

    assert!(!c.is_allowed(&holder));
    assert!(!f.sac_client().authorized(&holder));
    assert_eq!(
        c.try_authorize_trustline(&holder),
        Err(Ok(Error::AccountNotAllowed))
    );
}

#[test]
fn freezing_an_account_with_no_trustline_still_bans_it() {
    let f = Fixture::new(Policy::Denylist);
    let stranger = f.g_account();
    let c = f.client();

    c.freeze_accounts(&vec![&f.env, stranger.clone()]);

    // The event records that the SAC half did not run, so the audit trail is
    // truthful about what happened on-chain.
    f.assert_emitted("frozen");
    assert!(c.is_banned(&stranger));
    f.sac_client().trust(&stranger);
    assert_eq!(
        c.try_authorize_trustline(&stranger),
        Err(Ok(Error::AccountBanned))
    );
}

#[test]
fn unfreeze_reverses_both_halves() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.authorize_trustline(&holder);
    c.freeze_accounts(&vec![&f.env, holder.clone()]);

    c.unfreeze_accounts(&vec![&f.env, holder.clone()]);

    assert!(!c.is_banned(&holder));
    assert!(f.sac_client().authorized(&holder));
}

#[test]
fn deauthorize_trustline_is_not_a_freeze() {
    // Documented, deliberate asymmetry: `deauthorize_trustline` is the
    // transient tool and leaves the policy untouched, so a denylisted asset
    // lets the holder re-authorize. Anyone wanting a durable stop must use
    // `freeze_accounts` — which is exactly why freeze exists as its own call.
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.authorize_trustline(&holder);

    c.deauthorize_trustline(&holder, &Reason::KycExpired);

    assert!(!f.sac_client().authorized(&holder));
    assert!(!c.is_banned(&holder));
    c.authorize_trustline(&holder);
    assert!(f.sac_client().authorized(&holder));
}

#[test]
fn deauthorizing_an_account_without_a_trustline_is_a_typed_error() {
    let f = Fixture::new(Policy::Denylist);
    let stranger = f.g_account();
    assert_eq!(
        f.client()
            .try_deauthorize_trustline(&stranger, &Reason::Sanctions),
        Err(Ok(Error::NoTrustline))
    );
}

#[test]
fn freeze_needs_auth_revocable_to_deauthorize() {
    // Without AUTH_REVOCABLE the asset refuses the deauthorize half. The ban
    // still lands (fail-safe direction) and the event says `deauthorized:
    // false`, so an operator can see the issuer flag is missing.
    let f = Fixture::with_flags(Policy::Denylist, false);
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.authorize_trustline(&holder);

    c.freeze_accounts(&vec![&f.env, holder.clone()]);

    assert!(c.is_banned(&holder));
    assert!(f.sac_client().authorized(&holder)); // the SAC half could not run
    assert_eq!(
        c.try_authorize_trustline(&holder),
        Err(Ok(Error::AccountBanned))
    );
}

// ---------------------------------------------------------------------------
// Pause — the emergency stop
// ---------------------------------------------------------------------------

#[test]
fn paused_rejects_everything() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    let other = Address::generate(&f.env);
    let c = f.client();
    c.authorize_trustline(&holder);

    c.pause();
    assert!(c.is_paused());

    let batch = vec![&f.env, other.clone()];
    assert_eq!(
        c.try_authorize_trustline(&other),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        c.try_deauthorize_trustline(&holder, &Reason::Sanctions),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        c.try_add_banned_accounts(&batch),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        c.try_remove_banned_accounts(&batch),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(c.try_allow(&batch), Err(Ok(Error::ContractPaused)));
    assert_eq!(c.try_disallow(&batch), Err(Ok(Error::ContractPaused)));
    assert_eq!(
        c.try_freeze_accounts(&batch),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        c.try_unfreeze_accounts(&batch),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        c.try_mint_to_account(&holder, &1),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(c.try_clawback(&holder, &1), Err(Ok(Error::ContractPaused)));
    assert_eq!(
        c.try_set_policy(&Policy::Allowlist),
        Err(Ok(Error::ContractPaused))
    );

    // Nothing changed on-chain while paused.
    assert!(f.sac_client().authorized(&holder));
    assert!(!c.is_banned(&other));
}

#[test]
fn pause_leaves_recovery_open() {
    // Recovery must survive the emergency stop: an admin swap, an upgrade and
    // the unpause itself all stay callable, or a paused contract would be
    // unrecoverable.
    let f = Fixture::new(Policy::Denylist);
    let c = f.client();
    c.pause();

    let new_admin = Address::generate(&f.env);
    c.set_admin(&new_admin);
    assert_eq!(c.admin(), new_admin);

    c.unpause();
    assert!(!c.is_paused());
}

#[test]
fn pause_and_unpause_are_not_idempotent() {
    let f = Fixture::new(Policy::Denylist);
    let c = f.client();
    assert_eq!(c.try_unpause(), Err(Ok(Error::PauseUnchanged)));
    c.pause();
    assert_eq!(c.try_pause(), Err(Ok(Error::PauseUnchanged)));
}

// ---------------------------------------------------------------------------
// Supply
// ---------------------------------------------------------------------------

#[test]
fn mint_and_clawback_move_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
    let admin = Address::generate(&env);
    let authorizer = env.register(
        TrustlineAuthorizer,
        (admin, sac.address(), Policy::Denylist),
    );
    StellarAssetClient::new(&env, &sac.address()).set_admin(&authorizer);

    let holder = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .issuer()
        .address();
    StellarAssetClient::new(&env, &sac.address()).trust(&holder);
    let c = TrustlineAuthorizerClient::new(&env, &authorizer);
    c.authorize_trustline(&holder);

    c.mint_to_account(&holder, &1_000);
    assert_eq!(TokenClient::new(&env, &sac.address()).balance(&holder), 1_000);

    c.clawback(&holder, &400);
    assert_eq!(TokenClient::new(&env, &sac.address()).balance(&holder), 600);
}

#[test]
fn clawback_without_the_issuer_flag_is_a_typed_error() {
    let f = Fixture::new(Policy::Denylist); // no ClawbackEnabledFlag
    let holder = f.holder_with_trustline();
    let c = f.client();
    c.authorize_trustline(&holder);
    c.mint_to_account(&holder, &100);

    assert_eq!(c.try_clawback(&holder, &50), Err(Ok(Error::AssetRefused)));
}

#[test]
fn minting_to_an_unauthorized_holder_is_refused() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline(); // trustline exists but unauthorized
    assert_eq!(
        f.client().try_mint_to_account(&holder, &1),
        Err(Ok(Error::AssetRefused))
    );
}

#[test]
fn non_positive_amounts_are_rejected() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    assert_eq!(
        c.try_mint_to_account(&holder, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(c.try_clawback(&holder, &-1), Err(Ok(Error::InvalidAmount)));
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

#[test]
fn authorizing_an_account_with_no_trustline_is_a_typed_error() {
    let f = Fixture::new(Policy::Denylist);
    let stranger = f.g_account();
    assert_eq!(
        f.client().try_authorize_trustline(&stranger),
        Err(Ok(Error::NoTrustline))
    );
}

#[test]
fn the_authorizer_cannot_authorize_itself() {
    let f = Fixture::new(Policy::Denylist);
    let authorizer = f.authorizer.clone();
    assert_eq!(
        f.client().try_authorize_trustline(&authorizer),
        Err(Ok(Error::CannotAuthorizeAdminContract))
    );
}

#[test]
fn batches_are_bounded() {
    let f = Fixture::new(Policy::Denylist);
    let c = f.client();
    assert_eq!(
        c.try_add_banned_accounts(&vec![&f.env]),
        Err(Ok(Error::InvalidBatch))
    );

    let mut too_many = vec![&f.env];
    for _ in 0..=MAX_BATCH {
        too_many.push_back(Address::generate(&f.env));
    }
    assert_eq!(
        c.try_add_banned_accounts(&too_many),
        Err(Ok(Error::InvalidBatch))
    );
}

#[test]
#[should_panic] // require_auth on a non-admin address
fn admin_calls_require_the_admin_signature() {
    let f = Fixture::new(Policy::Denylist);
    // Drop the blanket mock and re-authorize only a stranger: the admin's
    // `require_auth()` now has nothing to satisfy it.
    f.env.set_auths(&[]);
    f.client()
        .add_banned_accounts(&vec![&f.env, Address::generate(&f.env)]);
}

#[test]
fn set_admin_moves_control() {
    let f = Fixture::new(Policy::Denylist);
    let c = f.client();
    let new_admin = Address::generate(&f.env);
    c.set_admin(&new_admin);
    f.assert_emitted("admin_changed");

    assert_eq!(c.admin(), new_admin);
}

#[test]
fn is_eligible_previews_the_policy_decision() {
    let f = Fixture::new(Policy::Denylist);
    let stranger = Address::generate(&f.env);
    let c = f.client();
    // No trustline yet, but eligible — the CLI uses this to explain a refusal
    // before spending a transaction on it.
    assert!(c.is_eligible(&stranger));
    c.add_banned_accounts(&vec![&f.env, stranger.clone()]);
    assert!(!c.is_eligible(&stranger));
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

#[test]
fn every_state_transition_emits_an_event() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    let c = f.client();
    let batch = vec![&f.env, holder.clone()];

    c.authorize_trustline(&holder);
    f.assert_emitted("authorized");
    c.add_banned_accounts(&batch);
    f.assert_emitted("banned");
    c.remove_banned_accounts(&batch);
    f.assert_emitted("unbanned");
    c.freeze_accounts(&batch);
    f.assert_emitted("frozen");
    c.unfreeze_accounts(&batch);
    f.assert_emitted("unfrozen");
    c.deauthorize_trustline(&holder, &Reason::IssuerRequest);
    f.assert_emitted("deauthorized");
    c.set_policy(&Policy::Allowlist);
    f.assert_emitted("policy_set");
    c.allow(&batch);
    f.assert_emitted("allowed");
    c.disallow(&batch);
    f.assert_emitted("disallowed");
    c.pause();
    f.assert_emitted("paused");
    c.unpause();
    f.assert_emitted("unpaused");
}

#[test]
fn the_authorized_event_carries_policy_admin_and_ledger() {
    let f = Fixture::new(Policy::Denylist);
    let holder = f.holder_with_trustline();
    f.client().authorize_trustline(&holder);

    // Exact-shape assertion: an indexer reading this event gets the account
    // (as a topic), the policy in force, the admin that stood behind the
    // decision, and the ledger — SEP §8's audit row, in full.
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.authorizer),
        std::vec![Authorized {
            account: holder,
            policy: Policy::Denylist,
            authorizer_admin: f.admin.clone(),
            ledger: f.env.ledger().sequence(),
        }
        .to_xdr(&f.env, &f.authorizer)],
    );
}

// ---------------------------------------------------------------------------
// Integration with the onboard router
//
// The router discovers this contract from `SAC.admin()` and calls
// `authorize_trustline` inside the holder's single signed transaction. These
// tests pin the contract between the two: a typed rejection must roll the
// whole onboarding back, and a success must come back as `Authorized`.
// ---------------------------------------------------------------------------

mod router {
    use super::*;
    use trustline_onboard::{
        Error as RouterError, OnboardStatus, TrustlineOnboard, TrustlineOnboardClient,
    };

    /// The real router, deployed fresh — it is stateless, so one per test.
    fn router(f: &Fixture) -> Address {
        f.env.register(TrustlineOnboard, ())
    }

    #[test]
    fn onboard_discovers_this_authorizer_and_returns_authorized() {
        let f = Fixture::new(Policy::Denylist);
        let holder = f.g_account();

        // One call, one holder signature: trustline created AND authorized.
        assert_eq!(
            TrustlineOnboardClient::new(&f.env, &router(&f)).onboard(&f.sac.address(), &holder),
            OnboardStatus::Authorized
        );
        assert!(f.sac_client().authorized(&holder));
    }

    #[test]
    fn onboard_rolls_back_entirely_when_the_holder_is_banned() {
        let f = Fixture::new(Policy::Denylist);
        let holder = f.g_account();
        f.client().add_banned_accounts(&vec![&f.env, holder.clone()]);

        assert_eq!(
            TrustlineOnboardClient::new(&f.env, &router(&f)).try_onboard(&f.sac.address(), &holder),
            Err(Ok(RouterError::AuthorizationRefused))
        );

        // Atomicity: the trustline the router created in the same transaction
        // is gone too, so a banned address is left with no footprint at all.
        assert!(!f.has_trustline(&holder));
    }

    #[test]
    fn onboard_cannot_re_authorize_a_frozen_holder() {
        // The replay an attacker would actually try: get authorized, get
        // frozen, then run the public one-signature onboarding again.
        let f = Fixture::new(Policy::Denylist);
        let holder = f.g_account();
        let id = router(&f);
        let r = TrustlineOnboardClient::new(&f.env, &id);
        assert_eq!(
            r.onboard(&f.sac.address(), &holder),
            OnboardStatus::Authorized
        );

        f.client().freeze_accounts(&vec![&f.env, holder.clone()]);

        assert_eq!(
            r.try_onboard(&f.sac.address(), &holder),
            Err(Ok(RouterError::AuthorizationRefused))
        );
        assert!(!f.sac_client().authorized(&holder));
    }

    #[test]
    fn a_paused_authorizer_stops_the_router_too() {
        let f = Fixture::new(Policy::Denylist);
        let holder = f.g_account();
        f.client().pause();

        assert_eq!(
            TrustlineOnboardClient::new(&f.env, &router(&f)).try_onboard(&f.sac.address(), &holder),
            Err(Ok(RouterError::AuthorizationRefused))
        );
    }

    #[test]
    fn allowlist_assets_onboard_only_after_the_issuer_allows() {
        let f = Fixture::new(Policy::Allowlist);
        let holder = f.g_account();
        let id = router(&f);
        let r = TrustlineOnboardClient::new(&f.env, &id);

        assert_eq!(
            r.try_onboard(&f.sac.address(), &holder),
            Err(Ok(RouterError::AuthorizationRefused))
        );

        f.client().allow(&vec![&f.env, holder.clone()]);
        assert_eq!(
            r.onboard(&f.sac.address(), &holder),
            OnboardStatus::Authorized
        );
    }
}
