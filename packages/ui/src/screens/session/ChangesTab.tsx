import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { SessionDiffReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { DiffView } from "./DiffView.js";
import { Button } from "../../design/Button.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import { visibleAnchor, type ReadTask, type CommentOnPart } from "./workspace-types.js";
export function ChangesTab({ session, task, onComment }: { session: ReadSession; task: ReadTask; onComment?: CommentOnPart | undefined }) {
 const [selected, setSelected] = useState<{ repository: string; number: number }>();
 return <section aria-label="Changed files">{task.changedFiles?.length ? <ul className="rv-changed-files">{task.changedFiles.map(file => { const anchor = visibleAnchor(session, "change_file", file.repository + ":" + file.path);return <li key={file.repository + ":" + file.path}><div><strong><VisibleText text={file.path} /></strong><p className="rv-muted"><VisibleText text={file.repository} /></p><p>{file.added} lines added, {file.removed} removed</p></div>{anchor && onComment && <Button variant="quiet" aria-label={"Comment on " + visibleText(file.path)} onClick={event => onComment(anchor, event.currentTarget)}>Comment</Button>}</li>; })}</ul> : <p>No changed files are available yet.</p>}{!task.pullRequests?.length ? <p>The full diff appears once the pull request is open.</p> : <div aria-label="Available pull request diffs">{task.pullRequests.map(pr => <Button key={pr.repository + ":" + pr.number} variant="quiet" onClick={() => setSelected({ repository: pr.repository, number: pr.number })}>View diff for <VisibleText text={pr.repository} /> #{pr.number}</Button>)}</div>}{selected && task.pullRequests?.some(pr => pr.repository === selected.repository && pr.number === selected.number) && <RequestedDiff key={session.sessionId + ":" + selected.repository + ":" + selected.number} sessionId={session.sessionId} repository={selected.repository} number={selected.number} />}</section>;
}

function RequestedDiff({ sessionId, repository, number }: { sessionId: string; repository: string; number: number }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const query = useInfiniteQuery({ queryKey: ["session", sessionId, "diff", repository, number], initialPageParam: 1,
 queryFn: ({ pageParam }) => api.get("/v1/app/sessions/" + encodeURIComponent(sessionId) + "/diff?" + new URLSearchParams({ repository, number: String(number), page: String(pageParam) }).toString(), SessionDiffReaderSchema),
 getNextPageParam: page => page.nextPage });
 if (query.isError) return <p role="status">{query.error instanceof ApiError && query.error.status === 404 ? "This diff is unavailable, or you no longer have access." : "The diff couldn't be loaded."} <Button variant="quiet" onClick={() => { void query.refetch(); }}>Try again</Button></p>;
 if (query.isPending) return <p role="status">Loading diff…</p>;
 return <>{query.data.pages.map((page, index) => <DiffView key={index} diff={page} />)}{query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage(); }}>Load more files</Button>}</>;
}
