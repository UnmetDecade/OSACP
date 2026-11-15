import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, randomToken, sha256, verifyPassword } from "../src/passwords.js";

test("hashPassword verifies only the original password", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("correct horse battery stapl", hash), false);
  assert.equal(verifyPassword("", hash), false);
});

test("each hash uses a fresh salt", () => {
  const a = hashPassword("same-password-123");
  const b = hashPassword("same-password-123");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("same-password-123", a), true);
  assert.equal(verifyPassword("same-password-123", b), true);
});

test("malformed or hostile hashes are rejected without throwing", () => {
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", "plaintext"), false);
  assert.equal(verifyPassword("x", "scrypt$1$8$1$AA==$AA=="), false);
  assert.equal(verifyPassword("x", "scrypt$999999999$8$1$AA==$AA=="), false);
  assert.equal(verifyPassword("x", "bcrypt$32768$8$1$AA==$AA=="), false);
});

test("tokens are prefixed, random, and hash deterministically", () => {
  const a = randomToken("sess");
  const b = randomToken("sess");
  assert.match(a, /^sess_[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
  assert.equal(sha256(a), sha256(a));
  assert.notEqual(sha256(a), sha256(b));
});
