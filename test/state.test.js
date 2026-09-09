/* The state file is small enough to test directly, and it is the piece most
   likely to be wrong in a way nobody notices. */

import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clear, read, write } from "../state.ts";

// Never the real one: a test must not clobber a running server's state.
const FILE = join(mkdtempSync(join(tmpdir(), "review-html-")), "d", "s.json");

afterEach(() => clear(FILE));

test("what was written comes back", () => {
  const state = { pid: 42, port: 8422, token: "t" };
  write(state, FILE);
  assert.deepEqual(read(FILE), state);
});

/* The token is the only secret this tool has, so the modes are the point of
   the file, not a detail of it. */
test("the file and its directory are readable only by their owner", () => {
  write({ pid: 42, port: 8422, token: "t" }, FILE);
  assert.equal(statSync(FILE).mode & 0o777, 0o600);
  assert.equal(statSync(join(FILE, "..")).mode & 0o777, 0o700);
});

test("a mode is imposed on a file that already existed", () => {
  write({ pid: 1, port: 8422, token: "t" }, FILE);
  writeFileSync(FILE, "{}", { mode: 0o644 });
  write({ pid: 2, port: 8422, token: "t" }, FILE);
  assert.equal(statSync(FILE).mode & 0o777, 0o600);
});

test("absent, unparseable and incomplete all read as nothing", () => {
  assert.equal(read(FILE), null);
  writeFileSync(FILE, "not json");
  assert.equal(read(FILE), null);
  for (const partial of [{ pid: 1 }, { pid: 1, port: 8422 }, { token: "t" }]) {
    writeFileSync(FILE, JSON.stringify(partial));
    assert.equal(read(FILE), null, JSON.stringify(partial));
  }
});

test("clearing twice is not an error", () => {
  write({ pid: 1, port: 8422, token: "t" }, FILE);
  clear(FILE);
  clear(FILE);
  assert.equal(read(FILE), null);
});
