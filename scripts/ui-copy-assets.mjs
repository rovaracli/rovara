import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
for (const path of ["design/design.css", "shell/shell.css", "screens/home/home.css", "screens/live/live.css", "screens/project/project.css", "screens/session/session.css", "screens/builder/builder.css", "screens/agents/agents.css", "screens/onboarding/onboarding.css", "screens/admin/admin.css",
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
 "screens/project/learning.css"]) {
 const source = new URL(`../packages/ui/src/${path}`, import.meta.url);
 const destination = new URL(`../packages/ui/dist/${path}`, import.meta.url);
 await mkdir(fileURLToPath(new URL(".", destination)), { recursive: true });
 await copyFile(source, destination);
}
