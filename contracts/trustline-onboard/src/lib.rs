#![no_std]
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    TrustFailed = 1,
    AuthorizationFailed = 2,
}

#[contractclient(name = "EurcvAuthClient")]
pub trait EurcvAuth {
    fn authorize_trustline(
        env: Env,
        account: Address,
    ) -> Result<(), soroban_sdk::Error>;
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
        StellarAssetClient::new(&env, &sac)
            .try_trust(&holder)
            .map_err(|_| Error::TrustFailed)?
            .map_err(|_| Error::TrustFailed)?;
        EurcvAuthClient::new(&env, &eurcv_auth)
            .try_authorize_trustline(&holder)
            .map_err(|_| Error::AuthorizationFailed)?
            .map_err(|_| Error::AuthorizationFailed)?;
        Ok(())
    }
}

mod test;
