# openclaw-channel-multibot

OpenClaw channel plugin that connects your agents to the [Multibot](https://github.com/arturograu/multibot) mobile app.

## Installation

```bash
openclaw plugins install github:arturograu/openclaw_channel_multibot
```

## Configuration

Add the following to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "multibot": {
      "relay": "wss://multibot-relay.fly.dev",
      "agents": [{ "id": "main", "name": "My Assistant" }]
    }
  },
  "agents": {
    "bindings": [
      {
        "channel": "multibot",
        "peerId": "main",
        "agentId": "main"
      }
    ]
  }
}
```

Each entry in `agents` corresponds to one OpenClaw agent you want to expose.
The `peerId` in the binding must match the agent `id`.

## Pairing with the app

1. Start OpenClaw: `openclaw gateway run`
2. Look for the pairing code in the logs:
   ```
   [multibot] pairing code: WOLF-7482
   ```
3. Open Multibot → Add Agent → OpenClaw → enter the code
4. Your agents will appear in the app automatically

## How it works

```
Flutter app ←→ wss://multibot-relay.fly.dev ←→ OpenClaw plugin ←→ Your agents
```
