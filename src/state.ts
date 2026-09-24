import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Tests override REVIEW_STATE to avoid touching a real server's state.
export const FILE =
  process.env.REVIEW_STATE ?? join(homedir(), ".cache", "review-html", "state.json");

export type State = { pid: number; port: number; token: string };

type Stored = { version?: number; plans?: string[]; pid?: number; port?: number; token?: string };

function stored(file: string): Stored {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`invalid review state: ${file}`);
  }
  const value = data as Stored;
  if (value.version !== undefined && value.version !== 1) {
    throw new Error(`unsupported review state version: ${file}`);
  }
  if (
    value.plans !== undefined &&
    (!Array.isArray(value.plans) || !value.plans.every((p) => typeof p === "string"))
  ) {
    throw new Error(`invalid plans in review state: ${file}`);
  }
  return value;
}

// State may outlive its server; callers verify identity before acting.
export function read(file = FILE): State | null {
  try {
    const { pid, port, token } = stored(file);
    if (typeof pid !== "number" || typeof port !== "number") return null;
    return typeof token === "string" && token ? { pid, port, token } : null;
  } catch {
    return null;
  }
}

export function readPlans(file = FILE): string[] {
  return stored(file).plans ?? [];
}

// Atomic replacement avoids leaving a partial token or plan list behind.
function save(data: Stored, file: string) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = join(dir, `.state-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function write(state: State, file = FILE) {
  save({ version: 1, plans: readPlans(file), ...state }, file);
}

export function writePlans(plans: string[], file = FILE) {
  const { pid, port, token } = stored(file);
  save({ version: 1, plans, pid, port, token }, file);
}

// Forget the process, not the plans. On an empty state, remove the file.
export function clear(file = FILE) {
  if (!existsSync(file)) return;
  const plans = readPlans(file);
  if (plans.length) save({ version: 1, plans }, file);
  else rmSync(file);
}
