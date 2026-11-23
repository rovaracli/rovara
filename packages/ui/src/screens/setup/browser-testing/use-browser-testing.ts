// The Browser testing page's reads and writes (GROUP-SCREEN-BRIEF READ HANDLING + WRITE AUTHORITY, rule #14, DEC 254zzz324).
//   - ONE read carries both the facts and who may change them (`canManage` is a live company owner or admin). The shared `servedReadState` + `isAccessEnded` decide what a failed read leaves: a transient failure KEEPS the
//     last facts with one reconnecting line and TAKES AWAY every write; an access signal (401/403/404) clears the facts.
//   - A write control is enabled only while that read is fresh and says `canManage`. At send time the read is asked again: a failed or no-longer-allowed read sends nothing; a changed draft revision or approval digest is a
//     conflict and sends nothing.
//   - A change is never repeated by the client. A failure that is not one of Code's fixed refusals (a lost answer, a 5xx, an unreadable answer) is an UNKNOWN outcome: every write stays off until a read (Check) says what Rovara has.
import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrowserTestingView } from "@agentx/contracts/web";
import { browserTestingKey, useBrowserTestingApi } from "../../../api/browser-testing.js";
import { ApiError } from "../../../api/errors.js";
import { isAccessEnded, servedReadState } from "../../../api/served-read.js";
import { BROWSER_TESTING_SENTENCES, BT } from "./browser-testing-text.js";
import { BROWSER_TESTING_CLOUD_SENTENCES, BROWSER_TESTING_CODE_SENTENCES } from "@agentx/contracts/web";

export type Outcome =
  | { kind: "none" }
  | { kind: "conflict" }
  | { kind: "no-permission"; sent?: true }
  | { kind: "refused"; text: string }
  | { kind: "unknown" }
  | { kind: "checked" };

/** What a write is allowed to depend on: the facts the person looked at. A send stops with a conflict when they are not what the read says now. */
export interface Seen { draftRevision?: number; approvalDigest?: string }

/** A failure that is not one of Code's fixed refusals: the answer was lost, unreadable or unexplained, so the change may have been made. */
const outcomeIsUnknown = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) return true;
  if (error.status === 0 || error.code === "INVALID_RESPONSE" || error.code === "NETWORK_ERROR" || error.message === BROWSER_TESTING_CLOUD_SENTENCES.outcomeUnknown) return true;
  return error.status >= 500 && !BROWSER_TESTING_SENTENCES.has(error.message);
};

export function useBrowserTesting(project: string) {
  const api = useBrowserTestingApi(), query = useQueryClient();
  const read = useQuery({ queryKey: browserTestingKey(project), queryFn: () => api.read(project), retry: false, refetchInterval: (current) => (current.state.data?.state === "checking" ? 5000 : false) });
  const [busy, setBusy] = useState<string>();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const [wrote, setWrote] = useState(false);
  /** When the data the last change answered was stored: the stale line says "Saved" only while that is still the data on screen. */
  const [savedAt, setSavedAt] = useState(0);
  const sending = useRef(false);

  const shown = servedReadState(read);
  const view = shown.data;
  const fresh = view !== undefined && shown.staleSince === undefined;
  const denied = read.isError && isAccessEnded(read.error);
  const locked = outcome.kind === "unknown";
  /** Write controls: this read is fresh, it says this person may, nothing is in flight and no outcome is unknown. */
  const canChange = fresh && view.canManage && busy === undefined && !locked;
  const savedStale = view !== undefined && shown.staleSince !== undefined && wrote && shown.staleSince === savedAt;

  const reread = useCallback(async (): Promise<{ view: BrowserTestingView } | { failed: "denied" | "failed" }> => {
    const again = await read.refetch();
    if (again.isError || again.data === undefined) return { failed: isAccessEnded(again.error) ? "denied" : "failed" };
    return { view: again.data };
  }, [read]);

  /** One change. `still` says whether the read now still has what the person looked at; `send` makes the one request. */
  async function change(name: string, still: (now: BrowserTestingView) => boolean, send: (now: BrowserTestingView) => Promise<BrowserTestingView>, onDone?: () => void): Promise<void> {
    if (sending.current || !canChange) return;
    sending.current = true; setBusy(name); setOutcome({ kind: "none" });
    try {
      const now = await reread();
      if ("failed" in now) { setOutcome({ kind: "refused", text: now.failed === "denied" ? BT.noPermissionText : BT.rereadFailed }); return; }
      if (!now.view.canManage) { setOutcome({ kind: "no-permission" }); return; }
      if (!still(now.view)) { setOutcome({ kind: "conflict" }); return; }
      try {
        const answered = await send(now.view);
        query.setQueryData(browserTestingKey(project), answered);
        setSavedAt(query.getQueryState(browserTestingKey(project))?.dataUpdatedAt ?? Date.now());
        setWrote(true);
        onDone?.();
      } catch (caught) {
        if (outcomeIsUnknown(caught)) { setOutcome({ kind: "unknown" }); return; }
        const error = caught as ApiError;
        if (error.status === 409 && error.message === BROWSER_TESTING_CODE_SENTENCES.stale) setOutcome({ kind: "conflict" });
        else if (error.status === 403) setOutcome({ kind: "no-permission", sent: true });
        else setOutcome({ kind: "refused", text: BROWSER_TESTING_SENTENCES.has(error.message) ? error.message : BT.sendFailed });
        void query.invalidateQueries({ queryKey: browserTestingKey(project) });
      }
    } finally { sending.current = false; setBusy(undefined); }
  }

  /** Check: a read, never a write. It is what lifts the lock of an unknown outcome. */
  async function check(): Promise<void> {
    if (sending.current) return;
    sending.current = true; setBusy("check-read");
    try {
      const now = await reread();
      if ("view" in now) setOutcome(outcome.kind === "unknown" ? { kind: "checked" } : { kind: "none" });
    } finally { sending.current = false; setBusy(undefined); }
  }
  async function refresh(): Promise<void> {
    if (sending.current) return;
    sending.current = true; setBusy("refresh-read");
    try { const now = await reread(); if ("view" in now && outcome.kind === "conflict") setOutcome({ kind: "none" }); } finally { sending.current = false; setBusy(undefined); }
  }

  const id = () => crypto.randomUUID();
  const act = {
    startSetup: () => change("refresh", () => true, () => api.refresh(project, id())),
    readAgain: () => change("refresh", (now) => now.candidate === null && !now.setupWaiting, () => api.refresh(project, id())),
    saveChoices: (seen: Seen, choices: Parameters<typeof api.choices>[3], onDone: () => void) => change("choices", (now) => now.draft !== null && now.draft.revision === seen.draftRevision && !now.draft.locked, () => api.choices(project, id(), seen.draftRevision!, choices), onDone),
    checkSetup: (seen: Seen) => change("check", (now) => now.draft !== null && now.draft.revision === seen.draftRevision && !now.draft.locked && !now.draft.stale && now.sandboxAvailable, () => api.check(project, id(), seen.draftRevision!)),
    approve: (seen: Seen) => change("approve", (now) => now.candidate?.canApprove === true && now.candidate.approval?.artifactDigest === seen.approvalDigest, (now) => api.approve(project, now.candidate!.approval!).then((done) => done.view)),
    discard: (seen: Seen, onDone?: () => void) => change("discard", (now) => now.candidate !== null && (seen.approvalDigest === undefined || now.candidate.approval?.artifactDigest === seen.approvalDigest), () => api.discard(project, id()), onDone),
    pause: () => change("pause", (now) => now.approved !== null && !now.paused, () => api.pause(project, id())),
    resume: () => change("resume", (now) => now.approved !== null && now.paused, () => api.resume(project, id())),
  };
  return { read, view, fresh, denied, canChange, busy, outcome, setOutcome, savedStale, wrote, act, check, refresh };
}
