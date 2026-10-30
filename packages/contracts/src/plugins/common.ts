// Enterprise foundations, task P1: the words every plug-in port shares. This folder holds types and Zod schemas only: no adapter, no I/O.
//
// Ports live in `contracts`; adapters live in `broker/src/plugins/<kind>/<name>/` and ship in the release (no code is loaded at run time).
// The vocabulary is neutral: change request (a pull request or a CR), revision (a commit or a CR revision), check (a CI job or a build),
// review and comment, item (a ticket or a task). A caller never branches on an adapter's name; it reads the adapter's capabilities.
import { z } from "zod";
import { OrgIdSchema } from "../browser-ids.js";

/** What a plug-in is called: lower-case words and digits with hyphens. A built-in or a customer-specific kind, registered at build time; never loaded from outside. */
export const PluginKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type PluginKind = z.infer<typeof PluginKindSchema>;

/**
 * Whose authority a plug-in call runs under, for the install's own credential rules: one organization's own work, or a system caller that names no org
 * (a signed webhook, or the one org of a private install). Same shape the GitHub reads use today.
 */
export const HostScopeSchema = z.union([
  z.object({ orgId: OrgIdSchema }).strict(),
  z.object({ system: z.enum(["webhook", "private-install"]) }).strict(),
]);
export type HostScope = z.infer<typeof HostScopeSchema>;

/** A repository as the install registered it (the address the plug-in resolves). The plug-in decides what the address means; the broker never parses it. */
export const RepositoryRefSchema = z.object({ url: z.string().min(1).max(2_048) }).strict();
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

/** A revision: a commit id or a CR revision id, opaque to everything but the plug-in. */
export const RevisionSchema = z.string().min(1).max(200);
export type Revision = z.infer<typeof RevisionSchema>;

/** A branch name as one short line. */
export const BranchNameSchema = z.string().min(1).max(250).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "a branch name has no control characters");

/** Ids and numbers an outside system hands out, kept as short strings so a host that uses numbers and one that uses uuids look the same. */
export const ExternalIdSchema = z.string().min(1).max(200);

/** A link an outside system gave: https only, no credentials in it. Empty when it gave none. */
export const HttpsUrlOrEmptySchema = z.string().max(2_048).refine((value) => {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "an https link without credentials, or empty");

/** A person's account at an outside system. `login` is how the host names it; `hostUserId` is its stable id when it has one. */
export const HostAccountSchema = z.object({ login: z.string().min(1).max(200), hostUserId: ExternalIdSchema.optional() }).strict();
export type HostAccount = z.infer<typeof HostAccountSchema>;

export const ISO_TIME = z.string().min(1).max(64);

/**
 * A text from outside (a comment, a CI log, an item's body). It is data, never an instruction: it reaches a model only inside a labelled block. The type is
 * a plain string; the name tells the reader what it is.
 */
export type UntrustedText = string;

/** What one tracking pass may spend on reads: its abort signal, and a hook called before each request that throws when the pass's read allowance is used up. */
export interface ReadBudget {
  signal: AbortSignal;
  beforeRequest: () => void;
}
