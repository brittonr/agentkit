import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// -- Types --

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (reason: any) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface IrohDaemon {
	proc: ChildProcess;
	rl: readline.Interface;
	endpointId: string | null;
	relayUrl: string | null;
	pendingRequests: Map<string, PendingRequest>;
	requestId: number;
	logPath: string;
	logFd: number;
	ready: boolean;
}

interface PeerDefinition {
	name: string;
	endpoint_id: string;
	description: string;
	tags?: string[];
}

interface ReceivedMessage {
	from: string; // endpoint_id
	fromName: string | null; // resolved peer name
	content: string;
	timestamp: string;
}

// -- Constants --

const RPC_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for tasks
const CONNECT_TIMEOUT_MS = 30 * 1000;
const LOG_DIR = path.join(os.homedir(), ".pi", "agent", "iroh-rpc-logs");
const PEERS_PATH = path.join(os.homedir(), ".pi", "agent", "peers.json");

// -- Helpers --

function timestamp(): string {
	const d = new Date();
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function writeToFd(fd: number, line: string): void {
	try {
		fs.writeSync(fd, `[${timestamp()}] ${line}\n`);
	} catch { /* fd may be closed */ }
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + `... [${s.length} chars]`;
}

// -- Peer discovery --

function loadPeers(): PeerDefinition[] {
	// User peers: ~/.pi/agent/peers.json
	const peers: PeerDefinition[] = [];

	if (fs.existsSync(PEERS_PATH)) {
		try {
			const data = JSON.parse(fs.readFileSync(PEERS_PATH, "utf-8"));
			if (Array.isArray(data)) {
				for (const p of data) {
					if (p.name && p.endpoint_id && p.description) {
						peers.push({
							name: p.name,
							endpoint_id: p.endpoint_id,
							description: p.description,
							tags: Array.isArray(p.tags) ? p.tags : undefined,
						});
					}
				}
			}
		} catch {
			// Skip unparseable file
		}
	}

	return peers;
}

function findPeer(nameOrId: string, peers: PeerDefinition[]): PeerDefinition | undefined {
	// Match by name (case-insensitive) or by endpoint_id prefix
	const lower = nameOrId.toLowerCase();
	return peers.find(
		(p) =>
			p.name.toLowerCase() === lower ||
			p.endpoint_id === nameOrId ||
			p.endpoint_id.startsWith(nameOrId),
	);
}

// -- Extension entry point --

export default function (pi: ExtensionAPI) {
	let daemon: IrohDaemon | null = null;
	const inboxMessages: ReceivedMessage[] = [];
	let latestCtx: any = undefined;

	fs.mkdirSync(LOG_DIR, { recursive: true });

	// -- Daemon lifecycle --

	function startDaemon(): IrohDaemon {
		if (daemon && !daemon.proc.killed) {
			return daemon;
		}

		const logPath = path.join(LOG_DIR, `iroh-rpc-${Date.now()}.log`);
		const logFd = fs.openSync(logPath, "w");
		writeToFd(logFd, "Starting iroh-rpc daemon");

		const proc = spawn("iroh-rpc", [], {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				RUST_LOG: "info",
			},
		});

		const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

		const d: IrohDaemon = {
			proc,
			rl,
			endpointId: null,
			relayUrl: null,
			pendingRequests: new Map(),
			requestId: 0,
			logPath,
			logFd,
			ready: false,
		};

		// Process stdout (JSON lines)
		rl.on("line", (line) => {
			if (!line.trim()) return;
			writeToFd(logFd, `stdout: ${line}`);

			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}

			// RPC response
			if (msg.type === "response" && msg.id) {
				const pending = d.pendingRequests.get(msg.id);
				if (pending) {
					d.pendingRequests.delete(msg.id);
					clearTimeout(pending.timer);
					if (msg.success === false) {
						pending.reject(new Error(msg.error || "RPC error"));
					} else {
						pending.resolve(msg.data);
					}
				}
				return;
			}

			// Event — track incoming messages
			if (msg.type === "event" && msg.event === "message_received") {
				const data = msg.data || {};
				const peers = loadPeers();
				const peer = peers.find((p) => p.endpoint_id === data.from);
				const received: ReceivedMessage = {
					from: data.from || "unknown",
					fromName: peer?.name || null,
					content: data.content || "",
					timestamp: data.timestamp || new Date().toISOString(),
				};
				inboxMessages.push(received);
				writeToFd(logFd, `inbox: [${received.fromName || received.from.slice(0, 16)}] ${truncate(received.content, 100)}`);

				// Inject the message into the conversation so the agent sees it
				const fromLabel = received.fromName || received.from.slice(0, 16) + "...";
				pi.sendMessage({
					customType: "iroh_message",
					content: [{
						type: "text" as const,
						text: `[iroh message from ${fromLabel}]: ${received.content}`,
					}],
					display: "all",
				});
			}
		});

		// Process stderr (tracing logs)
		proc.stderr?.on("data", (data) => {
			const text = data.toString().trim();
			if (text) writeToFd(logFd, `stderr: ${text}`);
		});

		// Handle exit
		proc.on("exit", (code) => {
			writeToFd(logFd, `exited (code ${code})`);
			try { fs.closeSync(logFd); } catch { /* ignore */ }

			// Reject all pending requests
			for (const [, pending] of d.pendingRequests) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`Daemon exited with code ${code}`));
			}
			d.pendingRequests.clear();
			d.ready = false;

			if (daemon === d) daemon = null;
		});

		daemon = d;
		return d;
	}

	function sendCommand(d: IrohDaemon, command: Record<string, any>, timeout?: number): Promise<any> {
		const id = String(++d.requestId);
		const payload = JSON.stringify({ ...command, id }) + "\n";
		const timeoutMs = timeout || RPC_TIMEOUT_MS;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				d.pendingRequests.delete(id);
				reject(new Error(`RPC timeout after ${timeoutMs / 1000}s`));
			}, timeoutMs);

			d.pendingRequests.set(id, { resolve, reject, timer });

			if (!d.proc.stdin?.writable) {
				d.pendingRequests.delete(id);
				clearTimeout(timer);
				reject(new Error("Daemon stdin not writable"));
				return;
			}
			d.proc.stdin.write(payload);
		});
	}

	async function ensureDaemon(): Promise<IrohDaemon> {
		const d = startDaemon();

		if (!d.ready) {
			await new Promise((r) => setTimeout(r, 1000));
			try {
				const status = await sendCommand(d, { type: "status" }, 10000);
				d.endpointId = status.endpoint_id;
				d.relayUrl = status.relay_url;
				d.ready = true;
			} catch (e: any) {
				writeToFd(d.logFd, `Failed to get initial status: ${e.message}`);
			}
		}

		return d;
	}

	async function stopDaemon(): Promise<void> {
		if (!daemon) return;
		const d = daemon;

		try {
			await sendCommand(d, { type: "shutdown" }, 5000);
		} catch { /* ignore */ }

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				if (!d.proc.killed) d.proc.kill("SIGKILL");
				resolve();
			}, 3000);
			d.proc.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
			if (d.proc.exitCode !== null) {
				clearTimeout(timeout);
				resolve();
			}
		});

		daemon = null;
	}

	// -- Slash commands --

	pi.registerCommand("iroh", {
		description: "Show iroh-rpc daemon status and known peers",
		handler: async (_args, ctx) => {
			const peers = loadPeers();
			const lines: string[] = [];

			if (daemon?.ready) {
				try {
					const status = await sendCommand(daemon, { type: "status" }, 5000);
					lines.push(`Endpoint ID: ${status.endpoint_id}`);
					lines.push(`Relay: ${status.relay_url}`);
					lines.push(`Connected peers: ${status.peers}`);
					lines.push(`Uptime: ${status.uptime_secs}s`);
					lines.push(`Log: ${daemon.logPath}`);
				} catch (e: any) {
					lines.push(`Daemon error: ${e.message}`);
				}
			} else {
				lines.push("Daemon: not running (starts on first tool use)");
			}

			lines.push("");
			if (peers.length > 0) {
				lines.push(`Known peers (${PEERS_PATH}):`);
				for (const p of peers) {
					const tags = p.tags?.length ? ` [${p.tags.join(", ")}]` : "";
					lines.push(`  ${p.name}: ${p.description}${tags}`);
					lines.push(`    ${p.endpoint_id}`);
				}
			} else {
				lines.push(`No peers configured. Add them to ${PEERS_PATH}`);
			}

			if (inboxMessages.length > 0) {
				lines.push("");
				lines.push(`Inbox (${inboxMessages.length} messages):`);
				for (const m of inboxMessages.slice(-5)) {
					const from = m.fromName || m.from.slice(0, 16) + "...";
					lines.push(`  [${from}] ${truncate(m.content, 60)}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("iroh-stop", {
		description: "Stop the iroh-rpc daemon",
		handler: async (_args, ctx) => {
			await stopDaemon();
			ctx.ui.notify("iroh-rpc daemon stopped", "info");
		},
	});

	// -- LLM Tools --

	pi.registerTool({
		name: "iroh_status",
		label: "Iroh Status",
		description: [
			"Get the status of the local iroh P2P endpoint.",
			"Returns the endpoint ID (share this with others to let them connect),",
			"relay URL, connected peers, and uptime.",
			"Starts the iroh daemon if not running.",
		].join(" "),
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();
				const status = await sendCommand(d, { type: "status" });
				const peers = loadPeers();

				const result: any = { ...status, known_peers: peers.map((p) => ({ name: p.name, description: p.description, tags: p.tags })) };
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: undefined,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "iroh_send",
		label: "Iroh Send",
		description: [
			"Send a message to a remote peer over P2P QUIC.",
			"The peer can be specified by name (from peers.json) or endpoint ID.",
			"The iroh daemon auto-connects on first send; no explicit connect step needed.",
		].join(" "),
		parameters: Type.Object({
			peer: Type.String({ description: "Peer name (from peers.json) or endpoint ID" }),
			message: Type.String({ description: "Message content to send" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();
				const peers = loadPeers();
				const peer = findPeer(params.peer, peers);
				const endpointId = peer?.endpoint_id || params.peer;
				const peerLabel = peer?.name || endpointId.slice(0, 16) + "...";

				const result = await sendCommand(d, {
					type: "send",
					endpoint_id: endpointId,
					message: params.message,
				}, CONNECT_TIMEOUT_MS);

				return {
					content: [{
						type: "text",
						text: `Sent to ${peerLabel}: ${result.ack ? "ack received" : "no ack"}`,
					}],
					details: { peer: peerLabel, endpointId, result },
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message}` }],
					details: undefined,
					isError: true,
				};
			}
		},

		renderCall(args: any, theme: any) {
			const peer = args.peer || "...";
			const msg = args.message ? truncate(args.message, 60) : "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("iroh send ")) +
				theme.fg("accent", peer) +
				`\n  ${theme.fg("dim", msg)}`,
				0, 0,
			);
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
			const text = result.content?.[0]?.text || "(no output)";
			const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			return new Text(`${icon} ${text}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "iroh_broadcast",
		label: "Iroh Broadcast",
		description: "Broadcast a message to all connected iroh peers.",
		parameters: Type.Object({
			message: Type.String({ description: "Message to broadcast to all peers" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();
				const result = await sendCommand(d, {
					type: "broadcast",
					message: params.message,
				});
				const successes = result.results?.filter((r: any) => r.success).length || 0;
				const total = result.results?.length || 0;
				return {
					content: [{
						type: "text",
						text: `Broadcast: ${successes}/${total} peers received`,
					}],
					details: result,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "iroh_peers",
		label: "Iroh Peers",
		description: [
			"List known and connected iroh peers.",
			"Known peers come from ~/.pi/agent/peers.json.",
			"Connected peers are those with active iroh connections.",
		].join(" "),
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();
				const daemonPeers = await sendCommand(d, { type: "peers" });
				const knownPeers = loadPeers();
				const connected = new Set<string>(daemonPeers.peers || []);

				const peerList = knownPeers.map((p) => ({
					name: p.name,
					endpoint_id: p.endpoint_id,
					description: p.description,
					tags: p.tags || [],
					connected: connected.has(p.endpoint_id),
				}));

				// Add any connected peers not in known list
				for (const eid of connected) {
					if (!knownPeers.find((p) => p.endpoint_id === eid)) {
						peerList.push({
							name: "(unknown)",
							endpoint_id: eid,
							description: "Connected peer not in peers.json",
							tags: [],
							connected: true,
						});
					}
				}

				return {
					content: [{
						type: "text",
						text: JSON.stringify({ peers: peerList, connected_count: connected.size }, null, 2),
					}],
					details: undefined,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "iroh_share",
		label: "Iroh Share",
		description: [
			"Share files or data with remote peers via iroh-blobs.",
			"Files are content-addressed (BLAKE3 hashed) and transferred over P2P QUIC.",
			"Returns a blob ticket that the recipient uses with iroh_fetch to download.",
			"Include the ticket in your iroh_send message so the peer can fetch the context.",
		].join(" "),
		parameters: Type.Object({
			files: Type.Optional(Type.Array(Type.String(), { description: "File paths to share" })),
			data: Type.Optional(Type.String({ description: "Inline text data to share (alternative to files)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();

				if (params.files && params.files.length > 0) {
					const result = await sendCommand(d, {
						type: "share_files",
						paths: params.files,
					});
					const shared = result.shared || [];
					const lines = shared.map((s: any) => {
						if (s.ticket) {
							return `${s.path}: ticket=${s.ticket}`;
						}
						return `${s.path}: error=${s.error}`;
					});
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						details: undefined,
					};
				}

				if (params.data) {
					const b64 = Buffer.from(params.data, "utf-8").toString("base64");
					const result = await sendCommand(d, {
						type: "share_bytes",
						data: b64,
					});
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						details: undefined,
					};
				}

				return {
					content: [{ type: "text", text: "Provide either `files` or `data` to share." }],
					details: undefined,
					isError: true,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message}` }],
					details: undefined,
					isError: true,
				};
			}
		},

		renderCall(args: any, theme: any) {
			let detail = "";
			if (args.files?.length) {
				detail = args.files.map((f: string) => path.basename(f)).join(", ");
			} else if (args.data) {
				detail = truncate(args.data, 40);
			}
			return new Text(
				theme.fg("toolTitle", theme.bold("iroh share ")) +
				theme.fg("accent", detail || "..."),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "iroh_fetch",
		label: "Iroh Fetch",
		description: [
			"Fetch a blob from a remote peer using a blob ticket.",
			"The ticket comes from iroh_share output or from a message received from a peer.",
			"Downloads the content over P2P QUIC and returns it.",
		].join(" "),
		parameters: Type.Object({
			ticket: Type.String({ description: "Blob ticket string (starts with 'blob')" }),
			save_to: Type.Optional(Type.String({ description: "Optional file path to save the fetched content to" })),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();

				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: "Fetching blob from peer..." }],
						details: undefined,
					});
				}

				const result = await sendCommand(d, {
					type: "fetch",
					ticket: params.ticket,
				}, CONNECT_TIMEOUT_MS);

				// If save_to specified, write the data to disk
				if (params.save_to && result.data_b64) {
					const buf = Buffer.from(result.data_b64, "base64");
					fs.writeFileSync(params.save_to, buf);
					return {
						content: [{
							type: "text",
							text: `Fetched ${result.size} bytes → saved to ${params.save_to}`,
						}],
						details: result,
					};
				}

				// Return text content if available, otherwise base64
				if (result.text) {
					return {
						content: [{
							type: "text",
							text: `Fetched ${result.size} bytes:\n\n${result.text}`,
						}],
						details: result,
					};
				}

				return {
					content: [{
						type: "text",
						text: `Fetched ${result.size} bytes (binary, base64): ${truncate(result.data_b64 || "", 100)}`,
					}],
					details: result,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message}` }],
					details: undefined,
					isError: true,
				};
			}
		},

		renderCall(args: any, theme: any) {
			const ticket = args.ticket ? truncate(args.ticket, 30) : "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("iroh fetch ")) +
				theme.fg("dim", ticket),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "iroh_inbox",
		label: "Iroh Inbox",
		description: [
			"Read messages received from remote peers.",
			"Returns recent messages from the inbox.",
			"Messages are also injected into the conversation as they arrive.",
		].join(" "),
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Max messages to return (default: 20)" })),
			clear: Type.Optional(Type.Boolean({ description: "Clear inbox after reading" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const limit = params.limit || 20;
			const messages = inboxMessages.slice(-limit);

			const result = messages.map((m) => ({
				from: m.fromName || m.from,
				content: m.content,
				timestamp: m.timestamp,
			}));

			if (params.clear) {
				inboxMessages.length = 0;
			}

			return {
				content: [{
					type: "text",
					text: messages.length > 0
						? JSON.stringify(result, null, 2)
						: "Inbox is empty. No messages received from peers.",
				}],
				details: undefined,
			};
		},
	});

	// -- System prompt injection --

	pi.on("before_agent_start", async (_event, ctx) => {
		latestCtx = ctx;

		const peers = loadPeers();
		const hasDaemon = daemon?.ready;
		const hasInbox = inboxMessages.length > 0;

		if (peers.length === 0 && !hasDaemon && !hasInbox) return;

		let injection = "\n\n## Iroh P2P Networking\n\n";

		if (hasDaemon) {
			injection += `This agent has an iroh P2P endpoint: \`${daemon!.endpointId}\`\n\n`;
		}

		if (peers.length > 0) {
			injection += "### Known Remote Peers\n\n";
			injection += "These peers are configured in `~/.pi/agent/peers.json` and can be reached by name:\n\n";
			for (const p of peers) {
				const tags = p.tags?.length ? ` (${p.tags.join(", ")})` : "";
				injection += `- **${p.name}**: ${p.description}${tags}\n`;
			}
			injection += "\n";
			injection += "Use `iroh_send` with a peer name to message them. ";
			injection += "Use `iroh_share` to share files as content-addressed blobs, then include the ticket in your message. ";
			injection += "Use `iroh_fetch` to download blobs from tickets received in messages. ";
			injection += "Incoming messages appear in the conversation automatically.\n";
		}

		if (hasInbox) {
			const recent = inboxMessages.slice(-3);
			injection += "\n### Recent Messages\n\n";
			for (const m of recent) {
				const from = m.fromName || m.from.slice(0, 16) + "...";
				injection += `- [${from}]: ${truncate(m.content, 80)}\n`;
			}
		}

		return {
			systemPrompt: ctx.getSystemPrompt() + injection,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
	});

	// -- Graceful shutdown --

	pi.on("session_shutdown", async () => {
		await stopDaemon();
	});
}
