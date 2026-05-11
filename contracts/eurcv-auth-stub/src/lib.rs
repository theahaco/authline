#![no_std]
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

const SAC_KEY: Symbol = symbol_short!("SAC");

#[contract]
pub struct EurcvAuthStub;

#[contractimpl]
impl EurcvAuthStub {
    pub fn __constructor(env: Env, sac: Address) {
        env.storage().instance().set(&SAC_KEY, &sac);
    }

    pub fn authorize_trustline(env: Env, account: Address) {
        let sac: Address = env
            .storage()
            .instance()
            .get(&SAC_KEY)
            .expect("SAC not set");
        StellarAssetClient::new(&env, &sac).set_authorized(&account, &true);
    }

    pub fn sac(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&SAC_KEY)
            .expect("SAC not set")
    }
}

mod test;
