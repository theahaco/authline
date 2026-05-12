#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, IssuerFlags};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

#[contract]
pub struct StubEurcvAuth;

#[contractimpl]
impl StubEurcvAuth {
    pub fn __constructor(env: Env, sac: Address) {
        env.storage()
            .instance()
            .set(&symbol_short!("SAC"), &sac);
    }
}

#[contractimpl]
impl EurcvAuth for StubEurcvAuth {
    fn authorize_trustline(
        env: Env,
        account: Address,
    ) -> Result<(), soroban_sdk::Error> {
        let sac: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("SAC"))
            .expect("SAC not set");
        StellarAssetClient::new(&env, &sac).set_authorized(&account, &true);
        Ok(())
    }
}

#[test]
fn onboard_creates_trustline_and_authorizes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let sac_addr = sac.address();
    sac.issuer().set_flag(IssuerFlags::RequiredFlag);

    let eurcv_auth_addr = env.register(StubEurcvAuth, (sac_addr.clone(),));
    StellarAssetClient::new(&env, &sac_addr).set_admin(&eurcv_auth_addr);

    let onboard_addr = env.register(TrustlineOnboard, ());
    let client = TrustlineOnboardClient::new(&env, &onboard_addr);

    client.onboard(&sac_addr, &eurcv_auth_addr, &holder);

    assert!(StellarAssetClient::new(&env, &sac_addr).authorized(&holder));
}
