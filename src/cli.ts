import { readFileSync } from "node:fs";
import { loadPersistedCode, loadPersistedToken, persistCode } from "./token-storage";
import type { AgentInfo, CliProgram } from "./types";

const CODE_TTL_MS = 10 * 60_000; // 10 minutes

interface CliOptions {
  relayUrl: string;
  tokenPath: string;
}

export function registerCliCommands(
  program: CliProgram,
  options: CliOptions,
): void {
  const { relayUrl, tokenPath } = options;

  const askred = program
    .command("askred")
    .description("AskRed plugin commands");

  askred
    .command("new-pairing-code")
    .description("Generate a fresh pairing code for the AskRed app")
    .action(async () => {
      const token = loadPersistedToken(tokenPath, {
        warn: (msg) => console.error(msg),
      });

      if (!token) {
        console.error(
          "No relay token found. Start the gateway first so the plugin can connect to the relay.",
        );
        process.exit(1);
      }

      console.log("Connecting to relay...");

      const ws = new WebSocket(`${relayUrl}/plugin`);
      let sentNewCode = false;

      const timeout = setTimeout(() => {
        console.error("Timed out waiting for response from relay.");
        ws.close();
        process.exit(1);
      }, 15_000);

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === "code" && typeof msg.code === "string") {
          if (!sentNewCode) {
            // Initial code from connection — ignore it and request a new one.
            // Send token in body so the relay knows which session to rotate
            // (no reconnect — that would hijack the running plugin's slot).
            sentNewCode = true;
            ws.send(JSON.stringify({ type: "new-code", token }));
            return;
          }

          // This is the fresh pairing code — persist it to disk
          clearTimeout(timeout);
          persistCode(tokenPath, msg.code, { warn: (m) => console.error(m) });
          console.log(`\n  New pairing code: ${msg.code}\n`);
          console.log(
            "Use this code in the AskRed app to reconnect your agents.",
          );
          console.log("The code expires in 10 minutes.");
          ws.close();
        }

        if (msg.type === "error") {
          clearTimeout(timeout);
          console.error(`Relay error: ${msg.message as string}`);
          ws.close();
          process.exit(1);
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        console.error("Could not connect to relay.");
        process.exit(1);
      };

      await new Promise<void>((resolve) => {
        ws.onclose = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    });

  askred
    .command("status")
    .description(
      "Show the current pairing code (reads from disk — no relay connection needed)",
    )
    .action(() => {
      const saved = loadPersistedCode(tokenPath);

      if (!saved) {
        console.error(
          "No pairing code found. Start the gateway first, then run:\n\n  openclaw askred new-pairing-code\n",
        );
        process.exit(1);
      }

      const ageMs = Date.now() - saved.codeAt;
      if (ageMs > CODE_TTL_MS) {
        console.log(
          `\n  Pairing code expired (generated ${Math.round(ageMs / 60_000)} min ago).\n`,
        );
        console.log("  Run this to get a new one:\n");
        console.log("    openclaw askred new-pairing-code\n");
        return;
      }

      const remainingMin = Math.max(
        1,
        Math.round((CODE_TTL_MS - ageMs) / 60_000),
      );
      console.log(`\n  Pairing code: ${saved.code}\n`);
      console.log(`  Expires in ~${remainingMin} min.`);
      console.log(
        "  Use this code in the AskRed app to connect your agents.\n",
      );
    });

  askred
    .command("list-agents")
    .description("List agents from the local OpenClaw config")
    .action(() => {
      try {
        const configPath = `${process.env.HOME}/.openclaw/config.json`;
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as Record<string, unknown>;
        const channels = config.channels as Record<string, unknown> | undefined;
        const askredConfig = channels?.askred as
          | Record<string, unknown>
          | undefined;
        const agents = (askredConfig?.agents ?? []) as AgentInfo[];

        if (agents.length === 0) {
          const topAgents = config.agents as
            | Record<string, unknown>
            | undefined;
          const list = (topAgents?.list ?? []) as Array<{ id: string }>;
          if (list.length > 0) {
            console.log(`\n  Registered agents (${list.length}):\n`);
            for (const agent of list) {
              console.log(`    ${agent.id}`);
            }
            console.log();
            return;
          }

          console.log("No agents found in config.");
          return;
        }

        console.log(`\n  Registered agents (${agents.length}):\n`);
        console.log("  ID              Name");
        console.log("  ──────────────  ──────────────");
        for (const agent of agents) {
          console.log(`  ${agent.id.padEnd(16)}${agent.name}`);
        }
        console.log();
      } catch {
        console.error(
          "Could not read agent configuration from ~/.openclaw/config.json",
        );
        process.exit(1);
      }
    });
}
