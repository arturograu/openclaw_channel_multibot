import type {
  AgentInfo,
  AudioAttachment,
  InboundContext,
  PluginLogger,
  RelayIncoming,
  RelayOutgoing,
} from "./types.ts";

const RECONNECT_DELAY_MS = 5_000;
const PING_INTERVAL_MS = 30_000;

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
  private startResolve: (() => void) | null = null;

  private readonly relayUrl: string;
  private readonly agents: AgentInfo[];
  private readonly onInbound: InboundHandler;
  private readonly log: PluginLogger;
  private readonly onTokenChanged?: (token: string) => void;

  constructor(opts: RelayConnectionOptions) {
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

  sendChunk(agentId: string, sessionId: string, content: string, audio?: AudioAttachment): void {
    this.send({ type: "chunk", agentId, sessionId, content, ...(audio && { audio }) });
  }

  sendResponse(agentId: string, sessionId: string, content: string, audio?: AudioAttachment): void {
    this.send({ type: "response", agentId, sessionId, content, ...(audio && { audio }) });
  }

  sendError(agentId: string, sessionId: string, message: string): void {
    this.send({ type: "error", agentId, sessionId, message });
  }

  get code(): string | null {
    return this.pairingCode;
  }

  /** Ask the relay to generate a fresh pairing code (invalidates the old one). */
  requestNewCode(): void {
    this.log.info("[multibot] requesting new pairing code from relay…");
    this.send({ type: "new-code" });
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
    const url = `${this.relayUrl}/plugin`;
    this.log.info(`[multibot] connecting to relay at ${url}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.log.info("[multibot] relay connected");
      this.startPing();

      // If we have a stored token from a previous session, attempt to
      // reclaim the same pairing code so the app can reconnect seamlessly.
      if (this.reconnectToken) {
        this.send({ type: "reconnect", token: this.reconnectToken });
      }
    };

    ws.onmessage = (event) => {
      let msg: RelayIncoming;
      try {
        msg = JSON.parse(event.data as string) as RelayIncoming;
      } catch {
        this.log.warn("[multibot] relay: invalid JSON received");
        return;
      }

      if (msg.type === "code") {
        this.pairingCode = msg.code;
        if (msg.token) {
          this.reconnectToken = msg.token;
          this.onTokenChanged?.(msg.token);
        }
        this.log.info(`[multibot] pairing code: ${msg.code}`);
        this.send({ type: "register", agents: this.agents });
        return;
      }

      if (msg.type === "message") {
        const { agentId, sessionId, content } = msg;
        // chatId encodes both agentId and sessionId so the outbound handler
        // can reconstruct them when OpenClaw calls sendText.
        const chatId = `${agentId}::${sessionId}`;

        const ctx: InboundContext = {
          envelope: {
            accountId: "multibot",
            channelId: "multibot",
            peerId: agentId, // drives agent routing via bindings
            peerType: "user",
          },
          text: content,
          senderId: sessionId,
          senderName: "Multibot User",
          recipientId: agentId,
          chatId,
          chatType: "direct",
          timestamp: Date.now(),
          messageId: `${sessionId}-${Date.now()}`,
        };

        this.onInbound(ctx).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error(`[multibot] error processing inbound: ${message}`);
          this.sendError(agentId, sessionId, message);
        });
      }
    };

    ws.onerror = (err) => {
      this.log.error(`[multibot] relay error: ${String(err)}`);
    };

    ws.onclose = () => {
      // Ignore close events from stale WebSocket instances (e.g. after stop+start).
      if (ws !== this.ws) return;
      this.log.warn("[multibot] relay disconnected");
      this.clearPing();
      if (!this.stopped) {
        this.log.info(`[multibot] reconnecting in ${RECONNECT_DELAY_MS}ms…`);
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    };
  }

  private send(msg: RelayOutgoing): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
