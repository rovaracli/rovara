import { useMemo, useState } from "react";
import { Link } from "react-router";
import { usePublishRequests, type ReadPublishRequest } from "../../api/agent-publish.js";
import { useNav } from "../../api/nav.js";
import { ApiError } from "../../api/errors.js";
import { paths } from "../../paths.js";
import { useAnnounce } from "../../design/Announcer.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Tabs } from "../../design/Tabs.js";
import { VisibleText } from "../../design/VisibleText.js";
import { NotFound } from "../../shell/NotFound.js";
import { PublishRequestCard } from "./PublishRequestCard.js";
import { useAgentPublishOn } from "./publish-flags.js";
import "./publish.css";

type Feed = ReturnType<typeof usePublishRequests>;
const decidable = (request: ReadPublishRequest): boolean => request.state === "pending" && request.approval.canDecide;
const flatten = (feed: Feed): ReadPublishRequest[] => feed.isError ? [] : feed.data?.pages.flatMap(page => page.requests) ?? [];

function Failed({ feed, what }: { feed: Feed; what: string }) {
 return <div role="alert"><p><VisibleText text={feed.error instanceof ApiError ? feed.error.message : `Couldn't load ${what}. Try again.`} /></p><Button onClick={() => { void feed.refetch(); }}>Try again</Button></div>;
}
function List({ feed, label, empty, meId, onDecided, only }: { feed: Feed; label: string; empty: string; meId: string | undefined; onDecided: (message: string) => void; only?: (request: ReadPublishRequest) => boolean }) {
 const items = flatten(feed).filter(request => only === undefined || only(request));
 return <div>
  {feed.isPending && <Skeleton label={"Loading " + label} />}
  {feed.isError && <Failed feed={feed} what={label} />}
  {!feed.isPending && !feed.isError && items.length === 0 && <p className="rv-pub-empty">{empty}</p>}
  {items.length > 0 && <ul className="rv-pub-list" aria-label={label}>{items.map(request => <PublishRequestCard key={request.requestId} request={request} meId={meId} onDecided={onDecided} />)}</ul>}
  {feed.hasNextPage && <Button busy={feed.isFetchingNextPage} onClick={() => { void feed.fetchNextPage(); }}>Show more</Button>}
 </div>;
}

/**
 * Publish requests: the ones waiting for you to decide (maintainers and admins) and the ones you asked for. Only where the publishing switch is on; off, this address is not found, as it was before.
 */
export default function PublishRequestsScreen() {
 const on = useAgentPublishOn(), nav = useNav(), announce = useAnnounce();
 const waiting = usePublishRequests({ state: "pending" }, on), mine = usePublishRequests({ state: "all", mine: true }, on);
 const [tab, setTab] = useState<string>(), [notice, setNotice] = useState<string>();
 const meId = nav.isError ? undefined : nav.data?.me.developerId;
 const toDecide = useMemo(() => flatten(waiting).filter(decidable), [waiting]);
 if (!on) return <NotFound />;
 const current = tab ?? (toDecide.length > 0 ? "decide" : "mine");
 const onDecided = (message: string) => { setNotice(message);announce(message); };
 return <section className="rv-pub-screen">
  <PageHeader title="Publish requests" description="Asks to share an agent with a project or the whole company." focusOnMount actions={<Link className="rv-button" to={paths.directory}>All agents</Link>} />
  {notice !== undefined && <p role="status" className="rv-pub-notice"><VisibleText text={notice} /></p>}
  {waiting.isPending ? <Skeleton label="Loading requests" /> : <Tabs label="Publish requests" value={current} onValueChange={setTab} items={[
   { value: "decide", label: toDecide.length > 0 ? `To decide (${String(toDecide.length)})` : "To decide", content: <List feed={waiting} label="requests to decide" empty="Nothing waits for you to decide." meId={meId} onDecided={onDecided} only={decidable} /> },
   { value: "mine", label: "My requests", content: <List feed={mine} label="your requests" empty="You haven't asked to publish anything yet. Open an agent you own and choose Ask to publish." meId={meId} onDecided={onDecided} /> },
  ]} />}
 </section>;
}
