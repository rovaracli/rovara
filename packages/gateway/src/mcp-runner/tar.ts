// Stdio MCP host redesign (T2): the little of the tar format the runner needs, written here so that the runner image needs no `tar` program and so that the bytes are exactly
// what we say they are. Only ustar headers and the two pax records `path` and `linkpath` (for long names) are used. Nothing else is ever produced, and a reader that sees anything
// else refuses (bundle.ts).
export const TAR_BLOCK = 512;

/** A tar archive that cannot be written or read. The message is a fixed code, never text from the archive. */
export class TarError extends Error {
  constructor(readonly code: "bad_header" | "bad_checksum" | "unsupported" | "bad_pax" | "too_large") {
    super(code);
    this.name = "TarError";
  }
}

export interface TarHeaderFields {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  /** One character: `0` file, `5` directory, `2` symbolic link, `x` pax header. */
  type: string;
  linkname: string;
  uname: string;
  gname: string;
  prefix: string;
  magic: string;
  version: string;
}

const text = (value: string): Buffer => Buffer.from(value, "utf8");

function putString(block: Buffer, offset: number, length: number, value: string): void {
  const bytes = text(value);
  if (bytes.length > length) throw new TarError("bad_header");
  bytes.copy(block, offset);
}

function putOctal(block: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TarError("bad_header");
  const digits = value.toString(8);
  if (digits.length > length - 1) throw new TarError("too_large");
  block.write(digits.padStart(length - 1, "0"), offset, "latin1");
}

/** One 512-byte ustar header. `name` and `linkname` must fit in 100 bytes (longer names go in a pax header). */
export function encodeHeader(fields: { name: string; mode: number; size: number; type: string; linkname?: string }): Buffer {
  const block = Buffer.alloc(TAR_BLOCK, 0);
  putString(block, 0, 100, fields.name);
  putOctal(block, 100, 8, fields.mode);
  putOctal(block, 108, 8, 0);
  putOctal(block, 116, 8, 0);
  putOctal(block, 124, 12, fields.size);
  putOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  if (fields.type.length !== 1) throw new TarError("bad_header");
  block.write(fields.type, 156, "latin1");
  putString(block, 157, 100, fields.linkname ?? "");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  putOctal(block, 329, 8, 0);
  putOctal(block, 337, 8, 0);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(sum.toString(8).padStart(6, "0"), 148, "latin1");
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

/** The body of a pax header: `<length> <key>=<value>\n` records. The header's size is this body's length; the writer pads it to a whole block. */
export function encodePaxBody(records: ReadonlyArray<readonly [string, string]>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of records) {
    const rest = text(` ${key}=${value}\n`);
    let length = rest.length + 1;
    while (String(length).length + rest.length !== length) length = String(length).length + rest.length;
    parts.push(text(String(length)), rest);
  }
  return Buffer.concat(parts);
}

/** Zero padding that brings `size` bytes of content up to a whole block. */
export function paddingFor(size: number): number {
  return (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
}

function readString(block: Buffer, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end += 1;
  // After the first NUL only NULs may follow: anything else would hide data from a reader that stops at the NUL.
  for (let index = end; index < limit; index += 1) if (block[index] !== 0) throw new TarError("bad_header");
  return block.toString("utf8", offset, end);
}

function readOctal(block: Buffer, offset: number, length: number): number {
  // A leading 0x80 byte would mean a base-256 number (a size over 8 GiB, or a negative number): not accepted.
  if ((block[offset]! & 0x80) !== 0) throw new TarError("unsupported");
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0 && block[end] !== 0x20) end += 1;
  for (let index = end; index < limit; index += 1) if (block[index] !== 0 && block[index] !== 0x20) throw new TarError("bad_header");
  const digits = block.toString("latin1", offset, end);
  if (!/^[0-7]{1,11}$/u.test(digits)) throw new TarError("bad_header");
  return Number.parseInt(digits, 8);
}

export function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/** Decodes one header block and checks its checksum. The block must not be a zero block (the caller tells the end of the archive). */
export function decodeHeader(block: Buffer): TarHeaderFields {
  if (block.length !== TAR_BLOCK) throw new TarError("bad_header");
  const stored = readOctal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  if (sum !== stored) throw new TarError("bad_checksum");
  return {
    name: readString(block, 0, 100),
    mode: readOctal(block, 100, 8),
    uid: readOctal(block, 108, 8),
    gid: readOctal(block, 116, 8),
    size: readOctal(block, 124, 12),
    mtime: readOctal(block, 136, 12),
    type: block.toString("latin1", 156, 157),
    linkname: readString(block, 157, 100),
    magic: block.toString("latin1", 257, 263),
    version: block.toString("latin1", 263, 265),
    uname: readString(block, 265, 32),
    gname: readString(block, 297, 32),
    prefix: readString(block, 345, 155),
  };
}

/** Parses a pax body. Only well-formed records are accepted; a repeated key is refused. */
export function decodePaxBody(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new TarError("bad_pax");
    const lengthText = body.toString("latin1", offset, space);
    if (!/^[1-9][0-9]{0,6}$/u.test(lengthText)) throw new TarError("bad_pax");
    const length = Number(lengthText);
    const end = offset + length;
    if (end > body.length || body[end - 1] !== 0x0a || space + 1 >= end - 1) throw new TarError("bad_pax");
    const record = body.toString("utf8", space + 1, end - 1);
    const equals = record.indexOf("=");
    if (equals < 1) throw new TarError("bad_pax");
    const key = record.slice(0, equals);
    if (records.has(key)) throw new TarError("bad_pax");
    records.set(key, record.slice(equals + 1));
    offset = end;
  }
  return records;
}
