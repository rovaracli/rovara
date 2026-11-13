// The parameters a stack's template declares, and which of them have no Default (a deploy must send those, or the stack must already hold
// them for the cdk engine's previous values). The required names ride on the declared set as a non-enumerable property, so every reader of
// the plain set is unchanged. Used by the rollback's check of every stack's parameters before the first deploy (deploy-environment.ts).

/** A template's declared parameter names, carrying the names that have no Default. */
export type DeclaredParameters = ReadonlySet<string> & { readonly required?: ReadonlySet<string> };

/** From a template's `Parameters` section. */
export function declaredFromTemplate(parameters: unknown): DeclaredParameters {
  const entries = parameters !== null && typeof parameters === "object" ? Object.entries(parameters as Record<string, unknown>) : [];
  const required = entries.filter(([, value]) => value === null || typeof value !== "object" || !Object.hasOwn(value, "Default")).map(([name]) => name);
  const declared = new Set(entries.map(([name]) => name));
  Object.defineProperty(declared, "required", { value: new Set(required), enumerable: false });
  return declared;
}

/** The names without a Default, or undefined when the set came from somewhere that did not record them. */
export function requiredParameters(declared: ReadonlySet<string>): ReadonlySet<string> | undefined {
  return (declared as DeclaredParameters).required;
}
