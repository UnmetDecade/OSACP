import { describe, expect, it, vi } from "vitest";
import { zipFiles } from "./zip";

function file(name: string, content: string | Uint8Array<ArrayBuffer>): File {
  return new File([content], name);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function entryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.length && readU32(bytes, offset) === 0x04034b50) {
    const nameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const compressedSize = readU32(bytes, offset + 18);
    names.push(decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
}

function entryPayload(bytes: Uint8Array, index: number): Uint8Array {
  let offset = 0;
  for (let i = 0; i < index; i++) {
    const nameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const compressedSize = readU32(bytes, offset + 18);
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  const nameLength = readU16(bytes, offset + 26);
  const extraLength = readU16(bytes, offset + 28);
  const compressedSize = readU32(bytes, offset + 18);
  return bytes.subarray(offset + 30 + nameLength + extraLength, offset + 30 + nameLength + extraLength + compressedSize);
}

describe("zipFiles", () => {
  it("writes a valid zip with every entry under the root folder", async () => {
    const result = await zipFiles("project", [
      { path: "README.md", file: file("README.md", "# hello") },
      { path: "src/main.ts", file: file("main.ts", "export const answer = 42;") },
    ]);

    expect(result.name).toBe("project.zip");
    expect(result.type).toBe("application/zip");

    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(readU32(bytes, 0)).toBe(0x04034b50);
    expect(readU32(bytes, bytes.length - 22)).toBe(0x06054b50);
    expect(entryNames(bytes)).toEqual(["project/README.md", "project/src/main.ts"]);
  });

  it("stores the original bytes when compression is unavailable or not smaller", async () => {
    const binary: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(5));
    binary.set([1, 2, 3, 4, 5]);
    const result = await zipFiles("bin", [{ path: "data.bin", file: new File([binary], "data.bin") }]);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(Array.from(entryPayload(bytes, 0))).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports progress for every entry", async () => {
    const onProgress = vi.fn();
    await zipFiles(
      "p",
      [
        { path: "a.txt", file: file("a.txt", "a") },
        { path: "b.txt", file: file("b.txt", "b") },
      ],
      onProgress,
    );
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("normalizes duplicate slashes and sanitizes the archive name", async () => {
    const result = await zipFiles("", [{ path: "src//a.txt", file: file("a.txt", "a") }]);
    expect(result.name).toBe("folder.zip");
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(entryNames(bytes)).toEqual(["/src/a.txt"]);
  });

  it("produces an empty archive when there are no files", async () => {
    const result = await zipFiles("empty", []);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(entryNames(bytes)).toEqual([]);
    expect(readU32(bytes, bytes.length - 22)).toBe(0x06054b50);
  });
});
