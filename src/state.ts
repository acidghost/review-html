import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Tests override REVIEW_STATE to avoid touching a real server's state.
export const FILE =
  process.env.REVIEW_STATE ??
  join(homedir(), ".cache", "review-html", "state.json");

export type State = { pid: number; port: number; token: string };

// State may outlive its server; callers verify identity before acting.
export function read(file = FILE): State | null {
  try {
    const { pid, port, token } = JSON.parse(readFileSync(file, "utf8"));
    if (typeof pid !== "number" || typeof port !== "number") return null;
    return typeof token === "string" && token ? { pid, port, token } : null;
  } catch {
    return null;
  }
}

// Reset modes even on existing paths: creation modes alone do not protect the token.
export function write(state: State, file = FILE) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clear(file = FILE) {
  try {
    rmSync(file);
  } catch {}
}
