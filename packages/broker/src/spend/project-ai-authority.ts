// Native read snapshots for the existing project AI settings commit; no lifecycle/catalog writes.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { StoredProjectDefinitionSchema, PROJECT_REVISION_SK_PREFIX, agentXError, projectArchivedMessage, projectPk, projectRevisionKey, projectMetaKey, orgProjectCatalogKey, type OrgId } from "@agentx/contracts";
import { Aliases, type TransactItem } from "../agents/table-writes.js";
type Deps = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string };
type Item = Record<string, unknown>;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The project's current registration or status could not be checked. Reload or ask an installation administrator to check it.");
async function read(deps: Deps, Key: {pk:string;sk:string}): Promise<Item | undefined> {
  return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key,ConsistentRead:true})) as {Item?:Item}).Item;
}
function snapshot(deps: Deps, Key: {pk:string;sk:string}, raw: Item | undefined, fields: string[]): TransactItem {
  if(raw===undefined)return {ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_not_exists(pk)"}};
  const aliases=new Aliases();
  const condition=["attribute_exists(pk)",...fields.map(field=>raw[field]===undefined?`attribute_not_exists(${aliases.name(field)})`:`${aliases.name(field)} = ${aliases.value(raw[field])}`)].join(" AND ");
  return {ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:condition,ExpressionAttributeNames:aliases.names,...(Object.keys(aliases.values).length===0?{}:{ExpressionAttributeValues:aliases.values})}};
}
export async function projectAiLifecycleChecks(deps: Deps, orgId: OrgId, project: string, options: {allowArchived?:boolean} = {}): Promise<TransactItem[]> {
  const catalogKey=orgProjectCatalogKey(orgId,project),metaKey=projectMetaKey(orgId,project);
  const [response,catalog,meta]=await Promise.all([
    deps.documentClient.send(new QueryCommand({TableName:deps.tableName,KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":pk":projectPk(orgId,project),":prefix":PROJECT_REVISION_SK_PREFIX},ScanIndexForward:false,Limit:1,ConsistentRead:true})) as Promise<{Items?:Item[]}>,read(deps,catalogKey),read(deps,metaKey),
  ]);
  const row=response.Items?.[0];
  if(row===undefined)throw agentXError("PROJECT_NOT_FOUND","project not found");
  const parsed=StoredProjectDefinitionSchema.safeParse(row.definition);
  if(!parsed.success||parsed.data.name!==project||!Number.isSafeInteger(parsed.data.revision))throw unavailable();
  const key=projectRevisionKey(orgId,project,parsed.data.revision);
  if(row.pk!==key.pk||row.sk!==key.sk)throw unavailable();
  if(catalog!==undefined&&(catalog.entityType!=="PROJECT_CATALOG"||catalog.name!==project||(catalog.orgId!==undefined&&catalog.orgId!==orgId)||(catalog.latestRevision!==undefined&&catalog.latestRevision!==parsed.data.revision)))throw unavailable();
  if(meta!==undefined&&(meta.entityType!=="PROJECT_META"||meta.name!==project||(meta.status!==undefined&&meta.status!=="active"&&meta.status!=="archived")))throw unavailable();
  if(meta?.status==="archived"&&options.allowArchived!==true)throw agentXError("PROJECT_ARCHIVED",projectArchivedMessage(project));
  return [snapshot(deps,key,row,["definition"]),snapshot(deps,catalogKey,catalog,["entityType","name","orgId","latestRevision"]),snapshot(deps,metaKey,meta,["entityType","name","status","revision","archivedAt","archivedBy","updatedAt"])];
}
