#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, IssuerFlags};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

// A correct authorizer: it is the SAC admin and authorizes the account.
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

// An authorizer that always returns an error (never authorizes).
#[contract]
pub struct FailingAuthorizer;

#[contractimpl]
impl FailingAuthorizer {
    pub fn authorize_trustline(_env: Env, _account: Address) -> Result<(), Error> {
        Err(Error::AuthorizationFailed)
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

fn setup(env: &Env) -> (Address, Address) {
    let issuer = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let sac_addr = sac.address();
    sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    let onboard_addr = env.register(TrustlineOnboard, ());
    (sac_addr, onboard_addr)
}

#[test]
fn onboard_creates_trustline_and_authorizes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac_addr, onboard_addr) = setup(&env);

    let authorizer = env.register(StubAuthorizer, (sac_addr.clone(),));
    StellarAssetClient::new(&env, &sac_addr).set_admin(&authorizer);

    let client = TrustlineOnboardClient::new(&env, &onboard_addr);
    client.onboard(&sac_addr, &authorizer, &holder);

    assert!(StellarAssetClient::new(&env, &sac_addr).authorized(&holder));
}

#[test]
fn onboard_surfaces_authorization_failure() {
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
}

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

#[test]
fn onboard_rejects_when_post_condition_unmet() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac_addr, onboard_addr) = setup(&env);

    // Noop authorizer returns Ok but never sets the authorized flag, so the
    // post-condition `sac.authorized(holder)` is false.
    let authorizer = env.register(NoopAuthorizer, ());
    let client = TrustlineOnboardClient::new(&env, &onboard_addr);

    assert_eq!(
        client.try_onboard(&sac_addr, &authorizer, &holder),
        Err(Ok(Error::NotAuthorized))
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
            Err(Err(_)) => {} // InvokeError::Abort — also "not typed": acceptable
            Ok(_) => panic!("call to a missing export must not succeed"),
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
            Err(Err(_)) => {}
            Ok(_) => panic!("a panicking authorizer must not report success"),
        }
    }
}
