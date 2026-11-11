// The company switcher's three entry points, as lazy components. With the switch off (company-flags.ts) AppShell never renders them, so the first download holds only these few lines.
import { lazy } from "react";
export const CompanyHeader = lazy(async () => ({ default: (await import("./company/CompanySwitcher.js")).CompanyHeader }));
export const CompanyPhoneList = lazy(async () => ({ default: (await import("./company/CompanySwitcher.js")).CompanyPhoneList }));
export const CompanyGate = lazy(async () => ({ default: (await import("./company/CompanySwitcher.js")).CompanyGate }));
