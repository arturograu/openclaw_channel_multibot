import { cancelSession } from "./dispatch";
import type {
  AgentInfo,
  AudioAttachment,
  InboundContext,
  PluginLogger,
  RelayIncoming,
  RelayOutgoing,
} from "./types";
import { sanitizeForLog } from "./validation";

const INITIAL_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000; // 5 minutes
const PING_INTERVAL_MS = 30_000;
const MAX_MESSAGE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_ID_LENGTH = 256;
const MAX_CONCURRENT_DISPATCHES = 10;

type InboundHandler = (ctx: InboundContext) => Promise<void>;

export interface RelayConnectionOptions {
  relayUrl: string;
  agents: AgentInfo[];
  onInbound: InboundHandler;
  log: PluginLogger;
  /** Token from a previous session, loaded from disk. */
  initialToken?: string;
  /** Called whenever the relay issues a new reconnect token — persist it. */
  onTokenChanged?: (token: string) => void;
}

export class RelayConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private pairingCode: string | null = null;
  private reconnectToken: string | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private startResolve: (() => void) | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

  private readonly relayUrl: string;
  private readonly agents: AgentInfo[];
  private readonly onInbound: InboundHandler;
  private readonly log: PluginLogger;
  private readonly onTokenChanged?: (token: string) => void;
  private activeDispatches = 0;

  constructor(opts: RelayConnectionOptions) {
    if (!opts.relayUrl.startsWith("wss://")) {
      throw new Error(
        `[askred] relay URL must use wss:// (got ${opts.relayUrl})`,
      );
    }
    this.relayUrl = opts.relayUrl;
    this.agents = opts.agents;
    this.onInbound = opts.onInbound;
    this.log = opts.log;
    this.reconnectToken = opts.initialToken ?? null;
    this.onTokenChanged = opts.onTokenChanged;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();

    // Return a promise that stays pending until stop() is called.
    // The health-monitor interprets a resolved start() as "service completed."
    return new Promise<void>((resolve) => {
      this.startResolve = resolve;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearPing();
    this.ws?.close();
    this.ws = null;

    if (this.startResolve) {
      this.startResolve();
      this.startResolve = null;
    }
  }

  healthCheck(): { ok: boolean; status: string } {
    if (this.stopped) {
      return { ok: false, status: "stopped" };
    }
    // Always report ok when not explicitly stopped — the relay auto-reconnects,
    // so transient disconnections should not trigger health-monitor restarts.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: true, status: "reconnecting" };
    }
    return { ok: true, status: "connected" };
  }

  sendChunk(
    agentId: string,
    sessionId: string,
    content: string,
    audio?: AudioAttachment,
  ): void {
    this.send({
      type: "chunk",
      agentId,
      sessionId,
      content,
      ...(audio && { audio }),
    });
  }

  sendResponse(
    agentId: string,
    sessionId: string,
    content: string,
    audio?: AudioAttachment,
  ): void {
    this.send({
      type: "response",
      agentId,
      sessionId,
      content,
      ...(audio && { audio }),
    });
  }

  sendError(agentId: string, sessionId: string, message: string): void {
    this.send({ type: "error", agentId, sessionId, message });
  }

  get code(): string | null {
    return this.pairingCode;
  }

  /** Ask the relay to generate a fresh pairing code (invalidates the old one). */
  requestNewCode(): void {
    if (!this.reconnectToken) {
      this.log.warn("[askred] cannot request new code — no token available");
      return;
    }
    this.log.info("[askred] requesting new pairing code from relay…");
    this.send({ type: "new-code", token: this.reconnectToken });
  }

  private startPing(): void {
    this.clearPing();
    this.pingInterval = setInterval(() => {
      this.send({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.relayUrl}/plugin`;
    this.log.info(`[askred] connecting to relay at ${url}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.log.info("[askred] relay connected");
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.startPing();

      // If we have a stored token from a previous session, attempt to
      // reclaim the same pairing code so the app can reconnect seamlessly.
      if (this.reconnectToken) {
        this.send({ type: "reconnect", token: this.reconnectToken });
      }
    };

    ws.onmessage = (event) => {
      const raw = event.data as string;

      if (raw.length > MAX_MESSAGE_SIZE) {
        this.log.warn(
          `[askred] relay: message too large (${raw.length} bytes), dropping`,
        );
        return;
      }

      let msg: RelayIncoming;
      try {
        msg = JSON.parse(raw) as RelayIncoming;
      } catch {
        this.log.warn("[askred] relay: invalid JSON received");
        return;
      }

      if (msg.type === "code") {
        if (typeof msg.code !== "string" || msg.code.length === 0) {
          this.log.warn("[askred] relay: code message missing code field");
          return;
        }
        this.pairingCode = msg.code;
        if (msg.token && typeof msg.token === "string") {
          this.reconnectToken = msg.token;
          this.onTokenChanged?.(msg.token);
        }
        this.log.debug?.(`[askred] pairing code: ${sanitizeForLog(msg.code)}`);
        this.send({ type: "register", agents: this.agents });
        return;
      }

      if (msg.type === "cancel") {
        const { agentId, sessionId } = msg;
        if (
          typeof agentId !== "string" ||
          agentId.length === 0 ||
          typeof sessionId !== "string" ||
          sessionId.length === 0
        ) {
          this.log.warn(
            "[askred] relay: cancel message missing required fields",
          );
          return;
        }
        cancelSession(sessionId, this, agentId, this.log);
        return;
      }

      if (msg.type === "message") {
        const { agentId, sessionId, content } = msg;

        if (
          typeof agentId !== "string" ||
          agentId.length === 0 ||
          typeof sessionId !== "string" ||
          sessionId.length === 0 ||
          typeof content !== "string"
        ) {
          this.log.warn("[askred] relay: message missing required fields");
          return;
        }

        if (
          agentId.length > MAX_ID_LENGTH ||
          sessionId.length > MAX_ID_LENGTH
        ) {
          this.log.warn(
            "[askred] relay: agentId/sessionId exceeds length limit",
          );
          return;
        }

        if (agentId.includes("::") || sessionId.includes("::")) {
          this.log.warn(
            "[askred] relay: agentId/sessionId contains invalid delimiter",
          );
          return;
        }

        // chatId encodes both agentId and sessionId so the outbound handler
        // can reconstruct them when OpenClaw calls sendText.
        const chatId = `${agentId}::${sessionId}`;

        const ctx: InboundContext = {
          envelope: {
            accountId: "askred",
            channelId: "askred",
            peerId: agentId, // drives agent routing via bindings
            peerType: "user",
          },
          text: content,
          senderId: sessionId,
          senderName: "AskRed User",
          recipientId: agentId,
          chatId,
          chatType: "direct",
          timestamp: Date.now(),
          messageId: `${sessionId}-${Date.now()}`,
        };

        if (this.activeDispatches >= MAX_CONCURRENT_DISPATCHES) {
          this.log.warn(
            "[askred] too many concurrent dispatches, dropping message",
          );
          this.sendError(
            agentId,
            sessionId,
            "Server is busy, please try again",
          );
          return;
        }

        this.activeDispatches++;
        this.onInbound(ctx)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error(`[askred] error processing inbound: ${message}`);
            this.sendError(agentId, sessionId, "An internal error occurred");
          })
          .finally(() => {
            this.activeDispatches--;
          });
      }
    };

    ws.onerror = (err) => {
      this.log.error(`[askred] relay error: ${String(err)}`);
    };

    ws.onclose = () => {
      // Ignore close events from stale WebSocket instances (e.g. after stop+start).
      if (ws !== this.ws) return;
      this.log.warn("[askred] relay disconnected");
      this.clearPing();
      if (!this.stopped) {
        const delay = this.reconnectDelay;
        this.log.info(`[askred] reconnecting in ${delay}ms…`);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delay);
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          MAX_RECONNECT_DELAY_MS,
        );
      }
    };
  }

  private send(msg: RelayOutgoing): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
