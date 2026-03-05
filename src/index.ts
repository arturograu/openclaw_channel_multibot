import { RelayConnection } from "./relay";
import type {
  ChannelPlugin,
  InboundContext,
  OpenClawConfig,
  OutboundTextContext,
  PluginContext,
  SendResult,
} from "./types";

const CHANNEL_ID = "multibot";
const DEFAULT_RELAY = "wss://multibot-relay.fly.dev";

export default function register(api: PluginContext): void {
  const cfg = api.config.channels?.multibot;
  const relayUrl = cfg?.relay ?? DEFAULT_RELAY;

  // Use channel-specific agents, gateway agent list, or default to "main"
  const gatewayAgents = api.config.agents?.list ?? [];
  const agents =
    cfg?.agents ??
    (gatewayAgents.length > 0
      ? gatewayAgents.map((a) => ({ id: a.id, name: a.id }))
      : [{ id: "main", name: "Main" }]);

  api.logger.info(
    `[multibot] exposing ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ")}`,
  );

  const relay = new RelayConnection(
    relayUrl,
    agents,
    handleInbound,
    api.logger,
  );

  async function handleInbound(ctx: InboundContext): Promise<void> {
    api.logger.debug(
      `[multibot] inbound from peer=${ctx.envelope.peerId} chat=${ctx.chatId}: ${ctx.text}`,
    );
  }

  const channelPlugin: ChannelPlugin = {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Multibot",
      selectionLabel: "Multibot App",
      docsPath: "/channels/multibot",
      blurb: "Chat with your OpenClaw agents from the Multibot mobile app.",
      order: 50,
    },
    capabilities: {
      chatTypes: ["direct"],
    },
    config: {
      listAccountIds: (_cfg: OpenClawConfig) => ["multibot"],
      resolveAccount: (_cfg: OpenClawConfig, accountId?: string) => ({
        accountId: accountId ?? "multibot",
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
        relay.sendResponse(agentId, sessionId, ctx.text);
        return { ok: true };
      },
    },
  };

  api.registerChannel({ plugin: channelPlugin });

  api.registerService({
    id: CHANNEL_ID,
    async start() {
      await relay.start();
      if (relay.code) {
        api.logger.info(`[multibot] pairing code: ${relay.code}`);
      }
    },
    async stop() {
      await relay.stop();
    },
  });
}
