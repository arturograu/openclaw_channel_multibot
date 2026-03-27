# openclaw-askred

OpenClaw channel plugin that connects your agents to the AskRed mobile app.

## Installation

```bash
openclaw plugins install openclaw-askred
```

## Configuration

Add the following to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "askred": {
      "relay": "wss://multibot-relay.fly.dev",
      "agents": [{ "id": "main", "name": "My Assistant" }]
    }
  },
  "agents": {
    "bindings": [
      {
        "channel": "askred",
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
   [askred] pairing code: WOLF-7482
   ```
3. Open AskRed → Add Agent → OpenClaw → enter the code
4. Your agents will appear in the app automatically

## CLI commands

### Generate a new pairing code

```bash
openclaw askred new-pairing-code
```

Invalidates the current pairing code and generates a fresh one. Useful if you need to re-pair the app after a reset.

## How it works

```
AskRed app ←→ wss://multibot-relay.fly.dev ←→ OpenClaw plugin ←→ Your agents
```
