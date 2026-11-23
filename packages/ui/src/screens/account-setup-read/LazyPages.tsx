// The G5 account pages as mounted on the real /app routes (one lazy chunk, outside the initial bundle). Each page sits in ReadEntry:
// the identity read, its failure block and the shared served-read policy (one Reconnecting line).
import { ReadEntry } from "./ReadEntry.js";
import { AccountReadScreen } from "./AccountReadScreen.js";
import { AutomationKeysReadScreen } from "./AutomationKeysReadScreen.js";
import { GithubAccountReadScreen } from "./GithubAccountReadScreen.js";
import "./account-setup-read.css";

export function AccountPage() { return <ReadEntry title="Account" code="ACCOUNT-READ-FAILED"><AccountReadScreen /></ReadEntry>; }
export function GithubAccountPage() { return <ReadEntry title="Your GitHub account" code="PERSONAL-GITHUB-READ-FAILED"><GithubAccountReadScreen /></ReadEntry>; }
export function AutomationKeysPage() { return <ReadEntry title="Automation keys" code="AUTOMATION-KEYS-READ-FAILED"><AutomationKeysReadScreen /></ReadEntry>; }
