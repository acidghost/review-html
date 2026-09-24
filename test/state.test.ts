import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clear, read, readPlans, write, writePlans } from "../src/state.ts";

// Never the real one: a test must not clobber a running server's state.
const FILE = join(mkdtempSync(join(tmpdir(), "review-html-")), "d", "s.json");

afterEach(() => rmSync(FILE, { force: true }));

test("what was written comes back", () => {
  const state = { pid: 42, port: 8422, token: "t" };
  write(state, FILE);
  assert.deepEqual(read(FILE), state);
});

// The token must not be readable by other users.
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

test("plans survive clearing server identity and a new server write", () => {
  write({ pid: 1, port: 8422, token: "old" }, FILE);
  writePlans(["/tmp/a.html", "/tmp/b.htm"], FILE);
  clear(FILE);
  assert.equal(read(FILE), null);
  assert.deepEqual(readPlans(FILE), ["/tmp/a.html", "/tmp/b.htm"]);
  write({ pid: 2, port: 8422, token: "new" }, FILE);
  assert.deepEqual(readPlans(FILE), ["/tmp/a.html", "/tmp/b.htm"]);
  assert.equal(statSync(FILE).mode & 0o777, 0o600);
});

test("corrupt plan state does not get silently overwritten", () => {
  writeFileSync(FILE, "not json");
  assert.throws(() => readPlans(FILE));
  assert.throws(() => writePlans(["/tmp/a.html"], FILE));
});

test("clearing twice is not an error", () => {
  write({ pid: 1, port: 8422, token: "t" }, FILE);
  clear(FILE);
  clear(FILE);
  assert.equal(read(FILE), null);
});
