import { extractAudioFromPayload } from "./audio";
import type { RelayConnection } from "./relay";
import type {
  AudioAttachment,
  InboundContext,
  PluginLogger,
  PluginRuntime,
} from "./types";

const CHANNEL_ID = "askred";
const ACCOUNT_ID = "askred";
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB

// ── Active session tracking (for cancellation) ──────────────────────────────

interface SessionState {
  cancelled: boolean;
}

const activeSessions = new Map<string, SessionState>();

/**
 * Marks a session as cancelled so the dispatch loop stops sending chunks.
 * Returns true if the session was found and cancelled.
 */
export function cancelSession(
  sessionId: string,
  relay: RelayConnection,
  agentId: string,
  logger: PluginLogger,
): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.cancelled = true;
  logger.info(`[askred] session ${sessionId} cancelled by user`);
  relay.sendError(agentId, sessionId, "Cancelled by user");
  return true;
}

export async function dispatchToAgent(
  runtime: PluginRuntime,
  logger: PluginLogger,
  relay: RelayConnection,
  ctx: InboundContext,
): Promise<void> {
  const [agentId, sessionId] = ctx.chatId.split("::");
  activeSessions.set(sessionId, { cancelled: false });
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
    channel: "AskRed",
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
      logger.error(`[askred] session record error: ${String(err)}`);
    },
  });

  let fullContent = "";
  let lastAudio: AudioAttachment | undefined;

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: inboundPayload,
      cfg: config,
      dispatcherOptions: {
        deliver: async (payload) => {
          const state = activeSessions.get(sessionId);
          if (state?.cancelled) return;

          const { text, audio } = extractAudioFromPayload(payload, logger);

          if (audio) {
            logger.info(
              `[askred] audio extracted: ${audio.mimeType}, ${audio.data.length} chars base64`,
            );
            lastAudio = audio;
          }
          if (!text && !audio) return;

          if (fullContent.length + text.length > MAX_RESPONSE_SIZE) {
            logger.warn("[askred] response size limit exceeded, truncating");
            return;
          }

          fullContent += text;
          relay.sendChunk(agentId, sessionId, text, audio);
        },
        onError: (err) => {
          const detail = err instanceof Error ? err.message : String(err);
          logger.error(`[askred] reply error: ${detail}`);
          relay.sendError(
            agentId,
            sessionId,
            "An error occurred while processing the response",
          );
        },
      },
    });

    const state = activeSessions.get(sessionId);
    if (!state?.cancelled) {
      relay.sendResponse(agentId, sessionId, fullContent, lastAudio);
    }
  } finally {
    activeSessions.delete(sessionId);
  }
}
