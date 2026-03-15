import { vi } from "vitest";
import type {
  CliCommand,
  CliProgram,
  DispatcherOptions,
  OpenClawConfig,
  PluginContext,
  PluginLogger,
  PluginRuntime,
} from "../src/types.ts";

// ── Logger ──────────────────────────────────────────────────────────────────

export function createMockLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ── Runtime ─────────────────────────────────────────────────────────────────

export function createMockRuntime(overrides?: {
  storePath?: string;
  config?: OpenClawConfig;
}): PluginRuntime {
  const config = overrides?.config ?? {};
  const storePath = overrides?.storePath ?? "/tmp/test-store";

  return {
    config: {
      loadConfig: vi.fn(() => config),
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "test-agent",
          sessionKey: "test-session-key",
        })),
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx) => ctx),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatInboundEnvelope: vi.fn(() => "formatted-body"),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async (params: { dispatcherOptions: DispatcherOptions }) => {
            // By default, do nothing. Tests can override this.
          },
        ),
      },
      session: {
        resolveStorePath: vi.fn(() => storePath),
        readSessionUpdatedAt: vi.fn(() => undefined),
        recordInboundSession: vi.fn(async () => {}),
      },
    },
  };
}

// ── Plugin context ──────────────────────────────────────────────────────────

export function createMockPluginContext(overrides?: {
  config?: OpenClawConfig;
  runtime?: PluginRuntime;
}): PluginContext & {
  registeredChannel: { plugin: unknown } | null;
  registeredService: { id: string; start: () => Promise<void>; stop: () => Promise<void>; healthCheck?: () => { ok: boolean; status: string } } | null;
  registeredCli: { setup: (ctx: { program: CliProgram }) => void; opts: { commands: string[] } } | null;
} {
  const ctx = {
    config: overrides?.config ?? {},
    logger: createMockLogger(),
    runtime: overrides?.runtime ?? createMockRuntime(),
    registeredChannel: null as { plugin: unknown } | null,
    registeredService: null as { id: string; start: () => Promise<void>; stop: () => Promise<void>; healthCheck?: () => { ok: boolean; status: string } } | null,
    registeredCli: null as { setup: (ctx: { program: CliProgram }) => void; opts: { commands: string[] } } | null,
    registerChannel: vi.fn((opts: { plugin: unknown }) => {
      ctx.registeredChannel = opts;
    }),
    registerService: vi.fn((service: unknown) => {
      ctx.registeredService = service as typeof ctx.registeredService;
    }),
    registerCli: vi.fn((setup: (ctx: { program: CliProgram }) => void, opts: { commands: string[] }) => {
      ctx.registeredCli = { setup, opts };
    }),
  };
  return ctx;
}

// ── Mock WebSocket ──────────────────────────────────────────────────────────

export class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError(err?: unknown): void {
    this.onerror?.(err ?? new Error("test error"));
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  get parsedMessages(): unknown[] {
    return this.sentMessages.map((m) => JSON.parse(m));
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static latest(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

// ── Mock CliCommand (commander.js) ──────────────────────────────────────────

export class MockCliCommand implements CliCommand {
  name: string;
  desc = "";
  registeredAction: ((...args: unknown[]) => void | Promise<void>) | null = null;
  subcommands: MockCliCommand[] = [];

  constructor(name: string) {
    this.name = name;
  }

  command(name: string): CliCommand {
    const sub = new MockCliCommand(name);
    this.subcommands.push(sub);
    return sub;
  }

  description(desc: string): CliCommand {
    this.desc = desc;
    return this;
  }

  option(): CliCommand {
    return this;
  }

  argument(): CliCommand {
    return this;
  }

  action(fn: (...args: unknown[]) => void | Promise<void>): CliCommand {
    this.registeredAction = fn;
    return this;
  }
}

export class MockCliProgram implements CliProgram {
  commands: MockCliCommand[] = [];

  command(name: string): CliCommand {
    const cmd = new MockCliCommand(name);
    this.commands.push(cmd);
    return cmd;
  }
}
