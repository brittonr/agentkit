---
name: iroh-rpc
description: P2P agent communication over iroh QUIC networking. Use for connecting agents across machines, sending messages between peers, and distributed agent coordination.
capabilities:
  - execute
---

# Iroh RPC — P2P Agent Communication

Iroh-rpc provides direct peer-to-peer communication between AI agents using
iroh's QUIC networking with automatic NAT traversal and relay fallback.

## Architecture

- **iroh-rpc daemon**: Rust binary using `irpc` + `irpc-iroh` crates
- **iroh-rpc extension**: Pi extension that manages the daemon and exposes LLM tools
- **Protocol**: Custom ALPN `agentkit/rpc/1` with typed RPC messages

## LLM Tools

The extension registers these tools:

### `iroh_status`
Get local endpoint info (endpoint ID, relay URL, peer count, uptime).
The endpoint ID is what other agents use to connect.

### `iroh_connect`
Connect to a remote agent by endpoint ID. Sends a hello handshake.
```
endpoint_id: "abc123..." (base32 endpoint ID string)
```

### `iroh_send`
Send a message to a specific peer.
```
endpoint_id: "abc123..."
message: "Hello from agent A"
```

### `iroh_broadcast`
Send a message to all connected peers.

### `iroh_peers`
List all connected peers.

## Slash Commands

- `/iroh` — Show daemon status
- `/iroh-stop` — Stop the daemon

## Connecting Two Agents

1. Agent A runs `iroh_status` → gets endpoint ID
2. Agent A shares endpoint ID with Agent B (e.g., via file, clipboard, or prompt)
3. Agent B runs `iroh_connect` with Agent A's endpoint ID
4. Both agents can now `iroh_send` messages to each other

## How It Works

- Uses [iroh](https://iroh.computer) for QUIC P2P connectivity
- Uses [irpc](https://docs.rs/irpc) for typed RPC over iroh connections
- Automatic relay server discovery and NAT hole punching
- Persistent identity (key stored at `~/.local/share/iroh-rpc/key`)
- JSON-RPC bridge between the Rust daemon and the TypeScript extension
