import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelayConnection } from "../src/relay.ts";
import type { PluginLogger } from "../src/types.ts";
import { MockWebSocket, createMockLogger } from "./helpers.ts";

// Replace global WebSocket with our mock.
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.reset();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
});

afterEach(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
});

function createRelay(overrides?: {
  log?: PluginLogger;
  initialToken?: string;
  onTokenChanged?: (token: string) => void;
  onInbound?: (ctx: unknown) => Promise<void>;
}) {
  const log = overrides?.log ?? createMockLogger();
  return {
    relay: new RelayConnection({
      relayUrl: "wss://test-relay.example.com",
      agents: [{ id: "agent-1", name: "Agent One" }],
      onInbound: overrides?.onInbound ?? vi.fn(async () => {}),
      log,
      initialToken: overrides?.initialToken,
      onTokenChanged: overrides?.onTokenChanged,
    }),
    log,
  };
}

// ── Construction & start ────────────────────────────────────────────────────

describe("RelayConnection", () => {
  describe("start", () => {
    it("connects to the relay /plugin endpoint", () => {
      const { relay } = createRelay();
      relay.start(); // don't await — it resolves on stop()

      const ws = MockWebSocket.latest();
      expect(ws.url).toBe("wss://test-relay.example.com/plugin");
    });

    it("logs the connection URL", () => {
      const { relay, log } = createRelay();
      relay.start();

      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("connecting to relay"),
      );
    });

    it("resolves when stop is called", async () => {
      const { relay } = createRelay();
      const startPromise = relay.start();
      await relay.stop();
      await expect(startPromise).resolves.toBeUndefined();
    });
  });

  // ── Stop ────────────────────────────────────────────────────────────────

  describe("stop", () => {
    it("closes the WebSocket", async () => {
      const { relay } = createRelay();
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      await relay.stop();
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it("does not reconnect after stop", async () => {
      vi.useFakeTimers();
      const { relay } = createRelay();
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      await relay.stop();
      const countBefore = MockWebSocket.instances.length;
      vi.advanceTimersByTime(10_000);
      expect(MockWebSocket.instances.length).toBe(countBefore);
      vi.useRealTimers();
    });
  });

  // ── Health check ──────────────────────────────────────────────────────

  describe("healthCheck", () => {
    it("returns stopped when stopped", async () => {
      const { relay } = createRelay();
      relay.start();
      await relay.stop();

      expect(relay.healthCheck()).toEqual({ ok: false, status: "stopped" });
    });

    it("returns connected when WebSocket is open", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();

      expect(relay.healthCheck()).toEqual({ ok: true, status: "connected" });
    });

    it("returns reconnecting when WebSocket is not open", () => {
      const { relay } = createRelay();
      relay.start();
      // Don't call simulateOpen — ws exists but is not OPEN in mock default
      // Actually, our mock sets readyState to OPEN by default. Let's close it.
      MockWebSocket.latest().readyState = MockWebSocket.CLOSED;

      expect(relay.healthCheck()).toEqual({ ok: true, status: "reconnecting" });
    });
  });

  // ── onopen ────────────────────────────────────────────────────────────

  describe("on connection open", () => {
    it("logs connected", () => {
      const { relay, log } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();

      expect(log.info).toHaveBeenCalledWith("[multibot] relay connected");
    });

    it("sends reconnect message when token exists", () => {
      const { relay } = createRelay({ initialToken: "saved-token" });
      relay.start();
      MockWebSocket.latest().simulateOpen();

      const messages = MockWebSocket.latest().parsedMessages;
      expect(messages).toContainEqual({
        type: "reconnect",
        token: "saved-token",
      });
    });

    it("does not send reconnect when no token", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();

      const messages = MockWebSocket.latest().parsedMessages;
      const reconnects = messages.filter(
        (m: unknown) => (m as { type: string }).type === "reconnect",
      );
      expect(reconnects).toHaveLength(0);
    });

    it("starts sending pings", () => {
      vi.useFakeTimers();
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();

      vi.advanceTimersByTime(30_000);
      const pings = MockWebSocket.latest()
        .parsedMessages.filter(
          (m: unknown) => (m as { type: string }).type === "ping",
        );
      expect(pings.length).toBeGreaterThanOrEqual(1);
      vi.useRealTimers();
    });
  });

  // ── Code message ──────────────────────────────────────────────────────

  describe("code message", () => {
    it("stores the pairing code", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateMessage({ type: "code", code: "ABCD" });

      expect(relay.code).toBe("ABCD");
    });

    it("logs the pairing code", () => {
      const { relay, log } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateMessage({ type: "code", code: "ABCD" });

      expect(log.info).toHaveBeenCalledWith("[multibot] pairing code: ABCD");
    });

    it("sends register with agents after receiving code", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateMessage({ type: "code", code: "ABCD" });

      const messages = MockWebSocket.latest().parsedMessages;
      expect(messages).toContainEqual({
        type: "register",
        agents: [{ id: "agent-1", name: "Agent One" }],
      });
    });

    it("persists token via onTokenChanged callback", () => {
      const onTokenChanged = vi.fn();
      const { relay } = createRelay({ onTokenChanged });
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateMessage({
        type: "code",
        code: "ABCD",
        token: "new-token",
      });

      expect(onTokenChanged).toHaveBeenCalledWith("new-token");
    });

    it("does not call onTokenChanged when code has no token", () => {
      const onTokenChanged = vi.fn();
      const { relay } = createRelay({ onTokenChanged });
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateMessage({ type: "code", code: "ABCD" });

      expect(onTokenChanged).not.toHaveBeenCalled();
    });
  });

  // ── Inbound message ───────────────────────────────────────────────────

  describe("inbound message", () => {
    it("builds InboundContext and calls onInbound", async () => {
      const onInbound = vi.fn(async () => {});
      const { relay } = createRelay({ onInbound });
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateMessage({
        type: "message",
        agentId: "agent-1",
        sessionId: "sess-1",
        content: "hello",
      });

      // onInbound is called asynchronously
      await vi.waitFor(() => expect(onInbound).toHaveBeenCalled());
      const ctx = onInbound.mock.calls[0][0];
      expect(ctx.chatId).toBe("agent-1::sess-1");
      expect(ctx.text).toBe("hello");
      expect(ctx.envelope.peerId).toBe("agent-1");
      expect(ctx.senderId).toBe("sess-1");
      expect(ctx.chatType).toBe("direct");
    });

    it("sends error when onInbound throws", async () => {
      const onInbound = vi.fn(async () => {
        throw new Error("handler failed");
      });
      const { relay, log } = createRelay({ onInbound });
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateMessage({
        type: "message",
        agentId: "agent-1",
        sessionId: "sess-1",
        content: "hello",
      });

      await vi.waitFor(() => expect(log.error).toHaveBeenCalled());
      const messages = MockWebSocket.latest().parsedMessages;
      expect(messages).toContainEqual({
        type: "error",
        agentId: "agent-1",
        sessionId: "sess-1",
        message: "handler failed",
      });
    });

    it("handles non-Error throws", async () => {
      const onInbound = vi.fn(async () => {
        throw "string error";
      });
      const { relay, log } = createRelay({ onInbound });
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateMessage({
        type: "message",
        agentId: "agent-1",
        sessionId: "sess-1",
        content: "hello",
      });

      await vi.waitFor(() => expect(log.error).toHaveBeenCalled());
      const messages = MockWebSocket.latest().parsedMessages;
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "error", message: "string error" }),
      );
    });
  });

  // ── Invalid JSON ──────────────────────────────────────────────────────

  describe("invalid JSON", () => {
    it("logs warning and does not crash", () => {
      const { relay, log } = createRelay();
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();
      ws.onmessage?.({ data: "not json{{{" });

      expect(log.warn).toHaveBeenCalledWith(
        "[multibot] relay: invalid JSON received",
      );
    });
  });

  // ── Send methods ──────────────────────────────────────────────────────

  describe("send methods", () => {
    it("sendChunk sends chunk message", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      relay.sendChunk("a", "s", "content");

      expect(MockWebSocket.latest().parsedMessages).toContainEqual({
        type: "chunk",
        agentId: "a",
        sessionId: "s",
        content: "content",
      });
    });

    it("sendChunk includes audio when provided", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      const audio = { data: "base64data", mimeType: "audio/mpeg" };
      relay.sendChunk("a", "s", "content", audio);

      expect(MockWebSocket.latest().parsedMessages).toContainEqual({
        type: "chunk",
        agentId: "a",
        sessionId: "s",
        content: "content",
        audio,
      });
    });

    it("sendResponse sends response message", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      relay.sendResponse("a", "s", "done");

      expect(MockWebSocket.latest().parsedMessages).toContainEqual({
        type: "response",
        agentId: "a",
        sessionId: "s",
        content: "done",
      });
    });

    it("sendResponse includes audio when provided", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      const audio = { data: "base64data", mimeType: "audio/wav" };
      relay.sendResponse("a", "s", "done", audio);

      expect(MockWebSocket.latest().parsedMessages).toContainEqual({
        type: "response",
        agentId: "a",
        sessionId: "s",
        content: "done",
        audio,
      });
    });

    it("sendError sends error message", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      relay.sendError("a", "s", "something broke");

      expect(MockWebSocket.latest().parsedMessages).toContainEqual({
        type: "error",
        agentId: "a",
        sessionId: "s",
        message: "something broke",
      });
    });

    it("requestNewCode sends new-code message", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      relay.requestNewCode();

      expect(MockWebSocket.latest().parsedMessages).toContainEqual({
        type: "new-code",
      });
    });

    it("does not send when WebSocket is not open", () => {
      const { relay } = createRelay();
      relay.start();
      const ws = MockWebSocket.latest();
      ws.readyState = MockWebSocket.CLOSED;

      relay.sendChunk("a", "s", "data");
      expect(ws.sentMessages).toHaveLength(0);
    });
  });

  // ── Reconnection ──────────────────────────────────────────────────────

  describe("reconnection", () => {
    it("reconnects after unexpected close", () => {
      vi.useFakeTimers();
      const { relay } = createRelay();
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      ws.simulateClose();
      const countAfterClose = MockWebSocket.instances.length;

      vi.advanceTimersByTime(5_000);
      expect(MockWebSocket.instances.length).toBe(countAfterClose + 1);
      vi.useRealTimers();
    });

    it("ignores close from stale WebSocket after restart", () => {
      vi.useFakeTimers();
      const { relay } = createRelay();
      relay.start();
      const firstWs = MockWebSocket.latest();
      firstWs.simulateOpen();

      // Simulate a reconnect that creates a new WebSocket
      firstWs.simulateClose();
      vi.advanceTimersByTime(5_000);

      // Now the old ws fires close again — should be ignored
      const countBefore = MockWebSocket.instances.length;
      firstWs.onclose?.();
      vi.advanceTimersByTime(5_000);
      // Should not create yet another connection
      expect(MockWebSocket.instances.length).toBe(countBefore);
      vi.useRealTimers();
    });
  });

  // ── Error handling ────────────────────────────────────────────────────

  describe("WebSocket error", () => {
    it("logs the error", () => {
      const { relay, log } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateError("connection failed");

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("relay error"),
      );
    });
  });

  // ── Code getter ───────────────────────────────────────────────────────

  describe("code getter", () => {
    it("returns null before any code is received", () => {
      const { relay } = createRelay();
      expect(relay.code).toBeNull();
    });
  });
});
