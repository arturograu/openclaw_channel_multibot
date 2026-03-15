#!/usr/bin/env node
/**
 * CLI to request a new Multibot pairing code from the relay.
 *
 * Usage:  npx multibot-new-code
 *         multibot-new-code          (if installed globally)
 *
 * The plugin writes connection info to ~/.openclaw/multibot-cli.json on
 * startup, so the gateway must be running for this to work.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI_CONFIG_PATH = join(homedir(), ".openclaw", "multibot-cli.json");

function loadCliConfig() {
  if (!existsSync(CLI_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CLI_CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function loadToken(path) {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return data.token ?? null;
  } catch {
    return null;
  }
}

const config = loadCliConfig();
if (!config) {
  console.error(
    "Error: Could not find multibot plugin config.\n" +
    "Make sure the OpenClaw gateway is running with the multibot plugin installed.",
  );
  process.exit(1);
}

const token = loadToken(config.tokenPath);
if (!token) {
  console.error(
    "Error: No relay token found. The plugin has not connected to the relay yet.\n" +
    "Start the OpenClaw gateway and wait for the initial pairing code.",
  );
  process.exit(1);
}

console.log("Connecting to relay...");

const url = `${config.relayUrl}/plugin`;
const ws = new WebSocket(url);
let gotCode = false;

const timeout = setTimeout(() => {
  console.error("Error: Timed out waiting for response from relay.");
  ws.close();
  process.exit(1);
}, 15_000);

ws.onopen = () => {
  // Authenticate with the stored token, then ask for a new code.
  ws.send(JSON.stringify({ type: "reconnect", token }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === "code") {
    if (!gotCode) {
      // First code = reconnect restored the session. Now request a fresh one.
      gotCode = true;
      ws.send(JSON.stringify({ type: "new-code" }));
      return;
    }
    // Second code = the actual new pairing code.
    clearTimeout(timeout);
    console.log(`\n  New pairing code: ${msg.code}\n`);
    console.log("Use this code in the Multibot app to reconnect your agents.");
    ws.close();
  }

  if (msg.type === "error") {
    clearTimeout(timeout);
    console.error(`Relay error: ${msg.message}`);
    ws.close();
    process.exit(1);
  }
};

ws.onerror = () => {
  clearTimeout(timeout);
  console.error("Error: Could not connect to relay.");
  process.exit(1);
};

ws.onclose = () => {
  clearTimeout(timeout);
};
