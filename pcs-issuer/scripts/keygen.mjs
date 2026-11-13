#!/usr/bin/env node
/**
 * Generate the two key pairs for the PCS:
 *   - ES256 (P-256): issues instance / approval / host / admin JWTs
 *   - Ed25519: issues deployment intents (commands); Host Runtime verifies with the public key
 *
 * Existing keys are kept by default (so online tokens keep working); only `--force` overwrites them.
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "..", "keys");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const force = process.argv.includes("--force");

function writePair(name, { publicKey, privateKey }) {
  const privatePath = path.join(dir, `${name}-private.pem`);
  const publicPath = path.join(dir, `${name}-public.pem`);
  const exists = fs.existsSync(privatePath) || fs.existsSync(publicPath);
  if (exists && !force) {
    console.log(`Keeping existing key: ${privatePath}`);
    return;
  }
  fs.writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  console.log(`Generated:\n  ${privatePath}\n  ${publicPath}`);
}

// Backward-compatible with legacy filenames: private.pem / public.pem are the JWT keys.
const jwtPrivate = path.join(dir, "private.pem");
const jwtPublic = path.join(dir, "public.pem");
if ((fs.existsSync(jwtPrivate) || fs.existsSync(jwtPublic)) && !force) {
  console.log(`Keeping existing key: ${jwtPrivate}`);
} else {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.writeFileSync(jwtPrivate, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(jwtPublic, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  console.log(`Generated:\n  ${jwtPrivate}\n  ${jwtPublic}`);
}

writePair("command", generateKeyPairSync("ed25519"));

console.log(
  "\nPrivate keys stay in PCS: the scheduler only needs public.pem to verify JWTs, and Host Runtime only needs command-public.pem to verify deployment intents.",
);
