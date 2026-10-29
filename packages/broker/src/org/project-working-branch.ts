// Exact working-branch review core. No save or task admission decision.
import { z } from "zod";
import { AgentXError, AgentXNameSchema, GitBranchNameSchema, OrgIdSchema, agentXError, canonicalJson, type StoredProjectDefinition } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { parseGitHubRepository } from "../github-app.js";
import { readProjectLifecycleAuthority as authority, readProjectLifecycleState as projectState, validateProjectLifecycleIdentifiers as identifiers } from "./reviewed-project-archive.js";
type Repository = StoredProjectDefinition["repositories"][number];
export type WorkingBranchReviewDependencies = Pick<DeveloperRouteDependencies,"documentClient"|"tableName"|"now"> & {
 /** Fresh org-bound repository access/identity check. Required on every install. */
 checkRepository?: (orgId: string, repository: Readonly<Repository>) => Promise<unknown>;
 /** Fresh exact refs/heads/<branch> lookup in the checked installation; undefined if absent. */
 resolveBranch?: (orgId: string, repository: Readonly<Repository>, branch: string) => Promise<unknown>;
};
const inputSchema = z.object({ expectedOrgId: OrgIdSchema, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1), expectedProjectRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER), repository:AgentXNameSchema, branch:GitBranchNameSchema.refine(value=>value!=="HEAD"&&!value.startsWith("refs/")) }).strict();
const identitySchema = z.object({installationId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),repositoryId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
const resolvedSchema = identitySchema.extend({fullName:z.string().max(140).regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/),branch:GitBranchNameSchema,commit:z.string().regex(/^[a-f0-9]{40}$/)}).strict();
const invalid=()=>agentXError("CONFIG_INVALID","Review a valid repository branch and project before continuing.");
const stale=()=>agentXError("CHANGE_STALE","The company or project changed. Refresh and review the working branch again.");
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The working branch could not be checked. Try again.");
const missingBranch=()=>agentXError("NOT_FOUND","That branch is unavailable in this project's repository.");
function safe(error:unknown){
 if(error instanceof AgentXError){
  if(error.code==="CONFIG_INVALID")return invalid();
  if(error.code==="CHANGE_STALE")return stale();
  if(error.code==="FORBIDDEN")return agentXError("FORBIDDEN","Only a current project maintainer can review a working branch.");
  if(error.code==="NOT_FOUND")return agentXError("NOT_FOUND","That project, repository or branch is unavailable in this company.");
  if(error.code==="GITHUB_NOT_CONNECTED")return agentXError("GITHUB_NOT_CONNECTED","Reconnect this project's repository before reviewing its working branch.");
 }
 return unavailable();
}
export async function readProjectWorkingBranchPreview(deps:WorkingBranchReviewDependencies,caller:DeveloperCaller,name:string,body:unknown){
 try{
  // Keep scope immutable across injected asynchronous provider operations.
  const scope=Object.freeze({...caller}),parsed=inputSchema.safeParse(body);if(!parsed.success)throw invalid();const input=parsed.data;
  identifiers(scope,name);if(input.expectedOrgId!==scope.orgId)throw stale();
  await authority(deps,scope,name);const state=await projectState(deps,scope,name);
  if(state.status!=="active"||state.epoch!==input.expectedRevision||state.projectRevision!==input.expectedProjectRevision)throw stale();
  const repository=state.definition.repositories.find(repo=>repo.name===input.repository);if(repository===undefined)throw agentXError("NOT_FOUND","Repository unavailable.");
  const definitionSnapshot=canonicalJson(state.definition),registered=structuredClone(repository),github=parseGitHubRepository(registered.url),fullName=`${github.owner}/${github.name}`;
  if (/^\.+$/.test(github.name)) throw invalid();
  const checkRepository=deps.checkRepository,resolveBranch=deps.resolveBranch;if(checkRepository===undefined||resolveBranch===undefined)throw unavailable();
  async function connected(){
   try{const identity=identitySchema.parse(await checkRepository!(scope.orgId,structuredClone(registered)));
    if((registered.installationId!==undefined&&identity.installationId!==registered.installationId)||(registered.githubRepositoryId!==undefined&&identity.repositoryId!==registered.githubRepositoryId))throw unavailable();return identity;
   }catch(error){if(error instanceof AgentXError&&error.code==="GITHUB_NOT_CONNECTED")throw error;throw unavailable();}
  }
  const before=await connected();let raw:unknown;
  try{raw=await resolveBranch(scope.orgId,structuredClone(registered),input.branch);}catch(error){if(error instanceof AgentXError&&error.code==="GITHUB_NOT_CONNECTED")throw error;throw unavailable();}
  if(raw===undefined)throw missingBranch();
  const result=resolvedSchema.safeParse(raw);if(!result.success)throw unavailable();const resolved=result.data;
  if(resolved.fullName.toLowerCase()!==fullName.toLowerCase()||resolved.branch!==input.branch||resolved.installationId!==before.installationId||resolved.repositoryId!==before.repositoryId)throw unavailable();
  const after=await connected();if(after.installationId!==before.installationId||after.repositoryId!==before.repositoryId)throw stale();
  // No external or database reads are atomic. This final check bounds what this preview
  // returns; a future save and task admission must independently revalidate and fence.
  await authority(deps,scope,name);const current=await projectState(deps,scope,name);
  if(current.status!=="active"||current.epoch!==state.epoch||current.projectRevision!==state.projectRevision||canonicalJson(current.definition)!==definitionSnapshot)throw stale();
  return {orgId:scope.orgId,project:name,repository:input.repository,repositoryFullName:fullName,installationId:resolved.installationId,repositoryId:resolved.repositoryId,branch:input.branch,commit:resolved.commit,expectedRevision:state.epoch,expectedProjectRevision:state.projectRevision,checkedAt:new Date(deps.now()).toISOString()};
 }catch(error){throw safe(error);}
}
