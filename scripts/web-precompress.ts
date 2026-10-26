import { readdir, readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import path from "node:path";
const directory = "packages/web/dist/app/assets";
for (const name of (await readdir(directory)).sort()) {
 if (/\.(br|gz)$/.test(name)) continue;
 const file = path.join(directory, name), bytes = await readFile(file);
 await writeFile(`${file}.br`, brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
 await writeFile(`${file}.gz`, gzipSync(bytes, { level: 9 }));
}
