import { RelayConnection } from "./relay";
import type {
  ChannelPlugin,
  InboundContext,
  OpenClawConfig,
  OutboundTextContext,
  PluginContext,
  PluginRuntime,
  SendResult,
} from "./types";

const CHANNEL_ID = "multibot";
const ACCOUNT_ID = "multibot";
const DEFAULT_RELAY = "wss://multibot-relay.fly.dev";

export default function register(api: PluginContext): void {
  const cfg = api.config.channels?.multibot;
  const relayUrl = cfg?.relay ?? DEFAULT_RELAY;
  const runtime = api.runtime;

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

    const [agentId, sessionId] = ctx.chatId.split("::");

    try {
      await dispatchToAgent(runtime, api, relay, ctx);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      api.logger.error(`[multibot] dispatch error: ${message}`);
      relay.sendError(agentId, sessionId, message);
    }
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
      listAccountIds: (_cfg: OpenClawConfig) => [ACCOUNT_ID],
      resolveAccount: (_cfg: OpenClawConfig, accountId?: string) => ({
        accountId: accountId ?? ACCOUNT_ID,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx: OutboundTextContext): Promise<SendResult> => {
        const [aid, sid] = ctx.to.split("::");
        if (!aid || !sid) {
          api.logger.error(`[multibot] malformed chatId: ${ctx.to}`);
          return { ok: false, error: "malformed chatId" };
        }
        relay.sendResponse(aid, sid, ctx.text);
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

// ── Agent dispatch ───────────────────────────────────────────────────────────

async function dispatchToAgent(
  runtime: PluginRuntime,
  api: PluginContext,
  relay: RelayConnection,
  ctx: InboundContext,
): Promise<void> {
  const [agentId, sessionId] = ctx.chatId.split("::");
  const loadedCfg = runtime.config.loadConfig();

  // 1. Resolve routing
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: loadedCfg,
    channel: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    peer: { kind: "user", id: ctx.senderId },
  });

  // 2. Build & finalize inbound context
  const storePath = runtime.channel.session.resolveStorePath(
    undefined,
    { agentId: route.agentId },
  );

  const envelopeOpts = runtime.channel.reply.resolveEnvelopeFormatOptions(loadedCfg);
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = runtime.channel.reply.formatInboundEnvelope({
    channel: "Multibot",
    from: ctx.senderName || ctx.senderId,
    timestamp: ctx.timestamp,
    body: ctx.text,
    chatType: "direct",
    sender: { name: ctx.senderName, id: ctx.senderId },
    previousTimestamp,
    envelope: envelopeOpts,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: ctx.text,
    CommandBody: ctx.text,
    From: ctx.chatId,
    To: ctx.chatId,
    SessionKey: route.sessionKey,
    AccountId: ACCOUNT_ID,
    ChannelId: CHANNEL_ID,
    ChatType: "direct",
    ConversationLabel: ctx.senderName || ctx.senderId,
    SenderName: ctx.senderName,
    SenderId: ctx.senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: ctx.messageId,
    Timestamp: ctx.timestamp,
    CommandAuthorized: undefined,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: ctx.chatId,
  });

  // 3. Record session
  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: { channel: CHANNEL_ID, accountId: ACCOUNT_ID },
    onRecordError: (err) => {
      api.logger.error(`[multibot] session record error: ${String(err)}`);
    },
  });

  // 4. Dispatch to agent — stream chunks as they arrive
  let fullContent = "";

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        if (!payload.text) return;
        fullContent += payload.text;
        // Stream each block to the app in real-time
        relay.sendChunk(agentId, sessionId, payload.text);
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.error(`[multibot] reply error: ${message}`);
        relay.sendError(agentId, sessionId, message);
      },
    },
  });

  // 5. Signal completion
  relay.sendResponse(agentId, sessionId, fullContent);
}
