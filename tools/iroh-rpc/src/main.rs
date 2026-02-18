use anyhow::{Context, Result};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use irpc::{
    channel::{mpsc, oneshot},
    rpc::RemoteService,
    rpc_requests, WithChannels,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

// ============================================================================
// Protocol Definition
// ============================================================================

/// A text message sent between agents
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentMessage {
    pub from: String,      // sender's endpoint_id
    pub content: String,   // message content
    pub timestamp: String, // ISO 8601 timestamp
}

/// Request: Send a message to this agent
#[derive(Debug, Serialize, Deserialize)]
pub struct SendMsg {
    pub message: AgentMessage,
}

/// Response: Ack with optional reply
#[derive(Debug, Serialize, Deserialize)]
pub struct SendMsgResponse {
    pub ack: bool,
    pub agent_id: String,
}

/// Request: Get agent status
#[derive(Debug, Serialize, Deserialize)]
pub struct GetStatus;

/// Response: Agent status info
#[derive(Debug, Serialize, Deserialize)]
pub struct StatusResponse {
    pub agent_id: String,
    pub peers: Vec<String>,
    pub uptime_secs: u64,
}

/// Request: Subscribe to events from this agent
#[derive(Debug, Serialize, Deserialize)]
pub struct Subscribe;

/// An event streamed to subscribers
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentEvent {
    pub kind: String,      // "message", "peer_joined", "peer_left"
    pub data: String,      // JSON-encoded event data
    pub timestamp: String,
}

// The protocol definition using irpc derive macro
#[rpc_requests(message = AgentRpcMessage)]
#[derive(Serialize, Deserialize, Debug)]
enum AgentProtocol {
    /// Send a message to this agent, get ack back
    #[rpc(tx = oneshot::Sender<SendMsgResponse>)]
    SendMsg(SendMsg),

    /// Get agent status
    #[rpc(tx = oneshot::Sender<StatusResponse>)]
    GetStatus(GetStatus),

    /// Subscribe to agent events (server streaming)
    #[rpc(tx = mpsc::Sender<AgentEvent>)]
    Subscribe(Subscribe),
}

// ============================================================================
// Agent State
// ============================================================================

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct PeerInfo {
    endpoint_id: String,
    connected_at: String,
}

pub struct AgentState {
    endpoint_id: String,
    peers: Mutex<HashMap<String, PeerInfo>>,
    subscribers: Mutex<Vec<mpsc::Sender<AgentEvent>>>,
    start_time: std::time::Instant,
}

impl AgentState {
    fn new(endpoint_id: String) -> Arc<Self> {
        Arc::new(Self {
            endpoint_id,
            peers: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            start_time: std::time::Instant::now(),
        })
    }

    async fn add_peer(&self, endpoint_id: &str) {
        let mut peers = self.peers.lock().await;
        if !peers.contains_key(endpoint_id) {
            let peer_info = PeerInfo {
                endpoint_id: endpoint_id.to_string(),
                connected_at: chrono::Utc::now().to_rfc3339(),
            };
            peers.insert(endpoint_id.to_string(), peer_info.clone());

            // Emit peer_joined event
            self.emit_event("peer_joined", serde_json::json!({
                "endpoint_id": endpoint_id,
                "timestamp": peer_info.connected_at,
            }))
            .await;
        }
    }

    async fn peer_ids(&self) -> Vec<String> {
        self.peers.lock().await.keys().cloned().collect()
    }

    async fn emit_event(&self, kind: &str, data: serde_json::Value) {
        let event = AgentEvent {
            kind: kind.to_string(),
            data: data.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        // Emit to stdout for JSON-RPC bridge
        emit_json(&serde_json::json!({
            "type": "event",
            "event": kind,
            "data": data,
            "timestamp": event.timestamp,
        }));

        // Also send to subscribers
        let subscribers = self.subscribers.lock().await;
        for tx in subscribers.iter() {
            let tx = tx.clone();
            let event = event.clone();
            tokio::spawn(async move {
                let _ = tx.send(event).await;
            });
        }
    }
}

// ============================================================================
// Agent Actor
// ============================================================================

struct AgentActor {
    recv: tokio::sync::mpsc::Receiver<AgentRpcMessage>,
    state: Arc<AgentState>,
}

impl AgentActor {
    async fn run(mut self) {
        info!("AgentActor started");
        while let Some(msg) = self.recv.recv().await {
            match msg {
                AgentRpcMessage::SendMsg(msg) => {
                    let WithChannels { inner, tx, .. } = msg;
                    debug!(
                        "Received message from {}: {}",
                        inner.message.from, inner.message.content
                    );

                    // Track peer
                    self.state.add_peer(&inner.message.from).await;

                    // Emit event
                    self.state
                        .emit_event(
                            "message_received",
                            serde_json::json!({
                                "from": inner.message.from,
                                "content": inner.message.content,
                                "timestamp": inner.message.timestamp,
                            }),
                        )
                        .await;

                    // Send ack
                    let response = SendMsgResponse {
                        ack: true,
                        agent_id: self.state.endpoint_id.clone(),
                    };
                    if let Err(e) = tx.send(response).await {
                        warn!("Failed to send ack: {:?}", e);
                    }
                }
                AgentRpcMessage::GetStatus(msg) => {
                    let WithChannels { tx, .. } = msg;
                    let peers = self.state.peer_ids().await;
                    let response = StatusResponse {
                        agent_id: self.state.endpoint_id.clone(),
                        peers,
                        uptime_secs: self.state.start_time.elapsed().as_secs(),
                    };
                    if let Err(e) = tx.send(response).await {
                        warn!("Failed to send status: {:?}", e);
                    }
                }
                AgentRpcMessage::Subscribe(msg) => {
                    let WithChannels { tx, .. } = msg;
                    debug!("New subscriber added");
                    self.state.subscribers.lock().await.push(tx);
                }
            }
        }
        info!("AgentActor stopped");
    }
}

// ============================================================================
// Agent API
// ============================================================================

pub struct AgentApi {
    client: irpc::Client<AgentProtocol>,
    _actor_task: Option<Arc<n0_future::task::AbortOnDropHandle<()>>>,
}

impl AgentApi {
    pub const ALPN: &[u8] = b"agentkit/rpc/1";

    /// Spawn a local agent actor
    pub fn spawn(state: Arc<AgentState>) -> Self {
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        let actor = AgentActor { recv: rx, state };
        let task = n0_future::task::spawn(actor.run());
        AgentApi {
            client: irpc::Client::local(tx),
            _actor_task: Some(Arc::new(n0_future::task::AbortOnDropHandle::new(task))),
        }
    }

    /// Connect to a remote agent
    pub fn connect(endpoint: Endpoint, addr: impl Into<EndpointAddr>) -> Self {
        AgentApi {
            client: irpc_iroh::client(endpoint, addr, Self::ALPN),
            _actor_task: None,
        }
    }

    /// Get the protocol handler for the iroh Router
    pub fn protocol_handler(&self) -> Result<impl iroh::protocol::ProtocolHandler> {
        let local = self
            .client
            .as_local()
            .context("cannot listen on remote")?;
        Ok(irpc_iroh::IrohProtocol::new(
            AgentProtocol::remote_handler(local),
        ))
    }

    /// Send a message to the agent
    pub async fn send_msg(&self, msg: AgentMessage) -> irpc::Result<SendMsgResponse> {
        self.client.rpc(SendMsg { message: msg }).await
    }

    /// Get agent status
    pub async fn get_status(&self) -> irpc::Result<StatusResponse> {
        self.client.rpc(GetStatus).await
    }

    /// Subscribe to events
    pub async fn subscribe(&self) -> irpc::Result<mpsc::Receiver<AgentEvent>> {
        self.client.server_streaming(Subscribe, 64).await
    }
}

// ============================================================================
// JSON-RPC Command Types
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Command {
    #[serde(rename = "status")]
    Status { id: String },
    #[serde(rename = "connect")]
    Connect {
        id: String,
        endpoint_id: String,
    },
    #[serde(rename = "send")]
    Send {
        id: String,
        endpoint_id: String,
        message: String,
    },
    #[serde(rename = "broadcast")]
    Broadcast { id: String, message: String },
    #[serde(rename = "peers")]
    Peers { id: String },
    #[serde(rename = "share_bytes")]
    ShareBytes {
        id: String,
        /// base64-encoded data to share
        data: String,
    },
    #[serde(rename = "share_files")]
    ShareFiles {
        id: String,
        /// list of file paths to share
        paths: Vec<String>,
    },
    #[serde(rename = "fetch")]
    Fetch {
        id: String,
        /// blob ticket string (from share command output)
        ticket: String,
    },
    #[serde(rename = "shutdown")]
    Shutdown { id: String },
}

#[derive(Debug, Serialize)]
struct Response {
    id: String,
    #[serde(rename = "type")]
    type_: String,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ============================================================================
// Helper Functions
// ============================================================================

fn emit_json(value: &impl Serialize) {
    if let Ok(json) = serde_json::to_string(value) {
        println!("{}", json);
    }
}

fn emit_response(
    id: String,
    success: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
) {
    emit_json(&Response {
        id,
        type_: "response".to_string(),
        success,
        data,
        error,
    });
}

fn get_key_path() -> PathBuf {
    let mut path = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("iroh-rpc");
    std::fs::create_dir_all(&path).ok();
    path.push("key");
    path
}

async fn load_or_create_key() -> Result<SecretKey> {
    let key_path = get_key_path();

    if key_path.exists() {
        let key_bytes = tokio::fs::read(&key_path).await?;
        if key_bytes.len() != 32 {
            anyhow::bail!("Invalid key file length");
        }
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&key_bytes);
        let key = SecretKey::from_bytes(&bytes);
        info!("Loaded existing key from {:?}", key_path);
        Ok(key)
    } else {
        let key = SecretKey::generate(&mut rand::rng());
        let key_bytes = key.to_bytes();
        tokio::fs::write(&key_path, &key_bytes).await?;
        info!("Created new key at {:?}", key_path);
        Ok(key)
    }
}

// ============================================================================
// Command Handlers
// ============================================================================

struct CommandContext {
    local_api: AgentApi,
    endpoint: Endpoint,
    state: Arc<AgentState>,
    remote_clients: Arc<Mutex<HashMap<String, AgentApi>>>,
    blobs: iroh_blobs::BlobsProtocol,
}

impl CommandContext {
    async fn get_or_create_client(&self, endpoint_id: &str) -> Result<AgentApi> {
        let mut clients = self.remote_clients.lock().await;
        if let Some(api) = clients.get(endpoint_id) {
            // Return a clone that shares the same client
            return Ok(AgentApi {
                client: api.client.clone(),
                _actor_task: None,
            });
        }

        // Parse endpoint ID
        let peer_id: EndpointId = endpoint_id.parse().context("Invalid endpoint_id")?;
        let addr = EndpointAddr::new(peer_id);

        // Create new client
        let api = AgentApi::connect(self.endpoint.clone(), addr);
        clients.insert(endpoint_id.to_string(), AgentApi {
            client: api.client.clone(),
            _actor_task: None,
        });

        Ok(api)
    }

    async fn handle_status(&self) -> Result<serde_json::Value> {
        let status = self.local_api.get_status().await?;
        let addr = self.endpoint.addr();
        let relay_url = addr
            .relay_urls()
            .next()
            .map(|url| url.to_string())
            .unwrap_or_else(|| "none".to_string());

        Ok(serde_json::json!({
            "endpoint_id": status.agent_id,
            "relay_url": relay_url,
            "peers": status.peers.len(),
            "uptime_secs": status.uptime_secs,
        }))
    }

    async fn handle_connect(&self, endpoint_id: &str) -> Result<serde_json::Value> {
        debug!("Connecting to {}", endpoint_id);
        let api = self.get_or_create_client(endpoint_id).await?;

        // Send a hello message
        let hello_msg = AgentMessage {
            from: self.state.endpoint_id.clone(),
            content: "hello".to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        let response = api.send_msg(hello_msg).await?;

        // Track peer
        self.state.add_peer(endpoint_id).await;

        Ok(serde_json::json!({
            "endpoint_id": endpoint_id,
            "connected": true,
            "ack": response.ack,
        }))
    }

    async fn handle_send(&self, endpoint_id: &str, message: &str) -> Result<serde_json::Value> {
        debug!("Sending message to {}: {}", endpoint_id, message);
        let api = self.get_or_create_client(endpoint_id).await?;

        let msg = AgentMessage {
            from: self.state.endpoint_id.clone(),
            content: message.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        let response = api.send_msg(msg).await?;

        Ok(serde_json::json!({
            "endpoint_id": endpoint_id,
            "sent": true,
            "ack": response.ack,
        }))
    }

    async fn handle_broadcast(&self, message: &str) -> Result<serde_json::Value> {
        let peers = self.state.peer_ids().await;
        let mut results = Vec::new();

        for peer_id in peers {
            match self.handle_send(&peer_id, message).await {
                Ok(_) => results.push(serde_json::json!({
                    "endpoint_id": peer_id,
                    "success": true,
                })),
                Err(e) => {
                    warn!("Failed to send to {}: {}", peer_id, e);
                    results.push(serde_json::json!({
                        "endpoint_id": peer_id,
                        "success": false,
                        "error": e.to_string(),
                    }));
                }
            }
        }

        Ok(serde_json::json!({
            "broadcast": true,
            "results": results,
        }))
    }

    async fn handle_peers(&self) -> Result<serde_json::Value> {
        let status = self.local_api.get_status().await?;
        Ok(serde_json::json!({
            "peers": status.peers,
            "count": status.peers.len(),
        }))
    }

    async fn handle_share_bytes(&self, data_b64: &str) -> Result<serde_json::Value> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .context("invalid base64")?;

        // Add bytes to store and get TagInfo
        let tag_info = self.blobs.add_bytes(bytes).await
            .context("failed to add bytes")?;
        
        // Create a blob ticket manually
        let addr = self.endpoint.addr();
        let ticket = iroh_blobs::ticket::BlobTicket::new(
            addr,
            tag_info.hash,
            tag_info.format,
        );

        Ok(serde_json::json!({
            "ticket": ticket.to_string(),
            "hash": tag_info.hash.to_string(),
            "format": format!("{:?}", tag_info.format),
        }))
    }

    async fn handle_share_files(&self, paths: &[String]) -> Result<serde_json::Value> {
        let mut results = Vec::new();
        let addr = self.endpoint.addr();

        for path_str in paths {
            let path = std::path::Path::new(path_str);
            if !path.exists() {
                results.push(serde_json::json!({
                    "path": path_str,
                    "error": "file not found",
                }));
                continue;
            }

            match self.blobs.add_path(path).await {
                Ok(tag_info) => {
                    let ticket = iroh_blobs::ticket::BlobTicket::new(
                        addr.clone(),
                        tag_info.hash,
                        tag_info.format,
                    );
                    results.push(serde_json::json!({
                        "path": path_str,
                        "ticket": ticket.to_string(),
                        "hash": tag_info.hash.to_string(),
                    }));
                }
                Err(e) => {
                    results.push(serde_json::json!({
                        "path": path_str,
                        "error": e.to_string(),
                    }));
                }
            }
        }

        Ok(serde_json::json!({ "shared": results }))
    }

    async fn handle_fetch(&self, ticket_str: &str) -> Result<serde_json::Value> {
        let ticket: iroh_blobs::ticket::BlobTicket = ticket_str
            .parse()
            .context("invalid blob ticket")?;

        // Connect to the remote endpoint
        let conn = self.endpoint
            .connect(ticket.addr().clone(), iroh_blobs::ALPN)
            .await
            .context("failed to connect to blob provider")?;

        // Download the blob
        self.blobs.store().remote().fetch(conn, ticket.hash_and_format()).await
            .context("failed to fetch blob")?;

        // Read the fetched data using a reader
        let mut reader = self.blobs.store().reader(ticket.hash());
        let mut data = Vec::new();
        reader.read_to_end(&mut data).await
            .context("failed to read blob data")?;

        // Return as base64 + try utf-8 text
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        let text = String::from_utf8(data.clone()).ok();

        Ok(serde_json::json!({
            "hash": ticket.hash().to_string(),
            "size": data.len(),
            "data_b64": b64,
            "text": text,
        }))
    }

    async fn handle_command(&self, cmd: Command) -> (String, bool, Option<serde_json::Value>, Option<String>) {
        match cmd {
            Command::Status { id } => match self.handle_status().await {
                Ok(data) => (id, true, Some(data), None),
                Err(e) => (id, false, None, Some(e.to_string())),
            },
            Command::Connect { id, endpoint_id } => {
                match self.handle_connect(&endpoint_id).await {
                    Ok(data) => (id, true, Some(data), None),
                    Err(e) => (id, false, None, Some(e.to_string())),
                }
            }
            Command::Send {
                id,
                endpoint_id,
                message,
            } => match self.handle_send(&endpoint_id, &message).await {
                Ok(data) => (id, true, Some(data), None),
                Err(e) => (id, false, None, Some(e.to_string())),
            },
            Command::Broadcast { id, message } => match self.handle_broadcast(&message).await {
                Ok(data) => (id, true, Some(data), None),
                Err(e) => (id, false, None, Some(e.to_string())),
            },
            Command::Peers { id } => match self.handle_peers().await {
                Ok(data) => (id, true, Some(data), None),
                Err(e) => (id, false, None, Some(e.to_string())),
            },
            Command::ShareBytes { id, data } => match self.handle_share_bytes(&data).await {
                Ok(data) => (id, true, Some(data), None),
                Err(e) => (id, false, None, Some(e.to_string())),
            },
            Command::ShareFiles { id, paths } => match self.handle_share_files(&paths).await {
                Ok(data) => (id, true, Some(data), None),
                Err(e) => (id, false, None, Some(e.to_string())),
            },
            Command::Fetch { id, ticket } => match self.handle_fetch(&ticket).await {
                Ok(data) => (id, true, Some(data), None),
                Err(e) => (id, false, None, Some(e.to_string())),
            },
            Command::Shutdown { id } => {
                info!("Shutdown requested");
                (
                    id,
                    true,
                    Some(serde_json::json!({"shutdown": true})),
                    None,
                )
            }
        }
    }
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing (logs to stderr)
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    info!("Starting iroh-rpc daemon (irpc version)");

    // Load or create secret key
    let secret_key = load_or_create_key().await?;

    // Build endpoint (need to accept both ALPNs)
    let endpoint = Endpoint::builder()
        .secret_key(secret_key)
        .alpns(vec![
            AgentApi::ALPN.to_vec(),
            iroh_blobs::ALPN.to_vec(),
        ])
        .bind()
        .await?;

    let endpoint_id = endpoint.id();
    info!("Endpoint started with ID: {}", endpoint_id);

    // Create blob store (in-memory for now)
    let blob_store = iroh_blobs::store::mem::MemStore::new();
    let blobs = iroh_blobs::BlobsProtocol::new(&blob_store, None);

    // Create agent state
    let state = AgentState::new(endpoint_id.to_string());

    // Spawn local agent actor
    let local_api = AgentApi::spawn(state.clone());

    // Build and spawn router with protocol handler
    let handler = local_api.protocol_handler()?;
    let router = iroh::protocol::Router::builder(endpoint.clone())
        .accept(AgentApi::ALPN, handler)
        .accept(iroh_blobs::ALPN, blobs.clone())
        .spawn();

    // Wait for endpoint to be online
    router.endpoint().online().await;
    info!("Endpoint is online");

    // Create command context
    let ctx = CommandContext {
        local_api,
        endpoint: endpoint.clone(),
        state: state.clone(),
        remote_clients: Arc::new(Mutex::new(HashMap::new())),
        blobs: blobs.clone(),
    };

    // Read commands from stdin
    let stdin = tokio::io::stdin();
    let reader = BufReader::new(stdin);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        debug!("Received command: {}", line);

        match serde_json::from_str::<Command>(line) {
            Ok(cmd) => {
                let is_shutdown = matches!(cmd, Command::Shutdown { .. });
                let (id, success, data, error) = ctx.handle_command(cmd).await;
                emit_response(id, success, data, error);

                if is_shutdown {
                    info!("Shutting down");
                    break;
                }
            }
            Err(e) => {
                error!("Failed to parse command: {}", e);
                emit_response(
                    "unknown".to_string(),
                    false,
                    None,
                    Some(format!("Invalid command: {}", e)),
                );
            }
        }
    }

    // Graceful shutdown
    info!("Shutting down router");
    router.shutdown().await?;

    info!("Exiting");
    Ok(())
}
