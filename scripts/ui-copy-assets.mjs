import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
for (const path of ["design/design.css", "look-v2.css", "shell/shell.css", "screens/home/home.css", "screens/live/live.css", "screens/project/project.css", "screens/session/session.css", "screens/builder/builder.css", "screens/agents/agents.css", "screens/agents/publish.css", "screens/onboarding/onboarding.css", "screens/onboarding/setup-v2/project-setup.css", "screens/admin/admin.css",
 // Lane B: allowed-websites editor, shared by admin and own-project surfaces.
 "screens/admin/projects/allowed-websites.css",
 "screens/admin/projects/project-slack.css",
 // Lane C: owned waiting-queue filter styles.
 "screens/admin/waiting/waiting.css",
 // Insights (switch rovara.insights = v2; its own lazy chunk).
 "screens/insights/insights.css",
 // Spending page (switch rovara.spending = v2).
 "screens/admin/spending.css",
 // Health and readiness (switch rovara.health = v2).
 "screens/admin/health/health.css",
 // Trial page, trial banner and Settings > Billing (switch rovara.billing = v2).
 "screens/billing/trial-billing.css",
 // Working agreement panel (switch rovara.agreement = v2).
 "screens/agreement/agreement.css",
 // Lane C2: owned audit filter styles.
 "screens/admin/audit/audit.css",
 // Lane C12: owned Connections guidance styles.
 "screens/admin/connections/connections.css",
 // Lane C14: owned Models source guidance styles.
 "screens/admin/models/model-source-guidance.css",
 // Playbook v1.1: the company How we work page.
 "screens/admin/how-we-work/how-we-work.css",
 // Company rules (G-04): the Company rules page.
 "screens/admin/company-rules/company-rules.css",
 // v1.2 learning loop: the Suggested rules section of the project How we work tab.
 "screens/project/learning.css",
 // Learning v2 L3b: the Lessons and Sources tabs (their own lazy chunk).
 "screens/project/lessons/lessons.css",
 // OWNER DECISION 18: the task page's plan panel and PR feedback view (their own lazy chunks).
 "screens/session/plan-panel.css",
 // Recent sign-in window page (lane exp/approval-window; its own lazy chunk).
 "screens/admin/approval-window/approval-window.css",
 // Automations (chains and triggers; the `chains` feature; their own lazy chunks).
 "screens/automations/automations.css"]) {
 const source = new URL(`../packages/ui/src/${path}`, import.meta.url);
 const destination = new URL(`../packages/ui/dist/${path}`, import.meta.url);
 await mkdir(fileURLToPath(new URL(".", destination)), { recursive: true });
 await copyFile(source, destination);
}
