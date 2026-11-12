/**
 * 最小 ustar 打包器。
 *
 * 只用来把部署带来的配置文件写进容器（Docker 的 PUT /containers/{id}/archive
 * 要求 tar）。不引入依赖：只支持普通文件和必要的父目录，单文件上限 1MiB。
 */

const BLOCK = 512;
const MAX_SIZE = 1024 * 1024;

function octal(value: number, length: number): string {
  const text = Math.max(0, Math.floor(value)).toString(8);
  if (text.length > length - 1) throw new Error(`tar 字段溢出：${value}`);
  return `${text.padStart(length - 1, "0")}\0`;
}

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar 字段过长：${value.slice(0, 40)}`);
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
  // 校验和字段先填空格，再按整体字节求和。
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
  /** 容器内绝对路径，例如 /opt/platform/profiles.json */
  path: string;
  content: string;
}

/** 生成 tar；调用方把 path=/ 传给 Docker，路径去掉开头的 / 即落到容器根。 */
export function buildTar(files: TarFile[]): Buffer {
  const blocks: Buffer[] = [];
  const dirs = new Set<string>();

  for (const file of files) {
    const name = file.path.replace(/^\/+/, "");
    if (!name || name.includes("..")) throw new Error(`tar 路径非法：${file.path}`);
    const data = Buffer.from(file.content, "utf8");
    if (data.length > MAX_SIZE) throw new Error(`tar 文件超过 1MiB：${file.path}`);

    // 父目录先入包，Docker 解包时才不会因为目录缺失失败。
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
