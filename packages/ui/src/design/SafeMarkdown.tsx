import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeAppPath, safeExternalUrl } from "../text/links.js";
export function SafeMarkdown({ markdown }: { markdown: string }) { return <div className="rv-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => safeAppPath(url) ? url : safeExternalUrl(url) ?? ""} components={{ img: () => null, a: ({ href, children }) => href ? <a href={href} {...(safeAppPath(href) ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{children}</a> : <>{children}</> }}>{markdown}</Markdown></div>; }
