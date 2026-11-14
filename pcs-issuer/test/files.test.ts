import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRelPath, parseListing } from "../src/files.js";
import { PcsError } from "../src/errors.js";

test("workspace paths are normalized to a relative form", () => {
  assert.equal(normalizeRelPath(""), "");
  assert.equal(normalizeRelPath("./"), "");
  assert.equal(normalizeRelPath("a/b"), "a/b");
  assert.equal(normalizeRelPath("./a//b/"), "a/b");
  assert.equal(normalizeRelPath("a/./b"), "a/b");
});

test("workspace paths cannot escape the root", () => {
  for (const raw of ["/etc/passwd", "../x", "a/../../x", ".."]) {
    assert.throws(
      () => normalizeRelPath(raw),
      (e: unknown) => e instanceof PcsError && e.status === 400,
      `expected ${JSON.stringify(raw)} to be rejected`,
    );
  }
});

function record(type: string, mtime: string, size: string, name: string): string {
  return [type, mtime, size, name].join("\0") + "\0";
}

test("listing records carry type, size, mtime and name", () => {
  const out = parseListing(
    Buffer.from(
      record("f", "1700000001", "12", "a b.txt") + record("d", "1700000000", "", "src"),
    ),
  );
  assert.equal(out.truncated, false);
  assert.deepEqual(
    out.entries.map((e) => [e.type, e.name, e.size, e.modified_at]),
    [
      ["dir", "src", null, new Date(1_700_000_000_000).toISOString()],
      ["file", "a b.txt", 12, new Date(1_700_000_001_000).toISOString()],
    ],
  );
});

test("the T marker flags a truncated listing", () => {
  const out = parseListing(Buffer.from(record("f", "1700000001", "1", "x") + "T\0"));
  assert.equal(out.truncated, true);
  assert.equal(out.entries.length, 1);
});

test("workspace paths reject NUL bytes and oversized input", () => {
  assert.throws(() => normalizeRelPath("a\0b"), (e: unknown) => e instanceof PcsError && e.status === 400);
  assert.throws(
    () => normalizeRelPath("a".repeat(4_097)),
    (e: unknown) => e instanceof PcsError && e.status === 400,
  );
});
