import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
for (const path of ["design/fonts/inter-latin-400.woff2", "design/fonts/inter-latin-600.woff2", "design/fonts/jetbrains-mono-latin-400.woff2", "design/fonts/Inter-OFL.txt", "design/fonts/JetBrainsMono-OFL.txt", "design/design.css", "shell/shell.css", "screens/home/home.css", "screens/inbox/inbox.css", "screens/live/live.css", "screens/work/work.css", "screens/project/project.css", "screens/session/session.css", "screens/session/task-capture-view.css", "screens/session/task-page.css", "screens/builder/builder.css", "screens/agents/agents.css", "screens/onboarding/onboarding.css", "screens/admin/admin.css",
 // Rebuilt Work/Inbox styles (WIRING-3: mounted on the real /app/work and /app/inbox routes).
 "screens/work/work-preview.css",
 "screens/session/pr-feedback-card.css",
 "screens/inbox/inbox-preview.css",
 // Design system v2: shared part styles, including mounted gallery consumers.
 "design/parts/chips-buttons.css",
 "design/parts/decision-timeline.css",
 "design/parts/table-toast-dialog.css",
 "design/parts/outcome-delivery-held.css",
 "design/parts/shell-gallery.css",
 // Lane B: allowed-websites editor, shared by admin and own-project surfaces.
 "screens/admin/projects/allowed-websites.css",
 "screens/admin/projects/project-slack.css",
 // Lane C: owned waiting-queue filter styles.
 "screens/admin/waiting/waiting.css",
 // G1: the rebuilt company administration pages (Overview, Settings, Audit) and the project page working-branches panel.
 "screens/company-admin-read/company-admin-read.css",
 // Lane C12: owned Connections guidance styles.
 "screens/admin/connections/connections.css",
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
 // The "AI and spending" page and onboarding step: its cards.
 "screens/setup/ai-spend.css",
 // L4-U5: the "Setup needs repair" card and the paused upkeep notice.
 "screens/setup/setup-repair.css",
 // W6: the wiki row on the setup checklist.
 "screens/setup/wiki/wiki-setup.css",
 // Feature A3: the Cost and time pages.
 "screens/admin/report/report.css",
 // WIRING-1B: the rebuilt company money / AI pages (the report, features, AI and sources, Product AI).
 "screens/company-money-ai-read/company-money-ai-read.css",
 // Lead 4 J3: the Ask box and its answer.
 "screens/answers/answers.css",
 // Understand's questions and their answer form: the session page, the Work list and Home.
 "screens/session/answer-form.css",
 // UI-TASK-MERGE: the per-PR merge section and receipt view.
 "screens/session/merge-section.css",
 // Close dialog: the Close preview (what stays, is freed and is discarded).
 "screens/session/close-preview.css",
 // Task Session: the answer-only receipt on the task page.
 "screens/session/answer-receipt.css",
 // Task Session: the served status chip and narrow Talk layout.
 "screens/session/talk.css",
 // The rebuilt Wiki and Skills pages (G3; their own lazy chunk).
 "screens/wiki-skills-read/wiki-skills-read.css",
 // L4-JA89: the project Skills tab (its own lazy chunk).
 "screens/project/skills/skills.css",
 // G4 (Rules, Lessons and How we work): the rebuilt project views, company Rules, Setup recipes and the lesson batch.
 "screens/rules-lessons-read/rules-lessons-read.css"]) {
 const source = new URL(`../packages/ui/src/${path}`, import.meta.url);
 const destination = new URL(`../packages/ui/dist/${path}`, import.meta.url);
 await mkdir(fileURLToPath(new URL(".", destination)), { recursive: true });
 await copyFile(source, destination);
}
