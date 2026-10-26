import { createContext, createElement, memo, useContext, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeAppPath, safeExternalUrl } from "../text/links.js";
import { visibleText } from "./VisibleText.js";
export interface MarkdownComment { start: number; end: number; control: ReactNode }
const EMPTY: readonly MarkdownComment[] = [], Comments = createContext(EMPTY);
type BlockTag = "p" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre" | "ul" | "ol" | "blockquote" | "table";
type BlockProps = ExtraProps & { children?: ReactNode; start?: number | undefined; className?: string | undefined };
function MarkdownBlock({ tag, node, children, start: listStart, className }: { tag: BlockTag; node: ExtraProps["node"]; children?: ReactNode; start?: number | undefined; className?: string | undefined }) {
 const comments = useContext(Comments), start = node?.position?.start.offset, end = node?.position?.end.offset;
 const comment = comments.find(value => value.start === start && value.end === end), content = createElement(tag, { ...(tag === "ol" && listStart !== undefined ? { start: listStart } : {}), ...(className === undefined ? {} : { className }) }, children);
 return comment === undefined ? content : <div className="rv-annotated-block">{content}<div className="rv-annotation">{comment.control}</div></div>;
}
const block = (tag: BlockTag, props: BlockProps) => <MarkdownBlock tag={tag} node={props.node} start={props.start} className={props.className}>{props.children}</MarkdownBlock>;
// Stable renderer identities preserve evidence DOM and focus when presence or comments update.
const components: Components = {
 h1: props => block("h2", props), h2: props => block("h3", props), h3: props => block("h4", props), h4: props => block("h5", props), h5: props => block("h6", props), h6: props => block("h6", props),
 p: props => block("p", props), pre: props => block("pre", props), ul: props => block("ul", props), ol: props => block("ol", props), blockquote: props => block("blockquote", props), table: props => block("table", props),
 img: () => null,
 a: ({ href, children }) => href ? <a href={href} {...(safeAppPath(href) ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{children}</a> : <>{children}</>,
};
function showControls() {
 const visit = (value: unknown): void => {
  if (typeof value !== "object" || value === null) return;
  const node = value as Record<string, unknown>;
  if ((node.type === "text" || node.type === "code" || node.type === "inlineCode") && typeof node.value === "string") node.value = visibleText(node.value);
  if (Array.isArray(node.children)) for (const child of node.children) visit(child);
 };
 return visit;
}
export const SafeMarkdown = memo(function SafeMarkdown({ markdown, comments = EMPTY }: { markdown: string; comments?: readonly MarkdownComment[] | undefined }) {
 return <Comments.Provider value={comments}><div className="rv-markdown"><Markdown remarkPlugins={[remarkGfm, showControls]} skipHtml urlTransform={url => safeAppPath(url) ? url : safeExternalUrl(url) ?? ""} components={components}>{markdown}</Markdown></div></Comments.Provider>;
});
