import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockPluginContext, createMockRuntime, MockWebSocket, MockCliProgram } from "./helpers.ts";
import type { ChannelPlugin, DispatcherOptions, OpenClawConfig, ReplyPayload, Service } from "../src/types.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// We need to mock fs and the RelayConnection before importing register.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Mock RelayConnection to avoid real WebSocket usage.
const mockRelay = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  healthCheck: vi.fn(() => ({ ok: true, status: "connected" })),
  sendChunk: vi.fn(),
  sendResponse: vi.fn(),
  sendError: vi.fn(),
  requestNewCode: vi.fn(),
  code: "TEST",
};

vi.mock("../src/relay.ts", () => {
  const MockRelayConnection = vi.fn(function (this: unknown) {
    Object.assign(this as object, mockRelay);
  });
  return { RelayConnection: MockRelayConnection };
});

import register from "../src/index.ts";
import { RelayConnection } from "../src/relay.ts";

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  MockWebSocket.reset();
});

// ── Agent resolution ────────────────────────────────────────────────────────

describe("register — agent resolution", () => {
  it("uses agents from channel config when provided", () => {
    const api = createMockPluginContext({
      config: {
        channels: {
          multibot: {
            relay: "wss://custom-relay.example.com",
            agents: [{ id: "custom", name: "Custom Agent" }],
          },
        },
      },
    });

    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    expect(relayOpts.agents).toEqual([{ id: "custom", name: "Custom Agent" }]);
    expect(relayOpts.relayUrl).toBe("wss://custom-relay.example.com");
  });

  it("falls back to gateway agent list", () => {
    const api = createMockPluginContext({
      config: {
        agents: { list: [{ id: "gw-agent" }] },
      },
    });

    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    expect(relayOpts.agents).toEqual([{ id: "gw-agent", name: "gw-agent" }]);
  });

  it("defaults to 'main' agent when nothing is configured", () => {
    const api = createMockPluginContext();
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    expect(relayOpts.agents).toEqual([{ id: "main", name: "Main" }]);
  });

  it("uses default relay URL when not configured", () => {
    const api = createMockPluginContext();
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    expect(relayOpts.relayUrl).toBe("wss://multibot-relay.fly.dev");
  });
});

// ── Token persistence ───────────────────────────────────────────────────────

describe("register — token persistence", () => {
  it("loads token from disk when file exists", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ token: "disk-token" }));

    const api = createMockPluginContext();
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    expect(relayOpts.initialToken).toBe("disk-token");
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("loaded persisted relay token"),
    );
  });

  it("passes undefined when no token file exists", () => {
    mockedFs.existsSync.mockReturnValue(false);

    const api = createMockPluginContext();
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    expect(relayOpts.initialToken).toBeUndefined();
  });

  it("saves token when relay issues a new one", () => {
    mockedFs.existsSync.mockReturnValue(false);

    const api = createMockPluginContext();
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    relayOpts.onTokenChanged?.("new-relay-token");

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("multibot-relay-token.json"),
      JSON.stringify({ token: "new-relay-token" }),
    );
  });

  it("creates directory when saving token if it does not exist", () => {
    mockedFs.existsSync.mockReturnValue(false);

    const api = createMockPluginContext();
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    relayOpts.onTokenChanged?.("tok");

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true },
    );
  });

  it("handles corrupt token file gracefully", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("not json");

    const api = createMockPluginContext();
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    expect(relayOpts.initialToken).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to load relay token"),
    );
  });

  it("handles token save failure gracefully", () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.writeFileSync.mockImplementation(() => {
      throw new Error("disk full");
    });

    const api = createMockPluginContext();
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    // Should not throw
    relayOpts.onTokenChanged?.("tok");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to save relay token"),
    );
  });
});

// ── Channel plugin registration ─────────────────────────────────────────────

describe("register — channel plugin", () => {
  it("registers a channel plugin with correct metadata", () => {
    const api = createMockPluginContext();
    register(api);

    expect(api.registerChannel).toHaveBeenCalled();
    const plugin = api.registeredChannel!.plugin as ChannelPlugin;
    expect(plugin.id).toBe("multibot");
    expect(plugin.meta.label).toBe("Multibot");
    expect(plugin.capabilities.chatTypes).toEqual(["direct"]);
    expect(plugin.outbound.deliveryMode).toBe("direct");
  });

  it("listAccountIds returns multibot", () => {
    const api = createMockPluginContext();
    register(api);

    const plugin = api.registeredChannel!.plugin as ChannelPlugin;
    expect(plugin.config.listAccountIds({})).toEqual(["multibot"]);
  });

  it("resolveAccount returns provided accountId", () => {
    const api = createMockPluginContext();
    register(api);

    const plugin = api.registeredChannel!.plugin as ChannelPlugin;
    expect(plugin.config.resolveAccount({}, "custom")).toEqual({
      accountId: "custom",
    });
  });

  it("resolveAccount defaults to multibot", () => {
    const api = createMockPluginContext();
    register(api);

    const plugin = api.registeredChannel!.plugin as ChannelPlugin;
    expect(plugin.config.resolveAccount({})).toEqual({
      accountId: "multibot",
    });
  });
});

// ── Outbound sendText ───────────────────────────────────────────────────────

describe("register — outbound sendText", () => {
  it("sends response for valid chatId", async () => {
    const api = createMockPluginContext();
    register(api);

    const plugin = api.registeredChannel!.plugin as ChannelPlugin;
    const result = await plugin.outbound.sendText({
      text: "hello",
      to: "agent-1::session-1",
      accountId: "multibot",
      sessionKey: "key",
    });

    expect(result).toEqual({ ok: true });
    expect(mockRelay.sendResponse).toHaveBeenCalledWith(
      "agent-1",
      "session-1",
      "hello",
      undefined,
    );
  });

  it("returns error for malformed chatId", async () => {
    const api = createMockPluginContext();
    register(api);

    const plugin = api.registeredChannel!.plugin as ChannelPlugin;
    const result = await plugin.outbound.sendText({
      text: "hello",
      to: "no-separator",
      accountId: "multibot",
      sessionKey: "key",
    });

    expect(result).toEqual({ ok: false, error: "malformed chatId" });
  });

  it("extracts MEDIA: reference from text", async () => {
    mockedFs.readFileSync.mockReturnValue(Buffer.from("audio-data"));

    const api = createMockPluginContext();
    register(api);

    const plugin = api.registeredChannel!.plugin as ChannelPlugin;
    await plugin.outbound.sendText({
      text: "Here is audio MEDIA:/tmp/audio.mp3 enjoy",
      to: "agent-1::session-1",
      accountId: "multibot",
      sessionKey: "key",
    });

    expect(mockRelay.sendResponse).toHaveBeenCalledWith(
      "agent-1",
      "session-1",
      "Here is audio  enjoy",
      expect.objectContaining({ mimeType: "audio/mpeg" }),
    );
  });
});

// ── Service registration ────────────────────────────────────────────────────

describe("register — service", () => {
  it("registers service with correct id", () => {
    const api = createMockPluginContext();
    register(api);

    expect(api.registerService).toHaveBeenCalled();
    expect(api.registeredService!.id).toBe("multibot");
  });

  it("service start calls relay.start", async () => {
    const api = createMockPluginContext();
    register(api);

    await api.registeredService!.start();
    expect(mockRelay.start).toHaveBeenCalled();
  });

  it("service stop calls relay.stop", async () => {
    const api = createMockPluginContext();
    register(api);

    await api.registeredService!.stop();
    expect(mockRelay.stop).toHaveBeenCalled();
  });

  it("service healthCheck delegates to relay", () => {
    const api = createMockPluginContext();
    register(api);

    const result = api.registeredService!.healthCheck!();
    expect(result).toEqual({ ok: true, status: "connected" });
  });
});

// ── CLI registration ────────────────────────────────────────────────────────

describe("register — CLI", () => {
  it("registers multibot CLI command", () => {
    const api = createMockPluginContext();
    register(api);

    expect(api.registerCli).toHaveBeenCalled();
    expect(api.registeredCli!.opts.commands).toEqual(["multibot"]);
  });

  it("sets up multibot new-pairing-code subcommand", () => {
    const api = createMockPluginContext();
    register(api);

    const program = new MockCliProgram();
    api.registeredCli!.setup({ program });

    const multibotCmd = program.commands.find((c) => c.name === "multibot");
    expect(multibotCmd).toBeDefined();
    const newCodeCmd = multibotCmd!.subcommands.find(
      (c) => c.name === "new-pairing-code",
    );
    expect(newCodeCmd).toBeDefined();
    expect(newCodeCmd!.registeredAction).toBeInstanceOf(Function);
  });
});

// ── CLI action ──────────────────────────────────────────────────────────────

describe("register — CLI new-pairing-code action", () => {
  let originalWebSocket: typeof WebSocket;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    originalExit = process.exit;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    process.exit = originalExit;
  });

  function getCliAction(api: ReturnType<typeof createMockPluginContext>) {
    const program = new MockCliProgram();
    api.registeredCli!.setup({ program });
    const multibotCmd = program.commands.find((c) => c.name === "multibot")!;
    const newCodeCmd = multibotCmd.subcommands.find((c) => c.name === "new-pairing-code")!;
    return newCodeCmd.registeredAction!;
  }

  it("exits with error when no token is found", async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const api = createMockPluginContext();
    register(api);
    const action = getCliAction(api);

    // process.exit is mocked (no-op), so the action continues to WebSocket.
    // We need to close the WS to let the action promise resolve.
    const actionPromise = action();
    const ws = MockWebSocket.latest();
    ws.simulateClose();

    await actionPromise;
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("connects to relay and requests new code on reconnect", async () => {
    // First call: existsSync for token load during register = false
    // Then during CLI action: existsSync for token = true
    let callCount = 0;
    mockedFs.existsSync.mockImplementation(() => {
      callCount++;
      return callCount > 1; // false for register, true for CLI action
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ token: "cli-token" }));

    const api = createMockPluginContext();
    register(api);
    const action = getCliAction(api);

    // Run action but don't await — it will block on the WebSocket promise
    const actionPromise = action();

    // Get the CLI's WebSocket and simulate the flow
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    // First code message = reconnect restored session
    ws.simulateMessage({ type: "code", code: "OLD-CODE", token: "t" });

    // The action should have sent new-code request
    expect(ws.parsedMessages).toContainEqual({ type: "reconnect", token: "cli-token" });
    expect(ws.parsedMessages).toContainEqual({ type: "new-code" });

    // Second code message = the new pairing code
    ws.simulateMessage({ type: "code", code: "FRESH-CODE" });

    await actionPromise;
  });

  it("exits on relay error message", async () => {
    let callCount = 0;
    mockedFs.existsSync.mockImplementation(() => {
      callCount++;
      return callCount > 1;
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ token: "tok" }));

    const api = createMockPluginContext();
    register(api);
    const action = getCliAction(api);

    const actionPromise = action();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ type: "error", message: "bad token" });

    await actionPromise;
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits on timeout when relay does not respond", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    mockedFs.existsSync.mockImplementation(() => {
      callCount++;
      return callCount > 1;
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ token: "tok" }));

    const api = createMockPluginContext();
    register(api);
    const action = getCliAction(api);

    const actionPromise = action();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    // Advance past the 15s timeout
    vi.advanceTimersByTime(16_000);

    await actionPromise;
    expect(process.exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });

  it("exits on WebSocket error", async () => {
    let callCount = 0;
    mockedFs.existsSync.mockImplementation(() => {
      callCount++;
      return callCount > 1;
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ token: "tok" }));

    const api = createMockPluginContext();
    register(api);
    const action = getCliAction(api);

    const actionPromise = action();
    const ws = MockWebSocket.latest();
    ws.simulateError();
    ws.simulateClose();

    await actionPromise;
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ── Inbound dispatch ────────────────────────────────────────────────────────

describe("register — inbound handling", () => {
  it("dispatches inbound message through runtime pipeline", async () => {
    const runtime = createMockRuntime();

    // Make dispatchReply call deliver with text
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
      .mockImplementation(async (params: { dispatcherOptions: DispatcherOptions }) => {
        await params.dispatcherOptions.deliver({ text: "reply text" });
      });

    const api = createMockPluginContext({ runtime });
    register(api);

    // Get the onInbound handler from RelayConnection constructor
    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: {
        accountId: "multibot",
        channelId: "multibot",
        peerId: "agent-1",
        peerType: "user" as const,
      },
      text: "hello",
      senderId: "sess-1",
      senderName: "User",
      recipientId: "agent-1",
      chatId: "agent-1::sess-1",
      chatType: "direct" as const,
      timestamp: 1000,
      messageId: "msg-1",
    });

    expect(runtime.channel.routing.resolveAgentRoute).toHaveBeenCalled();
    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    expect(mockRelay.sendChunk).toHaveBeenCalledWith(
      "agent-1", "sess-1", "reply text", undefined,
    );
    expect(mockRelay.sendResponse).toHaveBeenCalledWith(
      "agent-1", "sess-1", "reply text", undefined,
    );
  });

  it("sends error when dispatch fails", async () => {
    const runtime = createMockRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
      .mockRejectedValue(new Error("dispatch boom"));

    const api = createMockPluginContext({ runtime });
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: {
        accountId: "multibot",
        channelId: "multibot",
        peerId: "agent-1",
        peerType: "user" as const,
      },
      text: "hello",
      senderId: "sess-1",
      recipientId: "agent-1",
      chatId: "agent-1::sess-1",
      chatType: "direct" as const,
      timestamp: 1000,
      messageId: "msg-1",
    });

    expect(mockRelay.sendError).toHaveBeenCalledWith(
      "agent-1", "sess-1", "dispatch boom",
    );
  });

  it("extracts audio from mediaUrls array in deliver payload", async () => {
    mockedFs.readFileSync.mockReturnValue(Buffer.from("audio-bytes"));

    const runtime = createMockRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
      .mockImplementation(async (params: { dispatcherOptions: DispatcherOptions }) => {
        await params.dispatcherOptions.deliver({
          text: "with audio",
          mediaUrls: ["/tmp/voice.mp3"],
        });
      });

    const api = createMockPluginContext({ runtime });
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: { accountId: "multibot", channelId: "multibot", peerId: "a", peerType: "user" as const },
      text: "hi", senderId: "s", recipientId: "a",
      chatId: "a::s", chatType: "direct" as const, timestamp: 1, messageId: "m",
    });

    expect(mockRelay.sendChunk).toHaveBeenCalledWith(
      "a", "s", "with audio",
      expect.objectContaining({ mimeType: "audio/mpeg" }),
    );
  });

  it("extracts audio from mediaUrl string in deliver payload", async () => {
    mockedFs.readFileSync.mockReturnValue(Buffer.from("wav-bytes"));

    const runtime = createMockRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
      .mockImplementation(async (params: { dispatcherOptions: DispatcherOptions }) => {
        await params.dispatcherOptions.deliver({
          text: "audio",
          mediaUrl: "/tmp/voice.wav",
        });
      });

    const api = createMockPluginContext({ runtime });
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: { accountId: "multibot", channelId: "multibot", peerId: "a", peerType: "user" as const },
      text: "hi", senderId: "s", recipientId: "a",
      chatId: "a::s", chatType: "direct" as const, timestamp: 1, messageId: "m",
    });

    expect(mockRelay.sendChunk).toHaveBeenCalledWith(
      "a", "s", "audio",
      expect.objectContaining({ mimeType: "audio/wav" }),
    );
  });

  it("extracts audio from MEDIA: reference in deliver text", async () => {
    mockedFs.readFileSync.mockReturnValue(Buffer.from("ogg-bytes"));

    const runtime = createMockRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
      .mockImplementation(async (params: { dispatcherOptions: DispatcherOptions }) => {
        await params.dispatcherOptions.deliver({
          text: "Listen here MEDIA:/tmp/clip.ogg done",
        });
      });

    const api = createMockPluginContext({ runtime });
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: { accountId: "multibot", channelId: "multibot", peerId: "a", peerType: "user" as const },
      text: "hi", senderId: "s", recipientId: "a",
      chatId: "a::s", chatType: "direct" as const, timestamp: 1, messageId: "m",
    });

    expect(mockRelay.sendChunk).toHaveBeenCalledWith(
      "a", "s", "Listen here  done",
      expect.objectContaining({ mimeType: "audio/ogg" }),
    );
  });

  it("skips deliver when payload has no text and no audio", async () => {
    const runtime = createMockRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
      .mockImplementation(async (params: { dispatcherOptions: DispatcherOptions }) => {
        await params.dispatcherOptions.deliver({ text: "" });
      });

    const api = createMockPluginContext({ runtime });
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: { accountId: "multibot", channelId: "multibot", peerId: "a", peerType: "user" as const },
      text: "hi", senderId: "s", recipientId: "a",
      chatId: "a::s", chatType: "direct" as const, timestamp: 1, messageId: "m",
    });

    expect(mockRelay.sendChunk).not.toHaveBeenCalled();
  });

  it("handles onError in dispatcher options", async () => {
    const runtime = createMockRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
      .mockImplementation(async (params: { dispatcherOptions: DispatcherOptions }) => {
        params.dispatcherOptions.onError?.(new Error("reply error"));
      });

    const api = createMockPluginContext({ runtime });
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: { accountId: "multibot", channelId: "multibot", peerId: "a", peerType: "user" as const },
      text: "hi", senderId: "s", recipientId: "a",
      chatId: "a::s", chatType: "direct" as const, timestamp: 1, messageId: "m",
    });

    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("reply error"),
    );
    expect(mockRelay.sendError).toHaveBeenCalledWith("a", "s", "reply error");
  });

  it("handles failed media file read gracefully", async () => {
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error("file not found");
    });

    const runtime = createMockRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
      .mockImplementation(async (params: { dispatcherOptions: DispatcherOptions }) => {
        await params.dispatcherOptions.deliver({
          text: "audio",
          mediaUrl: "/nonexistent/file.mp3",
        });
      });

    const api = createMockPluginContext({ runtime });
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: { accountId: "multibot", channelId: "multibot", peerId: "a", peerType: "user" as const },
      text: "hi", senderId: "s", recipientId: "a",
      chatId: "a::s", chatType: "direct" as const, timestamp: 1, messageId: "m",
    });

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to read media file"),
    );
    // Should still send the text chunk without audio
    expect(mockRelay.sendChunk).toHaveBeenCalledWith("a", "s", "audio", undefined);
  });

  it("calls onRecordError when session recording fails", async () => {
    const runtime = createMockRuntime();
    vi.mocked(runtime.channel.session.recordInboundSession)
      .mockImplementation(async (params: { onRecordError?: (err: unknown) => void }) => {
        params.onRecordError?.(new Error("session write failed"));
      });

    const api = createMockPluginContext({ runtime });
    register(api);

    const relayOpts = vi.mocked(RelayConnection).mock.calls[0][0];
    await relayOpts.onInbound({
      envelope: { accountId: "multibot", channelId: "multibot", peerId: "a", peerType: "user" as const },
      text: "hi", senderId: "s", recipientId: "a",
      chatId: "a::s", chatType: "direct" as const, timestamp: 1, messageId: "m",
    });

    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("session record error"),
    );
  });
});

// ── Mime type resolution ────────────────────────────────────────────────────

describe("register — mime type resolution", () => {
  const mimeTests = [
    { ext: ".mp3", expected: "audio/mpeg" },
    { ext: ".wav", expected: "audio/wav" },
    { ext: ".ogg", expected: "audio/ogg" },
    { ext: ".m4a", expected: "audio/mp4" },
    { ext: ".aac", expected: "audio/aac" },
    { ext: ".flac", expected: "audio/flac" },
    { ext: ".webm", expected: "audio/webm" },
    { ext: ".xyz", expected: "audio/mpeg" }, // unknown defaults to mpeg
  ];

  for (const { ext, expected } of mimeTests) {
    it(`resolves ${ext} to ${expected}`, async () => {
      mockedFs.readFileSync.mockReturnValue(Buffer.from("data"));

      const api = createMockPluginContext();
      register(api);

      const plugin = api.registeredChannel!.plugin as ChannelPlugin;
      await plugin.outbound.sendText({
        text: `MEDIA:/tmp/file${ext}`,
        to: "a::s",
        accountId: "multibot",
        sessionKey: "key",
      });

      expect(mockRelay.sendResponse).toHaveBeenCalledWith(
        "a", "s", "",
        expect.objectContaining({ mimeType: expected }),
      );
    });
  }
});
