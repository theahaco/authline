// Authline-local shim for @g2c/passkey-sdk — see package.json description.
// Strict StrKey checksum validation: at least as strict as upstream's check,
// and every value the wallets-kit module passes through it is a full
// C-address, so the stricter predicate is behavior-identical here.
import { StrKey } from "@stellar/stellar-sdk"

/** Whether `value` is a valid C-address (Soroban contract id). */
export const isContractId = (value) =>
	typeof value === "string" && StrKey.isValidContract(value)
