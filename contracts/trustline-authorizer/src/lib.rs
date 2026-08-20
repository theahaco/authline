#![no_std]
//! Asset-agnostic **Trustline Authorizer**.
//!
//! Installed as a classic asset's Stellar Asset Contract (SAC) admin
//! (`SAC.set_admin(this)`), it becomes the only address the protocol allows to
//! flip `AUTHORIZED` on that asset's trustlines — and it exposes that authority
//! through a *permissionless* [`authorize_trustline`] gated by a configurable
//! [`Policy`]:
//!
//! * [`Policy::Denylist`] — open by default: anyone not banned authorizes.
//! * [`Policy::Allowlist`] — gated: only accounts the issuer allowed authorize.
//!
//! Nothing in here names a specific asset: the SAC is a constructor argument,
//! so one wasm serves every issuer (the "asset-agnostic" part of the SEP).
//!
//! The rest of the surface is the admin console an issuer needs — ban, freeze,
//! pause, upgrade, mint, clawback — each gated on `admin().require_auth()` and
//! each emitting a structured event so the full authorization history is
//! reconstructable from the ledger alone (SEP §8).
//!
//! # The invariants worth stating
//!
//! 1. **Policy is evaluated on every call.** No "already authorized" fast path,
//!    no cached decision. A banned account that deletes and recreates its
//!    trustline, then retries `onboard()`, is rejected again.
//! 2. **Freeze is ban + deauthorize, never one without the other.** A
//!    deauthorized-but-still-permitted account would re-authorize itself on the
//!    next `authorize_trustline`, so [`freeze_accounts`] always updates the
//!    policy set too.
//! 3. **Every rejection is a typed contract error.** The onboard router reads an
//!    *untyped* abort as "this admin has no authorizer interface" and keeps the
//!    trustline; only a typed error is a refusal. Panicking here would silently
//!    downgrade a ban into an unauthorized trustline.

use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env, Executable, Vec,
};

/// Max addresses per batched admin call — bounds the footprint so a single
/// invocation cannot exceed the ledger's resource limits.
pub const MAX_BATCH: u32 = 50;

const DAY_LEDGERS: u32 = 17_280;
/// Persistent/instance entries are extended to ~90 days on every touch.
const BUMP_LEDGERS: u32 = 90 * DAY_LEDGERS;
const BUMP_THRESHOLD: u32 = BUMP_LEDGERS - 7 * DAY_LEDGERS;

/// Which set `authorize_trustline` consults.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Policy {
    /// Open by default — every account authorizes except those banned.
    Denylist,
    /// Gated — only accounts explicitly allowed authorize.
    Allowlist,
}

/// Why a holder was deauthorized — an enumerated code so compliance reporting
/// does not have to parse free text (SEP §8).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Reason {
    Sanctions,
    KycExpired,
    IssuerRequest,
    Unspecified,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Instance: the issuer's admin address.
    Admin,
    /// Instance: the managed SAC.
    Sac,
    /// Instance: the active [`Policy`].
    Policy,
    /// Instance: pause flag.
    Paused,
    /// Persistent, per account: present ⇒ banned (denylist).
    Banned(Address),
    /// Persistent, per account: present ⇒ allowed (allowlist).
    Allowed(Address),
}

/// Rejections. The first five are the SEP's normative minimum; the rest are
/// admin-side misuse. All are *typed* — see the module invariants.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Denylist policy: the account is banned.
    AccountBanned = 1,
    /// Allowlist policy: the account was never allowed (or was disallowed).
    AccountNotAllowed = 2,
    /// The account has no trustline for the managed asset — create it first
    /// (CAP-73 `SAC.trust()`, or a classic `CHANGE_TRUST`).
    NoTrustline = 3,
    /// The contract is paused.
    ContractPaused = 4,
    /// The authorizer cannot authorize itself.
    CannotAuthorizeAdminContract = 5,
    /// Constructor: the `sac` argument is not a built-in Stellar Asset Contract.
    NotSac = 6,
    /// A batch was empty or larger than [`MAX_BATCH`].
    InvalidBatch = 7,
    /// `pause` while paused, or `unpause` while not paused.
    PauseUnchanged = 8,
    /// Mint/clawback amount was not positive.
    InvalidAmount = 9,
    /// Clawback or mint was refused by the asset (missing flag, unauthorized
    /// holder, insufficient balance).
    AssetRefused = 10,
}

// ---------------------------------------------------------------------------
// Events (SEP §8). Every one carries the admin that authorized the change and
// the ledger it happened on, so an issuer can rebuild an audit trail from the
// ledger without running an indexer.
// ---------------------------------------------------------------------------

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Authorized {
    #[topic]
    pub account: Address,
    pub policy: Policy,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deauthorized {
    #[topic]
    pub account: Address,
    pub reason: Reason,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Banned {
    #[topic]
    pub account: Address,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unbanned {
    #[topic]
    pub account: Address,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Allowed {
    #[topic]
    pub account: Address,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Disallowed {
    #[topic]
    pub account: Address,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

/// `deauthorized` records whether the SAC-side deauthorization actually ran:
/// freezing an account that has no trustline yet still bans it (that is the
/// point — ban *before* the trustline exists), and the event says so.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frozen {
    #[topic]
    pub account: Address,
    pub deauthorized: bool,
    pub policy: Policy,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unfrozen {
    #[topic]
    pub account: Address,
    pub reauthorized: bool,
    pub policy: Policy,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Clawback {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Minted {
    #[topic]
    pub to: Address,
    pub amount: i128,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paused {
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unpaused {
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicySet {
    pub policy: Policy,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    #[topic]
    pub new_admin: Address,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    pub wasm_hash: BytesN<32>,
    pub authorizer_admin: Address,
    pub ledger: u32,
}

#[contract]
pub struct TrustlineAuthorizer;

#[contractimpl]
impl TrustlineAuthorizer {
    /// Deploy against one asset. `sac` MUST be the built-in Stellar Asset
    /// Contract of a classic asset (checked on-chain via CAP-68), and the
    /// issuer must hand it admin rights afterwards with
    /// `SAC.set_admin(<this contract>)` — until then every SAC-touching call
    /// here fails.
    pub fn __constructor(env: Env, admin: Address, sac: Address, policy: Policy) {
        // Anti-misconfiguration: a non-SAC address can never grant this
        // contract authorization authority, so refuse at deploy time rather
        // than stranding an issuer with a dead authorizer.
        if !matches!(sac.executable(), Some(Executable::StellarAsset)) {
            panic_with_error!(&env, Error::NotSac);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Sac, &sac);
        storage.set(&DataKey::Policy, &policy);
        storage.set(&DataKey::Paused, &false);
        storage.extend_ttl(BUMP_THRESHOLD, BUMP_LEDGERS);
    }

    // -- the permissionless interface -------------------------------------

    /// Authorize `account`'s trustline on the managed asset, **on its behalf**:
    /// neither the issuer nor the holder signs at call time — the authority is
    /// this contract's SAC adminship. This is what makes a zero-holder-signature
    /// onboarding possible.
    ///
    /// The policy is re-evaluated on every call, so a ban applied after a
    /// previous success still takes effect on the retry.
    pub fn authorize_trustline(env: Env, account: Address) -> Result<(), Error> {
        Self::require_running(&env)?;
        if account == env.current_contract_address() {
            return Err(Error::CannotAuthorizeAdminContract);
        }
        Self::check_policy(&env, &account)?;

        // The SAC rejects `set_authorized` for an address with no trustline;
        // catching that is what turns an untyped abort — which the onboard
        // router would read as "no authorizer interface" — into a typed error.
        match Self::sac_client(&env).try_set_authorized(&account, &true) {
            Ok(Ok(())) => {}
            _ => return Err(Error::NoTrustline),
        }

        Authorized {
            account,
            policy: Self::policy(env.clone()),
            authorizer_admin: Self::admin(env.clone()),
            ledger: env.ledger().sequence(),
        }
        .publish(&env);
        Ok(())
    }

    // -- policy list management -------------------------------------------

    /// Ban accounts under [`Policy::Denylist`]. Works on accounts that have no
    /// trustline yet — that is the pre-emptive ban an issuer needs before a
    /// sanctioned address ever touches the asset. Banning an account that
    /// *already* holds an authorized trustline does not deauthorize it; use
    /// [`freeze_accounts`] for that.
    pub fn add_banned_accounts(env: Env, accounts: Vec<Address>) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        Self::check_batch(&accounts)?;
        for account in accounts {
            Self::set_flag(&env, DataKey::Banned(account.clone()), true);
            Banned {
                account,
                authorizer_admin: admin.clone(),
                ledger,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Lift a ban. Does not re-authorize an existing trustline — that is
    /// [`unfreeze_accounts`] — the account simply becomes eligible again.
    pub fn remove_banned_accounts(env: Env, accounts: Vec<Address>) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        Self::check_batch(&accounts)?;
        for account in accounts {
            Self::set_flag(&env, DataKey::Banned(account.clone()), false);
            Unbanned {
                account,
                authorizer_admin: admin.clone(),
                ledger,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Admit accounts under [`Policy::Allowlist`] — typically after off-band KYC.
    pub fn allow(env: Env, accounts: Vec<Address>) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        Self::check_batch(&accounts)?;
        for account in accounts {
            Self::set_flag(&env, DataKey::Allowed(account.clone()), true);
            Allowed {
                account,
                authorizer_admin: admin.clone(),
                ledger,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Withdraw allowlist admission. Existing authorized trustlines keep
    /// working until frozen — use [`freeze_accounts`] to stop a holder now.
    pub fn disallow(env: Env, accounts: Vec<Address>) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        Self::check_batch(&accounts)?;
        for account in accounts {
            Self::set_flag(&env, DataKey::Allowed(account.clone()), false);
            Disallowed {
                account,
                authorizer_admin: admin.clone(),
                ledger,
            }
            .publish(&env);
        }
        Ok(())
    }

    // -- lifecycle ---------------------------------------------------------

    /// Freeze holders: update the policy set **and** deauthorize, in that
    /// order, so the account cannot re-authorize itself by replaying
    /// `onboard()` — or by deleting and recreating the trustline, since the
    /// ban outlives the trustline entirely.
    ///
    /// Requires the issuer's `AUTH_REVOCABLE` flag for the deauthorize half. If
    /// the account has no trustline the ban still lands and the emitted event
    /// records `deauthorized = false`.
    pub fn freeze_accounts(env: Env, accounts: Vec<Address>) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        Self::check_batch(&accounts)?;
        let policy = Self::policy(env.clone());
        let client = Self::sac_client(&env);
        for account in accounts {
            match policy {
                Policy::Denylist => Self::set_flag(&env, DataKey::Banned(account.clone()), true),
                Policy::Allowlist => Self::set_flag(&env, DataKey::Allowed(account.clone()), false),
            }
            let deauthorized = matches!(client.try_set_authorized(&account, &false), Ok(Ok(())));
            Frozen {
                account,
                deauthorized,
                policy,
                authorizer_admin: admin.clone(),
                ledger,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Reverse a freeze: re-admit under the policy **and** re-authorize the
    /// trustline if one exists (`reauthorized = false` when it does not).
    pub fn unfreeze_accounts(env: Env, accounts: Vec<Address>) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        Self::check_batch(&accounts)?;
        let policy = Self::policy(env.clone());
        let client = Self::sac_client(&env);
        for account in accounts {
            match policy {
                Policy::Denylist => Self::set_flag(&env, DataKey::Banned(account.clone()), false),
                Policy::Allowlist => Self::set_flag(&env, DataKey::Allowed(account.clone()), true),
            }
            let reauthorized = matches!(client.try_set_authorized(&account, &true), Ok(Ok(())));
            Unfrozen {
                account,
                reauthorized,
                policy,
                authorizer_admin: admin.clone(),
                ledger,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Deauthorize one trustline **without** touching the policy set.
    ///
    /// This is the transient, policy-consistent tool (e.g. pausing a holder
    /// whose allowlist entry you are about to review), NOT a freeze: under a
    /// denylist the account is still un-banned and will re-authorize itself on
    /// the next `authorize_trustline`. For a durable stop use
    /// [`freeze_accounts`].
    pub fn deauthorize_trustline(env: Env, account: Address, reason: Reason) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        let client = Self::sac_client(&env);
        match client.try_set_authorized(&account, &false) {
            Ok(Ok(())) => {}
            _ => return Err(Error::NoTrustline),
        }
        Deauthorized {
            account,
            reason,
            authorizer_admin: admin,
            ledger,
        }
        .publish(&env);
        Ok(())
    }

    // -- supply ------------------------------------------------------------

    /// Mint to a holder. Fails with [`Error::AssetRefused`] if the recipient's
    /// trustline is missing or unauthorized — mint the asset *after* onboarding.
    pub fn mint_to_account(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        match Self::sac_client(&env).try_mint(&to, &amount) {
            Ok(Ok(())) => {}
            _ => return Err(Error::AssetRefused),
        }
        Minted {
            to,
            amount,
            authorizer_admin: admin,
            ledger,
        }
        .publish(&env);
        Ok(())
    }

    /// Claw back a balance. Requires the issuer's `AUTH_CLAWBACK_ENABLED` flag
    /// (and the holder's trustline to carry the clawback bit); without it the
    /// asset refuses and this returns [`Error::AssetRefused`].
    pub fn clawback(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        match Self::sac_client(&env).try_clawback(&from, &amount) {
            Ok(Ok(())) => {}
            _ => return Err(Error::AssetRefused),
        }
        Clawback {
            from,
            amount,
            authorizer_admin: admin,
            ledger,
        }
        .publish(&env);
        Ok(())
    }

    // -- emergency stop ----------------------------------------------------

    /// Stop everything: authorization, freezes, supply, policy edits. Only
    /// [`unpause`], [`set_admin`], [`upgrade`] and the read-only getters stay
    /// live, so a paused contract can still be recovered or fixed.
    pub fn pause(env: Env) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin_even_when_paused(&env)?;
        if Self::is_paused(env.clone()) {
            return Err(Error::PauseUnchanged);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        Paused {
            authorizer_admin: admin,
            ledger,
        }
        .publish(&env);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin_even_when_paused(&env)?;
        if !Self::is_paused(env.clone()) {
            return Err(Error::PauseUnchanged);
        }
        env.storage().instance().set(&DataKey::Paused, &false);
        Unpaused {
            authorizer_admin: admin,
            ledger,
        }
        .publish(&env);
        Ok(())
    }

    // -- admin-sep: Administratable + Upgradable ---------------------------

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("authorizer not initialized")
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin_even_when_paused(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        AdminChanged {
            new_admin,
            authorizer_admin: admin,
            ledger,
        }
        .publish(&env);
        Ok(())
    }

    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin_even_when_paused(&env)?;
        env.deployer()
            .update_current_contract_wasm(wasm_hash.clone());
        Upgraded {
            wasm_hash,
            authorizer_admin: admin,
            ledger,
        }
        .publish(&env);
        Ok(())
    }

    /// Switch policy. The two sets are kept independently, so switching does
    /// not silently reinterpret one list as the other: a denylist ban stays a
    /// ban if you switch back.
    pub fn set_policy(env: Env, policy: Policy) -> Result<(), Error> {
        let (admin, ledger) = Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Policy, &policy);
        PolicySet {
            policy,
            authorizer_admin: admin,
            ledger,
        }
        .publish(&env);
        Ok(())
    }

    // -- read-only ---------------------------------------------------------

    /// The managed asset's SAC.
    pub fn sac(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Sac)
            .expect("authorizer not initialized")
    }

    pub fn policy(env: Env) -> Policy {
        env.storage()
            .instance()
            .get(&DataKey::Policy)
            .expect("authorizer not initialized")
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn is_banned(env: Env, account: Address) -> bool {
        Self::flag(&env, &DataKey::Banned(account))
    }

    pub fn is_allowed(env: Env, account: Address) -> bool {
        Self::flag(&env, &DataKey::Allowed(account))
    }

    /// Would `authorize_trustline(account)` be permitted right now, ignoring
    /// whether a trustline exists? Lets a UI or CLI explain a refusal before
    /// spending a transaction on it.
    pub fn is_eligible(env: Env, account: Address) -> bool {
        !Self::is_paused(env.clone())
            && account != env.current_contract_address()
            && Self::check_policy(&env, &account).is_ok()
    }

    /// The asset's live view of the trustline, straight from the SAC.
    pub fn is_authorized(env: Env, account: Address) -> bool {
        matches!(
            Self::sac_client(&env).try_authorized(&account),
            Ok(Ok(true))
        )
    }

    // -- internals ---------------------------------------------------------

    fn sac_client(env: &Env) -> StellarAssetClient<'_> {
        StellarAssetClient::new(env, &Self::sac(env.clone()))
    }

    fn check_policy(env: &Env, account: &Address) -> Result<(), Error> {
        match Self::policy(env.clone()) {
            Policy::Denylist if Self::flag(env, &DataKey::Banned(account.clone())) => {
                Err(Error::AccountBanned)
            }
            Policy::Allowlist if !Self::flag(env, &DataKey::Allowed(account.clone())) => {
                Err(Error::AccountNotAllowed)
            }
            _ => Ok(()),
        }
    }

    fn flag(env: &Env, key: &DataKey) -> bool {
        let storage = env.storage().persistent();
        if storage.has(key) {
            storage.extend_ttl(key, BUMP_THRESHOLD, BUMP_LEDGERS);
            true
        } else {
            false
        }
    }

    fn set_flag(env: &Env, key: DataKey, on: bool) {
        let storage = env.storage().persistent();
        if on {
            storage.set(&key, &true);
            storage.extend_ttl(&key, BUMP_THRESHOLD, BUMP_LEDGERS);
        } else {
            storage.remove(&key);
        }
    }

    fn require_admin(env: &Env) -> Result<(Address, u32), Error> {
        Self::require_running(env)?;
        Self::require_admin_even_when_paused(env)
    }

    fn require_admin_even_when_paused(env: &Env) -> Result<(Address, u32), Error> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_LEDGERS);
        Ok((admin, env.ledger().sequence()))
    }

    fn require_running(env: &Env) -> Result<(), Error> {
        if Self::is_paused(env.clone()) {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }

    fn check_batch(accounts: &Vec<Address>) -> Result<(), Error> {
        if accounts.is_empty() || accounts.len() > MAX_BATCH {
            return Err(Error::InvalidBatch);
        }
        Ok(())
    }
}

mod test;
