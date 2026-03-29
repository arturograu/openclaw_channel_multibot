import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginRuntime } from "./types";

const TOKEN_FILE_NAME = "askred-relay-token.json";

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
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as { token?: unknown };
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
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ token }), { mode: 0o600 });
  } catch (err) {
    logger.warn(`[askred] failed to save relay token: ${err}`);
  }
}
