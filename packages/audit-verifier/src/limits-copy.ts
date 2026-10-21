/**
 * The exact copy shown on the page, in the CLI's `verify` and `export` output, in the export
 * file and in this package's README. The verifier prints this built-in text, never a bundle's.
 */
export const AUDIT_LIMITS_COPY = [
  "What this ledger proves: the records in this export have not been changed, removed or reordered since Rovara sealed them, and each sealed batch existed no later than the time an independent timestamp service signed.",
  "What it does not prove: that the records are true or complete. Rovara writes them, so an action Rovara never recorded, or recorded wrongly, does not show up as tampering. Records after the last seal are not sealed yet; this export says how many.",
  "It is tamper-evident, not tamper-proof. Someone with enough access could still change Rovara's live copy, but the change would show when checked against the sealed copy, the timestamps and your earlier exports. Keep every export you take.",
].join("\n\n");
