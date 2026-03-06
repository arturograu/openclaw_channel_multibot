import type {
  AgentInfo,
  InboundContext,
  PluginLogger,
  RelayIncoming,
  RelayOutgoing,
} from "./types.ts";

const RECONNECT_DELAY_MS = 5_000;

type InboundHandler = (ctx: InboundContext) => Promise<void>;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private pairingCode: string | null = null;

  constructor(
    private readonly relayUrl: string,
    private readonly agents: AgentInfo[],
    private readonly onInbound: InboundHandler,
    private readonly log: PluginLogger,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  sendChunk(agentId: string, sessionId: string, content: string): void {
    this.send({ type: "chunk", agentId, sessionId, content });
  }

  sendResponse(agentId: string, sessionId: string, content: string): void {
    this.send({ type: "response", agentId, sessionId, content });
  }

  sendError(agentId: string, sessionId: string, message: string): void {
    this.send({ type: "error", agentId, sessionId, message });
  }

  get code(): string | null {
    return this.pairingCode;
  }

  private connect(): void {
    const url = `${this.relayUrl}/plugin`;
    this.log.info(`[multibot] connecting to relay at ${url}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.log.info("[multibot] relay connected");
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
      this.log.warn("[multibot] relay disconnected");
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
