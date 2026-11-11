import type { SessionDiffReaderSchema } from "@agentx/cloud-contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { isGithubUrl } from "../../text/links.js";

/** Diff content is evidence, rendered as text even when a line resembles markup. */
export function DiffView({ diff }: { diff: ReturnType<typeof SessionDiffReaderSchema.parse> }) {
 return <section aria-label="Pull request diff">{diff.files.map(file => <details key={file.path} open>
  <summary><VisibleText text={file.path} /> <span>{file.additions} lines added, {file.deletions} removed</span></summary>
  {file.previousPath && <p>Previously <VisibleText text={file.previousPath} /></p>}
  {file.patch === undefined ? <p>{file.patchOmitted === "too_large" ? "This patch is too large to display." : "No text patch is available."} {isGithubUrl(diff.pullRequest.url) && <a href={diff.pullRequest.url} target="_blank" rel="noopener noreferrer">Open on GitHub</a>}</p> : <pre tabIndex={0} aria-label={"Diff for " + file.path}>{file.patch.split("\n").map((line, index) => {
   const sign = line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ";
   return <span key={index} className="rv-diff-line"><span className="rv-sr-only">{sign === "+" ? "Added line" : sign === "-" ? "Removed line" : "Context line"}</span><span aria-hidden="true">{sign}</span><VisibleText text={line.slice(sign === " " && !line.startsWith(" ") ? 0 : 1)} />{"\n"}</span>;
  })}</pre>}
 </details>)}</section>;
}
