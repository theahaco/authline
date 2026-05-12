#![no_std]
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contractclient, contractimpl, Address, Env, Error};

#[contractclient(name = "EurcvAuthClient")]
pub trait EurcvAuth {
    fn authorize_trustline(env: Env, account: Address) -> Result<(), Error>;
}

#[contract]
pub struct TrustlineOnboard;

#[contractimpl]
impl TrustlineOnboard {
    pub fn onboard(
        env: Env,
        sac: Address,
        eurcv_auth: Address,
        holder: Address,
    ) -> Result<(), Error> {
        holder.require_auth();
        StellarAssetClient::new(&env, &sac).trust(&holder);
        EurcvAuthClient::new(&env, &eurcv_auth).authorize_trustline(&holder);
        Ok(())
    }
}

mod test;
