// Enterprise foundations E3: Rovara staff routes are off in the Enterprise edition.
//
// Everything the OIDC entry point serves after the developer and internal routes is `/v1/admin/*`, called with the admin pool's token. On the hosted cloud that pool is
// Rovara staff; on a single-company install the same routes are how the company's own administrators set the install up (`rovara project add`, `rovara doctor`,
// Slack bindings). The Enterprise edition keeps the second and refuses the first, so the rule is a closed list of what an install's own operator may call:
// a route on the list is served, and every other `/v1/admin/*` route (staff turns, the staff path into any company's audit log, Rovara's own evaluation runs, and any
// route added later and not yet classified) is refused with the edition's fixed sentence until someone decides it belongs on the list.
import { requireFeature, type EditionPolicy } from "@agentx/contracts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** What an install's own operator calls. Anchored; a path is matched whole, so no prefix or suffix reaches a staff route through one of these. */
export const INSTALL_OPERATOR_ROUTES: readonly RegExp[] = [
  /^\/v1\/admin\/(?:me|health|failures|usage|chatgpt|credentials)$/,
  /^\/v1\/admin\/projects$/,
  /^\/v1\/admin\/projects\/(?:setup-proposals|setup-approvals)$/,
  new RegExp(`^/v1/admin/projects/setup-executions/${UUID}/retry$`),
  /^\/v1\/admin\/workspaces$/,
  /^\/v1\/admin\/workspaces\/prepare$/,
  new RegExp(`^/v1/admin/workspaces/[0-9a-f-]+/(?:cancel|stop)$`),
  /^\/v1\/admin\/slack\/bindings$/,
  /^\/v1\/admin\/slack\/bindings\/[^/]+\/[^/]+$/,
  /^\/v1\/admin\/slack\/teams\/[^/]+$/,
  /^\/v1\/admin\/changes$/,
  /^\/v1\/admin\/changes\/config$/,
  new RegExp(`^/v1/admin/changes/${UUID}(?:/(?:slack|apply|decline|outcome))?$`),
  /^\/v1\/admin\/runtime-installation\/(?:challenges|registrations|status)$/,
  new RegExp(`^/v1/admin/e2e/model-checks(?:/${UUID})?$`),
  /^\/v1\/admin\/org\/budget$/,
  // Second review (switch `cr`): the evidence that lets a model block is written by the install's administrator here, by Rovara staff on the hosted cloud.
  /^\/v1\/admin\/org\/second-review\/(?:replay|verdict)$/,
  /^\/v1\/admin\/egress\/(?:pending|approve|reject)$/,
  /^\/v1\/admin\/projects\/[a-z][a-z0-9-]{0,62}\/lessons-replay\/snapshots$/,
  /^\/v1\/admin\/tasks\/[^/]+\/(?:e2e-replay|lessons-replay(?:\/(?:approve|close|evidence))?|share-mode)$/,
  new RegExp(`^/v1/admin/github/webhook-deliveries/${UUID}/retry$`),
];

/**
 * Refuses (FORBIDDEN, the edition's fixed sentence) a route that is not an install operator's when the edition has no staff routes. An install with no edition (deployed
 * before editions) and Public are served as before.
 */
export function requireStaffRouteAllowed(policy: EditionPolicy | undefined, pathname: string): void {
  if (policy === undefined || policy.features.staffRoutes) return;
  if (INSTALL_OPERATOR_ROUTES.some((route) => route.test(pathname))) return;
  requireFeature(policy, "staffRoutes");
}
