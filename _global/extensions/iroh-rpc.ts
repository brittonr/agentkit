import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
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
	peers: string[];
	pendingRequests: Map<string, PendingRequest>;
	requestId: number;
	logPath: string;
	logFd: number;
	ready: boolean;
}

// -- Constants --

const RPC_TIMEOUT_MS = 60 * 1000;
const LOG_DIR = path.join(os.homedir(), ".pi", "agent", "iroh-rpc-logs");

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

// -- Extension entry point --

export default function (pi: ExtensionAPI) {
	let daemon: IrohDaemon | null = null;

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
			peers: [],
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

			// Event
			if (msg.type === "event") {
				writeToFd(logFd, `event: ${msg.event} ${JSON.stringify(msg.data || {})}`);

				// Track peers from events
				if (msg.event === "peer_joined" && msg.data?.endpoint_id) {
					if (!d.peers.includes(msg.data.endpoint_id)) {
						d.peers.push(msg.data.endpoint_id);
					}
				}
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

	function sendCommand(d: IrohDaemon, command: Record<string, any>): Promise<any> {
		const id = String(++d.requestId);
		const payload = JSON.stringify({ ...command, id }) + "\n";

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				d.pendingRequests.delete(id);
				reject(new Error(`RPC timeout after ${RPC_TIMEOUT_MS / 1000}s`));
			}, RPC_TIMEOUT_MS);

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

		// Get initial status to populate endpoint info
		if (!d.ready) {
			// Brief delay for daemon to start
			await new Promise((r) => setTimeout(r, 1000));
			try {
				const status = await sendCommand(d, { type: "status" });
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
			await sendCommand(d, { type: "shutdown" });
		} catch { /* ignore */ }

		// Wait for exit or kill
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
		description: "Show iroh-rpc daemon status",
		handler: async (_args, ctx) => {
			if (!daemon || daemon.proc.killed) {
				ctx.ui.notify("iroh-rpc daemon not running. It starts automatically when tools are used.", "info");
				return;
			}

			try {
				const status = await sendCommand(daemon, { type: "status" });
				const lines = [
					`Endpoint ID: ${status.endpoint_id}`,
					`Relay URL: ${status.relay_url}`,
					`Peers: ${status.peers}`,
					`Uptime: ${status.uptime_secs}s`,
					`Log: ${daemon.logPath}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e: any) {
				ctx.ui.notify(`Error: ${e.message}`, "error");
			}
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
		description: "Get the status of the local iroh P2P endpoint. Returns the endpoint ID (used by others to connect), relay URL, connected peers, and uptime. Starts the iroh daemon if not running.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();
				const status = await sendCommand(d, { type: "status" });
				return {
					content: [{
						type: "text",
						text: JSON.stringify(status, null, 2),
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
		name: "iroh_connect",
		label: "Iroh Connect",
		description: "Connect to a remote iroh agent by their endpoint ID. Sends a hello handshake and establishes a P2P QUIC connection with NAT traversal via relay servers.",
		parameters: Type.Object({
			endpoint_id: Type.String({ description: "The remote agent's endpoint ID (base32 string)" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();
				const result = await sendCommand(d, {
					type: "connect",
					endpoint_id: params.endpoint_id,
				});
				return {
					content: [{
						type: "text",
						text: JSON.stringify(result, null, 2),
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
		name: "iroh_send",
		label: "Iroh Send",
		description: "Send a message to a remote iroh agent over P2P QUIC. The message is delivered directly using irpc typed RPC over the iroh connection.",
		parameters: Type.Object({
			endpoint_id: Type.String({ description: "Target agent's endpoint ID" }),
			message: Type.String({ description: "Message content to send" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();
				const result = await sendCommand(d, {
					type: "send",
					endpoint_id: params.endpoint_id,
					message: params.message,
				});
				return {
					content: [{
						type: "text",
						text: JSON.stringify(result, null, 2),
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
		name: "iroh_broadcast",
		label: "Iroh Broadcast",
		description: "Broadcast a message to all connected iroh peers. Sends the message to every known peer agent.",
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
				return {
					content: [{
						type: "text",
						text: JSON.stringify(result, null, 2),
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
		name: "iroh_peers",
		label: "Iroh Peers",
		description: "List all connected iroh peers with their endpoint IDs.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const d = await ensureDaemon();
				const result = await sendCommand(d, { type: "peers" });
				return {
					content: [{
						type: "text",
						text: JSON.stringify(result, null, 2),
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

	// -- System prompt injection --

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!daemon?.ready) return;

		const injection = [
			"\n\n## Iroh P2P Networking",
			"",
			`This agent has an iroh P2P endpoint running.`,
			`- **Endpoint ID**: \`${daemon.endpointId}\``,
			`- **Relay URL**: ${daemon.relayUrl}`,
			`- **Connected Peers**: ${daemon.peers.length}`,
			"",
			"Use the `iroh_*` tools to communicate with other agents over P2P QUIC connections.",
			"Share your Endpoint ID with other agents so they can connect to you.",
		].join("\n");

		return {
			systemPrompt: ctx.getSystemPrompt() + injection,
		};
	});

	// -- Graceful shutdown --

	pi.on("session_shutdown", async () => {
		await stopDaemon();
	});
}
