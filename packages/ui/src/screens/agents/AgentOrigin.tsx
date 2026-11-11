import { Link } from "react-router";
import { AgentOriginViewSchema } from "@agentx/cloud-contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { paths } from "../../paths.js";
export function AgentOrigin({origin}:{origin:unknown}){const parsed=AgentOriginViewSchema.safeParse(origin);if(!parsed.success)return null;const value=parsed.data;if(!value.visible)return <p>Made from a session</p>;return <p>Made from a session: <Link to={paths.session(value.sessionId)} target="_blank" rel="noopener noreferrer"><VisibleText text={value.title}/></Link>. Opens in another tab to keep your edits here.</p>;}
