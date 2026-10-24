import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
for (const path of ["design/design.css", "shell/shell.css"]) {
 const source = new URL(`../packages/ui/src/${path}`, import.meta.url);
 const destination = new URL(`../packages/ui/dist/${path}`, import.meta.url);
 await mkdir(fileURLToPath(new URL(".", destination)), { recursive: true });
 await copyFile(source, destination);
}
