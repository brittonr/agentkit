# iroh-rpc

P2P RPC daemon for AI agent swarms using [iroh](https://iroh.computer) QUIC
networking and the [irpc](https://docs.rs/irpc) typed RPC framework.

## Overview

`iroh-rpc` is a long-lived daemon that:

- Creates an iroh QUIC endpoint with automatic NAT traversal
- Exposes a JSON-RPC interface over stdin/stdout for the pi extension
- Uses `irpc` + `irpc-iroh` for typed, efficient RPC between agents
- Supports direct peer-to-peer messaging with relay fallback

## Protocol

The agent protocol (`agentkit/rpc/1`) is defined using the `irpc` derive macro:

```rust
#[rpc_requests(message = AgentRpcMessage)]
enum AgentProtocol {
    SendMsg(SendMsg)     -> SendMsgResponse,   // oneshot RPC
    GetStatus(GetStatus) -> StatusResponse,     // oneshot RPC
    Subscribe(Subscribe) -> Stream<AgentEvent>, // server streaming
}
```

This gives us type-safe RPC that works both in-process (local) and over the
network (remote) with the same `AgentApi` interface.

## JSON-RPC Commands (stdin)

```json
{"id": "1", "type": "status"}
{"id": "2", "type": "connect", "endpoint_id": "<base32>"}
{"id": "3", "type": "send", "endpoint_id": "<base32>", "message": "hello"}
{"id": "4", "type": "broadcast", "message": "hello everyone"}
{"id": "5", "type": "peers"}
{"id": "6", "type": "shutdown"}
```

## JSON-RPC Responses (stdout)

```json
{"id": "1", "type": "response", "success": true, "data": {"endpoint_id": "...", "relay_url": "...", "peers": 0}}
{"type": "event", "event": "message_received", "data": {"from": "...", "content": "..."}}
```

## Build

```bash
# Nix
nix build .#iroh-rpc

# Cargo (for development)
nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#pkg-config nixpkgs#openssl nixpkgs#gcc -c cargo build
```

## Test

```bash
echo '{"id":"1","type":"status"}
{"id":"2","type":"shutdown"}' | iroh-rpc 2>/dev/null
```

## Dependencies

- [iroh](https://crates.io/crates/iroh) 0.96 — P2P QUIC networking
- [irpc](https://crates.io/crates/irpc) 0.12 — Typed RPC framework
- [irpc-iroh](https://crates.io/crates/irpc-iroh) 0.12 — iroh transport for irpc
