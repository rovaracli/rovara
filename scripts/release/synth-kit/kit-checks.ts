// Checks the kit's entry makes, kept apart from it so a test can run them without starting a synth.

/**
 * A synth that needs something looked up in an account (a VPC, a hosted zone, a parameter) records it as "missing context" and carries on with a dummy value. A kit never has an account to
 * look in (no credentials, no network), so a template that depends on a dummy value is a wrong template: the kit stops instead.
 */
export function assertNoLookups(manifest: { missing?: ReadonlyArray<{ key: string }> | undefined }): void {
  const missing = manifest.missing ?? [];
  if (missing.length > 0) {
    throw new Error(`the app asks for ${String(missing.length)} value(s) to be looked up in an AWS account (${missing.slice(0, 3).map((entry) => entry.key.slice(0, 80)).join(", ")}); a synthesis kit makes no AWS call and has no account to look in`);
  }
}

/** The recorded settings the kit takes as its context: text values only, nothing nested, a bounded number. */
export function checkedContext(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("the context file holds no context object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 200) throw new Error("the context file holds more settings than a build takes");
  const context: Record<string, string> = {};
  for (const [key, setting] of entries) {
    if (typeof setting !== "string") throw new Error(`the context setting ${key.slice(0, 80)} is not text`);
    context[key] = setting;
  }
  return context;
}
