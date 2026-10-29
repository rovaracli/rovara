export const AUDIT_LIMITS_COPY = "What this ledger proves: the records in this export have not been changed, removed or reordered since Rovara sealed them, and each sealed batch existed no later than the time an independent timestamp service signed.\n\nWhat it does not prove: that the records are true or complete. Rovara writes them, so an action Rovara never recorded, or recorded wrongly, does not show up as tampering. Records after the last seal are not sealed yet; this export says how many.\n\nIt is tamper-evident, not tamper-proof. Someone with enough access could still change Rovara's live copy, but the change would show when checked against the sealed copy, the timestamps and your earlier exports. Keep every export you take.";
export const GOVERNANCE_SENTENCE = "In governance mode, a privileged administrator could remove the sealed copies.";
// Lane C3 reuses the existing protected native export page; no SPA export mutation.
export const AUDIT_EXPORT_ENTRY_PATH = "/v1/app/audit/view?limit=1#export-form";
/** The protected search export in a secure window is not built (deferred; owner decision 2026-10-29). Keep false until it ships: it hides the console's export entry and its promise. */
export const AUDIT_PROTECTED_EXPORT_ENTRY_ENABLED = false as boolean;
export const AUDIT_VERIFIER_EXTENDS_EXAMPLE = "rovara-audit-verify newer.json.gz --extends older.json.gz";
