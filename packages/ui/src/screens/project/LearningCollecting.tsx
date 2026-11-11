import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { AppNavReaderSchema } from "@agentx/cloud-contracts/web";
import { COLLECTING_TEXT as T, collectingCount } from "./learning-text.js";

/** Shown in place of the empty state while the company's suggestions are off: Rovara keeps collecting corrections, and says where to turn suggestions on. The company page is a link only for a company owner or admin (the same signal the sidebar's Admin link uses, read from the shell's cached nav); anyone else would land on "Administration unavailable". */
export function LearningCollecting({ corrections }: { corrections: number }) {
 const role = useQuery<ReturnType<typeof AppNavReaderSchema.parse>, Error, string | undefined>({ queryKey: ["nav"], enabled: false, select: nav => nav.me.orgRole }).data, admin = role === "owner" || role === "admin";
 return <div className="rv-learning-collecting"><h3>{T.HEADING}</h3><p>{collectingCount(corrections)}</p><p className="rv-muted">{T.WHERE}{admin ? <Link to="/app/admin/how-we-work">{T.LINK}</Link> : T.LINK}</p></div>;
}
