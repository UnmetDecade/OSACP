#!/usr/bin/env node
/**
 * Test fixture: reports the arguments it was started with.
 *
 * Used to verify that cli-agent applies the approval matrix and strips the permission flags a
 * Profile configured, which would otherwise widen the autonomy level the scheduler asked for.
 */
import fs from "node:fs";

fs.writeFileSync("result.json", JSON.stringify({ summary: JSON.stringify(process.argv.slice(2)) }));
process.stdout.write("ARGV_OK\n");
