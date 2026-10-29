import { SaveWorkingBranch } from "./SaveWorkingBranch.js";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ProjectWorkingBranchContextReaderSchema, ProjectWorkingBranchPageReaderSchema, ProjectWorkingBranchPreviewReaderSchema, type ProjectWorkingBranchContext } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { createApiClient, type Reader } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { DataTable } from "../../../design/DataTable.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
const options = { gcTime: 0, staleTime: Infinity, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
type Api = ReturnType<typeof createApiClient>;
type Repo = ProjectWorkingBranchContext["repositories"][number];
const invalid = () => new ApiError(502, "INVALID_RESPONSE", "Working branch response could not be verified.");
async function read<T>(api: Api, path: string, reader: Reader<T>, signal: AbortSignal, matches: (value: T) => boolean): Promise<T> {
  signal.throwIfAborted();
  let data: T;
  try { data = await api.get(path, reader, undefined, { retry: "never" }); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError) {
      const known = new Set(["AUTH_REQUIRED", "FORBIDDEN", "GITHUB_NOT_CONNECTED", "CHANGE_STALE", "NOT_FOUND", "TOO_MANY_REQUESTS", "RUNTIME_UNAVAILABLE", "INVALID_RESPONSE", "NETWORK_ERROR"]);
      throw new ApiError(error.status, known.has(error.code) ? error.code : "REQUEST_FAILED", problem(error));
    }
    throw invalid();
  }
  signal.throwIfAborted();
  if (!matches(data)) throw invalid();
  return data;
}
function useCleanup(key: QueryKey) {
  const query = useQueryClient();
  useEffect(() => () => { void query.cancelQueries({ queryKey: key });query.removeQueries({ queryKey: key }); }, [query, key]);
}
function fatal(error: unknown, preview = false) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 409 || (!preview && error.status === 404) || error.code === "INVALID_RESPONSE");
}
function problem(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "GITHUB_NOT_CONNECTED") return "Reconnect this repository before inspecting working branches.";
    if (error.code === "INVALID_RESPONSE") return "Working branch response could not be verified. Refresh branch context.";
    if (error.status === 401 || error.status === 403) return "You no longer have permission to inspect working branches.";
    if (error.status === 409) return "Project context changed. Refresh branch context and project details.";
    if (error.status === 429) return "Too many branch checks. Try again later.";
    if (error.status === 404) return "That project, repository or branch is no longer available. Refresh before trying again.";
  }
  return "Couldn't check working branches. Try again.";
}
// Defensive labels remain safe if a future caller has not yet applied the strict reader.
export function WorkingBranchInspectLabel({ branch }: {branch: string}) { return <>Inspect <VisibleText text={branch} /></>; }
export function WorkingBranchRepositoryLabel({ fullName, name }: {fullName: string; name: string}) { return <><VisibleText text={fullName} /> (<VisibleText text={name} />)</>; }
function action(label: ReactNode, busy: boolean, run: () => void, blocked = false) {
  return <button type="button" className="rv-button rv-button-secondary" aria-disabled={busy || blocked || undefined} aria-busy={busy || undefined} onClick={() => { if (!busy && !blocked) run(); }}>{label}</button>;
}
function scopeMatches(value: {orgId: string; project: string; repository: string; repositoryFullName: string; expectedRevision: number; expectedProjectRevision: number}, context: ProjectWorkingBranchContext, repo: Repo) {
  return value.orgId === context.orgId && value.project === context.project && value.repository === repo.name && value.repositoryFullName.toLowerCase() === repo.fullName.toLowerCase() && value.expectedRevision === context.expectedRevision && value.expectedProjectRevision === context.expectedProjectRevision;
}
function basePath(context: ProjectWorkingBranchContext, repo: Repo) { return `/v1/app/projects/${encodeURIComponent(context.project)}/repositories/${encodeURIComponent(repo.name)}/branches`; }
function pins(context: ProjectWorkingBranchContext) { return { expectedOrgId: context.orgId, expectedRevision: String(context.expectedRevision), expectedProjectRevision: String(context.expectedProjectRevision) }; }
function BranchPreview({ api, root, context, repo, branch, onInvalid }: {api: Api; root: QueryKey; context: ProjectWorkingBranchContext; repo: Repo; branch: string; onInvalid: (error: unknown) => void}) {
  const key = useMemo(() => [...root, "preview", context.checkedAt, repo.name, branch], [root, context.checkedAt, repo.name, branch]);useCleanup(key);
  const preview = useQuery({ ...options, queryKey: key, queryFn: ({signal}) => read(api, basePath(context, repo) + "/preview?" + new URLSearchParams({...pins(context), branch}).toString(), ProjectWorkingBranchPreviewReaderSchema, signal, value => scopeMatches(value, context, repo) && value.branch === branch) });
  useEffect(() => { if (fatal(preview.error, true)) onInvalid(preview.error); }, [preview.error, onInvalid]);
  if (fatal(preview.error, true)) return <p role="alert">{problem(preview.error)}</p>;
  const missing = preview.error instanceof ApiError && preview.error.status === 404;
  return <section aria-label="Selected branch inspection"><h4>Selected branch: <VisibleText text={branch} /></h4>{action("Recheck selected branch", preview.isFetching, () => { void preview.refetch(); })}
    {preview.isPending ? <Skeleton label="Checking selected branch" /> : <>
      {preview.isError && <p role="alert">{missing ? "That branch is no longer available. Inspect another branch; no default branch was substituted." : preview.data ? `This branch check is stale. ${problem(preview.error)}` : problem(preview.error)}</p>}
      {preview.data && !missing && <><p>Commit: <code><VisibleText text={preview.data.commit} /></code></p><p>Checked at <time dateTime={preview.data.checkedAt}>{preview.data.checkedAt}</time> UTC.</p>{preview.isFetching && <p role="status">Rechecking the selected branch; the previous check is shown.</p>}{!preview.isFetching && !preview.isError && <SaveWorkingBranch key={`${preview.data.checkedAt}:${preview.data.commit}`} preview={preview.data} />}</>}
    </>}</section>;
}
function BranchPage({ api, root, context, repo, onInvalid }: {api: Api; root: QueryKey; context: ProjectWorkingBranchContext; repo: Repo; onInvalid: (error: unknown) => void}) {
  const [loaded, setLoaded] = useState(false), [history, setHistory] = useState<Array<string | undefined>>([undefined]), [index, setIndex] = useState(0), [selected, setSelected] = useState<string>();
  const cursor = history[index], key = useMemo(() => [...root, "page", context.checkedAt, repo.name, index, cursor ?? ""], [root, context.checkedAt, repo.name, index, cursor]);useCleanup(key);
  const page = useQuery({ ...options, queryKey: key, enabled: loaded, queryFn: ({signal}) => read(api, basePath(context, repo) + "?" + new URLSearchParams({...pins(context), ...(cursor === undefined ? {} : {cursor})}).toString(), ProjectWorkingBranchPageReaderSchema, signal, value => scopeMatches(value, context, repo) && value.page === index + 1) });
  useEffect(() => { if (fatal(page.error)) onInvalid(page.error); }, [page.error, onInvalid]);
  const blocked = page.isFetching || page.isError, next = page.data?.nextCursor;
  function refresh() { setSelected(undefined);if (!loaded) setLoaded(true);else void page.refetch(); }
  function forward() {
    if (next === undefined) return;
    if (history.slice(0, index + 1).includes(next)) { onInvalid(invalid());return; }
    setSelected(undefined);setHistory([...history.slice(0, index + 1), next]);setIndex(index + 1);
  }
  return <section aria-label="Branch pages">{action(loaded ? "Refresh branch page" : "Load branch page", page.isFetching, refresh)}
    <p>Pages are checked separately and are not a complete branch inventory. Nothing is loaded automatically beyond the page you request.</p>
    {loaded && <>{page.isPending ? <Skeleton label="Loading branch page" /> : fatal(page.error) ? <p role="alert">{problem(page.error)}</p> : <>
      {page.isError && <p role="alert">{page.data ? `This branch page is stale. ${problem(page.error)}` : problem(page.error)}</p>}
      {page.data && <><p>Page {page.data.page} · {page.data.branches.length} branches on this page. Checked at <time dateTime={page.data.checkedAt}>{page.data.checkedAt}</time> UTC.</p>
        {page.data.omittedUnsupported && <p>Some branch names are not supported by this chooser.</p>}
        {page.data.branches.length === 0 ? <p>{page.data.mayHaveMore ? "No supported branches on this page. More may be available." : "No branches were returned on this page."}</p> : <DataTable caption="Working branches on this page" rows={page.data.branches} rowKey={branch => branch} columns={[{key:"branch",title:"Branch",render:branch=><code><VisibleText text={branch} /></code>},{key:"inspect",title:"Inspection",render:branch=>action(<WorkingBranchInspectLabel branch={branch} />, false, () => setSelected(branch), blocked)}]} />}
        {page.data.limitReached && <p role="status">Page limit reached. This is not a complete branch inventory.</p>}
      </>}
    </>}{action("Previous branch page", page.isFetching, () => { setSelected(undefined);setIndex(index - 1); }, blocked || index === 0)}{action("Next branch page", page.isFetching, forward, blocked || next === undefined)}</>}
    {selected !== undefined && !blocked && !fatal(page.error) && <BranchPreview key={selected} api={api} root={root} context={context} repo={repo} branch={selected} onInvalid={onInvalid} />}
  </section>;
}
function Repositories({ api, root, context, onInvalid }: {api: Api; root: QueryKey; context: ProjectWorkingBranchContext; onInvalid: (error: unknown) => void}) {
  const [name, setName] = useState(context.repositories[0]?.name ?? ""), repo = context.repositories.find(value => value.name === name);
  return <>{context.omittedUnsupported && <p>Some repositories need a supported registered connection before they can be inspected.</p>}{repo === undefined ? <p>No registered repositories are available for branch inspection.</p> : <><label>Repository to inspect <select value={name} onChange={event => setName(event.target.value)}>{context.repositories.map(value=><option key={value.name} value={value.name}><WorkingBranchRepositoryLabel fullName={value.fullName} name={value.name} /></option>)}</select></label><BranchPage key={name} api={api} root={root} context={context} repo={repo} onInvalid={onInvalid} /></>}</>;
}
function Inspection({ name, projectRevision }: {name: string; projectRevision: number}) {
  const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), identity = useAdminContext();
  const root = useMemo(() => ["admin", "working-branches", identity.orgId, identity.developerId, name, projectRevision], [identity.orgId, identity.developerId, name, projectRevision]);useCleanup(root);
  const key = useMemo(() => [...root, "context"], [root]);
  const [blocked, setBlocked] = useState<unknown>();
  const context = useQuery({ ...options, queryKey: key, queryFn: async ({signal}) => {
    const value = await read(api, `/v1/app/projects/${encodeURIComponent(name)}/working-branches?` + new URLSearchParams({expectedOrgId:identity.orgId}).toString(), ProjectWorkingBranchContextReaderSchema, signal, data => data.orgId === identity.orgId && data.project === name);
    if (value.expectedProjectRevision !== projectRevision) throw new ApiError(409, "CHANGE_STALE", "Project context changed.");
    return value;
  } });
  const onInvalid = useCallback((error: unknown) => setBlocked(error), []);
  async function refresh() { const result = await context.refetch();if (result.isSuccess) setBlocked(undefined); }
  return <div className="rv-admin-branch-inspection" aria-busy={context.isFetching}>
    <p>Inspect a branch, then explicitly review and save its setting. Saving does not change task behavior; task consumers remain unavailable.</p>
    {action("Refresh branch context", context.isFetching, () => { void refresh(); })}
    {context.isPending ? <Skeleton label="Loading branch context" /> : context.isError || blocked !== undefined ? <p role="alert">{problem(blocked ?? context.error)}</p> : context.data && <><p>Project context checked at <time dateTime={context.data.checkedAt}>{context.data.checkedAt}</time> UTC · Project revision {context.data.expectedProjectRevision}.</p>{!context.isFetching && <Repositories api={api} root={root} context={context.data} onInvalid={onInvalid} />}</>}
  </div>;
}
export function WorkingBranches({ name, projectRevision, available }: {name: string; projectRevision: number; available: boolean}) {
  const identity = useAdminContext(), [open, setOpen] = useState(false), allowed = available && !identity.checking;
  const [previousAllowed, setPreviousAllowed] = useState(allowed);
  if (previousAllowed !== allowed) { setPreviousAllowed(allowed);if (!allowed) setOpen(false); }
  return <section aria-label="Working branch inspection"><h3>Working branch inspection</h3>{action(open ? "Close branch inspection" : "Inspect working branches", false, () => setOpen(!open), !allowed && !open)}{open && allowed && <Inspection key={`${identity.orgId}:${identity.developerId}:${name}:${projectRevision}`} name={name} projectRevision={projectRevision} />}</section>;
}
