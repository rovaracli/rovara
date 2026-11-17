// Page text as the app draws it: plain text nodes only, never markup (wiki text is made from repository content, so it is untrusted). A source marker opens a small popover
// with the file, the lines, the commit and what the check found ("source found", never "verified"); a stale, unfound or marked-wrong paragraph carries its own thin note, and
// nothing else on the page warns.
import { Fragment } from "react";
import { Popover } from "radix-ui";
import type { WikiBlock } from "../../../api/wiki.js";
import { VisibleText } from "../../../design/VisibleText.js";
import type { Cite, PageModel } from "./wiki-model.js";
import { SOURCE_WORDS, T, linesWords, shortSha } from "./wiki-text.js";

export interface BlockContext { model: PageModel; link(cite: Cite): string | undefined; headingId(blockId: string): string }

/** Backticked words become `code`; everything else is text. Odd or unclosed backticks stay as typed. */
function Inline({ text }: { text: string }) {
  const pieces = text.split("`");
  if (pieces.length % 2 === 0) return <VisibleText text={text} />;
  return <>{pieces.map((piece, index) => (index % 2 === 1 && piece !== "" ? <code key={index}><VisibleText text={piece} /></code> : <Fragment key={index}><VisibleText text={piece} /></Fragment>))}</>;
}

function Marker({ cite, link }: { cite: Cite; link: string | undefined }) {
  const where = `${cite.repo}/${cite.path}`;
  return (
    <Popover.Root>
      <Popover.Trigger className={`rv-wiki-cite${cite.source === "found" ? "" : " rv-wiki-cite-warn"}`} aria-label={`Source ${String(cite.n)}: ${where}, ${linesWords(cite.line, cite.lineEnd)}`}>{cite.n}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="rv-wiki-pop" sideOffset={6} collisionPadding={12} aria-label={`Source ${String(cite.n)}`}>
          <p className="rv-wiki-pop-path"><VisibleText text={where} /></p>
          <p className="rv-muted">{linesWords(cite.line, cite.lineEnd)} at <code>{shortSha(cite.commit)}</code></p>
          <p>{SOURCE_WORDS[cite.source]}</p>
          {cite.claims.length > 0 && <ul className="rv-wiki-pop-claims">{cite.claims.map((claim, index) => <li key={index}><VisibleText text={claim} /></li>)}</ul>}
          {link !== undefined && <a href={link} target="_blank" rel="noopener noreferrer">{T.SOURCE_OPEN}</a>}
          <Popover.Close className="rv-wiki-pop-close" aria-label={T.SOURCE_CLOSE}>Close</Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Block({ block, context }: { block: WikiBlock; context: BlockContext }) {
  if (block.kind === "heading") {
    return block.level === 2
      ? <h3 id={context.headingId(block.blockId)} className="rv-wiki-h2"><VisibleText text={block.text} /></h3>
      : <h4 id={context.headingId(block.blockId)} className="rv-wiki-h3"><VisibleText text={block.text} /></h4>;
  }
  const state = context.model.state(block), markers = context.model.markers(block);
  const struck = state.flagged;
  return (
    <div className={struck ? "rv-wiki-para rv-wiki-struck" : "rv-wiki-para"} data-block={block.blockId}>
      {block.kind === "paragraph"
        ? <p className="rv-wiki-text"><Inline text={block.text} />{markers.map((cite) => <Marker key={cite.n} cite={cite} link={context.link(cite)} />)}</p>
        : (
          <details className="rv-wiki-diagram">
            <summary>{T.DIAGRAM}</summary>
            <pre><VisibleText text={block.mermaid} /></pre>
          </details>
        )}
      {block.kind === "diagram" && markers.length > 0 && <p className="rv-wiki-text">{markers.map((cite) => <Marker key={cite.n} cite={cite} link={context.link(cite)} />)}</p>}
      {state.flagged && <p className="rv-wiki-pnote rv-wiki-pnote-flag"><b>{T.WRONG}</b> {T.WRONG_AFTER}</p>}
      {!state.flagged && state.stale !== undefined && <p className="rv-wiki-pnote rv-wiki-pnote-stale"><b>{T.STALE}</b> {state.stale.file === "" ? "A cited file" : <>The cited file <code><VisibleText text={state.stale.file} /></code></>} changed since this page was written.</p>}
      {!state.flagged && state.notFound && <p className="rv-wiki-pnote rv-wiki-pnote-stale"><b>{T.STALE}</b> {T.NOT_FOUND_NOTE}</p>}
    </div>
  );
}
