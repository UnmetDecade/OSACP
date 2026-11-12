/**
 * Minimal ZIP packer (browser side).
 *
 * Users can select a code folder directly; the directory is packed into one zip and uploaded, and the task carries a single
 * attachment URL. Text files are compressed with deflate-raw when possible; if the browser does not support it or compression is
 * not worthwhile, they are written as-is with store.
 */

export interface ZipEntryInput {
  /** Path relative to the selected folder root, e.g. src/main.ts. */
  path: string;
  file: File;
}

const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|jsx?|tsx?|mjs|cjs|css|scss|sass|less|html?|xml|svg|ya?ml|toml|ini|cfg|conf|env|properties|py|go|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|cs|rb|php|sh|bash|zsh|fish|ps1|sql|graphql|proto|dockerfile|gitignore|editorconfig|lock|patch|diff)$/i;

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

function crc32(data: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([new Uint8Array(data)])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Pack the file list into a zip; returns a File usable directly as an attachment upload. */
export async function zipFiles(
  rootName: string,
  entries: ZipEntryInput[],
  onProgress?: (done: number, total: number) => void,
): Promise<File> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const now = new Date();
  const stamp = dosDateTime(now);
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const data = new Uint8Array(await entry.file.arrayBuffer());
    const shouldCompress = TEXT_EXT.test(entry.path) || data.length > 4096;
    const compressed = shouldCompress ? await deflateRaw(data) : null;
    const useDeflate = Boolean(compressed && compressed.length < data.length);
    const payload = useDeflate ? compressed! : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const nameBytes = encoder.encode(`${rootName}/${entry.path}`.replace(/\/+/g, "/"));

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 filename
    lv.setUint16(8, method, true);
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    chunks.push(local);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length;
    onProgress?.(i + 1, entries.length);
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const blob = new Blob([...chunks, ...central, eocd], { type: "application/zip" });
  return new File([blob], `${rootName.replace(/[\\/:*?"<>|]+/g, "_") || "folder"}.zip`, {
    type: "application/zip",
  });
}
