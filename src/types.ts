// ── OpenClaw SDK stubs ────────────────────────────────────────────────────────
// Minimal types inferred from docs + DingTalk reference plugin.
// Replace with official @openclaw/plugin-sdk when/if published.

export interface AgentInfo {
  id: string;
  name: string;
}

export interface MultibotConfig {
  relay: string; // e.g. "wss://multibot-relay.fly.dev"
  agents: AgentInfo[]; // agents to expose to the app
}

export interface GatewayAgent {
  id: string;
  default?: boolean;
  workspace?: string;
}

export interface OpenClawConfig {
  agents?: {
    list?: GatewayAgent[];
  };
  channels?: {
    multibot?: MultibotConfig;
  };
  [key: string]: unknown;
}

export interface MessageEnvelope {
  accountId: string;
  channelId: string;
  peerId: string;
  peerType: "user" | "group" | "channel";
}

export interface InboundContext {
  envelope: MessageEnvelope;
  text: string;
  senderId: string;
  senderName?: string;
  recipientId: string;
  chatId: string;
  chatType: "direct" | "group" | "channel";
  timestamp: number;
  messageId: string;
}

export interface OutboundTextContext {
  text: string;
  to: string;
  accountId: string;
  sessionKey: string;
  runId?: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ChannelPlugin {
  id: string;
  meta: {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    blurb: string;
    order?: number;
  };
  capabilities: {
    chatTypes: ("direct" | "group" | "channel")[];
  };
  config: {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (
      cfg: OpenClawConfig,
      accountId?: string,
    ) => { accountId: string };
  };
  outbound: {
    deliveryMode: "direct" | "async";
    sendText: (context: OutboundTextContext) => Promise<SendResult>;
  };
}

export interface Service {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface PluginContext {
  config: OpenClawConfig;
  logger: PluginLogger;
  registerChannel(opts: { plugin: ChannelPlugin }): void;
  registerService(service: Service): void;
}

// ── Relay protocol ────────────────────────────────────────────────────────────

export interface RelayCodeMsg {
  type: "code";
  code: string;
}

export interface RelayInboundMsg {
  type: "message";
  agentId: string;
  sessionId: string;
  content: string;
}

export type RelayIncoming = RelayCodeMsg | RelayInboundMsg;

export interface RelayRegisterMsg {
  type: "register";
  agents: AgentInfo[];
}

export interface RelayResponseMsg {
  type: "response";
  agentId: string;
  sessionId: string;
  content: string;
}

export interface RelayErrorMsg {
  type: "error";
  agentId: string;
  sessionId: string;
  message: string;
}

export type RelayOutgoing = RelayRegisterMsg | RelayResponseMsg | RelayErrorMsg;
