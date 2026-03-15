import { extractMediaReference } from "./audio.ts";
import { registerCliCommands } from "./cli.ts";
import { dispatchToAgent } from "./dispatch.ts";
import { RelayConnection } from "./relay.ts";
import { loadPersistedToken, persistToken, resolveTokenPath } from "./token-storage.ts";
import type {
  AgentInfo,
  ChannelPlugin,
  InboundContext,
  OpenClawConfig,
  OutboundTextContext,
  PluginContext,
  SendResult,
} from "./types.ts";

const CHANNEL_ID = "multibot";
const ACCOUNT_ID = "multibot";
const DEFAULT_RELAY = "wss://multibot-relay.fly.dev";

export default function register(api: PluginContext): void {
  const channelConfig = api.config.channels?.multibot;
  const relayUrl = channelConfig?.relay ?? DEFAULT_RELAY;

  const agents = resolveAgents(api);
  api.logger.info(
    `[multibot] exposing ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ")}`,
  );

  const tokenPath = resolveTokenPath(api.runtime);
  const savedToken = loadPersistedToken(tokenPath, api.logger);
  if (savedToken) {
    api.logger.info("[multibot] loaded persisted relay token — will attempt reconnect");
  }

  const relay = new RelayConnection({
    relayUrl,
    agents,
    onInbound: (ctx) => handleInbound(api, relay, ctx),
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
    { commands: ["multibot"] },
  );
}

function resolveAgents(api: PluginContext): AgentInfo[] {
  const channelAgents = api.config.channels?.multibot?.agents;
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
    `[multibot] inbound from peer=${ctx.envelope.peerId} chat=${ctx.chatId}: ${ctx.text}`,
  );

  const [agentId, sessionId] = ctx.chatId.split("::");

  try {
    await dispatchToAgent(api.runtime, api.logger, relay, ctx);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    api.logger.error(`[multibot] dispatch error: ${message}`);
    relay.sendError(agentId, sessionId, message);
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
      label: "Multibot",
      selectionLabel: "Multibot App",
      docsPath: "/channels/multibot",
      blurb: "Chat with your OpenClaw agents from the Multibot mobile app.",
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
          api.logger.error(`[multibot] malformed chatId: ${ctx.to}`);
          return { ok: false, error: "malformed chatId" };
        }

        api.logger.debug(`[multibot] sendText text=${ctx.text.slice(0, 80)}`);

        const { cleanedText, audio } = extractMediaReference(ctx.text, api.logger);
        relay.sendResponse(agentId, sessionId, cleanedText, audio);
        return { ok: true };
      },
    },
  };
}
