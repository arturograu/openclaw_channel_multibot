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

      expect(log.info).toHaveBeenCalledWith("[askred] relay connected");
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

      expect(log.debug).toHaveBeenCalledWith("[askred] pairing code: ABCD");
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
        message: "An internal error occurred",
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
        expect.objectContaining({ type: "error", message: "An internal error occurred" }),
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
        "[askred] relay: invalid JSON received",
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

    it("requestNewCode sends new-code message with token", () => {
      const { relay } = createRelay();
      relay.start();
      MockWebSocket.latest().simulateOpen();
      // Simulate receiving a code+token so reconnectToken is set
      MockWebSocket.latest().simulateMessage({
        type: "code",
        code: "TEST-1234",
        token: "relay-token-abc",
      });
      relay.requestNewCode();

      expect(MockWebSocket.latest().parsedMessages).toContainEqual({
        type: "new-code",
        token: "relay-token-abc",
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

  // ── Input validation ──────────────────────────────────────────────────

  describe("input validation", () => {
    it("drops messages exceeding size limit", () => {
      const { relay, log } = createRelay();
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      // Simulate a very large message (>5 MB)
      const largeData = "x".repeat(6 * 1024 * 1024);
      ws.onmessage?.({ data: largeData });

      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("message too large"),
      );
    });

    it("rejects message with missing agentId", () => {
      const onInbound = vi.fn(async () => {});
      const { relay, log } = createRelay({ onInbound });
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      ws.simulateMessage({ type: "message", sessionId: "s", content: "hi" });

      expect(onInbound).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("missing required fields"),
      );
    });

    it("rejects message with missing sessionId", () => {
      const onInbound = vi.fn(async () => {});
      const { relay, log } = createRelay({ onInbound });
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      ws.simulateMessage({ type: "message", agentId: "a", content: "hi" });

      expect(onInbound).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("missing required fields"),
      );
    });

    it("rejects message with empty agentId", () => {
      const onInbound = vi.fn(async () => {});
      const { relay, log } = createRelay({ onInbound });
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      ws.simulateMessage({
        type: "message", agentId: "", sessionId: "s", content: "hi",
      });

      expect(onInbound).not.toHaveBeenCalled();
    });

    it("rejects agentId containing :: delimiter", () => {
      const onInbound = vi.fn(async () => {});
      const { relay, log } = createRelay({ onInbound });
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      ws.simulateMessage({
        type: "message", agentId: "evil::agent", sessionId: "s", content: "hi",
      });

      expect(onInbound).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid delimiter"),
      );
    });

    it("rejects sessionId containing :: delimiter", () => {
      const onInbound = vi.fn(async () => {});
      const { relay, log } = createRelay({ onInbound });
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      ws.simulateMessage({
        type: "message", agentId: "a", sessionId: "s::evil", content: "hi",
      });

      expect(onInbound).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid delimiter"),
      );
    });

    it("rejects code message with missing code field", () => {
      const { relay, log } = createRelay();
      relay.start();
      const ws = MockWebSocket.latest();
      ws.simulateOpen();

      ws.simulateMessage({ type: "code" });

      expect(relay.code).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("code message missing code field"),
      );
    });
  });

  // ── wss:// validation ──────────────────────────────────────────────────

  describe("URL validation", () => {
    it("throws when relay URL uses ws:// instead of wss://", () => {
      expect(() => {
        new RelayConnection({
          relayUrl: "ws://insecure-relay.example.com",
          agents: [{ id: "a", name: "A" }],
          onInbound: vi.fn(async () => {}),
          log: createMockLogger(),
        });
      }).toThrow("relay URL must use wss://");
    });

    it("accepts wss:// URLs", () => {
      expect(() => {
        new RelayConnection({
          relayUrl: "wss://secure-relay.example.com",
          agents: [{ id: "a", name: "A" }],
          onInbound: vi.fn(async () => {}),
          log: createMockLogger(),
        });
      }).not.toThrow();
    });
  });

  // ── Exponential backoff ────────────────────────────────────────────────

  describe("exponential backoff", () => {
    it("doubles delay on consecutive disconnects", () => {
      vi.useFakeTimers();
      const { relay } = createRelay();
      relay.start();

      // First disconnect → reconnect after 5s
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateClose();
      const countAfterFirst = MockWebSocket.instances.length;

      vi.advanceTimersByTime(5_000);
      expect(MockWebSocket.instances.length).toBe(countAfterFirst + 1);

      // Second disconnect → reconnect after 10s (doubled)
      MockWebSocket.latest().simulateClose();
      const countAfterSecond = MockWebSocket.instances.length;

      vi.advanceTimersByTime(5_000);
      // Should NOT have reconnected yet (delay is now 10s)
      expect(MockWebSocket.instances.length).toBe(countAfterSecond);

      vi.advanceTimersByTime(5_000);
      // Now it should have reconnected
      expect(MockWebSocket.instances.length).toBe(countAfterSecond + 1);

      vi.useRealTimers();
    });

    it("resets backoff on successful connection", () => {
      vi.useFakeTimers();
      const { relay } = createRelay();
      relay.start();

      // Trigger a disconnect to increase the delay
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(5_000);

      // Second disconnect (delay would be 10s)
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(10_000);

      // Connect successfully → resets backoff
      MockWebSocket.latest().simulateOpen();
      MockWebSocket.latest().simulateClose();
      const countAfterReset = MockWebSocket.instances.length;

      // Should reconnect after 5s again (reset), not 20s
      vi.advanceTimersByTime(5_000);
      expect(MockWebSocket.instances.length).toBe(countAfterReset + 1);

      vi.useRealTimers();
    });
  });
});
