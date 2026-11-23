import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LESSONS_SLACK_PATH, readLessonsSlackSwitch } from "../../api/lessons-slack.js";
import { createApiClient } from "../../api/client.js";
import { useAppHost } from "../../host.js";
import { Switch } from "../../design/Switch.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ReadState } from "../account-setup-read/ReadState.js";
import { COULDNT_REFRESH, STALE_REFUSAL, rereadFailed, servedFacts, useNoteWrite, useScopedRead, useWritable } from "../account-setup-read/read-model.js";
import { useReconnectingLine } from "../account-setup-read/reconnecting.js";

export const SLACK_LEARNING_WORDS = {
 LABEL: "Don't learn from my Slack messages",
 HELP: "Rovara only ever reads replies in a Slack thread it was working in, once, when its work ends. Turn this on and your replies are left out of what Rovara learns, from the next task on. Nothing already learned is changed here.",
 LOADING: "Loading your Slack setting", SAVE_FAILED: "Couldn't confirm it saved. Reload this page to check.", ON: "Saved. Your Slack replies are left out.", OFF: "Saved. Your Slack replies can be learned from again.",
} as const;

/**
 * The person's own switch, one row of Account's Learning group (`GET`/`PUT /v1/app/me/lessons-slack`). The person is the session's; the body is the one choice.
 * While the setting cannot be read the switch is not drawn and nothing is claimed about the person's setting: the row says Can't tell yet.
 */
export function SlackLearningSwitch() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), client = useQueryClient();
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>(), [written, setWritten] = useState<{ optOut: boolean; at: number }>();
 const current = useScopedRead(LESSONS_SLACK_PATH, { parse: readLessonsSlackSwitch });
 // The one write rule (useWritable): the switch is drawn and sent only while who you are and this setting are fresh reads.
 const writable = useWritable(current), noteWrite = useNoteWrite();
 async function change(optOut: boolean) {
  if (!writable) { setMessage({ kind: "alert", text: STALE_REFUSAL }); return; }
  setBusy(true); setMessage(undefined);
  try {
   const saved = await api.sendAnswer("PUT", LESSONS_SLACK_PATH, { optOut }, { parse: readLessonsSlackSwitch }, { retry: "never" });
   noteWrite();
   // The save went through: that is what the row says, even if reading it back fails (then the last read is kept and the saved word is held until a read newer than the save answers).
   setWritten({ optOut: saved.optOut, at: Date.now() });
   const refreshFailed = await rereadFailed(client, { predicate: entry => entry.queryKey.includes(LESSONS_SLACK_PATH) });
   const word = saved.optOut ? SLACK_LEARNING_WORDS.ON : SLACK_LEARNING_WORDS.OFF;
   setMessage({ kind: "status", text: refreshFailed ? `${word} ${COULDNT_REFRESH}` : word });
  } catch { setMessage({ kind: "alert", text: SLACK_LEARNING_WORDS.SAVE_FAILED }); } finally { setBusy(false); }
 }
 const { data, staleSince } = servedFacts(current), line = useReconnectingLine(staleSince);
 const content = (optOut: boolean) => <>
  <div className="g5-row-main"><h3>Learning from your Slack replies</h3><p className="g5-row-detail">{SLACK_LEARNING_WORDS.HELP}</p>
   {message !== undefined && <p className="g5-row-detail" role={message.kind === "alert" ? "alert" : "status"}><VisibleText text={message.text} /></p>}</div>
  <div className="g5-row-aside">{writable ? <Switch label={SLACK_LEARNING_WORDS.LABEL} checked={optOut} disabled={busy} onCheckedChange={next => { void change(next); }} /> : <span className="g5-row-detail" data-testid="slack-learning-value">{optOut ? "On" : "Off"}</span>}</div>
 </>;
 // The last good answer stays on screen (also while it is read again and after a failed re-read, with the one Reconnecting line), so the row and its fixed word do not blink away.
 // A word saved after that read is what the switch shows until a newer read answers.
 if (data !== undefined) return <li className="g5-row g5-row-switch" aria-label="Slack learning" data-testid="slack-learning">{line}{content(written !== undefined && current.dataUpdatedAt < written.at ? written.optOut : data.optOut)}</li>;
 // Loading, or no facts after an access signal / a first read that failed: the shared outcome (Can't tell yet, nothing claimed about the setting, no switch drawn).
 return <ReadState query={current} label="your Slack learning preference" rowLabel="Slack learning">{data => content(data.optOut)}</ReadState>;
}
