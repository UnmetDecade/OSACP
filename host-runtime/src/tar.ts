/**
 * Minimal ustar packer.
 *
 * Only used to write deployment-provided config files into a container (Docker's PUT /containers/{id}/archive
 * requires tar). No dependencies: only regular files and the necessary parent directories are supported, with a 1MiB per-file limit.
 */

const BLOCK = 512;
const MAX_SIZE = 1024 * 1024;

function octal(value: number, length: number): string {
  const text = Math.max(0, Math.floor(value)).toString(8);
  if (text.length > length - 1) throw new Error(`tar field overflow: ${value}`);
  return `${text.padStart(length - 1, "0")}\0`;
}

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field too long: ${value.slice(0, 40)}`);
  bytes.copy(buf, offset);
}

function header(name: string, mode: number, size: number, type: "0" | "5"): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  writeString(buf, 0, 100, name);
  writeString(buf, 100, 8, octal(mode, 8));
  writeString(buf, 108, 8, octal(0, 8));
  writeString(buf, 116, 8, octal(0, 8));
  writeString(buf, 124, 12, octal(size, 12));
  writeString(buf, 136, 12, octal(Math.floor(Date.now() / 1000), 12));
  // Fill the checksum field with spaces first, then sum over the whole byte range.
  buf.fill(0x20, 148, 156);
  writeString(buf, 156, 1, type);
  writeString(buf, 257, 6, "ustar\0");
  writeString(buf, 263, 2, "00");
  writeString(buf, 265, 32, "root");
  writeString(buf, 297, 32, "root");
  let sum = 0;
  for (const byte of buf) sum += byte;
  writeString(buf, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return buf;
}

export interface TarFile {
  /** Absolute path inside the container, e.g. /opt/platform/profiles.json */
  path: string;
  content: string;
}

/** Build the tar; the caller passes path=/ to Docker, and stripping the leading / lands the path at the container root. */
export function buildTar(files: TarFile[]): Buffer {
  const blocks: Buffer[] = [];
  const dirs = new Set<string>();

  for (const file of files) {
    const name = file.path.replace(/^\/+/, "");
    if (!name || name.includes("..")) throw new Error(`Invalid tar path: ${file.path}`);
    const data = Buffer.from(file.content, "utf8");
    if (data.length > MAX_SIZE) throw new Error(`tar file exceeds 1MiB: ${file.path}`);

    // Add parent directories first so Docker's unpack does not fail on missing directories.
    const parts = name.split("/");
    parts.pop();
    let dir = "";
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      blocks.push(header(`${dir}/`, 0o755, 0, "5"));
    }

    blocks.push(header(name, 0o644, data.length, "0"), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(blocks);
}
