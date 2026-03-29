import { extractMediaReference } from "./audio";
import { registerCliCommands } from "./cli";
import { dispatchToAgent } from "./dispatch";
import { RelayConnection } from "./relay";
import {
  loadPersistedToken,
  persistToken,
  resolveTokenPath,
} from "./token-storage";
import type {
  AgentInfo,
  ChannelPlugin,
  InboundContext,
  OutboundTextContext,
  PluginContext,
  SendResult,
} from "./types";
import { sanitizeForLog } from "./validation";

const CHANNEL_ID = "askred";
const ACCOUNT_ID = "askred";
const DEFAULT_RELAY = "wss://multibot-relay.fly.dev";

export default function register(api: PluginContext): void {
  const channelConfig = api.config.channels?.askred;
  const relayUrl = channelConfig?.relay ?? DEFAULT_RELAY;

  const agents = resolveAgents(api);
  api.logger.info(
    `[askred] exposing ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ")}`,
  );

  const tokenPath = resolveTokenPath(api.runtime);
  const savedToken = loadPersistedToken(tokenPath, api.logger);
  if (savedToken) {
    api.logger.info(
      "[askred] loaded persisted relay token — will attempt reconnect",
    );
  }

  const relay = new RelayConnection({
    relayUrl,
    agents,
    onInbound: (ctx): Promise<void> => handleInbound(api, relay, ctx),
    log: api.logger,
    initialToken: savedToken,
    onTokenChanged: (token) => persistToken(tokenPath, token, api.logger),
  });

  api.registerChannel({ plugin: createChannelPlugin(api, relay) });

  api.registerService({
    id: CHANNEL_ID,
    start: () => relay.start(),
    stop: () => relay.stop(),
    healthCheck: () => relay.healthCheck(),
  });

  api.registerCli(
    ({ program }) => registerCliCommands(program, { relayUrl, tokenPath }),
    { commands: ["askred"] },
  );
}

function resolveAgents(api: PluginContext): AgentInfo[] {
  const channelAgents = api.config.channels?.askred?.agents;
  if (channelAgents) return channelAgents;

  const gatewayAgents = api.config.agents?.list ?? [];
  if (gatewayAgents.length > 0) {
    return gatewayAgents.map((a) => ({ id: a.id, name: a.id }));
  }

  return [{ id: "main", name: "Main" }];
}

async function handleInbound(
  api: PluginContext,
  relay: RelayConnection,
  ctx: InboundContext,
): Promise<void> {
  api.logger.debug(
    `[askred] inbound from peer=${sanitizeForLog(ctx.envelope.peerId)} chat=${sanitizeForLog(ctx.chatId)}: ${sanitizeForLog(ctx.text.slice(0, 200))}`,
  );

  const [agentId, sessionId] = ctx.chatId.split("::");

  try {
    await dispatchToAgent(api.runtime, api.logger, relay, ctx);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    api.logger.error(`[askred] dispatch error: ${detail}`);
    relay.sendError(
      agentId,
      sessionId,
      "An error occurred while processing your message",
    );
  }
}

function createChannelPlugin(
  api: PluginContext,
  relay: RelayConnection,
): ChannelPlugin {
  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "AskRed",
      selectionLabel: "AskRed App",
      docsPath: "/channels/askred",
      blurb: "Chat with your OpenClaw agents from the AskRed mobile app.",
      order: 50,
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [ACCOUNT_ID],
      resolveAccount: (_cfg, accountId?) => ({
        accountId: accountId ?? ACCOUNT_ID,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx: OutboundTextContext): Promise<SendResult> => {
        const [agentId, sessionId] = ctx.to.split("::");
        if (!agentId || !sessionId) {
          api.logger.error("[askred] malformed chatId in sendText");
          return { ok: false, error: "malformed chatId" };
        }

        api.logger.debug(
          `[askred] sendText text=${sanitizeForLog(ctx.text.slice(0, 80))}`,
        );

        const { cleanedText, audio } = extractMediaReference(
          ctx.text,
          api.logger,
        );
        relay.sendResponse(agentId, sessionId, cleanedText, audio);
        return { ok: true };
      },
    },
  };
}
