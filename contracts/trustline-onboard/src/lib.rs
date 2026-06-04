#![no_std]
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contractclient, contracterror, contractimpl, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    TrustFailed = 1,
    AuthorizationFailed = 2,
    NotAuthorized = 3,
}

/// Generic trustline authorizer: any SAC-admin contract exposing
/// `authorize_trustline(account)` (e.g. EURCV's authorizer wraps `set_authorized`).
#[contractclient(name = "AuthorizerClient")]
pub trait Authorizer {
    fn authorize_trustline(env: Env, account: Address) -> Result<(), soroban_sdk::Error>;
}

#[contract]
pub struct TrustlineOnboard;

#[contractimpl]
impl TrustlineOnboard {
    /// Create the holder's trustline (CAP-73 `SAC.trust`) and authorize it via the
    /// asset's authorizer contract, in a single holder-signed transaction.
    pub fn onboard(
        env: Env,
        sac: Address,
        authorizer: Address,
        holder: Address,
    ) -> Result<(), Error> {
        holder.require_auth();
        let sac_client = StellarAssetClient::new(&env, &sac);
        sac_client
            .try_trust(&holder)
            .map_err(|_| Error::TrustFailed)?
            .map_err(|_| Error::TrustFailed)?;
        AuthorizerClient::new(&env, &authorizer)
            .try_authorize_trustline(&holder)
            .map_err(|_| Error::AuthorizationFailed)?
            .map_err(|_| Error::AuthorizationFailed)?;
        // Post-condition: confirm the holder is actually authorized on THIS sac.
        // Guards against a wrong/divergent SAC or an authorizer that no-ops.
        if !sac_client.authorized(&holder) {
            return Err(Error::NotAuthorized);
        }
        Ok(())
    }
}

mod test;
