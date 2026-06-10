#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, IssuerFlags};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Address, Env};

// A correct authorizer: installed as the SAC admin, authorizes the account.
#[contract]
pub struct StubAuthorizer;

#[contractimpl]
impl StubAuthorizer {
    pub fn __constructor(env: Env, sac: Address) {
        env.storage().instance().set(&symbol_short!("SAC"), &sac);
    }
}

#[contractimpl]
impl Authorizer for StubAuthorizer {
    fn authorize_trustline(env: Env, account: Address) -> Result<(), soroban_sdk::Error> {
        let sac: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("SAC"))
            .expect("SAC not set");
        StellarAssetClient::new(&env, &sac).set_authorized(&account, &true);
        Ok(())
    }
}

// An authorizer that always REJECTS with a typed contract error. Its error
// enum is deliberately FOREIGN to the router (its code collides with none of
// the router's 1-4): the router must CLASSIFY the rejection, not leak it.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StubError {
    Banned = 77,
}

#[contract]
pub struct FailingAuthorizer;

#[contractimpl]
impl FailingAuthorizer {
    pub fn authorize_trustline(_env: Env, _account: Address) -> Result<(), StubError> {
        Err(StubError::Banned)
    }
}

// An authorizer that returns Ok but does NOT actually authorize the account.
#[contract]
pub struct NoopAuthorizer;

#[contractimpl]
impl NoopAuthorizer {
    pub fn authorize_trustline(_env: Env, _account: Address) -> Result<(), Error> {
        Ok(())
    }
}

/// Register a SAC (optionally AUTH_REQUIRED) + the router. The SAC's initial
/// admin is a generated (instance-less) contract address; tests that need a
/// specific admin call `set_admin` themselves.
///
/// NOTE: `Address::generate` holders are C-addresses — `trust()` no-ops for
/// them and `authorized()` reads the contract-balance flag, so these tests
/// exercise discovery/classification, not classic trustline creation
/// (covered by the testnet e2e).
fn setup(env: &Env, auth_required: bool) -> (Address, Address) {
    let initial_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(initial_admin);
    if auth_required {
        sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    }
    let router = env.register(TrustlineOnboard, ());
    (sac.address(), router)
}

#[test]
fn open_asset_onboards_to_authorized() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, false);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    // Pin `holder.require_auth()`: the holder is the single authorizing
    // address of the onboard invocation's auth tree. `env.auths()` reflects
    // the MOST RECENT invocation, so read it before any further calls.
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, holder);

    assert_eq!(status, OnboardStatus::Authorized);
    assert!(StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn onboard_is_idempotent() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, false);
    let client = TrustlineOnboardClient::new(&env, &router);

    assert_eq!(client.onboard(&sac, &holder), OnboardStatus::Authorized);
    // Re-running is a no-op that still reports the truthful state.
    assert_eq!(client.onboard(&sac, &holder), OnboardStatus::Authorized);
}

#[test]
fn discovers_and_authorizes_via_admin_contract() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let authorizer = env.register(StubAuthorizer, (sac.clone(),));
    StellarAssetClient::new(&env, &sac).set_admin(&authorizer);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::Authorized);
    assert!(StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn typed_rejection_reverts_everything() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let authorizer = env.register(FailingAuthorizer, ());
    StellarAssetClient::new(&env, &sac).set_admin(&authorizer);

    assert_eq!(
        TrustlineOnboardClient::new(&env, &router).try_onboard(&sac, &holder),
        Err(Ok(Error::AuthorizationRefused))
    );
    // The whole call (including trust) rolled back.
    assert!(!StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn admin_without_export_yields_trustline_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let admin = env.register(classification::NoExportContract, ());
    StellarAssetClient::new(&env, &sac).set_admin(&admin);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::TrustlineOnly);
    assert!(!StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn panicking_authorizer_yields_trustline_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let admin = env.register(classification::PanickingAuthorizer, ());
    StellarAssetClient::new(&env, &sac).set_admin(&admin);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::TrustlineOnly);
    assert!(!StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn noop_authorizer_fails_post_condition() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let admin = env.register(NoopAuthorizer, ());
    StellarAssetClient::new(&env, &sac).set_admin(&admin);

    assert_eq!(
        TrustlineOnboardClient::new(&env, &router).try_onboard(&sac, &holder),
        Err(Ok(Error::NotAuthorized))
    );
}

#[test]
fn non_wasm_admin_yields_trustline_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    // Default admin from setup() is a generated, instance-less contract
    // address: executable() == None → same match arm as a G-account admin.
    let (sac, router) = setup(&env, true);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::TrustlineOnly);
}

#[test]
fn g_account_holder_gets_real_trustline() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (sac, router) = setup(&env, false);
    // The issuer of a SECOND asset is a real on-ledger account (G-address).
    let other = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let holder = other.issuer().address();

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::Authorized);
    assert!(StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn impostor_sac_is_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (_real_sac, router) = setup(&env, false);
    let client = TrustlineOnboardClient::new(&env, &router);

    // A wasm contract masquerading as a SAC…
    let impostor = env.register(classification::NoExportContract, ());
    assert_eq!(client.try_onboard(&impostor, &holder), Err(Ok(Error::NotSac)));
    // …a nonexistent contract id…
    let ghost = Address::generate(&env);
    assert_eq!(client.try_onboard(&ghost, &holder), Err(Ok(Error::NotSac)));
    // …and an Account-executable address (a real on-ledger G-account).
    let other = env.register_stellar_asset_contract_v2(Address::generate(&env));
    assert_eq!(
        client.try_onboard(&other.issuer().address(), &holder),
        Err(Ok(Error::NotSac))
    );
}

// ── Environment-semantics spike ──────────────────────────────────────────
// The 2-arg discovery router depends on these soroban-sdk 26 behaviors. They
// are kept as permanent tests so an SDK upgrade that changes them fails HERE,
// not in production classification.
mod classification {
    use super::*;
    use soroban_sdk::xdr::ScErrorType;
    use soroban_sdk::{contract, contractimpl, Executable};

    // A contract that does NOT export `authorize_trustline`.
    #[contract]
    pub struct NoExportContract;

    #[contractimpl]
    impl NoExportContract {
        pub fn ping(_env: Env) {}
    }

    // An authorizer that panics (untyped) instead of returning a typed error.
    #[contract]
    pub struct PanickingAuthorizer;

    #[contractimpl]
    impl PanickingAuthorizer {
        pub fn authorize_trustline(_env: Env, _account: Address) {
            panic!("untyped failure");
        }
    }

    #[test]
    fn native_contracts_report_wasm_executable() {
        let env = Env::default();
        let c = env.register(NoExportContract, ());
        assert!(matches!(c.executable(), Some(Executable::Wasm(_))));
    }

    #[test]
    fn sac_reports_stellar_asset_executable() {
        let env = Env::default();
        let issuer = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(issuer);
        assert_eq!(sac.address().executable(), Some(Executable::StellarAsset));
    }

    #[test]
    fn generated_address_reports_none() {
        let env = Env::default();
        // Address::generate produces a contract id with NO deployed instance.
        assert_eq!(Address::generate(&env).executable(), None);
    }

    #[test]
    fn missing_export_is_recoverable_non_contract_error() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let holder = Address::generate(&env);
        let target = env.register(NoExportContract, ());
        let res = AuthorizerClient::new(&env, &target).try_authorize_trustline(&holder);
        // Recoverable (Err, not a test abort), and NOT a typed contract error.
        match res {
            Err(Ok(e)) => assert!(!e.is_type(ScErrorType::Contract)),
            // Strictly Abort: a reclassification to InvokeError::Contract
            // would flip router behavior and must FAIL this spike.
            Err(Err(soroban_sdk::InvokeError::Abort)) => {}
            other => panic!("missing export must abort untyped, got {other:?}"),
        }
    }

    #[test]
    fn typed_error_is_contract_type() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let holder = Address::generate(&env);
        let target = env.register(FailingAuthorizer, ());
        let res = AuthorizerClient::new(&env, &target).try_authorize_trustline(&holder);
        match res {
            Err(Ok(e)) => assert!(e.is_type(ScErrorType::Contract)),
            other => panic!("expected a typed contract error, got {other:?}"),
        }
    }

    #[test]
    fn panic_is_recoverable_non_contract_error() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let holder = Address::generate(&env);
        let target = env.register(PanickingAuthorizer, ());
        let res = AuthorizerClient::new(&env, &target).try_authorize_trustline(&holder);
        match res {
            Err(Ok(e)) => assert!(!e.is_type(ScErrorType::Contract)),
            // Strictly Abort: a reclassification to InvokeError::Contract
            // would flip router behavior and must FAIL this spike.
            Err(Err(soroban_sdk::InvokeError::Abort)) => {}
            other => panic!("an untyped panic must abort untyped, got {other:?}"),
        }
    }
}
