import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginRuntime } from "./types";

const TOKEN_FILE_NAME = "askred-relay-token.json";

interface PersistedData {
  token?: string;
  code?: string;
  codeAt?: number;
}

function readFile(path: string): PersistedData {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as PersistedData;
}

function writeFile(path: string, data: PersistedData): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
}

export function resolveTokenPath(runtime: PluginRuntime): string {
  const storePath = runtime.channel.session.resolveStorePath(undefined, {
    agentId: "askred",
  });
  return join(storePath, TOKEN_FILE_NAME);
}

export function loadPersistedToken(
  path: string,
  logger: { warn(msg: string): void },
): string | undefined {
  try {
    const data = readFile(path);
    return typeof data.token === "string" ? data.token : undefined;
  } catch (err) {
    logger.warn(`[askred] failed to load relay token: ${err}`);
    return undefined;
  }
}

export function persistToken(
  path: string,
  token: string,
  logger: { warn(msg: string): void },
): void {
  try {
    const existing = existsSync(path) ? readFile(path) : {};
    writeFile(path, { ...existing, token });
  } catch (err) {
    logger.warn(`[askred] failed to save relay token: ${err}`);
  }
}

export function loadPersistedCode(
  path: string,
): { code: string; codeAt: number } | undefined {
  try {
    const data = readFile(path);
    if (typeof data.code === "string" && typeof data.codeAt === "number") {
      return { code: data.code, codeAt: data.codeAt };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function persistCode(
  path: string,
  code: string,
  logger: { warn(msg: string): void },
): void {
  try {
    const existing = existsSync(path) ? readFile(path) : {};
    writeFile(path, { ...existing, code, codeAt: Date.now() });
  } catch (err) {
    logger.warn(`[askred] failed to save pairing code: ${err}`);
  }
}
