#![no_std]
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{
    contract, contracterror, contractimpl, symbol_short, Address, Env, Symbol,
};

const SAC_KEY: Symbol = symbol_short!("SAC");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
}

#[contract]
pub struct EurcvAuthStub;

#[contractimpl]
impl EurcvAuthStub {
    pub fn __constructor(env: Env, sac: Address) {
        env.storage().instance().set(&SAC_KEY, &sac);
    }

    pub fn authorize_trustline(env: Env, account: Address) -> Result<(), Error> {
        let sac = Self::sac(env.clone())?;
        StellarAssetClient::new(&env, &sac).set_authorized(&account, &true);
        Ok(())
    }

    pub fn sac(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&SAC_KEY)
            .ok_or(Error::NotInitialized)
    }
}

mod test;
