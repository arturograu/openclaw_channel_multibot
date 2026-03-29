import { readFileSync } from "node:fs";
import { loadPersistedToken } from "./token-storage";
import type { AgentInfo, CliProgram } from "./types";

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

          // This is the fresh pairing code
          clearTimeout(timeout);
          console.log(`\n  New pairing code: ${msg.code}\n`);
          console.log(
            "Use this code in the AskRed app to reconnect your agents.",
          );
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
      "Check relay connection status and show the current pairing code",
    )
    .action(async () => {
      const token = loadPersistedToken(tokenPath, {
        warn: (msg) => console.error(msg),
      });

      if (!token) {
        console.error("No relay token found. Start the gateway first.");
        process.exit(1);
      }

      console.log("Connecting to relay...");

      const ws = new WebSocket(`${relayUrl}/plugin`);

      const timeout = setTimeout(() => {
        console.error("Could not connect to relay.");
        ws.close();
        process.exit(1);
      }, 15_000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "reconnect", token }));
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === "code" && typeof msg.code === "string") {
          clearTimeout(timeout);
          console.log(`\n  Relay connected. Pairing code: ${msg.code}\n`);
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
    .command("list-agents")
    .description("List agents registered with the relay")
    .action(async () => {
      const token = loadPersistedToken(tokenPath, {
        warn: (msg) => console.error(msg),
      });

      if (!token) {
        console.error("Start the gateway first to see registered agents.");
        process.exit(1);
      }

      console.log("Connecting to relay...");

      const ws = new WebSocket(`${relayUrl}/plugin`);
      let receivedCode = false;

      const timeout = setTimeout(() => {
        console.error("Could not connect to relay.");
        ws.close();
        process.exit(1);
      }, 15_000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "reconnect", token }));
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string) as Record<string, unknown>;
        } catch {
          return;
        }

        // After reconnect the relay sends a "code" message — the plugin
        // then registers its agents, which are included in the stored
        // session. For the CLI we just need to trigger the reconnect
        // and read the agents from the paired response or code message.
        if (msg.type === "code") {
          receivedCode = true;
          // After reconnection, send a register with empty agents
          // just to get back the stored agent list. Actually, the relay
          // stores agents in persistence, so we need to request them.
          // The simplest approach: register with a dummy empty array to
          // trigger the stored agents to be sent back. But that would
          // overwrite agents. Instead, just check if agents came in the
          // message itself — they won't for "code" type.
          // Better: read agents from the paired response on the app side.
          // For the plugin CLI, we need to read from the config directly.
        }

        if (msg.type === "error") {
          clearTimeout(timeout);
          console.error(`Relay error: ${msg.message as string}`);
          ws.close();
          process.exit(1);
        }
      };

      // Wait a bit for the connection to establish, then try reading
      // agents from the local config file instead.
      ws.onerror = () => {
        clearTimeout(timeout);
        console.error("Could not connect to relay.");
        process.exit(1);
      };

      // Give the connection a moment then close and read from config.
      await new Promise<void>((resolve) => {
        const checkTimeout = setTimeout(() => {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }, 3_000);

        ws.onclose = () => {
          clearTimeout(timeout);
          clearTimeout(checkTimeout);
          resolve();
        };
      });

      // Try to read agents from config (the canonical source).
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
          // Fallback to top-level agents list.
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
        if (receivedCode) {
          console.log(
            "Connected to relay but could not read agent list from config.",
          );
          console.log("Agents are configured in ~/.openclaw/config.json");
        } else {
          console.error("Could not read agent configuration.");
          process.exit(1);
        }
      }
    });
}
