#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, IssuerFlags};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Env};

#[test]
fn authorize_trustline_flips_authorized_flag() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let sac_addr = sac.address();
    sac.issuer().set_flag(IssuerFlags::RequiredFlag);

    let sac_client = StellarAssetClient::new(&env, &sac_addr);
    sac_client.trust(&holder);
    assert!(!sac_client.authorized(&holder));

    let stub = env.register(AuthorizerStub, (sac_addr.clone(),));
    sac_client.set_admin(&stub);

    AuthorizerStubClient::new(&env, &stub).authorize_trustline(&holder);

    assert!(sac_client.authorized(&holder));
}
