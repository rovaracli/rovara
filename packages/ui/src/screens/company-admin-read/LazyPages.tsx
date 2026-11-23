// The one lazy entry of the rebuilt company administration pages (G1): each real route renders its screen inside ReadEntry (the admin area's identity and access).
import { ReadEntry } from "./ReadEntry.js";
import { CompanyOverviewReadScreen } from "./CompanyOverviewReadScreen.js";
import { CompanySettingsReadScreen } from "./CompanySettingsReadScreen.js";
import { CompanyAuditReadScreen } from "./CompanyAuditReadScreen.js";
import "./company-admin-read.css";
export const OverviewPage = () => <ReadEntry><CompanyOverviewReadScreen /></ReadEntry>;
export const SettingsPage = () => <ReadEntry><CompanySettingsReadScreen /></ReadEntry>;
export const AuditPage = () => <ReadEntry><CompanyAuditReadScreen /></ReadEntry>;
