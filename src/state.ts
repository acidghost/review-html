/* Where a running server records itself, so `review-html stop` can find it.
   The alternative was matching a command line, which stops existing the
   moment this is a compiled binary. */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/* REVIEW_STATE moves it, which is what lets a test drive a whole lifecycle
   without touching the file a real server is using. */
export const FILE =
  process.env.REVIEW_STATE ??
  join(homedir(), ".cache", "review-html", "state.json");

export type State = { pid: number; port: number; token: string };

/* Written by whoever is serving, and never trusted: the file outlives a
   server that was killed. Callers verify its port and authenticated server
   identity before acting on it. Anything malformed reads as absent. */
export const read = (file = FILE): State | null => {
  try {
    const { pid, port, token } = JSON.parse(readFileSync(file, "utf8"));
    if (typeof pid !== "number" || typeof port !== "number") return null;
    return typeof token === "string" && token ? { pid, port, token } : null;
  } catch {
    return null;
  }
};

/* 0600 in a 0700 directory: the token in here is the whole of what tells a
   local process apart from a web page. mkdir and open only apply a mode when
   they create, so the modes are set again for a file that already existed. */
export const write = (state: State, file = FILE) => {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
};

export const clear = (file = FILE) => {
  try {
    rmSync(file);
  } catch {
    // Already gone is the outcome asked for.
  }
};
