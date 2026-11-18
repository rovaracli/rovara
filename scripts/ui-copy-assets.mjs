import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
for (const path of ["design/design.css", "shell/shell.css", "screens/home/home.css", "screens/inbox/inbox.css", "screens/live/live.css", "screens/work/work.css", "screens/project/project.css", "screens/session/session.css", "screens/builder/builder.css", "screens/agents/agents.css", "screens/onboarding/onboarding.css", "screens/admin/admin.css",
 // Lane B: allowed-websites editor, shared by admin and own-project surfaces.
 "screens/admin/projects/allowed-websites.css",
 "screens/admin/projects/project-slack.css",
 // Lane C: owned waiting-queue filter styles.
 "screens/admin/waiting/waiting.css",
 // Lane C2: owned audit filter styles.
 "screens/admin/audit/audit.css",
 // Lane C12: owned Connections guidance styles.
 "screens/admin/connections/connections.css",
 // Lane C14: owned Models source guidance styles.
 "screens/admin/models/model-source-guidance.css",
 // Playbook v1.1: the company How we work page.
 "screens/admin/how-we-work/how-we-work.css",
 // v1.2 learning loop: the Suggested rules section of the project How we work tab.
 "screens/project/learning.css",
 // Learning v2 L3b: the Lessons and Sources tabs (their own lazy chunk).
 "screens/project/lessons/lessons.css",
 // DEC 231: the inbox lesson batch, Learned in How we work, Lessons used on the task page.
 "screens/work/lessons.css",
 // Lead 4 L4-LP3W: Learned by code area, Where Rovara learns from, Team lessons for this area.
 "screens/project/lessons/areas.css",
 // Guided onboarding PR 11: Add to Slack, the Slack channel and Linear team rows.
 "screens/connect/connect.css",
 // Guided onboarding PR 9: the project setup checklist.
 "screens/setup/checklist.css",
 // Lead 4 W5: the project Wiki tab.
 "screens/project/wiki/wiki.css",
 // L4-D2: the setup approval card.
 "screens/setup/approval-card.css",
 // W6: the wiki row on the setup checklist.
 "screens/setup/wiki/wiki-setup.css",
 // Feature A3: the Cost and time pages.
 "screens/admin/report/report.css",
 // Lead 4 J3: the Ask box and its answer.
 "screens/answers/answers.css"]) {
 const source = new URL(`../packages/ui/src/${path}`, import.meta.url);
 const destination = new URL(`../packages/ui/dist/${path}`, import.meta.url);
 await mkdir(fileURLToPath(new URL(".", destination)), { recursive: true });
 await copyFile(source, destination);
}
