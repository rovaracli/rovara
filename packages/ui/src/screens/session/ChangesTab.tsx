import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema, SessionDiffReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { DiffView } from "./DiffView.js";
import { Button } from "../../design/Button.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { TaskDiffReadRecoveryView } from "./TaskDiffReadRecoveryView.js";
import type { ReadSession } from "./SessionHeader.js";
import { visibleAnchor, type ReadTask, type CommentOnPart } from "./workspace-types.js";
export function ChangesTab({ session, task, onComment }: { session: ReadSession; task: ReadTask; onComment?: CommentOnPart | undefined }) {
 const [selected, setSelected] = useState<{ repository: string; number: number }>();
 return <section aria-label="Changed files">{task.changedFiles?.length ? <ul className="rv-changed-files">{task.changedFiles.map(file => { const anchor = visibleAnchor(session, "change_file", file.repository + ":" + file.path);return <li key={file.repository + ":" + file.path}><div><strong><VisibleText text={file.path} /></strong><p className="rv-muted"><VisibleText text={file.repository} /></p><p>{file.added} lines added, {file.removed} removed</p></div>{anchor && onComment && <Button variant="quiet" aria-label={"Comment on " + visibleText(file.path)} onClick={event => onComment(anchor, event.currentTarget)}>Comment</Button>}</li>; })}</ul> : <p>No changed files are available yet.</p>}{!task.pullRequests?.length ? <p>The full diff appears once the pull request is open.</p> : <div aria-label="Available pull request diffs">{task.pullRequests.map(pr => <Button key={pr.repository + ":" + pr.number} variant="quiet" onClick={() => setSelected({ repository: pr.repository, number: pr.number })}>View diff for <VisibleText text={pr.repository} /> #{pr.number}</Button>)}</div>}{selected && task.pullRequests?.some(pr => pr.repository === selected.repository && pr.number === selected.number) && <RequestedDiff key={session.sessionId + ":" + selected.repository + ":" + selected.number} sessionId={session.sessionId} repository={selected.repository} number={selected.number} />}</section>;
}

// Refusal/failure and issue order outlive a mounted tab. This cache contains no code or links.
interface DiffReadFence { issued: number; failure?: "unavailable" | "load-failed" }
function RequestedDiff(props: { sessionId: string; repository: string; number: number }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const identity = useQuery({ queryKey: ["task-diff-identity"], queryFn: () => api.get("/v1/app/me", AppMeResponseReaderSchema), staleTime: 0, gcTime: 0, refetchOnMount: "always" });
 if (identity.isError) return <p role="status">The account for this diff could not be read. Load the task again.</p>;
 if (identity.isPending || identity.isFetching) return <p role="status">Reading the account for this diff…</p>;
 return <ScopedDiff key={JSON.stringify([identity.data.org.orgId, identity.data.developer.id])} {...props} companyId={identity.data.org.orgId} personId={identity.data.developer.id} />;
}
function ScopedDiff({ sessionId, repository, number, companyId, personId }: { sessionId: string; repository: string; number: number; companyId: string; personId: string }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), queryClient = useQueryClient();
 const queryKey = ["session", sessionId, "diff", repository, number, companyId, personId] as const;
 const fenceKey = ["task-diff-read-fence", companyId, personId, sessionId, repository, number] as const;
 const fence = useQuery<DiffReadFence>({ queryKey: fenceKey, queryFn: () => ({ issued: 0 }), enabled: false, gcTime: Infinity });
 const query = useInfiniteQuery({ queryKey, initialPageParam: 1, staleTime: 0, refetchOnMount: "always",
 queryFn: async ({ pageParam }) => {
  const previous = queryClient.getQueryData<DiffReadFence>(fenceKey), issued = (previous?.issued ?? 0) + 1;
  queryClient.setQueryData<DiffReadFence>(fenceKey, { ...previous, issued });
  try {
   const page = await api.get("/v1/app/sessions/" + encodeURIComponent(sessionId) + "/diff?" + new URLSearchParams({ repository, number: String(number), page: String(pageParam) }).toString(), SessionDiffReaderSchema);
   if (queryClient.getQueryData<DiffReadFence>(fenceKey)?.issued !== issued) throw new ApiError(0, "READ_SUPERSEDED", "A newer diff read has started.");
   queryClient.setQueryData<DiffReadFence>(fenceKey, { issued });
   return page;
  } catch (error) {
   if (queryClient.getQueryData<DiffReadFence>(fenceKey)?.issued === issued) {
    const refused = error instanceof ApiError && [401, 403, 404].includes(error.status) && !["CSRF_STALE", "CSRF_INVALID"].includes(error.code);
    queryClient.setQueryData<DiffReadFence>(fenceKey, { issued, failure: refused ? "unavailable" : "load-failed" });
    // Drop all sensitive payload, retaining the error/fence for this identity and subject.
    queryClient.setQueryData(queryKey, { pages: [], pageParams: [] });
   }
   throw error;
  }
 }, getNextPageParam: page => page.nextPage });
 const failure = fence.data?.failure;
 if (failure !== undefined || query.isError) return <TaskDiffReadRecoveryView state={failure ?? "load-failed"} onRetry={() => { if (!query.isFetching) void query.refetch(); }} />;
 if (query.isPending) return <p role="status">Loading diff…</p>;
 return <>{query.data.pages.map((page, index) => <DiffView key={index} diff={page} />)}{query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage(); }}>Load more files</Button>}</>;
}
