import { loadPersistedToken } from "./token-storage.ts";
import type { CliProgram } from "./types.ts";

interface CliOptions {
  relayUrl: string;
  tokenPath: string;
}

export function registerCliCommands(
  program: CliProgram,
  options: CliOptions,
): void {
  const { relayUrl, tokenPath } = options;

  const multibot = program
    .command("multibot")
    .description("Multibot plugin commands");

  multibot
    .command("new-pairing-code")
    .description("Generate a fresh pairing code for the Multibot app")
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
      let receivedFirstCode = false;

      const timeout = setTimeout(() => {
        console.error("Timed out waiting for response from relay.");
        ws.close();
        process.exit(1);
      }, 15_000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "reconnect", token }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;

        if (msg.type === "code") {
          if (!receivedFirstCode) {
            receivedFirstCode = true;
            ws.send(JSON.stringify({ type: "new-code" }));
            return;
          }
          clearTimeout(timeout);
          console.log(`\n  New pairing code: ${msg.code as string}\n`);
          console.log(
            "Use this code in the Multibot app to reconnect your agents.",
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
}
