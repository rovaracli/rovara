import { useId, useMemo, useState } from "react";
import { parseSlackPlaceInput, type SourcePickerKind } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { useSourceOptions, type SourceOptionsPage } from "../../../api/record-source-options.js";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { visibleText } from "../../../design/VisibleText.js";
import { T } from "./lessons-text.js";

const WORDS: Readonly<Record<Exclude<SourcePickerKind, "slack-private">, { pick: string; find: string; none: string; partial: string; cut: string; typed: string; hint: string }>> = {
 slack: { pick: T.SRC_PICK_SLACK, find: T.SRC_FIND_SLACK, none: T.SRC_NO_MATCH_SLACK, partial: T.SRC_PARTIAL_SLACK, cut: T.SRC_CUT_SLACK, typed: T.SRC_PLACE_SLACK, hint: T.SRC_HINT_SLACK },
 linear: { pick: T.SRC_PICK_LINEAR, find: T.SRC_FIND_LINEAR, none: T.SRC_NO_MATCH_LINEAR, partial: T.SRC_PARTIAL_LINEAR, cut: T.SRC_CUT_LINEAR, typed: T.SRC_PLACE_LINEAR, hint: T.SRC_HINT_LINEAR },
 jira: { pick: T.SRC_PICK_JIRA, find: T.SRC_FIND_JIRA, none: T.SRC_NO_MATCH_JIRA, partial: T.SRC_PARTIAL_JIRA, cut: T.SRC_CUT_JIRA, typed: T.SRC_PLACE_JIRA, hint: T.SRC_HINT_JIRA },
};
const SHOWN_MAX = 100;
const REASON: Readonly<Record<string, string>> = { added: T.SRC_OPT_ADDED, taken: T.SRC_OPT_TAKEN, slack_connect: T.SRC_OPT_CONNECT, clearing: T.SRC_OPT_CLEARING };
type Option = SourceOptionsPage["options"][number];

/** A pasted Slack link or ID becomes the ID the server will use (an app link keeps its workspace); anything else is left as typed. The server reads it again. */
function filledPlace(text: string): string {
 const parsed = parseSlackPlaceInput(text);
 return parsed === undefined || parsed.form === "scope" ? text : parsed.form === "client" ? "slack:" + parsed.teamId! + "/" + parsed.channelId : parsed.channelId;
}

/** The radio rows of a list. An option that is not available (already a source, used elsewhere, Slack Connect, clearing) is disabled with its reason; the bot-not-in-channel hint only where `hint` is on. */
function OptionRows({ options, group, value, onChange, unavailable, hint }: { options: readonly Option[]; group: string; value: string; onChange: (scope: string) => void; unavailable: (scope: string) => boolean; hint: boolean }) {
 return <ul>{options.slice(0, SHOWN_MAX).map(option => {
  const blocked = option.state !== "available" || unavailable(option.scope), reason = option.state !== "available" ? REASON[option.state] : blocked ? T.SRC_CLEARING : undefined;
  return <li key={option.scope}><label className="rv-lessons-option" data-unavailable={blocked}><input type="radio" name={group} value={option.scope} checked={value === option.scope} disabled={blocked} onChange={() => { if (!blocked) onChange(option.scope); }} />
   <span>{visibleText(option.name)}</span>{reason !== undefined && <span className="rv-muted">{reason}</span>}{hint && option.joined === false && option.state === "available" && <span className="rv-muted">{T.SRC_NOT_JOINED}</span>}</label></li>;
 })}</ul>;
}

/**
 * "Your private channels": the private channels that both Rovara and THIS person are in, read for them alone (the server finds their Slack account itself) and shown only on their screen, never kept beyond the Add form.
 * A person with no linked Slack account, or a read that fails, gets one fixed line and no name. Same radio group and states as the public list.
 */
function PrivateChannels({ project, group, value, onChange, unavailable, needle }: { project: string; group: string; value: string; onChange: (scope: string) => void; unavailable: (scope: string) => boolean; needle: string }) {
 const query = useSourceOptions(project, "slack-private", true), { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
 const options = useMemo(() => {
  const seen = new Set<string>(), all: Option[] = [];
  for (const page of query.data?.pages ?? []) for (const option of page.options) if (!seen.has(option.scope)) { seen.add(option.scope);all.push(option); }
  return all;
 }, [query.data]);
 if (query.data === undefined) return query.isError ? <p className="rv-muted">{T.SRC_PRIVATE_FAIL}</p> : null;
 if (query.data.pages[0]?.notLinked === true) return <p className="rv-muted">{T.SRC_PRIVATE_NOT_LINKED}</p>;
 if (options.length === 0 && !hasNextPage) return <p className="rv-muted">{T.SRC_PRIVATE_EMPTY}</p>;
 const matching = needle === "" ? options : options.filter(option => option.name.toLowerCase().includes(needle) || option.scope.toLowerCase().includes(needle));
 const cut = query.data.pages.at(-1)?.truncated === true || isFetchNextPageError, more = hasNextPage && !cut;
 return <fieldset className="rv-lessons-picker"><legend>{T.SRC_PRIVATE_LEGEND}</legend>
  <p className="rv-muted">{T.SRC_PRIVATE_ONLY_YOU}</p>
  {matching.length === 0 ? <p className="rv-muted">{cut || hasNextPage ? T.SRC_PARTIAL_SLACK : T.SRC_NO_MATCH_SLACK}</p> : <OptionRows options={matching} group={group} value={value} onChange={onChange} unavailable={unavailable} hint={false} />}
  {matching.length > SHOWN_MAX && <p className="rv-muted">{T.SRC_LIST_MORE}</p>}
  {cut && <p className="rv-muted">{T.SRC_CUT_SLACK}</p>}
  {more && <div className="rv-lessons-actions"><Button variant="secondary" busy={isFetchingNextPage} onClick={() => { void fetchNextPage(); }}>{T.SRC_SHOW_MORE}</Button></div>}
 </fieldset>;
}

/**
 * Where the person picks the place of a Slack, Linear or Jira source: a searchable list read from the server (the company's channels, teams or projects), with the typed id kept as "Enter an ID instead" and as the
 * fall back when the list cannot be read or is empty. An option that is already a source, held by another project, a Slack Connect channel, or still being cleared is shown disabled with its reason. The server
 * checks the place again on save; this only helps choosing. Names are shown as plain text, with hidden control characters spelled out. Only the first page is read; the next one when the person asks ("Show more"). A list
 * that is cut (the server's bound, or a page that failed) says so and never claims to be complete.
 */
export function PlacePicker({ project, kind, value, onChange, unavailable }: { project: string; kind: Exclude<SourcePickerKind, "slack-private">; value: string; onChange: (scope: string) => void; unavailable: (scope: string) => boolean }) {
 const words = WORDS[kind], group = useId(), query = useSourceOptions(project, kind, true), [typing, setTyping] = useState(false), [search, setSearch] = useState("");
 const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
 const options = useMemo(() => {
  const seen = new Set<string>(), all: Option[] = [];
  for (const page of query.data?.pages ?? []) for (const option of page.options) if (!seen.has(option.scope)) { seen.add(option.scope);all.push(option); }
  return all;
 }, [query.data]);
 const needle = search.trim().toLowerCase(), matching = needle === "" ? options : options.filter(option => option.name.toLowerCase().includes(needle) || option.scope.toLowerCase().includes(needle));
 const loading = query.data === undefined && !query.isError, done = query.data !== undefined && !hasNextPage && !isFetchingNextPage;
 const failed = query.data === undefined && query.isError, empty = done && options.length === 0;
 // Cut: the server stopped at its bound, or a later page could not be read. More to read: the person may ask. Either way the list is not complete, and a search must not say it is.
 const cut = query.data?.pages.at(-1)?.truncated === true || isFetchNextPageError, more = hasNextPage && !cut, partial = cut || hasNextPage;
 const canList = !failed && !empty;
 const typedField = typing || failed || empty;
 const toggle = (next: boolean) => { setTyping(next);setSearch("");onChange(""); };
 const failure = failed ? (kind === "slack" && query.error instanceof ApiError && query.error.code === "SLACK_SCOPE_MISSING" ? T.SRC_LIST_SCOPE : T.SRC_LIST_FAIL) : empty ? T.SRC_LIST_EMPTY : undefined;
 return <div className="rv-lessons-edit">
  {failure !== undefined && <p className="rv-muted">{failure}</p>}
  {typedField
   ? <TextField label={words.typed} hint={words.hint} value={value} maxLength={300} autoComplete="off" onChange={event => { onChange(kind === "slack" ? filledPlace(event.target.value) : event.target.value); }} />
   : <fieldset className="rv-lessons-picker"><legend>{words.pick}</legend>
     {loading ? <p role="status" className="rv-muted">{T.SRC_LIST_LOADING}</p> : <>
      <TextField label={words.find} value={search} autoComplete="off" onChange={event => { setSearch(event.target.value); }} />
      {matching.length === 0 ? <p className="rv-muted">{partial ? words.partial : words.none}</p>
       : <OptionRows options={matching} group={group} value={value} onChange={onChange} unavailable={unavailable} hint />}
      {matching.length > SHOWN_MAX && <p className="rv-muted">{T.SRC_LIST_MORE}</p>}
      {cut && <p className="rv-muted">{words.cut}</p>}
      {more && <div className="rv-lessons-actions"><Button variant="secondary" busy={isFetchingNextPage} onClick={() => { void fetchNextPage(); }}>{T.SRC_SHOW_MORE}</Button></div>}
     </>}
    </fieldset>}
  {kind === "slack" && !typing && <PrivateChannels project={project} group={group} value={value} onChange={onChange} unavailable={unavailable} needle={needle} />}
  {canList && <div className="rv-lessons-actions"><Button variant="secondary" onClick={() => { toggle(!typing); }}>{typing ? T.SRC_PICK_INSTEAD : kind === "slack" ? T.SRC_TYPE_INSTEAD_SLACK : T.SRC_TYPE_INSTEAD}</Button></div>}
 </div>;
}
