import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const source = new URL("../packages/ui/src/design/design.css", import.meta.url);
const directory = new URL("../packages/ui/dist/design/", import.meta.url);
await mkdir(fileURLToPath(directory), { recursive: true });
await copyFile(source, new URL("design.css", directory));
