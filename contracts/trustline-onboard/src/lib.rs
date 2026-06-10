#![no_std]
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::xdr::ScErrorType;
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, Address, Env, Executable,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `sac` is not a built-in Stellar Asset Contract (CAP-68 check).
    NotSac = 1,
    /// CAP-73 `trust()` failed (reserve, missing account, native asset,
    /// issuer as holder, …).
    TrustFailed = 2,
    /// The asset's authorizer (SAC admin) REJECTED the holder (typed error).
    AuthorizationRefused = 3,
    /// The authorizer reported success but the holder is not authorized.
    NotAuthorized = 4,
}

/// Outcome of `onboard`, reported truthfully from on-chain state.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OnboardStatus {
    /// Trustline exists and is authorized — the holder can receive the asset.
    Authorized,
    /// Trustline exists but is not authorized: the asset is AUTH_REQUIRED and
    /// its SAC admin offers no one-step `authorize_trustline` interface — the
    /// issuer authorizes off-platform (manual path).
    TrustlineOnly,
}

/// SEP interface: a one-step authorizer is the SAC admin exposing this.
/// Rejections MUST be typed contract errors — an untyped abort is read as
/// "interface absent", never as a rejection.
#[contractclient(name = "AuthorizerClient")]
pub trait Authorizer {
    fn authorize_trustline(env: Env, account: Address) -> Result<(), soroban_sdk::Error>;
}

#[contract]
pub struct TrustlineOnboard;

#[contractimpl]
impl TrustlineOnboard {
    /// Create the holder's trustline and, when the asset's SAC admin is a
    /// contract exposing `authorize_trustline`, authorize it — all under one
    /// holder signature. The asset's capability is DISCOVERED on-chain
    /// (CAP-68 `get_address_executable` + `SAC.admin()`), not configured.
    ///
    /// Returns `Authorized` when the trustline is usable, `TrustlineOnly`
    /// when the asset is AUTH_REQUIRED with no one-step authorizer (the
    /// trustline is kept; the issuer authorizes off-platform).
    ///
    /// **Atomic on rejection:** if the discovered authorizer rejects the
    /// holder with a typed contract error, the WHOLE transaction (including
    /// the trustline creation) is rolled back.
    ///
    /// **Immutable by design:** no admin or upgrade entrypoint; fixing a bug
    /// means deploying a new instance and updating the pinned router id.
    ///
    /// # Security
    ///
    /// The discovered admin is a contract CHOSEN BY THE ASSET, executed under
    /// the holder's signed authorization tree: in recording-mode simulation,
    /// any nested `holder.require_auth()` the admin triggers is folded into
    /// the single root auth entry the holder signs. The router cannot prevent
    /// a malicious admin from abusing this — only onboard SACs from a
    /// trusted/pinned source, and wallets SHOULD render the full auth tree.
    pub fn onboard(env: Env, sac: Address, holder: Address) -> Result<OnboardStatus, Error> {
        holder.require_auth();

        // Anti-copycat, on-chain: only a built-in SAC has classic trustlines.
        if !matches!(sac.executable(), Some(Executable::StellarAsset)) {
            return Err(Error::NotSac);
        }
        let sac_client = StellarAssetClient::new(&env, &sac);

        // CAP-73: create the trustline if needed (silent no-op when it
        // already exists; created UNauthorized for an AUTH_REQUIRED issuer).
        sac_client
            .try_trust(&holder)
            .map_err(|_| Error::TrustFailed)?
            .map_err(|_| Error::TrustFailed)?;

        // Open asset, or already authorized: done.
        if sac_client.authorized(&holder) {
            return Ok(OnboardStatus::Authorized);
        }

        // Discover the one-step capability from the only address the
        // protocol allows to authorize: the SAC admin. A non-wasm admin
        // (G-account, SAC, nonexistent) cannot expose the interface.
        let admin = sac_client.admin();
        if !matches!(admin.executable(), Some(Executable::Wasm(_))) {
            return Ok(OnboardStatus::TrustlineOnly);
        }
        match AuthorizerClient::new(&env, &admin).try_authorize_trustline(&holder) {
            // Post-condition: the authorizer must have authorized the holder
            // on THIS sac — guards a no-op or divergent authorizer. Also
            // covers a wrong-return-shape success (Ok(Err(ConversionError))):
            // the post-condition resolves it either way.
            Ok(_) => {
                if sac_client.authorized(&holder) {
                    Ok(OnboardStatus::Authorized)
                } else {
                    Err(Error::NotAuthorized)
                }
            }
            // A typed contract error is a REJECTION (SEP rule) — revert
            // everything, including the trustline.
            Err(Ok(e)) if e.is_type(ScErrorType::Contract) => Err(Error::AuthorizationRefused),
            // Statically unreachable for E = soroban_sdk::Error (its error
            // conversion is infallible, so typed rejections always surface
            // as Err(Ok(_)) above); kept as defense-in-depth.
            Err(Err(soroban_sdk::InvokeError::Contract(_))) => Err(Error::AuthorizationRefused),
            // Anything else (squashed Context/InvalidAction abort: missing
            // export or an untyped panic) means "no authorize_trustline
            // interface": keep the trustline and report it truthfully.
            Err(_) => Ok(OnboardStatus::TrustlineOnly),
        }
    }
}

mod test;
