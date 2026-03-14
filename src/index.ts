import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { dirname, extname, join } from "node:path";
import { RelayConnection } from "./relay";
import type {
  AudioAttachment,
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
const MEDIA_RE = /MEDIA:(\/[^\s]+)/g;

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
  };
  return map[ext] ?? "audio/mpeg";
}

function readMediaAsAudio(filePath: string, logger: { warn(msg: string): void }): AudioAttachment | undefined {
  try {
    const buf = readFileSync(filePath);
    return { data: buf.toString("base64"), mimeType: mimeFromPath(filePath) };
  } catch (err) {
    logger.warn(`[multibot] failed to read media file ${filePath}: ${err}`);
    return undefined;
  }
}

// ── Token persistence ─────────────────────────────────────────────────────────

const TOKEN_FILE_NAME = "multibot-relay-token.json";
const NEW_CODE_SENTINEL = "request-new-code";

function resolveTokenPath(runtime: PluginRuntime): string {
  const storePath = runtime.channel.session.resolveStorePath(undefined, {
    agentId: "multibot",
  });
  return join(storePath, TOKEN_FILE_NAME);
}

function loadToken(path: string, logger: { warn(msg: string): void }): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as { token?: string };
    return data.token ?? undefined;
  } catch (err) {
    logger.warn(`[multibot] failed to load relay token: ${err}`);
    return undefined;
  }
}

function saveToken(path: string, token: string, logger: { warn(msg: string): void }): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ token }));
  } catch (err) {
    logger.warn(`[multibot] failed to save relay token: ${err}`);
  }
}

// ── New-code sentinel watcher ─────────────────────────────────────────────────

function watchNewCodeSentinel(
  storePath: string,
  relay: RelayConnection,
  logger: { info(msg: string): void; warn(msg: string): void },
): FSWatcher | null {
  const dir = dirname(join(storePath, NEW_CODE_SENTINEL));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  try {
    return watch(dir, (_event, filename) => {
      if (filename !== NEW_CODE_SENTINEL) return;
      const sentinelPath = join(dir, NEW_CODE_SENTINEL);
      if (!existsSync(sentinelPath)) return;

      // Remove sentinel immediately to avoid repeated triggers.
      try { unlinkSync(sentinelPath); } catch { /* already gone */ }

      relay.requestNewCode();
      logger.info(
        `[multibot] new-code requested — watch the logs for the fresh pairing code`,
      );
    });
  } catch (err) {
    logger.warn(`[multibot] could not watch for new-code sentinel: ${err}`);
    return null;
  }
}

// ── Plugin registration ──────────────────────────────────────────────────────

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

  const tokenPath = resolveTokenPath(runtime);
  const savedToken = loadToken(tokenPath, api.logger);
  if (savedToken) {
    api.logger.info("[multibot] loaded persisted relay token — will attempt reconnect");
  }

  const relay = new RelayConnection({
    relayUrl,
    agents,
    onInbound: handleInbound,
    log: api.logger,
    initialToken: savedToken,
    onTokenChanged: (token) => saveToken(tokenPath, token, api.logger),
  });

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
        api.logger.debug(
          `[multibot] sendText text=${ctx.text.slice(0, 80)}`,
        );
        // Check for MEDIA: references in outbound text
        let text = ctx.text;
        let audio: AudioAttachment | undefined;
        const match = MEDIA_RE.exec(text);
        MEDIA_RE.lastIndex = 0;
        if (match) {
          audio = readMediaAsAudio(match[1], api.logger);
          text = text.replace(MEDIA_RE, "").trim();
          MEDIA_RE.lastIndex = 0;
        }
        relay.sendResponse(aid, sid, text, audio);
        return { ok: true };
      },
    },
  };

  api.registerChannel({ plugin: channelPlugin });

  // Watch for `request-new-code` sentinel file so the user can trigger
  // a fresh pairing code with: touch <storePath>/request-new-code
  // (or: openclaw new-code, if the gateway exposes a helper for this)
  let sentinelWatcher: FSWatcher | null = null;
  const sentinelDir = dirname(tokenPath);

  api.registerService({
    id: CHANNEL_ID,
    async start() {
      sentinelWatcher = watchNewCodeSentinel(sentinelDir, relay, api.logger);
      api.logger.info(
        `[multibot] to request a new pairing code, run: touch ${join(sentinelDir, NEW_CODE_SENTINEL)}`,
      );
      await relay.start();
    },
    async stop() {
      sentinelWatcher?.close();
      sentinelWatcher = null;
      await relay.stop();
    },
    healthCheck() {
      return relay.healthCheck();
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
  let lastAudio: AudioAttachment | undefined;

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        // Extract audio from mediaUrls (array), mediaUrl (string),
        // or MEDIA:/path references in the text.
        let audio: AudioAttachment | undefined;

        // 1. mediaUrls (array) — used by OpenClaw TTS
        const urls = payload.mediaUrls as string[] | undefined;
        if (Array.isArray(urls)) {
          for (const url of urls) {
            if (typeof url === "string" && url.length > 0) {
              audio = readMediaAsAudio(url, api.logger);
              if (audio) break;
            }
          }
        }

        // 2. mediaUrl (singular string) — fallback
        if (!audio && payload.mediaUrl && typeof payload.mediaUrl === "string") {
          audio = readMediaAsAudio(payload.mediaUrl, api.logger);
        }

        let text = payload.text ?? "";

        // 3. MEDIA:/path references in text — fallback
        if (!audio && text) {
          const match = MEDIA_RE.exec(text);
          MEDIA_RE.lastIndex = 0;
          if (match) {
            audio = readMediaAsAudio(match[1], api.logger);
            text = text.replace(MEDIA_RE, "").trim();
            MEDIA_RE.lastIndex = 0;
          }
        }

        if (audio) {
          api.logger.info(`[multibot] audio extracted: ${audio.mimeType}, ${audio.data.length} chars base64`);
          lastAudio = audio;
        }
        if (!text && !audio) return;

        fullContent += text;
        relay.sendChunk(agentId, sessionId, text, audio);
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.error(`[multibot] reply error: ${message}`);
        relay.sendError(agentId, sessionId, message);
      },
    },
  });

  // 5. Signal completion
  relay.sendResponse(agentId, sessionId, fullContent, lastAudio);
}
