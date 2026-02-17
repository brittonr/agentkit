import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// -- Types --

type WorkerStatus = "starting" | "idle" | "busy" | "dead";

interface AgentDefinition {
	name: string;
	description: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
	source: "user" | "project";
}

interface EphemeralResult {
	text: string;
	usage: { input: number; output: number; cost: number };
	durationMs: number;
	logPath?: string;
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (reason: any) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Worker {
	name: string;
	cwd: string;
	proc: ChildProcess;
	rl: readline.Interface;
	status: WorkerStatus;
	currentTask: string | undefined;
	lastAssistantText: string | undefined;
	logPath: string;
	logFd: number;
	pendingRequests: Map<string, PendingRequest>;
	requestId: number;
	spawnedAt: number;
	usage: { turns: number; input: number; output: number; cost: number };
	agentTempFile?: string;
}

// -- RPC Client (inline, ~50 lines) --

const RPC_TIMEOUT_MS = 5 * 60 * 1000;

function sendRpc(worker: Worker, command: Record<string, any>): Promise<any> {
	const id = String(++worker.requestId);
	const payload = JSON.stringify({ ...command, id }) + "\n";

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			worker.pendingRequests.delete(id);
			reject(new Error(`RPC timeout after ${RPC_TIMEOUT_MS / 1000}s for ${command.type}`));
		}, RPC_TIMEOUT_MS);

		worker.pendingRequests.set(id, { resolve, reject, timer });

		if (!worker.proc.stdin?.writable) {
			worker.pendingRequests.delete(id);
			clearTimeout(timer);
			reject(new Error("Worker stdin not writable"));
			return;
		}
		worker.proc.stdin.write(payload);
	});
}

function handleLine(
	worker: Worker,
	line: string,
	onEvent?: (event: any) => void,
): void {
	if (!line.trim()) return;
	let msg: any;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}

	// RPC response with id correlation
	if (msg.type === "response" && msg.id) {
		const pending = worker.pendingRequests.get(msg.id);
		if (pending) {
			worker.pendingRequests.delete(msg.id);
			clearTimeout(pending.timer);
			if (msg.success === false) {
				pending.reject(new Error(msg.error || "RPC error"));
			} else {
				pending.resolve(msg.data);
			}
		}
		return;
	}

	// Agent event -- pass through
	if (onEvent) onEvent(msg);
}

// -- Log formatting --

function timestamp(): string {
	const d = new Date();
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function writeToFd(fd: number, line: string): void {
	try {
		fs.writeSync(fd, `[${timestamp()}] ${line}\n`);
	} catch {
		// fd may have been closed
	}
}

function writeLog(worker: Worker, line: string): void {
	writeToFd(worker.logFd, line);
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + `... [${s.length} chars]`;
}

// -- Agent discovery --

function discoverAgents(cwd: string): AgentDefinition[] {
	const agents = new Map<string, AgentDefinition>();

	// Scan user agents: ~/.pi/agent/agents/*.md
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	if (fs.existsSync(userDir)) {
		for (const file of fs.readdirSync(userDir)) {
			if (!file.endsWith(".md")) continue;
			try {
				const content = fs.readFileSync(path.join(userDir, file), "utf-8");
				const { frontmatter, body } = parseFrontmatter(content);
				const name = frontmatter.name as string | undefined;
				const description = frontmatter.description as string | undefined;
				if (!name || !description) continue;

				const toolsRaw = frontmatter.tools as string | undefined;
				agents.set(name, {
					name,
					description,
					model: (frontmatter.model as string) || undefined,
					tools: toolsRaw ? toolsRaw.split(",").map((t: string) => t.trim()) : undefined,
					systemPrompt: body.trim(),
					source: "user",
				});
			} catch {
				// Skip unparseable files
			}
		}
	}

	// Scan project agents: walk up from cwd looking for .pi/agents/*.md
	let dir = cwd;
	while (true) {
		const projectDir = path.join(dir, ".pi", "agents");
		if (fs.existsSync(projectDir)) {
			for (const file of fs.readdirSync(projectDir)) {
				if (!file.endsWith(".md")) continue;
				try {
					const content = fs.readFileSync(path.join(projectDir, file), "utf-8");
					const { frontmatter, body } = parseFrontmatter(content);
					const name = frontmatter.name as string | undefined;
					const description = frontmatter.description as string | undefined;
					if (!name || !description) continue;

					const toolsRaw = frontmatter.tools as string | undefined;
					// Project overrides user on name collision
					agents.set(name, {
						name,
						description,
						model: (frontmatter.model as string) || undefined,
						tools: toolsRaw ? toolsRaw.split(",").map((t: string) => t.trim()) : undefined,
						systemPrompt: body.trim(),
						source: "project",
					});
				} catch {
					// Skip unparseable files
				}
			}
			break; // Found a .pi/agents dir, stop walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return [...agents.values()];
}

// -- Ephemeral runner --

async function runEphemeral(
	task: string,
	opts: {
		cwd: string;
		model?: string;
		tools?: string[];
		systemPrompt?: string;
		signal?: AbortSignal;
		logPath?: string;
		onProgress?: (text: string) => void;
	},
): Promise<EphemeralResult> {
	const start = Date.now();
	let tempFile: string | undefined;
	let logFd: number | undefined;

	try {
		// Set up log file
		if (opts.logPath) {
			logFd = fs.openSync(opts.logPath, "a");
			writeToFd(logFd, `task: "${truncate(task, 200)}"`);
		}

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
		];

		if (opts.model) {
			args.push("--model", opts.model);
			if (logFd !== undefined) writeToFd(logFd, `model: ${opts.model}`);
		}
		if (opts.tools) {
			args.push("--tools", opts.tools.join(","));
			if (logFd !== undefined) writeToFd(logFd, `tools: ${opts.tools.join(",")}`);
		}

		if (opts.systemPrompt) {
			tempFile = path.join(os.tmpdir(), `pi-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
			fs.writeFileSync(tempFile, opts.systemPrompt);
			args.push("--append-system-prompt", tempFile);
		}

		args.push(task);

		const proc = spawn("pi", args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (logFd !== undefined) writeToFd(logFd, `started (cwd: ${opts.cwd}, pid: ${proc.pid})`);

		// Collect stderr to log
		proc.stderr?.on("data", (data) => {
			const text = data.toString().trim();
			if (text && logFd !== undefined) writeToFd(logFd, `stderr: ${text}`);
		});

		// Handle abort signal
		if (opts.signal) {
			const onAbort = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 3000);
			};
			if (opts.signal.aborted) {
				proc.kill("SIGTERM");
			} else {
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		let text = "";
		let usage = { input: 0, output: 0, cost: 0 };

		const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

		for await (const line of rl) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				switch (event.type) {
					case "tool_execution_start": {
						const toolName = event.toolName || "unknown";
						let detail: string;
						if (toolName === "bash") {
							detail = `bash $ ${truncate(event.args?.command || "...", 80)}`;
						} else {
							detail = `${toolName} ${truncate(JSON.stringify(event.args || {}), 60)}`;
						}
						if (logFd !== undefined) writeToFd(logFd, `tool: ${detail}`);
						if (opts.onProgress) opts.onProgress(`tool: ${detail}`);
						break;
					}
					case "tool_execution_end": {
						const toolName = event.toolName || "unknown";
						const status = event.isError ? "error" : "done";
						if (logFd !== undefined) writeToFd(logFd, `tool ${status}: ${toolName}`);
						if (event.isError && opts.onProgress) opts.onProgress(`tool error: ${toolName}`);
						break;
					}
					case "message_end": {
						const msg = event.message;
						if (msg?.role === "assistant" && Array.isArray(msg.content)) {
							for (const part of msg.content) {
								if (part.type === "text") text += part.text;
							}
						}
						if (msg?.usage) {
							usage.input += msg.usage.input || 0;
							usage.output += msg.usage.output || 0;
							usage.cost += msg.usage.cost?.total || 0;
						}
						if (text && logFd !== undefined) {
							writeToFd(logFd, `response: ${truncate(text, 200)}`);
						}
						break;
					}
				}
			} catch {
				// Skip non-JSON lines
			}
		}

		// Wait for process exit
		await new Promise<void>((resolve) => {
			if (proc.exitCode !== null) {
				resolve();
			} else {
				proc.on("exit", () => resolve());
			}
		});

		const durationMs = Date.now() - start;
		if (logFd !== undefined) {
			writeToFd(logFd, `done (${durationMs}ms, ${formatTokens(usage.input)} in, ${formatTokens(usage.output)} out, $${usage.cost.toFixed(3)})`);
		}

		return { text: text || "(no output)", usage, durationMs, logPath: opts.logPath };
	} finally {
		if (tempFile) {
			try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
		}
		if (logFd !== undefined) {
			try { fs.closeSync(logFd); } catch { /* ignore */ }
		}
	}
}

// -- Concurrency helper --

async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < items.length) {
			const i = nextIndex++;
			results[i] = await fn(items[i], i);
		}
	}

	const workerCount = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

// -- Extension entry point --

export default function (pi: ExtensionAPI) {
	const workers = new Map<string, Worker>();
	const inZellij = !!process.env.ZELLIJ_SESSION_NAME;

	const SWARM_LOG_DIR = path.join(os.homedir(), ".pi", "agent", "swarm-logs");
	fs.mkdirSync(SWARM_LOG_DIR, { recursive: true });

	// -- UI helpers --

	function updateUI(ctx: any) {
		if (!ctx?.hasUI) return;

		// Status bar
		const total = workers.size;
		const busy = [...workers.values()].filter((w) => w.status === "busy").length;
		if (total === 0) {
			ctx.ui.setStatus("swarm", undefined);
			ctx.ui.setWidget("swarm", undefined);
		} else {
			ctx.ui.setStatus("swarm", `swarm: ${busy}/${total} busy`);

			// Widget
			const lines: string[] = [];
			for (const w of workers.values()) {
				const age = Math.round((Date.now() - w.spawnedAt) / 1000);
				const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
				const task = w.currentTask ? truncate(w.currentTask, 40) : "-";
				lines.push(`  ${w.name}: ${w.status} (${ageStr}) ${task}`);
			}
			ctx.ui.setWidget("swarm", lines);
		}
	}

	// Track the latest context for UI updates from event handlers
	let latestCtx: any = undefined;

	// -- Worker lifecycle --

	function spawnWorker(name: string, cwd: string, agentConfig?: AgentDefinition): Worker {
		if (workers.has(name)) {
			throw new Error(`Worker "${name}" already exists`);
		}

		const logPath = path.join(SWARM_LOG_DIR, `${name}.log`);
		const logFd = fs.openSync(logPath, "w");

		const args = [
			"--mode", "rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
		];

		let agentTempFile: string | undefined;

		if (agentConfig?.model) {
			args.push("--model", agentConfig.model);
		}
		if (agentConfig?.tools) {
			args.push("--tools", agentConfig.tools.join(","));
		}
		if (agentConfig?.systemPrompt) {
			agentTempFile = path.join(os.tmpdir(), `pi-worker-${name}-${Date.now()}.md`);
			fs.writeFileSync(agentTempFile, agentConfig.systemPrompt);
			args.push("--append-system-prompt", agentTempFile);
		}

		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

		const worker: Worker = {
			name,
			cwd,
			proc,
			rl,
			status: "starting",
			currentTask: undefined,
			lastAssistantText: undefined,
			logPath,
			logFd,
			pendingRequests: new Map(),
			requestId: 0,
			spawnedAt: Date.now(),
			usage: { turns: 0, input: 0, output: 0, cost: 0 },
			agentTempFile,
		};

		// Buffer for partial text from message_update events
		let messageTextBuffer = "";

		rl.on("line", (line) => {
			handleLine(worker, line, (event) => {
				// Translate events to log entries
				switch (event.type) {
					case "agent_start":
						worker.status = "busy";
						writeLog(worker, `agent started`);
						updateUI(latestCtx);
						break;

					case "agent_end":
						worker.status = "idle";
						writeLog(
							worker,
							`done (${worker.usage.turns} turns, ${formatTokens(worker.usage.input)} in, ${formatTokens(worker.usage.output)} out, $${worker.usage.cost.toFixed(3)})`,
						);
						updateUI(latestCtx);
						break;

					case "tool_execution_start":
						if (event.toolName === "bash") {
							const cmd = event.args?.command || "...";
							writeLog(worker, `tool: bash $ ${truncate(cmd, 80)}`);
						} else {
							const argPreview = JSON.stringify(event.args || {});
							writeLog(worker, `tool: ${event.toolName} ${truncate(argPreview, 60)}`);
						}
						break;

					case "tool_execution_end":
						if (event.isError) {
							writeLog(worker, `tool error: ${event.toolName}`);
						} else {
							writeLog(worker, `tool done: ${event.toolName}`);
						}
						break;

					case "message_start":
						messageTextBuffer = "";
						break;

					case "message_update":
						// Accumulate text deltas
						if (event.assistantMessageEvent?.type === "text") {
							messageTextBuffer += event.assistantMessageEvent.text || "";
						}
						break;

					case "message_end": {
						const msg = event.message;
						if (msg?.role === "assistant") {
							// Extract text content
							let text = "";
							if (Array.isArray(msg.content)) {
								for (const part of msg.content) {
									if (part.type === "text") text += part.text;
								}
							}
							if (text) {
								worker.lastAssistantText = text;
								writeLog(worker, `response: ${truncate(text, 200)}`);
							}
							// Track usage
							const usage = msg.usage;
							if (usage) {
								worker.usage.turns++;
								worker.usage.input += usage.input || 0;
								worker.usage.output += usage.output || 0;
								worker.usage.cost += usage.cost?.total || 0;
							}
						}
						messageTextBuffer = "";
						break;
					}
				}
			});
		});

		// Collect stderr
		proc.stderr?.on("data", (data) => {
			const text = data.toString().trim();
			if (text) writeLog(worker, `stderr: ${text}`);
		});

		// Handle exit
		proc.on("exit", (code) => {
			worker.status = "dead";
			writeLog(worker, `exited (code ${code})`);

			// Reject all pending requests
			for (const [id, pending] of worker.pendingRequests) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`Worker "${name}" exited with code ${code}`));
			}
			worker.pendingRequests.clear();

			try {
				fs.closeSync(worker.logFd);
			} catch { /* ignore */ }

			updateUI(latestCtx);
		});

		workers.set(name, worker);

		writeLog(worker, `started (cwd: ${cwd})`);

		// Mark as idle once started (RPC mode is ready immediately after spawn)
		// TODO: Could wait for a ready signal, but pi --mode rpc starts accepting commands right away
		worker.status = "idle";

		// Open Zellij floating pane to tail the log
		if (inZellij) {
			pi.exec("zellij", [
				"run", "-f",
				"--name", `swarm:${name}`,
				"-c", "--",
				"tail", "-f", logPath,
			]).catch(() => {
				// zellij CLI unavailable or failed, non-fatal
			});
		}

		updateUI(latestCtx);
		return worker;
	}

	async function killWorker(name: string): Promise<void> {
		const worker = workers.get(name);
		if (!worker) return;

		if (worker.status !== "dead") {
			worker.proc.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					if (!worker.proc.killed) worker.proc.kill("SIGKILL");
					resolve();
				}, 3000);
				worker.proc.on("exit", () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}

		// Clean up temp system-prompt file
		if (worker.agentTempFile) {
			try { fs.unlinkSync(worker.agentTempFile); } catch { /* ignore */ }
		}

		workers.delete(name);

		// TODO: Zellij doesn't support closing panes by name; the tail process
		// will exit naturally when the log fd is closed, causing the pane to close
		// if it was spawned with -c (close-on-exit).

		updateUI(latestCtx);
	}

	async function killAllWorkers(): Promise<void> {
		const names = [...workers.keys()];
		await Promise.all(names.map((n) => killWorker(n)));
	}

	function waitForWorkerIdle(worker: Worker, signal?: AbortSignal): Promise<void> {
		if (worker.status === "idle" || worker.status === "dead") {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const checkInterval = setInterval(() => {
				if (worker.status === "idle" || worker.status === "dead") {
					clearInterval(checkInterval);
					resolve();
				}
			}, 200);

			if (signal) {
				const onAbort = () => {
					clearInterval(checkInterval);
					reject(new Error("Aborted"));
				};
				if (signal.aborted) {
					clearInterval(checkInterval);
					reject(new Error("Aborted"));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	// -- Slash commands --

	pi.registerCommand("spawn", {
		description: "Create an RPC worker: /spawn <name> [--cwd path]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const name = parts[0];
			if (!name) {
				ctx.ui.notify("Usage: /spawn <name> [--cwd path]", "error");
				return;
			}

			let cwd = ctx.cwd;
			const cwdIdx = parts.indexOf("--cwd");
			if (cwdIdx >= 0 && parts[cwdIdx + 1]) {
				cwd = path.resolve(parts[cwdIdx + 1]);
			}

			try {
				spawnWorker(name, cwd);
				ctx.ui.notify(`Worker "${name}" spawned`, "info");
			} catch (e: any) {
				ctx.ui.notify(e.message, "error");
			}
		},
	});

	pi.registerCommand("task", {
		description: "Send prompt to worker: /task <worker> <prompt>",
		handler: async (args, ctx) => {
			const spaceIdx = args.indexOf(" ");
			if (spaceIdx < 0) {
				ctx.ui.notify("Usage: /task <worker> <prompt>", "error");
				return;
			}
			const name = args.slice(0, spaceIdx).trim();
			const prompt = args.slice(spaceIdx + 1).trim();

			const worker = workers.get(name);
			if (!worker) {
				ctx.ui.notify(`Worker "${name}" not found`, "error");
				return;
			}
			if (worker.status === "dead") {
				ctx.ui.notify(`Worker "${name}" is dead`, "error");
				return;
			}

			try {
				worker.currentTask = prompt;
				worker.status = "busy";
				writeLog(worker, `task: "${truncate(prompt, 100)}"`);
				updateUI(ctx);

				await sendRpc(worker, { type: "prompt", message: prompt });
				ctx.ui.notify(`Task sent to "${name}"`, "info");
			} catch (e: any) {
				ctx.ui.notify(`Failed to send task: ${e.message}`, "error");
			}
		},
	});

	pi.registerCommand("steer", {
		description: "Interrupt worker mid-task: /steer <worker> <message>",
		handler: async (args, ctx) => {
			const spaceIdx = args.indexOf(" ");
			if (spaceIdx < 0) {
				ctx.ui.notify("Usage: /steer <worker> <message>", "error");
				return;
			}
			const name = args.slice(0, spaceIdx).trim();
			const message = args.slice(spaceIdx + 1).trim();

			const worker = workers.get(name);
			if (!worker) {
				ctx.ui.notify(`Worker "${name}" not found`, "error");
				return;
			}

			try {
				await sendRpc(worker, { type: "steer", message });
				ctx.ui.notify(`Steering message sent to "${name}"`, "info");
			} catch (e: any) {
				ctx.ui.notify(`Failed to steer: ${e.message}`, "error");
			}
		},
	});

	pi.registerCommand("abort", {
		description: "Cancel current worker operation: /abort <worker>",
		handler: async (args, ctx) => {
			const name = args.trim();
			const worker = workers.get(name);
			if (!worker) {
				ctx.ui.notify(`Worker "${name}" not found`, "error");
				return;
			}

			try {
				await sendRpc(worker, { type: "abort" });
				ctx.ui.notify(`Abort sent to "${name}"`, "info");
			} catch (e: any) {
				ctx.ui.notify(`Failed to abort: ${e.message}`, "error");
			}
		},
	});

	pi.registerCommand("status", {
		description: "Show all workers",
		handler: async (_args, ctx) => {
			if (workers.size === 0) {
				ctx.ui.notify("No workers", "info");
				return;
			}

			const lines: string[] = [];
			for (const w of workers.values()) {
				const age = Math.round((Date.now() - w.spawnedAt) / 1000);
				const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
				const task = w.currentTask ? truncate(w.currentTask, 50) : "-";
				lines.push(
					`${w.name}: ${w.status} | age: ${ageStr} | task: ${task} | usage: ${w.usage.turns}t $${w.usage.cost.toFixed(3)}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("result", {
		description: "Get last assistant text from worker: /result <worker>",
		handler: async (args, ctx) => {
			const name = args.trim();
			const worker = workers.get(name);
			if (!worker) {
				ctx.ui.notify(`Worker "${name}" not found`, "error");
				return;
			}

			if (!worker.lastAssistantText) {
				ctx.ui.notify(`No result from "${name}" yet`, "warning");
				return;
			}

			// Inject the result into the lead session context
			pi.sendMessage({
				customType: "swarm_result",
				content: [
					{
						type: "text" as const,
						text: `[Worker ${name} result]:\n${worker.lastAssistantText}`,
					},
				],
				display: "all",
			});
		},
	});

	pi.registerCommand("kill", {
		description: "Shut down a worker: /kill <worker>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!workers.has(name)) {
				ctx.ui.notify(`Worker "${name}" not found`, "error");
				return;
			}

			await killWorker(name);
			ctx.ui.notify(`Worker "${name}" killed`, "info");
		},
	});

	pi.registerCommand("killall", {
		description: "Shut down all workers",
		handler: async (_args, ctx) => {
			const count = workers.size;
			await killAllWorkers();
			ctx.ui.notify(`${count} worker(s) killed`, "info");
		},
	});

	pi.registerCommand("agents", {
		description: "List discovered agent definitions",
		handler: async (_args, ctx) => {
			const agents = discoverAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify("No agent definitions found", "info");
				return;
			}

			const lines = agents.map((a) => {
				const model = a.model || "(default)";
				const tools = a.tools ? a.tools.join(",") : "(all)";
				return `${a.name} [${a.source}] | model: ${model} | tools: ${tools}\n  ${a.description}`;
			});
			ctx.ui.notify(lines.join("\n\n"), "info");
		},
	});

	// -- TUI Dashboard: /swarm --

	pi.registerCommand("swarm", {
		description: "Interactive swarm dashboard with workers and agents",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				type Section = "workers" | "agents";
				let section: Section = workers.size > 0 ? "workers" : "agents";
				let cursor = 0;
				let needsRender = false;
				let agents: AgentDefinition[] = [];

				function refreshAgents() {
					agents = discoverAgents(ctx.cwd);
				}
				refreshAgents();

				function workerList(): Worker[] {
					return [...workers.values()];
				}

				function sectionLength(): number {
					return section === "workers" ? workerList().length : agents.length;
				}

				function clampCursor() {
					const len = sectionLength();
					if (cursor >= len) cursor = Math.max(0, len - 1);
				}

				function statusIndicator(status: WorkerStatus): string {
					switch (status) {
						case "idle": return theme.fg("success", "idle");
						case "busy": return theme.fg("warning", "busy");
						case "starting": return theme.fg("accent", "starting");
						case "dead": return theme.fg("error", "dead");
					}
				}

				function formatAge(ms: number): string {
					const sec = Math.round((Date.now() - ms) / 1000);
					if (sec < 60) return `${sec}s`;
					if (sec < 3600) return `${Math.round(sec / 60)}m`;
					return `${Math.round(sec / 3600)}h`;
				}

				const cleanup = tui.addInputListener((data) => {
					// Filter out key release events (Kitty keyboard protocol sends both press + release)
					if (isKeyRelease(data)) return undefined;

					// Close
					if (matchesKey(data, "q") || matchesKey(data, "escape")) {
						cleanup();
						done();
						return { consume: true };
					}

					// Navigate
					if (matchesKey(data, "j") || matchesKey(data, "down")) {
						cursor = Math.min(cursor + 1, Math.max(0, sectionLength() - 1));
						needsRender = true;
						return { consume: true };
					}
					if (matchesKey(data, "k") || matchesKey(data, "up")) {
						cursor = Math.max(0, cursor - 1);
						needsRender = true;
						return { consume: true };
					}

					// Switch section
					if (matchesKey(data, "tab")) {
						section = section === "workers" ? "agents" : "workers";
						cursor = 0;
						needsRender = true;
						return { consume: true };
					}

					// Enter: open Zellij pane (worker) or spawn worker (agent)
					if (matchesKey(data, "enter")) {
						if (section === "workers") {
							const w = workerList()[cursor];
							if (w && inZellij) {
								pi.exec("zellij", [
									"run", "-f",
									"--name", `swarm:${w.name}`,
									"-c", "--",
									"tail", "-f", w.logPath,
								]).catch(() => {});
							}
						} else {
							const agent = agents[cursor];
							if (agent) {
								const name = agent.name + "-" + Date.now().toString(36).slice(-4);
								try {
									spawnWorker(name, ctx.cwd, agent);
									section = "workers";
									cursor = workerList().length - 1;
								} catch { /* already exists or other error */ }
							}
						}
						needsRender = true;
						return { consume: true };
					}

					// Worker actions
					if (section === "workers") {
						const w = workerList()[cursor];
						if (!w) return undefined;

						// x: kill worker
						if (matchesKey(data, "x")) {
							killWorker(w.name).then(() => {
								clampCursor();
								needsRender = true;
							});
							return { consume: true };
						}

						// a: abort current task
						if (matchesKey(data, "a")) {
							if (w.status === "busy") {
								sendRpc(w, { type: "abort" }).catch(() => {});
							}
							needsRender = true;
							return { consume: true };
						}

						// r: inject result into session
						if (matchesKey(data, "r")) {
							if (w.lastAssistantText) {
								pi.sendMessage({
									customType: "swarm_result",
									content: [{
										type: "text" as const,
										text: `[Worker ${w.name} result]:\n${w.lastAssistantText}`,
									}],
									display: "all",
								});
								cleanup();
								done();
							}
							return { consume: true };
						}

						// l: open log in Zellij
						if (matchesKey(data, "l")) {
							if (inZellij) {
								pi.exec("zellij", [
									"run", "-f",
									"--name", `log:${w.name}`,
									"-c", "--",
									"tail", "-f", w.logPath,
								]).catch(() => {});
							}
							return { consume: true };
						}
					}

					return undefined;
				});

				const component: Component & { dispose(): void } = {
					render(width: number): string[] {
						const wl = workerList();
						refreshAgents();
						clampCursor();

						const output: string[] = [];
						const border = theme.fg("border", "\u2500".repeat(width));
						const headerText = ` Swarm Dashboard `;
						output.push(theme.fg("accent", theme.bold(truncateToWidth(headerText, width))));
						output.push(border);

						// Workers section
						const workersActive = section === "workers";
						const wHeader = workersActive
							? theme.bold(theme.fg("accent", ` Workers (${wl.length})`))
							: theme.fg("muted", ` Workers (${wl.length})`);
						output.push(wHeader);

						if (wl.length === 0) {
							output.push(theme.fg("dim", "   (no workers)"));
						} else {
							wl.forEach((w, i) => {
								const selected = workersActive && i === cursor;
								const prefix = selected ? theme.fg("accent", " > ") : "   ";
								const name = truncateToWidth(w.name, 16).padEnd(16);
								const status = statusIndicator(w.status);
								const age = formatAge(w.spawnedAt).padEnd(5);
								const task = w.currentTask
									? theme.fg("text", truncateToWidth(w.currentTask, width - 46))
									: theme.fg("dim", "-");
								const cost = `$${w.usage.cost.toFixed(3)}`;

								const line = `${prefix}${name} ${status.padEnd(18)} ${age} ${cost.padStart(7)}  ${task}`;
								if (selected) {
									output.push(theme.bg("selectedBg", truncateToWidth(line, width)));
								} else {
									output.push(truncateToWidth(line, width));
								}
							});
						}

						output.push("");

						// Agents section
						const agentsActive = section === "agents";
						const aHeader = agentsActive
							? theme.bold(theme.fg("accent", ` Agents (${agents.length})`))
							: theme.fg("muted", ` Agents (${agents.length})`);
						output.push(aHeader);

						if (agents.length === 0) {
							output.push(theme.fg("dim", "   (no agent definitions found)"));
						} else {
							agents.forEach((a, i) => {
								const selected = agentsActive && i === cursor;
								const prefix = selected ? theme.fg("accent", " > ") : "   ";
								const name = truncateToWidth(a.name, 16).padEnd(16);
								const model = theme.fg("muted", (a.model || "default").padEnd(20));
								const src = theme.fg("dim", `[${a.source}]`.padEnd(10));
								const desc = theme.fg("text", truncateToWidth(a.description, width - 52));

								const line = `${prefix}${name} ${model} ${src} ${desc}`;
								if (selected) {
									output.push(theme.bg("selectedBg", truncateToWidth(line, width)));
								} else {
									output.push(truncateToWidth(line, width));
								}
							});
						}

						output.push(border);

						// Footer with context-sensitive keys
						let keys: string;
						if (section === "workers" && wl.length > 0) {
							keys = "q:close  j/k:nav  Tab:section  Enter:open pane  l:log  a:abort  x:kill  r:result";
						} else if (section === "agents" && agents.length > 0) {
							keys = "q:close  j/k:nav  Tab:section  Enter:spawn worker";
						} else {
							keys = "q:close  Tab:section";
						}
						output.push(theme.fg("muted", ` ${truncateToWidth(keys, width - 2)}`));

						return output;
					},

					invalidate() {
						needsRender = false;
						tui.requestRender(true);
					},

					dispose() {
						clearInterval(refreshInterval);
						cleanup();
					},
				};

				// Auto-refresh for live status updates
				const refreshInterval = setInterval(() => {
					// Always refresh since worker status changes over time
					component.invalidate();
				}, 1000);

				// Also handle input-driven renders faster
				const inputInterval = setInterval(() => {
					if (needsRender) component.invalidate();
				}, 16);

				const origDispose = component.dispose;
				component.dispose = () => {
					clearInterval(inputInterval);
					origDispose();
				};

				return component;
			}, { overlay: true });
		},
	});

	// -- LLM Tool: delegate_task --

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: [
			"Delegate a task to a persistent swarm worker (a separate pi instance).",
			"Auto-spawns the worker if it doesn't exist.",
			"Blocks until the worker finishes and returns the worker's response.",
			"Use this for long-running work that benefits from persistent state across multiple tasks.",
			"Optionally specify an agent definition name to configure the worker's model, tools, and system prompt.",
		].join(" "),
		parameters: Type.Object({
			worker: Type.String({ description: "Worker name (auto-created if new)" }),
			task: Type.String({ description: "Task prompt to send to the worker" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
			agent: Type.Optional(Type.String({ description: "Agent definition name to configure the worker (model, tools, system prompt)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { worker: workerName, task, cwd: workerCwd, agent: agentName } = params;

			// Resolve agent definition if specified
			let agentConfig: AgentDefinition | undefined;
			if (agentName) {
				const agents = discoverAgents(ctx.cwd);
				agentConfig = agents.find((a) => a.name === agentName);
				if (!agentConfig) {
					return {
						content: [{ type: "text", text: `Agent definition "${agentName}" not found. Use /agents to list available definitions.` }],
						details: undefined,
					};
				}
			}

			// Auto-spawn if needed
			let worker = workers.get(workerName);
			if (!worker || worker.status === "dead") {
				if (worker) workers.delete(workerName);
				try {
					worker = spawnWorker(workerName, workerCwd || ctx.cwd, agentConfig);
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Failed to spawn worker: ${e.message}` }],
						details: undefined,
					};
				}
				// Brief delay for RPC mode to initialize
				await new Promise((r) => setTimeout(r, 500));
			}

			// Send task
			worker.currentTask = task;
			worker.status = "busy";
			writeLog(worker, `task: "${truncate(task, 100)}"`);
			updateUI(ctx);

			try {
				await sendRpc(worker, { type: "prompt", message: task });
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Failed to send task: ${e.message}` }],
					details: undefined,
				};
			}

			// Stream progress updates while waiting
			const progressInterval = setInterval(() => {
				if (onUpdate && worker) {
					const status = worker.status === "busy" ? "working" : worker.status;
					onUpdate({
						content: [
							{
								type: "text",
								text: `[${workerName}] ${status}: ${worker.usage.turns} turns, ${formatTokens(worker.usage.input)} in, $${worker.usage.cost.toFixed(3)}`,
							},
						],
						details: undefined,
					});
				}
			}, 2000);

			try {
				await waitForWorkerIdle(worker, signal);
			} catch (e: any) {
				clearInterval(progressInterval);
				// If aborted, try to abort the worker too
				if (signal?.aborted) {
					sendRpc(worker, { type: "abort" }).catch(() => {});
				}
				return {
					content: [{ type: "text", text: `Worker interrupted: ${e.message}` }],
					details: undefined,
				};
			}

			clearInterval(progressInterval);

			const result = worker.lastAssistantText || "(no output)";
			worker.currentTask = undefined;

			return {
				content: [{ type: "text", text: result }],
				details: undefined,
			};
		},
	});

	// -- LLM Tool: subagent (ephemeral) --

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Run ephemeral one-shot subagent(s) for quick tasks.",
			"Spawns a temporary pi instance that processes the task and exits.",
			"Three modes (exactly one required): single task, parallel tasks, or chained tasks.",
			"Use this for quick, focused tasks. For long-running work, use delegate_task instead.",
		].join(" "),
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent definition name (default for all tasks if not overridden per-task)" })),
			task: Type.Optional(Type.String({ description: "Single task prompt (mutually exclusive with tasks/chain)" })),
			tasks: Type.Optional(Type.Array(
				Type.Object({
					agent: Type.Optional(Type.String({ description: "Agent definition override for this task" })),
					task: Type.String({ description: "Task prompt" }),
				}),
				{ description: "Parallel tasks (max 8, 4 concurrent). Mutually exclusive with task/chain." },
			)),
			chain: Type.Optional(Type.Array(
				Type.Object({
					agent: Type.Optional(Type.String({ description: "Agent definition override for this step" })),
					task: Type.String({ description: "Task prompt. Use {previous} to reference the previous step's output." }),
				}),
				{ description: "Sequential chain of tasks. {previous} is replaced with prior step output. Mutually exclusive with task/tasks." },
			)),
			cwd: Type.Optional(Type.String({ description: "Working directory override" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { agent: defaultAgentName, task, tasks, chain, cwd: overrideCwd } = params;
			const workingDir = overrideCwd || ctx.cwd;

			// Validate exactly one mode
			const modes = [task, tasks, chain].filter(Boolean).length;
			if (modes !== 1) {
				return {
					content: [{ type: "text", text: "Specify exactly one of: task (single), tasks (parallel), or chain (sequential)." }],
					details: undefined,
				};
			}

			const agents = discoverAgents(ctx.cwd);
			let ephemeralCounter = 0;

			function resolveAgent(name?: string): AgentDefinition | undefined {
				const n = name || defaultAgentName;
				if (!n) return undefined;
				return agents.find((a) => a.name === n);
			}

			function makeLabel(agentName?: string, suffix?: string): string {
				const base = agentName || defaultAgentName || "anon";
				const id = `${base}-${Date.now()}-${ephemeralCounter++}`;
				return suffix ? `${id}-${suffix}` : id;
			}

			function openLogPane(logPath: string, label: string): void {
				if (!inZellij) return;
				pi.exec("zellij", [
					"run", "-f",
					"--name", `subagent:${label}`,
					"-c", "--",
					"tail", "-f", logPath,
				]).catch(() => {});
			}

			function buildOpts(agentName?: string, extra?: {
				logPath?: string;
				onProgress?: (text: string) => void;
			}): {
				cwd: string;
				model?: string;
				tools?: string[];
				systemPrompt?: string;
				signal?: AbortSignal;
				logPath?: string;
				onProgress?: (text: string) => void;
			} {
				const agent = resolveAgent(agentName);
				return {
					cwd: workingDir,
					model: agent?.model,
					tools: agent?.tools,
					systemPrompt: agent?.systemPrompt,
					signal: signal || undefined,
					...extra,
				};
			}

			// -- Single mode --
			if (task) {
				const agentDef = resolveAgent();
				if (defaultAgentName && !agentDef) {
					return {
						content: [{ type: "text", text: `Agent definition "${defaultAgentName}" not found. Use /agents to list available definitions.` }],
						details: undefined,
					};
				}

				const label = makeLabel();
				const logPath = path.join(SWARM_LOG_DIR, `${label}.log`);
				fs.writeFileSync(logPath, "");
				openLogPane(logPath, label);

				const result = await runEphemeral(task, buildOpts(undefined, {
					logPath,
					onProgress: (text) => {
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text", text: `[${defaultAgentName || "subagent"}] ${text}` }],
								details: undefined,
							});
						}
					},
				}));
				return {
					content: [{
						type: "text",
						text: `${result.text}\n\n---\n[${result.durationMs}ms | ${formatTokens(result.usage.input)} in, ${formatTokens(result.usage.output)} out, $${result.usage.cost.toFixed(3)} | log: ${logPath}]`,
					}],
					details: undefined,
				};
			}

			// -- Parallel mode --
			if (tasks) {
				if (tasks.length > 8) {
					return {
						content: [{ type: "text", text: "Maximum 8 parallel tasks allowed." }],
						details: undefined,
					};
				}

				const results = await mapWithConcurrencyLimit(tasks, 4, async (item, idx) => {
					const itemAgent = item.agent || defaultAgentName;
					const label = makeLabel(itemAgent, `t${idx}`);
					const logPath = path.join(SWARM_LOG_DIR, `${label}.log`);
					fs.writeFileSync(logPath, "");
					openLogPane(logPath, label);

					return runEphemeral(item.task, buildOpts(item.agent, {
						logPath,
						onProgress: (text) => {
							if (onUpdate) {
								onUpdate({
									content: [{ type: "text", text: `[task ${idx + 1}/${tasks.length}] ${text}` }],
									details: undefined,
								});
							}
						},
					}));
				});

				const combined = results.map((r, i) => {
					const logInfo = r.logPath ? ` | log: ${r.logPath}` : "";
					return `## Task ${i + 1}\n${r.text}\n[${r.durationMs}ms | $${r.usage.cost.toFixed(3)}${logInfo}]`;
				}).join("\n\n");

				const totalCost = results.reduce((sum, r) => sum + r.usage.cost, 0);
				return {
					content: [{
						type: "text",
						text: `${combined}\n\n---\nTotal: ${results.length} tasks, $${totalCost.toFixed(3)}`,
					}],
					details: undefined,
				};
			}

			// -- Chain mode --
			if (chain) {
				let previous = "";
				let lastResult: EphemeralResult | undefined;

				for (let i = 0; i < chain.length; i++) {
					const step = chain[i];
					const prompt = step.task.replace(/\{previous\}/g, previous);

					const stepAgent = step.agent || defaultAgentName;
					const label = makeLabel(stepAgent, `s${i}`);
					const logPath = path.join(SWARM_LOG_DIR, `${label}.log`);
					fs.writeFileSync(logPath, "");
					openLogPane(logPath, label);

					lastResult = await runEphemeral(prompt, buildOpts(step.agent, {
						logPath,
						onProgress: (text) => {
							if (onUpdate) {
								onUpdate({
									content: [{ type: "text", text: `[chain ${i + 1}/${chain.length}] ${text}` }],
									details: undefined,
								});
							}
						},
					}));
					previous = lastResult.text;
				}

				if (!lastResult) {
					return {
						content: [{ type: "text", text: "Chain was empty." }],
						details: undefined,
					};
				}

				const logInfo = lastResult.logPath ? ` | log: ${lastResult.logPath}` : "";
				return {
					content: [{
						type: "text",
						text: `${lastResult.text}\n\n---\n[chain: ${chain.length} steps, ${lastResult.durationMs}ms last step, $${lastResult.usage.cost.toFixed(3)} last step${logInfo}]`,
					}],
					details: undefined,
				};
			}

			return {
				content: [{ type: "text", text: "No task specified." }],
				details: undefined,
			};
		},
	});

	// -- System prompt injection --

	pi.on("before_agent_start", async (_event, ctx) => {
		latestCtx = ctx;

		const agents = discoverAgents(ctx.cwd);
		const hasAgents = agents.length > 0;
		const hasWorkers = workers.size > 0;

		if (!hasAgents && !hasWorkers) return;

		let injection = "";

		if (hasAgents) {
			const agentList = agents
				.map((a) => `- **${a.name}**: ${a.description} (model: ${a.model || "default"}, tools: ${a.tools ? a.tools.join(",") : "all"})`)
				.join("\n");
			injection += `\n\n## Available Agent Definitions\n\n${agentList}`;
		}

		if (hasWorkers) {
			const workerList = [...workers.values()]
				.map((w) => `- ${w.name}: ${w.status}${w.currentTask ? ` (task: ${truncate(w.currentTask, 60)})` : ""}`)
				.join("\n");
			injection += `\n\n## Active Swarm Workers\n\n${workerList}`;
		}

		injection += "\n\n## Swarm Usage Guide\n\n";
		injection += "- Use the **subagent** tool for quick, ephemeral one-shot tasks (search, review, analysis). The agent processes the task and exits.\n";
		injection += "- Use the **delegate_task** tool for persistent, long-running work that benefits from maintaining state across multiple interactions.\n";
		if (hasAgents) {
			injection += `- Both tools accept an optional \`agent\` parameter to use a named agent definition (${agents.map((a) => a.name).join(", ")}).`;
		}

		return {
			systemPrompt: ctx.getSystemPrompt() + injection,
		};
	});

	// Keep latestCtx updated on other events too
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateUI(ctx);
	});

	// -- Graceful shutdown --

	pi.on("session_shutdown", async () => {
		await killAllWorkers();
	});
}
