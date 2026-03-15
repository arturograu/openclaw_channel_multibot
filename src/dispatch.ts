import { extractAudioFromPayload } from "./audio.ts";
import type { RelayConnection } from "./relay.ts";
import type {
  AudioAttachment,
  InboundContext,
  PluginLogger,
  PluginRuntime,
} from "./types.ts";

const CHANNEL_ID = "multibot";
const ACCOUNT_ID = "multibot";

export async function dispatchToAgent(
  runtime: PluginRuntime,
  logger: PluginLogger,
  relay: RelayConnection,
  ctx: InboundContext,
): Promise<void> {
  const [agentId, sessionId] = ctx.chatId.split("::");
  const config = runtime.config.loadConfig();

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    peer: { kind: "user", id: ctx.senderId },
  });

  const storePath = runtime.channel.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });

  const envelopeOpts =
    runtime.channel.reply.resolveEnvelopeFormatOptions(config);

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

  const inboundPayload = runtime.channel.reply.finalizeInboundContext({
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

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: inboundPayload,
    updateLastRoute: { channel: CHANNEL_ID, accountId: ACCOUNT_ID },
    onRecordError: (err) => {
      logger.error(`[multibot] session record error: ${String(err)}`);
    },
  });

  let fullContent = "";
  let lastAudio: AudioAttachment | undefined;

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: inboundPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        const { text, audio } = extractAudioFromPayload(payload, logger);

        if (audio) {
          logger.info(
            `[multibot] audio extracted: ${audio.mimeType}, ${audio.data.length} chars base64`,
          );
          lastAudio = audio;
        }
        if (!text && !audio) return;

        fullContent += text;
        relay.sendChunk(agentId, sessionId, text, audio);
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[multibot] reply error: ${message}`);
        relay.sendError(agentId, sessionId, message);
      },
    },
  });

  relay.sendResponse(agentId, sessionId, fullContent, lastAudio);
}
