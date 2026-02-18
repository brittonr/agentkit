---
name: iroh-rpc
description: P2P agent communication over iroh QUIC networking. Use for connecting agents across machines, sending messages between peers, and distributed agent coordination.
capabilities:
  - execute
---

# Iroh RPC — P2P Agent Communication

Iroh-rpc provides direct peer-to-peer communication between AI agents using
iroh's QUIC networking with automatic NAT traversal and relay fallback.

## Peer Configuration

Peers are configured at `~/.pi/agent/peers.json`:

```json
[
  {
    "name": "gpu-box",
    "endpoint_id": "6e824c303f596d2e...",
    "description": "Server with 4x A100 GPUs for ML training",
    "tags": ["gpu", "ml"]
  },
  {
    "name": "prod-monitor",
    "endpoint_id": "8b3f418a76bf5f79...",
    "description": "Production cluster monitoring agent",
    "tags": ["prod", "k8s"]
  }
]
```

Fields:
- `name` — Short name to reference this peer (used in `iroh_send`)
- `endpoint_id` — The peer's iroh endpoint ID (get it from `iroh_status`)
- `description` — What this peer does (injected into system prompt so the model can route)
- `tags` — Optional categorization tags

## LLM Tools

### `iroh_status`
Get local endpoint info and list known peers.

### `iroh_send`
Send a message to a peer **by name** or endpoint ID.
```
peer: "gpu-box"          # matches name from peers.json
message: "Run benchmark on model v3"
```

### `iroh_broadcast`
Send a message to all connected peers.

### `iroh_peers`
List known peers with connection status.

### `iroh_share`
Share files or inline data as content-addressed blobs over P2P.
Returns a blob ticket to include in messages.
```
files: ["/path/to/schema.ts", "/path/to/routes.ts"]   # share files
data: "inline text context to share"                    # or share text
```

### `iroh_fetch`
Download a blob by ticket (from `iroh_share` output or received in a message).
```
ticket: "blobaaebcgba..."    # blob ticket string
save_to: "/tmp/fetched.txt"  # optional, save to file
```

### `iroh_inbox`
Read messages received from remote peers.
```
limit: 20     # optional, max messages
clear: true   # optional, clear after reading
```

## Slash Commands

- `/iroh` — Show daemon status, known peers, and recent inbox
- `/iroh-stop` — Stop the daemon

## Sharing Context with Blobs

To send a task with file context to a peer:

1. `iroh_share(files: ["src/schema.ts", "src/routes.ts"])` → gets tickets
2. `iroh_send(peer: "bob", message: '{"task": "review these", "context": "blobaaeb..."}')`
3. Bob's agent receives the message, sees the ticket, calls `iroh_fetch(ticket: "blobaaeb...")`
4. Bob now has the full file contents over P2P QUIC

Blobs are content-addressed (BLAKE3 hashed) — if Bob already has the
content, it won't transfer again.

## How It Works

1. Peers are loaded from `~/.pi/agent/peers.json`
2. Peer names and descriptions are injected into the system prompt
3. The model decides which peer to message based on the task
4. `iroh_send` resolves the name → endpoint ID and sends via iroh QUIC
5. `iroh_share` adds files to the blob store and creates tickets
6. `iroh_fetch` downloads blobs from tickets received in messages
7. Incoming messages appear in the conversation automatically
8. The iroh daemon starts lazily on first tool use

## Getting a Peer's Endpoint ID

On the remote machine, run:
```bash
echo '{"id":"1","type":"status"}' | iroh-rpc 2>/dev/null | jq -r '.data.endpoint_id'
```

Or from a pi session, use the `iroh_status` tool.

## Architecture

- **iroh-rpc daemon** (Rust) — uses `irpc` + `irpc-iroh` for typed RPC over iroh QUIC
- **iroh-rpc extension** (TypeScript) — manages daemon, discovers peers, registers tools
- **Protocol**: `agentkit/rpc/1` ALPN with `SendMsg`, `GetStatus`, `Subscribe` RPC methods
- **Identity**: Persistent key at `~/.local/share/iroh-rpc/key`
