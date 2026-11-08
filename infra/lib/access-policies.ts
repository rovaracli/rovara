// The two access-stack policy documents (and the pure helpers around them) now live in
// packages/contracts/src/access-policies.ts: phase 15c2's export bundle needs them from the CLI
// package, which may import @agentx/contracts but not infra/. This file re-exports them so every
// existing infra import (access.ts, role-path.ts, permissions-boundary.ts) and every existing test
// (access-policies.test.ts, access-stack.test.ts, environment-naming.test.ts) keeps working
// unchanged.
export {
  BOUNDARY_INSTANCE_PROFILE_ACTIONS,
  BOUNDARY_NAMED_READS,
  BOUNDARY_SERVICES,
  CLOUDFRONT_BOUNDARY_ACTIONS,
  MANAGED_POLICY_ACTIONS,
  SERVICE_LINKED_ROLE_SERVICES,
  SERVICE_ROLE_SERVICES,
  defaultBoundaryArn,
  defaultBoundaryName,
  defaultBoundaryStatements,
  TASK_PERSON_PROOF_ENV,
  TEAM_RECORD_BOUNDARY_DENIED_ACTIONS,
  TEAM_RECORD_BOUNDARY_SERVICES,
  TEAM_RECORD_LAKE_DEPLOY_ACTIONS,
  TEAM_RECORD_LIST_ACTIONS,
  TEAM_RECORD_VECTORS_DEPLOY_ACTIONS,
  TEAM_RECORD_WORK_GROUP_DEPLOY_ACTIONS,
  teamRecordVectorsRoleName,
  environmentRolePath,
  fixedNameEnvironmentRoleNames,
  taskPersonProofRoleName,
  operatorRoleStatements,
  serviceRoleStatements,
  withoutSids,
  type PolicyScope,
  type PolicyStatementJson,
} from "@agentx/contracts";
