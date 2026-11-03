// Enterprise foundations, task E1: the edition of an install and the one table every edition gate reads.
//
// One codebase runs as two editions. "enterprise" is an install in the customer's own AWS account (one company, nothing sent to Rovara by default);
// "public" is Rovara Cloud (many companies, our AWS account). The edition is set once per install at deploy time and is never read from a request,
// an org setting or the database. This file is pure: it reads no environment and makes no network call; `resolveEdition` takes the raw deploy value.
import { z } from "zod";
import { agentXError } from "./errors.js";

export const EditionSchema = z.enum(["enterprise", "public"]);
export type Edition = z.infer<typeof EditionSchema>;
export const EDITIONS: readonly Edition[] = EditionSchema.options;

/** The deploy parameter, the CDK context key and the process environment variable that carry the edition. */
export const EDITION_CONTEXT_KEY = "rovaraEdition";
/** The CDK context key `rovara init` sets on a new install, so that an install with no explicit edition is refused. */
export const NEW_INSTALL_CONTEXT_KEY = "rovaraNewInstall";
export const EDITION_ENV_VAR = "ROVARA_EDITION";

/**
 * Every feature an edition can turn on or off. The table below is the single source: every gate reads it, and no code compares an edition name
 * to decide access. A feature that is off in both editions is one that is designed but not built yet.
 */
export const EDITION_FEATURES = [
  /** Groups (division, team) under the company. Deferred: the gate exists now so groups can never leak into Public. */
  "groups",
  /** Today's simple company locks: How we work `locked`, stop ceilings, budgets. Built, used by both editions. */
  "companyLocksSimple",
  /** Group-level locks, lock exceptions and "strictest wins". */
  "companyLocksGroup",
  /** The read-only Auditor role. */
  "auditorRole",
  /** Company sign-in with OIDC or SAML, and IdP group to role mapping. */
  "sso",
  /** SCIM provisioning. Not built. */
  "scim",
  /** On-demand audit export for owners and admins (built). */
  "auditExportOnDemand",
  /** Continuous audit export to the customer's own S3, readable by the Auditor. */
  "auditExportContinuous",
  /** Code host, build system and tracker plug-ins beyond the built-in GitHub, GitHub Actions and CodeBuild ones. */
  "codeHostPlugins",
  /** A custom model endpoint (base URL). Refused on Public: a customer-chosen URL there is a server-side request forgery risk. */
  "customModelEndpoint",
  /** Private package registries (INTG2). On in both: Public allows CodeArtifact and public hosts only. */
  "privateRegistries",
  /** The customer's own admin approves egress domains on save. On Public, Rovara staff approve. */
  "egressApprovalByCustomerAdmin",
  /** Rovara staff routes (`/v1/admin/*`). Off in Enterprise: support there is a customer-approved operator role, never these routes. */
  "staffRoutes",
  /** Trial, billing and one-trial-per-GitHub-account. */
  "trialAndBilling",
  /** The opt-in, pull-only update check against Rovara's signed release manifest. */
  "updateCheck",
  /** Opt-in operational telemetry. Not built; after the pilot, if ever. */
  "telemetry",
  /**
   * The sign-in methods of the hosted product (email code, Google, GitHub, Slack, Cognito). Off in Enterprise: a company signs in through its own provider, so a
   * person removed from the provider's groups cannot get back in through another linked method (task E3 gates the routes by this row).
   */
  "publicSignInMethods",
  /** AI navigation in browser tests without being charged to spend first (the customer's account pays). */
  "aiNavigationUncharged",
  /**
   * MCP servers on the customer's own network (private HTTPS endpoints an admin approves in settings, and stdio servers run by the MCP host), for the project's
   * context sources. Refused on Public: a customer-chosen private address there is a server-side request forgery risk.
   */
  "privateMcpServers",
  /**
   * MCP servers that Rovara runs for the customer from an npm package (the MCP host). NOT FOR PRODUCTION until the host is redesigned (see the lane E follow-up): Enterprise only,
   * and even there it is off until the install sets `ROVARA_STDIO_MCP_SERVERS=1`.
   */
  "stdioMcpServers",
  /** Live interaction, Fix with agent: "contact support" opens a staff ticket (codes, ids and the diagnosis text, after per-escalation consent). Public only: Enterprise has no staff routes. */
  "diagnosisSupportEscalation",
  /** Live interaction, Fix with agent: "contact support" prepares the redacted support bundle that the customer's operator reads before sending it. Enterprise only; nothing is sent from the install. */
  "diagnosisSupportBundle",
] as const;
export const EditionFeatureSchema = z.enum(EDITION_FEATURES);
export type EditionFeature = z.infer<typeof EditionFeatureSchema>;

/** Which editions have each feature. Written as a table so a reviewer reads one row per feature. */
export const EDITION_FEATURE_TABLE: Readonly<Record<EditionFeature, { readonly enterprise: boolean; readonly public: boolean }>> = {
  groups: { enterprise: true, public: false },
  companyLocksSimple: { enterprise: true, public: true },
  companyLocksGroup: { enterprise: true, public: false },
  auditorRole: { enterprise: true, public: false },
  sso: { enterprise: true, public: false },
  scim: { enterprise: false, public: false },
  auditExportOnDemand: { enterprise: true, public: true },
  auditExportContinuous: { enterprise: true, public: false },
  codeHostPlugins: { enterprise: true, public: false },
  customModelEndpoint: { enterprise: true, public: false },
  privateRegistries: { enterprise: true, public: true },
  egressApprovalByCustomerAdmin: { enterprise: true, public: false },
  staffRoutes: { enterprise: false, public: true },
  trialAndBilling: { enterprise: false, public: true },
  updateCheck: { enterprise: true, public: false },
  telemetry: { enterprise: false, public: false },
  publicSignInMethods: { enterprise: false, public: true },
  aiNavigationUncharged: { enterprise: true, public: false },
  privateMcpServers: { enterprise: true, public: false },
  stdioMcpServers: { enterprise: true, public: false },
  diagnosisSupportEscalation: { enterprise: false, public: true },
  diagnosisSupportBundle: { enterprise: true, public: false },
};

/** Team record retention (Learning v2): A live only, B process then drop, C raw text about 30 days plus distilled knowledge, D full history. */
export const RetentionOptionSchema = z.enum(["A", "B", "C", "D"]);
export type RetentionOption = z.infer<typeof RetentionOptionSchema>;

export const RECORD_SOURCE_KINDS = ["slack", "github", "tickets", "rovara"] as const;
export const RecordSourceKindSchema = z.enum(RECORD_SOURCE_KINDS);
export type RecordSourceKind = z.infer<typeof RecordSourceKindSchema>;

export interface EditionPolicy {
  readonly edition: Edition;
  /** Public: many companies in one deployment. Enterprise: one company per install. */
  readonly multiTenant: boolean;
  /**
   * The longest a sign-in session may last, in seconds, so that taking a person out of an identity provider group takes effect within this time. Enterprise:
   * 8 hours. Absent on Public, which keeps its own session lifetime.
   */
  readonly sessionMaxSeconds: number | undefined;
  readonly features: Readonly<Record<EditionFeature, boolean>>;
  readonly defaults: {
    /** Per source, what an admin starts from. */
    readonly teamRecordRetention: Readonly<Record<RecordSourceKind, RetentionOption>>;
    /** Slack text: the default and the highest level a setting can reach. Public's ceiling is B, so no setting can raise it. */
    readonly slack: { readonly defaultRetention: RetentionOption; readonly ceiling: RetentionOption };
  };
}

const featuresOf = (edition: Edition): Readonly<Record<EditionFeature, boolean>> =>
  Object.freeze(Object.fromEntries(EDITION_FEATURES.map((feature) => [feature, EDITION_FEATURE_TABLE[feature][edition]])) as Record<EditionFeature, boolean>);

/** An Enterprise session lasts at most this long: a group removal at the identity provider takes effect within 8 hours at the latest. */
export const ENTERPRISE_SESSION_MAX_SECONDS = 8 * 60 * 60;

/** Freezes a policy all the way down, so no caller can turn a feature on. */
function frozen(policy: EditionPolicy): EditionPolicy {
  Object.freeze(policy.defaults.teamRecordRetention);
  Object.freeze(policy.defaults.slack);
  Object.freeze(policy.defaults);
  return Object.freeze(policy);
}

const POLICIES: Readonly<Record<Edition, EditionPolicy>> = {
  enterprise: frozen({
    edition: "enterprise",
    multiTenant: false,
    sessionMaxSeconds: ENTERPRISE_SESSION_MAX_SECONDS,
    features: featuresOf("enterprise"),
    defaults: {
      teamRecordRetention: { slack: "C", github: "C", tickets: "C", rovara: "C" },
      slack: { defaultRetention: "C", ceiling: "C" },
    },
  }),
  public: frozen({
    edition: "public",
    multiTenant: true,
    sessionMaxSeconds: undefined,
    features: featuresOf("public"),
    defaults: {
      teamRecordRetention: { slack: "B", github: "D", tickets: "D", rovara: "D" },
      slack: { defaultRetention: "B", ceiling: "B" },
    },
  }),
};

export function editionPolicy(edition: Edition): EditionPolicy {
  return POLICIES[edition];
}

export const EDITION_MISSING_MESSAGE = `This install has no edition. Set ${EDITION_ENV_VAR} (CDK context ${EDITION_CONTEXT_KEY}) to "enterprise" or "public".`;
export const EDITION_UNKNOWN_MESSAGE = `This install's edition is not recognised. ${EDITION_ENV_VAR} must be exactly "enterprise" or "public".`;

/**
 * The edition of this install, from the deploy parameter. Fails closed:
 *  - a value that is not exactly "enterprise" or "public" (any other spelling, an empty string) is refused, whatever else is set;
 *  - a missing value is refused, except in the first release, where `allowDerivedFromCloud` derives it from the old `cloud` flag
 *    (cloud true is Public; anything else is Enterprise) so existing staging and private installs keep working.
 * The caller refuses to start on the thrown error. Nothing here ever reads a request or a stored setting.
 */
export function resolveEdition(input: { configured: string | undefined; cloud: boolean | undefined; allowDerivedFromCloud: boolean }): Edition {
  if (input.configured !== undefined) {
    const parsed = EditionSchema.safeParse(input.configured);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", EDITION_UNKNOWN_MESSAGE);
    return parsed.data;
  }
  if (!input.allowDerivedFromCloud) throw agentXError("CONFIG_INVALID", EDITION_MISSING_MESSAGE);
  return input.cloud === true ? "public" : "enterprise";
}

/** The install's edition from its process environment (ROVARA_EDITION, set on every function at deploy time); undefined when it is not set or not an edition (an EC2 worker has none). */
export function editionFromEnvironment(env: { ROVARA_EDITION?: string | undefined } = process.env): Edition | undefined {
  const parsed = EditionSchema.safeParse(env.ROVARA_EDITION);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What the owner is told when a model call was refused because the account behind the route has not enabled the model. The route runs on the customer's own AWS account in Enterprise (they can enable the model
 * in the Bedrock console), and on Rovara's account in Public, i.e. Rovara Cloud (nothing for the customer to enable). An edition that is not known says neither.
 */
export function modelNotEnabledSentence(model: string | undefined, edition: Edition | undefined): string {
  const name = model ?? "This model";
  if (edition === "enterprise") return `${name} isn't enabled for your AWS account. Enable it in the Bedrock console, or Rovara will use another model.`;
  if (edition === "public") return `${name} isn't available on Rovara's AI right now; Rovara will use another model.`;
  return `${name} isn't available on the AWS account behind this model route; Rovara will use another model.`;
}

export const ENTERPRISE_ONLY_MESSAGE = "This feature is part of the Enterprise edition.";
export const NOT_IN_THIS_EDITION_MESSAGE = "This feature is not available in this edition.";
export const NOT_AVAILABLE_YET_MESSAGE = "This feature is not available yet.";

export function featureEnabled(policy: EditionPolicy, feature: EditionFeature): boolean {
  return policy.features[feature] === true;
}

/**
 * Refuses (FORBIDDEN) when the edition does not have the feature. The sentence is fixed and never echoes the caller's input. An unknown feature
 * name (a bug, or a value that came from outside) is refused too: the check is a lookup in the table, never an assumption.
 */
export function requireFeature(policy: EditionPolicy, feature: EditionFeature): void {
  if (Object.hasOwn(policy.features, feature) && policy.features[feature] === true) return;
  const row = Object.hasOwn(EDITION_FEATURE_TABLE, feature) ? EDITION_FEATURE_TABLE[feature] : undefined;
  if (row === undefined || (!row.enterprise && !row.public)) throw agentXError("FORBIDDEN", NOT_AVAILABLE_YET_MESSAGE);
  throw agentXError("FORBIDDEN", row.enterprise ? ENTERPRISE_ONLY_MESSAGE : NOT_IN_THIS_EDITION_MESSAGE);
}

/** What `GET /v1/app/install` answers: the UI hides what is off. The UI never decides access; the broker does. */
export const InstallInfoSchema = z.object({
  edition: EditionSchema,
  features: z.record(EditionFeatureSchema, z.boolean()),
}).strict();
export type InstallInfo = z.infer<typeof InstallInfoSchema>;

export function installInfo(policy: EditionPolicy): InstallInfo {
  return { edition: policy.edition, features: { ...policy.features } };
}

/**
 * The edition of an install, decided ONCE at synth time from the `rovaraEdition` context and the `agentxCloud` context. Never at run time: a process that
 * lacks the `cloud` dependency must not guess (guessing Enterprise inside Public turns on custom model endpoints and company sign-in; guessing Public inside an
 * Enterprise install turns on staff routes). Every function and task then carries the result as `ROVARA_EDITION`.
 *  - an explicit `enterprise` together with the hosted cloud, or an explicit `public` without it, is refused;
 *  - the hosted cloud is `public`;
 *  - a NEW install (`newInstall`, set by `rovara init`) with no explicit edition is refused: nobody gets an edition by default;
 *  - an existing install that has no explicit edition (the legacy deployment, a named install that predates editions) gets none: it keeps today's behaviour,
 *    is not stamped, and is not treated as Enterprise. It chooses an edition on its next planned change.
 */
export function editionAtSynth(input: { explicit: Edition | undefined; cloud: boolean; newInstall?: boolean }): Edition | undefined {
  if (input.explicit === "enterprise" && input.cloud) throw agentXError("CONFIG_INVALID", "The Enterprise edition cannot be combined with the hosted cloud (agentxCloud).");
  if (input.explicit === "public" && !input.cloud) throw agentXError("CONFIG_INVALID", "The Public edition is the hosted cloud: set agentxCloud, or choose the Enterprise edition.");
  const decided = input.explicit ?? (input.cloud ? "public" : undefined);
  if (decided === undefined && input.newInstall === true) {
    throw agentXError("CONFIG_INVALID", `A new install must choose its edition: set ${EDITION_CONTEXT_KEY} to "enterprise" (or use the hosted cloud for "public").`);
  }
  return decided;
}

/** An install's edition is set once. `rovara deploy` (not yet wired) reads the recorded edition and calls this; a redeploy that asks for another edition than the recorded one is refused. */
export function assertEditionUnchanged(recorded: Edition | undefined, requested: Edition): void {
  if (recorded !== undefined && recorded !== requested) {
    throw agentXError("CONFIG_INVALID", `This install was deployed as ${recorded}. The edition cannot change on a redeploy; build a new install instead.`);
  }
}
