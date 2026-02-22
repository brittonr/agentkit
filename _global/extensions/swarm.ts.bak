import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Container, isKeyRelease, Markdown, matchesKey, Spacer, Text, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
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
	model?: string;
	toolCalls: { name: string; args: Record<string, any> }[];
}

interface SubagentResultItem {
	agent: string;
	task: string;
	text: string;
	model?: string;
	usage: { input: number; output: number; cost: number };
	durationMs: number;
	logPath?: string;
	step?: number;
	toolCalls: { name: string; args: Record<string, any> }[];
	isError: boolean;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SubagentResultItem[];
}

interface DelegateDetails {
	worker: string;
	agent?: string;
	task: string;
	text: string;
	usage: { turns: number; input: number; output: number; cost: number };
	durationMs: number;
	isError: boolean;
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
	worktreePath?: string;
	originalCwd: string;
}

// -- Git Worktree helpers --

const EXEC_OPTS = { stdio: ["pipe", "pipe", "pipe"] as const, timeout: 10000 };

function git(args: string[], cwd: string, timeout?: number): string {
	return execFileSync("git", args, { ...EXEC_OPTS, cwd, timeout: timeout ?? 10000 }).toString().trim();
}

function isGitRepo(cwd: string): boolean {
	try {
		return git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
	} catch {
		return false;
	}
}

function getGitToplevel(cwd: string): string | null {
	try {
		return git(["rev-parse", "--show-toplevel"], cwd);
	} catch {
		return null;
	}
}

function getWorktreeBase(toplevel: string): string {
	return path.join(os.tmpdir(), "pi-worktrees", path.basename(toplevel));
}

function createWorktree(name: string, baseCwd: string, opts?: {
	ref?: string;
	newBranch?: string;
}): string | null {
	if (!isGitRepo(baseCwd)) return null;

	const toplevel = getGitToplevel(baseCwd);
	if (!toplevel) return null;

	const worktreeBase = getWorktreeBase(toplevel);
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const worktreePath = path.join(worktreeBase, safeName);

	try {
		fs.mkdirSync(worktreeBase, { recursive: true });

		// Remove stale worktree at this path if it exists
		try {
			git(["worktree", "remove", "--force", worktreePath], toplevel);
		} catch {
			// Not a worktree or doesn't exist
		}

		const ref = opts?.ref || "HEAD";
		if (opts?.newBranch) {
			git(["worktree", "add", "-b", opts.newBranch, worktreePath, ref], toplevel, 30000);
		} else {
			git(["worktree", "add", "--detach", worktreePath, ref], toplevel, 30000);
		}

		return worktreePath;
	} catch {
		return null;
	}
}

function removeWorktree(worktreePath: string, baseCwd: string): void {
	const toplevel = getGitToplevel(baseCwd);
	if (!toplevel) return;

	try {
		git(["worktree", "remove", "--force", worktreePath], toplevel);
	} catch {
		// Best-effort: rm + prune
		try {
			fs.rmSync(worktreePath, { recursive: true, force: true });
			git(["worktree", "prune"], toplevel, 5000);
		} catch {
			// ignore
		}
	}
}

interface WorktreeInfo {
	name: string;
	path: string;
	head: string;
	branch: string | null;
	dirty: boolean;
}

function listWorktrees(baseCwd: string): WorktreeInfo[] {
	const toplevel = getGitToplevel(baseCwd);
	if (!toplevel) return [];

	const worktreeBase = getWorktreeBase(toplevel);
	if (!fs.existsSync(worktreeBase)) return [];

	const results: WorktreeInfo[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(worktreeBase);
	} catch {
		return [];
	}

	for (const name of entries) {
		const wtPath = path.join(worktreeBase, name);
		try {
			const stat = fs.statSync(wtPath);
			if (!stat.isDirectory()) continue;

			let head = "unknown";
			let branch: string | null = null;
			let dirty = false;

			try {
				head = git(["rev-parse", "--short", "HEAD"], wtPath).slice(0, 7);
			} catch { /* ignore */ }
			try {
				branch = git(["symbolic-ref", "--short", "HEAD"], wtPath);
			} catch {
				branch = null; // detached HEAD
			}
			try {
				const status = git(["status", "--porcelain"], wtPath);
				dirty = status.length > 0;
			} catch { /* ignore */ }

			results.push({ name, path: wtPath, head, branch, dirty });
		} catch {
			// skip entries we can't stat
		}
	}

	return results;
}

function removeAllWorktrees(baseCwd: string): number {
	const wts = listWorktrees(baseCwd);
	let removed = 0;
	for (const wt of wts) {
		removeWorktree(wt.path, baseCwd);
		removed++;
	}
	return removed;
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
		try {
			worker.proc.stdin.write(payload);
		} catch (err: any) {
			worker.pendingRequests.delete(id);
			clearTimeout(timer);
			reject(new Error(`Worker stdin write failed: ${err.message}`));
		}
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
		writeLog(worker, `unparseable: ${truncate(line, 120)}`);
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
	let ephemeralWorktree: string | undefined;
	const originalCwd = opts.cwd;

	try {
		// Set up log file
		if (opts.logPath) {
			logFd = fs.openSync(opts.logPath, "a");
			writeToFd(logFd, `task: "${truncate(task, 200)}"`);
		}

		// Create git worktree for isolation
		const wtName = `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const wt = createWorktree(wtName, originalCwd);
		if (wt) {
			ephemeralWorktree = wt;
			opts = { ...opts, cwd: wt };
			if (logFd !== undefined) writeToFd(logFd, `worktree: ${wt}`);
		}

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
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
			env: { ...process.env, [SWARM_DEPTH_ENV]: String(swarmDepth + 1) },
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
		let model: string | undefined;
		const toolCalls: { name: string; args: Record<string, any> }[] = [];

		const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

		for await (const line of rl) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				switch (event.type) {
					case "tool_execution_start": {
						const toolName = event.toolName || "unknown";
						toolCalls.push({ name: toolName, args: event.args || {} });
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
						if (msg?.model && !model) model = msg.model;
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

		// Wait for process exit (also handle spawn errors where 'exit' never fires)
		await new Promise<void>((resolve, reject) => {
			if (proc.exitCode !== null) {
				resolve();
			} else {
				proc.on("exit", () => resolve());
				proc.on("error", (err) => reject(new Error(`Failed to spawn pi: ${err.message}`)));
			}
		});

		const durationMs = Date.now() - start;
		if (logFd !== undefined) {
			writeToFd(logFd, `done (${durationMs}ms, ${formatTokens(usage.input)} in, ${formatTokens(usage.output)} out, $${usage.cost.toFixed(3)})`);
		}

		return { text: text || "(no output)", usage, durationMs, logPath: opts.logPath, model, toolCalls };
	} finally {
		if (tempFile) {
			try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
		}
		if (logFd !== undefined) {
			try { fs.closeSync(logFd); } catch { /* ignore */ }
		}
		// Clean up ephemeral worktree
		if (ephemeralWorktree) {
			removeWorktree(ephemeralWorktree, originalCwd);
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

// -- Rendering helpers --

const COLLAPSED_TOOL_COUNT = 8;

function formatToolCallDisplay(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function formatUsageStats(
	usage: { input: number; output: number; cost: number; turns?: number },
	extras?: { durationMs?: number; model?: string; logPath?: string },
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (extras?.durationMs) parts.push(`${extras.durationMs}ms`);
	if (extras?.model) parts.push(extras.model);
	if (extras?.logPath) parts.push(`log: ${extras.logPath}`);
	return parts.join(" ");
}

function renderToolCalls(
	toolCalls: { name: string; args: Record<string, any> }[],
	themeFg: (color: any, text: string) => string,
	limit?: number,
): string {
	const toShow = limit ? toolCalls.slice(-limit) : toolCalls;
	const skipped = limit && toolCalls.length > limit ? toolCalls.length - limit : 0;
	let text = "";
	if (skipped > 0) text += themeFg("muted", `... ${skipped} earlier tool calls\n`);
	for (const tc of toShow) {
		text += themeFg("muted", "→ ") + formatToolCallDisplay(tc.name, tc.args, themeFg) + "\n";
	}
	return text.trimEnd();
}

// -- Extension entry point --

const MAX_SWARM_DEPTH = 3;
const SWARM_DEPTH_ENV = "PI_SWARM_DEPTH";

function currentSwarmDepth(): number {
	const raw = process.env[SWARM_DEPTH_ENV];
	if (!raw) return 0;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

export default function (pi: ExtensionAPI) {
	const swarmDepth = currentSwarmDepth();

	// At the nesting cap — register nothing so workers can't spawn deeper.
	if (swarmDepth >= MAX_SWARM_DEPTH) return;

	const workers = new Map<string, Worker>();
	const inZellij = !!process.env.ZELLIJ_SESSION_NAME;

	const SWARM_LOG_DIR = path.join(os.homedir(), ".pi", "agent", "swarm-logs");
	fs.mkdirSync(SWARM_LOG_DIR, { recursive: true });

	// Prune log files older than 7 days on startup
	const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
	try {
		const now = Date.now();
		for (const file of fs.readdirSync(SWARM_LOG_DIR)) {
			if (!file.endsWith(".log")) continue;
			const filePath = path.join(SWARM_LOG_DIR, file);
			try {
				const stat = fs.statSync(filePath);
				if (now - stat.mtimeMs > LOG_MAX_AGE_MS) {
					fs.unlinkSync(filePath);
				}
			} catch { /* skip files we can't stat/remove */ }
		}
	} catch { /* non-fatal: log dir scan failed */ }

	// -- UI helpers --

	function updateUI(ctx: any) {
		if (!ctx?.hasUI) return;

		// Status bar — exclude dead workers (they're removed from map on exit,
		// but guard against transient states during cleanup)
		const alive = [...workers.values()].filter((w) => w.status !== "dead");
		const total = alive.length;
		const busy = alive.filter((w) => w.status === "busy").length;
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

		const originalCwd = cwd;
		const logPath = path.join(SWARM_LOG_DIR, `${name}.log`);
		const logFd = fs.openSync(logPath, "w");

		// Create git worktree for isolation
		let worktreePath: string | undefined;
		const wt = createWorktree(`worker-${name}`, cwd);
		if (wt) {
			worktreePath = wt;
			cwd = wt;
			writeToFd(logFd, `worktree: ${wt}`);
		}

		const args = [
			"--mode", "rpc",
			"--no-session",
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

		let proc: ChildProcess;
		let rl: readline.Interface;
		try {
			proc = spawn("pi", args, {
				cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, [SWARM_DEPTH_ENV]: String(swarmDepth + 1) },
			});
			rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
		} catch (e) {
			// Clean up resources allocated before the failed spawn
			try { fs.closeSync(logFd); } catch { /* ignore */ }
			if (agentTempFile) {
				try { fs.unlinkSync(agentTempFile); } catch { /* ignore */ }
			}
			if (worktreePath) {
				removeWorktree(worktreePath, originalCwd);
			}
			throw e;
		}

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
			worktreePath,
			originalCwd,
		};

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

		// Handle spawn error (e.g., pi binary not found — 'exit' may not fire)
		proc.on("error", (err) => {
			writeLog(worker, `spawn error: ${err.message}`);
			// Trigger the same cleanup as exit
			if (worker.status !== "dead") {
				worker.status = "dead";
				for (const [id, pending] of worker.pendingRequests) {
					clearTimeout(pending.timer);
					pending.reject(new Error(`Worker "${name}" spawn failed: ${err.message}`));
				}
				worker.pendingRequests.clear();
				try { worker.rl.close(); } catch { /* ignore */ }
				try { fs.closeSync(worker.logFd); } catch { /* ignore */ }
				if (worker.agentTempFile) {
					try { fs.unlinkSync(worker.agentTempFile); } catch { /* ignore */ }
					worker.agentTempFile = undefined;
				}
				if (worker.worktreePath) {
					removeWorktree(worker.worktreePath, worker.originalCwd);
					worker.worktreePath = undefined;
				}
				workers.delete(name);
				updateUI(latestCtx);
			}
		});

		// Handle exit — full cleanup so naturally-dying workers don't leak resources
		proc.on("exit", (code) => {
			worker.status = "dead";
			writeLog(worker, `exited (code ${code})`);

			// Reject all pending requests
			for (const [id, pending] of worker.pendingRequests) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`Worker "${name}" exited with code ${code}`));
			}
			worker.pendingRequests.clear();

			// Close readline interface
			try { worker.rl.close(); } catch { /* ignore */ }

			// Close log fd
			try { fs.closeSync(worker.logFd); } catch { /* ignore */ }

			// Clean up temp system-prompt file
			if (worker.agentTempFile) {
				try { fs.unlinkSync(worker.agentTempFile); } catch { /* ignore */ }
				worker.agentTempFile = undefined;
			}

			// Clean up git worktree
			if (worker.worktreePath) {
				removeWorktree(worker.worktreePath, worker.originalCwd);
				worker.worktreePath = undefined;
			}

			// Remove from map so dead workers don't accumulate
			workers.delete(name);

			updateUI(latestCtx);
		});

		workers.set(name, worker);

		writeLog(worker, `started (cwd: ${cwd}${worktreePath ? `, worktree: ${worktreePath}` : ""})`);

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

		// Idempotent cleanup — exit handler may have already done these
		try { worker.rl.close(); } catch { /* ignore */ }

		if (worker.agentTempFile) {
			try { fs.unlinkSync(worker.agentTempFile); } catch { /* ignore */ }
			worker.agentTempFile = undefined;
		}

		if (worker.worktreePath) {
			removeWorktree(worker.worktreePath, worker.originalCwd);
			worker.worktreePath = undefined;
		}

		workers.delete(name);
		updateUI(latestCtx);
	}

	async function killAllWorkers(): Promise<void> {
		const names = [...workers.keys()];
		await Promise.all(names.map((n) => killWorker(n)));
	}

	function waitForWorkerIdle(worker: Worker, signal?: AbortSignal): Promise<void> {
		if (worker.status === "idle") return Promise.resolve();
		if (worker.status === "dead") return Promise.reject(new Error("Worker died"));

		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearInterval(checkInterval);
				reject(new Error("Aborted"));
			};

			const checkInterval = setInterval(() => {
				if (worker.status === "idle") {
					clearInterval(checkInterval);
					if (signal) signal.removeEventListener("abort", onAbort);
					resolve();
				} else if (worker.status === "dead") {
					clearInterval(checkInterval);
					if (signal) signal.removeEventListener("abort", onAbort);
					reject(new Error("Worker died during task execution"));
				}
			}, 200);

			if (signal) {
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
				// Reset status — task was never delivered
				worker.status = "idle";
				worker.currentTask = undefined;
				updateUI(ctx);
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
				type ViewMode = "dashboard" | "log";
				let viewMode: ViewMode = "dashboard";
				let section: Section = workers.size > 0 ? "workers" : "agents";
				let cursor = 0;
				let componentRef: (Component & { dispose(): void; invalidate(): void }) | null = null;
				let agents: AgentDefinition[] = [];

				// Log viewer state
				let logWorkerName = "";
				let logLines: string[] = [];
				let logScroll = 0; // offset from bottom (0 = tailing)
				let logFollow = true; // auto-scroll to bottom

				function openLogView(worker: Worker) {
					logWorkerName = worker.name;
					logLines = [];
					logScroll = 0;
					logFollow = true;
					refreshLog();
					viewMode = "log";
					componentRef?.invalidate();
				}

				function closeLogView() {
					viewMode = "dashboard";
					componentRef?.invalidate();
				}

				const MAX_LOG_LINES = 5000; // cap in-memory log lines

				function refreshLog() {
					try {
						const logFilePath = path.join(SWARM_LOG_DIR, `${logWorkerName}.log`);
						const stat = fs.statSync(logFilePath);
						// For large files, only read the tail (estimate ~120 bytes/line)
						const readBytes = Math.min(stat.size, MAX_LOG_LINES * 120);
						const fd = fs.openSync(logFilePath, "r");
						try {
							const buf = Buffer.alloc(readBytes);
							const offset = Math.max(0, stat.size - readBytes);
							fs.readSync(fd, buf, 0, readBytes, offset);
							const content = buf.toString("utf-8");
							logLines = content.split("\n");
							// If we started mid-file, drop the first partial line
							if (offset > 0 && logLines.length > 0) logLines.shift();
							// Remove trailing empty line from split
							if (logLines.length > 0 && logLines[logLines.length - 1] === "") {
								logLines.pop();
							}
						} finally {
							fs.closeSync(fd);
						}
					} catch {
						logLines = ["(unable to read log file)"];
					}
				}

				let agentsLastRefresh = 0;
				const AGENT_REFRESH_INTERVAL = 5000; // re-scan at most every 5s

				function refreshAgents() {
					const now = Date.now();
					if (now - agentsLastRefresh < AGENT_REFRESH_INTERVAL) return;
					agents = discoverAgents(ctx.cwd);
					agentsLastRefresh = now;
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

				function statusIndicator(status: WorkerStatus): { styled: string; raw: string } {
					switch (status) {
						case "idle": return { styled: theme.fg("success", "idle"), raw: "idle" };
						case "busy": return { styled: theme.fg("warning", "busy"), raw: "busy" };
						case "starting": return { styled: theme.fg("accent", "starting"), raw: "starting" };
						case "dead": return { styled: theme.fg("error", "dead"), raw: "dead" };
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

					// -- Log viewer mode --
					if (viewMode === "log") {
						if (matchesKey(data, "q") || matchesKey(data, "escape")) {
							closeLogView();
							return { consume: true };
						}
						if (matchesKey(data, "j") || matchesKey(data, "down")) {
							if (logScroll > 0) {
								logScroll--;
								if (logScroll === 0) logFollow = true;
							}
							componentRef?.invalidate();
							return { consume: true };
						}
						if (matchesKey(data, "k") || matchesKey(data, "up")) {
							logScroll = Math.min(logScroll + 1, Math.max(0, logLines.length - 1));
							logFollow = false;
							componentRef?.invalidate();
							return { consume: true };
						}
						// Page down
						if (matchesKey(data, "ctrl+d")) {
							logScroll = Math.max(0, logScroll - 15);
							if (logScroll === 0) logFollow = true;
							componentRef?.invalidate();
							return { consume: true };
						}
						// Page up
						if (matchesKey(data, "ctrl+u")) {
							logScroll = Math.min(logScroll + 15, Math.max(0, logLines.length - 1));
							logFollow = false;
							componentRef?.invalidate();
							return { consume: true };
						}
						// Go to bottom (tail)
						if (matchesKey(data, "shift+g")) {
							logScroll = 0;
							logFollow = true;
							componentRef?.invalidate();
							return { consume: true };
						}
						// Go to top
						if (matchesKey(data, "g")) {
							logScroll = Math.max(0, logLines.length - 1);
							logFollow = false;
							componentRef?.invalidate();
							return { consume: true };
						}
						// Toggle follow mode
						if (matchesKey(data, "f")) {
							logFollow = !logFollow;
							if (logFollow) logScroll = 0;
							componentRef?.invalidate();
							return { consume: true };
						}
						return { consume: true }; // Consume all input in log view
					}

					// -- Dashboard mode --

					// Close
					if (matchesKey(data, "q") || matchesKey(data, "escape")) {
						cleanup();
						done();
						return { consume: true };
					}

					// Navigate
					if (matchesKey(data, "j") || matchesKey(data, "down")) {
						cursor = Math.min(cursor + 1, Math.max(0, sectionLength() - 1));
						componentRef?.invalidate();
						return { consume: true };
					}
					if (matchesKey(data, "k") || matchesKey(data, "up")) {
						cursor = Math.max(0, cursor - 1);
						componentRef?.invalidate();
						return { consume: true };
					}

					// Switch section
					if (matchesKey(data, "tab")) {
						section = section === "workers" ? "agents" : "workers";
						cursor = 0;
						componentRef?.invalidate();
						return { consume: true };
					}

					// Enter: open log (worker) or spawn worker (agent)
					if (matchesKey(data, "enter")) {
						if (section === "workers") {
							const w = workerList()[cursor];
							if (w) openLogView(w);
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
						componentRef?.invalidate();
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
								componentRef?.invalidate();
							});
							return { consume: true };
						}

						// a: abort current task
						if (matchesKey(data, "a")) {
							if (w.status === "busy") {
								sendRpc(w, { type: "abort" }).catch(() => {});
							}
							componentRef?.invalidate();
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

						// l: open log viewer
						if (matchesKey(data, "l")) {
							openLogView(w);
							return { consume: true };
						}
					}

					return undefined;
				});

				function renderDashboard(width: number): string[] {
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
								const { styled: status, raw: statusRaw } = statusIndicator(w.status);
								const statusPad = " ".repeat(Math.max(0, 10 - statusRaw.length));
								const age = formatAge(w.spawnedAt).padEnd(5);
								const task = w.currentTask
									? theme.fg("text", truncateToWidth(w.currentTask, width - 46))
									: theme.fg("dim", "-");
								const cost = `$${w.usage.cost.toFixed(3)}`;

								const line = `${prefix}${name} ${status}${statusPad} ${age} ${cost.padStart(7)}  ${task}`;
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
							keys = "q:close  j/k:nav  Tab:section  Enter/l:log  a:abort  x:kill  r:result";
						} else if (section === "agents" && agents.length > 0) {
							keys = "q:close  j/k:nav  Tab:section  Enter:spawn worker";
						} else {
							keys = "q:close  Tab:section";
						}
						output.push(theme.fg("muted", ` ${truncateToWidth(keys, width - 2)}`));

						return output;
					}

					function renderLogView(width: number): string[] {
						refreshLog();
						const output: string[] = [];
						const border = theme.fg("border", "\u2500".repeat(width));

						// Header
						const w = workers.get(logWorkerName);
						const statusStr = w ? ` [${w.status}]` : " [dead]";
						const followStr = logFollow
							? theme.fg("success", " \u25CF following")
							: theme.fg("dim", " \u25CB paused");
						const headerText = ` Log: ${logWorkerName}${statusStr}`;
						output.push(theme.fg("accent", theme.bold(truncateToWidth(headerText, width - 14))) + followStr);
						output.push(border);

						// Calculate visible area (reserve 2 for header, 1 for border, 1 for footer)
						const viewHeight = Math.max(1, (tui.terminal.rows || 24) - 4);

						if (logLines.length === 0) {
							output.push(theme.fg("dim", " (empty log)"));
							for (let i = 1; i < viewHeight; i++) output.push("");
						} else {
							// Determine the visible window
							const endIdx = logLines.length - logScroll;
							const startIdx = Math.max(0, endIdx - viewHeight);
							const visible = logLines.slice(startIdx, endIdx);

							// Pad if fewer lines than viewport
							for (let i = visible.length; i < viewHeight; i++) {
								output.push("");
							}

							for (const line of visible) {
								// Colorize timestamps
								const styled = line.replace(
									/^\[(\d{2}:\d{2}:\d{2})\]/,
									(_, ts) => theme.fg("dim", `[${ts}]`),
								);
								output.push(truncateToWidth(` ${styled}`, width));
							}
						}

						output.push(border);

						// Footer
						const pos = logLines.length > 0
							? `${logLines.length - logScroll}/${logLines.length}`
							: "0/0";
						const keys = `q/Esc:back  j/k:scroll  ^d/^u:page  g/G:top/bottom  f:follow  ${theme.fg("dim", pos)}`;
						output.push(theme.fg("muted", ` ${truncateToWidth(keys, width - 2)}`));

						return output;
					}

				const component: Component & { dispose(): void; invalidate(): void } = {
					render(width: number): string[] {
						if (viewMode === "log") return renderLogView(width);
						return renderDashboard(width);
					},

					invalidate() {
						tui.requestRender(true);
					},

					dispose() {
						clearInterval(refreshInterval);
						componentRef = null;
						cleanup();
					},
				};

				componentRef = component;

				// Auto-refresh for live status updates (worker status, log tailing)
				const refreshInterval = setInterval(() => {
					component.invalidate();
				}, 1000);

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
			const startTime = Date.now();

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

				// Confirm before running project-local agents
				if (agentConfig.source === "project" && ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Run project-local agent?",
						`Agent: ${agentConfig.name}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agent not approved." }],
							details: undefined,
						};
					}
				}
			}

			// Auto-spawn if needed
			let worker = workers.get(workerName);
			let agentIgnored = false;
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
			} else if (agentName) {
				// Worker already exists — agent config is ignored
				agentIgnored = true;
			}

			// Snapshot usage before task to compute per-task delta
			const usageBefore = {
				turns: worker.usage.turns,
				input: worker.usage.input,
				output: worker.usage.output,
				cost: worker.usage.cost,
			};

			// Send task — clear stale text so we don't return a previous task's output
			worker.lastAssistantText = undefined;
			worker.currentTask = task;
			worker.status = "busy";
			writeLog(worker, `task: "${truncate(task, 100)}"`);
			updateUI(ctx);

			try {
				await sendRpc(worker, { type: "prompt", message: task });
			} catch (e: any) {
				// Reset status — task was never delivered
				worker.status = "idle";
				worker.currentTask = undefined;
				updateUI(ctx);
				return {
					content: [{ type: "text", text: `Failed to send task: ${e.message}` }],
					details: undefined,
				};
			}

			// Stream progress updates while waiting
			const progressInterval = setInterval(() => {
				try {
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
				} catch { /* non-fatal: progress update failed */ }
			}, 2000);

			try {
				await waitForWorkerIdle(worker, signal);
			} catch (e: any) {
				clearInterval(progressInterval);
				// If aborted, try to abort the worker too
				if (signal?.aborted) {
					sendRpc(worker, { type: "abort" }).catch(() => {});
				}
				const partialText = worker.lastAssistantText || "(no output)";
				const errorDetails: DelegateDetails = {
					worker: workerName,
					agent: agentIgnored ? undefined : agentName,
					task,
					text: partialText,
					usage: {
						turns: worker.usage.turns - usageBefore.turns,
						input: worker.usage.input - usageBefore.input,
						output: worker.usage.output - usageBefore.output,
						cost: worker.usage.cost - usageBefore.cost,
					},
					durationMs: Date.now() - startTime,
					isError: true,
				};
				return {
					content: [{ type: "text", text: `Worker interrupted: ${e.message}\n\nPartial output:\n${partialText}` }],
					details: errorDetails,
				};
			}

			clearInterval(progressInterval);

			let result = worker.lastAssistantText || "(no output)";
			worker.currentTask = undefined;

			if (agentIgnored) {
				result = `Note: Worker "${workerName}" already existed — agent "${agentName}" config was ignored. Kill the worker first to apply a different agent.\n\n${result}`;
			}

			const delegateDetails: DelegateDetails = {
				worker: workerName,
				agent: agentIgnored ? undefined : agentName,
				task,
				text: result,
				usage: {
					turns: worker.usage.turns - usageBefore.turns,
					input: worker.usage.input - usageBefore.input,
					output: worker.usage.output - usageBefore.output,
					cost: worker.usage.cost - usageBefore.cost,
				},
				durationMs: Date.now() - startTime,
				isError: false,
			};
			return {
				content: [{ type: "text", text: result }],
				details: delegateDetails,
			};
		},

		renderCall(args: any, theme: any) {
			const workerName = args.worker || "...";
			const agentName = args.agent;
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text = theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", workerName);
			if (agentName) text += theme.fg("muted", ` (${agentName})`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
			const details = result.details as DelegateDetails | undefined;
			if (!details) {
				const text = result.content?.[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const icon = details.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

			if (expanded) {
				const container = new Container();
				let header = `${icon} ${theme.fg("toolTitle", theme.bold(details.worker))}`;
				if (details.agent) header += theme.fg("muted", ` (${details.agent})`);
				container.addChild(new Text(header, 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
				if (details.text && details.text !== "(no output)") {
					container.addChild(new Markdown(details.text.trim(), 0, 0, mdTheme));
				} else {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				}
				const usageStr = formatUsageStats(details.usage, { durationMs: details.durationMs });
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				return container;
			}

			// Collapsed
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.worker))}`;
			if (details.agent) text += theme.fg("muted", ` (${details.agent})`);
			if (details.text && details.text !== "(no output)") {
				const preview = details.text.split("\n").slice(0, 3).join("\n");
				text += `\n${theme.fg("toolOutput", preview)}`;
			} else {
				text += `\n${theme.fg("muted", "(no output)")}`;
			}
			const usageStr = formatUsageStats(details.usage, { durationMs: details.durationMs });
			if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			return new Text(text, 0, 0);
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

			// Check for project-local agents and confirm if needed
			const projectAgentsUsed = new Set<string>();
			const checkAgent = (name?: string) => {
				const n = name || defaultAgentName;
				if (!n) return;
				const a = agents.find((ag) => ag.name === n);
				if (a?.source === "project") projectAgentsUsed.add(a.name);
			};
			if (task) checkAgent();
			if (tasks) for (const t of tasks) checkAgent(t.agent);
			if (chain) for (const c of chain) checkAgent(c.agent);

			if (projectAgentsUsed.size > 0 && ctx.hasUI) {
				const names = [...projectAgentsUsed].join(", ");
				const ok = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${names}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
						details: undefined,
					};
				}
			}

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
				const singleDetails: SubagentDetails = {
					mode: "single",
					results: [{
						agent: defaultAgentName || "anon",
						task,
						text: result.text,
						model: result.model,
						usage: result.usage,
						durationMs: result.durationMs,
						logPath,
						toolCalls: result.toolCalls,
						isError: false,
					}],
				};
				return {
					content: [{ type: "text", text: result.text }],
					details: singleDetails,
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

					const r = await runEphemeral(item.task, buildOpts(item.agent, {
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
					return { ephemeral: r, agent: itemAgent || "anon", task: item.task, logPath };
				});

				const parallelDetails: SubagentDetails = {
					mode: "parallel",
					results: results.map((r) => ({
						agent: r.agent,
						task: r.task,
						text: r.ephemeral.text,
						model: r.ephemeral.model,
						usage: r.ephemeral.usage,
						durationMs: r.ephemeral.durationMs,
						logPath: r.logPath,
						toolCalls: r.ephemeral.toolCalls,
						isError: false,
					})),
				};

				const summaries = results.map((r) => {
					const preview = r.ephemeral.text.slice(0, 100) + (r.ephemeral.text.length > 100 ? "..." : "");
					return `[${r.agent}]: ${preview}`;
				});
				const totalCost = results.reduce((sum, r) => sum + r.ephemeral.usage.cost, 0);
				return {
					content: [{
						type: "text",
						text: `Parallel: ${results.length} tasks completed ($${totalCost.toFixed(3)})\n\n${summaries.join("\n\n")}`,
					}],
					details: parallelDetails,
				};
			}

			// -- Chain mode --
			if (chain) {
				let previous = "";
				const chainResults: SubagentResultItem[] = [];

				for (let i = 0; i < chain.length; i++) {
					if (signal?.aborted) break;
					const step = chain[i];
					const prompt = step.task.replace(/\{previous\}/g, previous);

					const stepAgent = step.agent || defaultAgentName;
					const label = makeLabel(stepAgent, `s${i}`);
					const logPath = path.join(SWARM_LOG_DIR, `${label}.log`);
					fs.writeFileSync(logPath, "");
					openLogPane(logPath, label);

					const stepResult = await runEphemeral(prompt, buildOpts(step.agent, {
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

					chainResults.push({
						agent: stepAgent || "anon",
						task: prompt,
						text: stepResult.text,
						model: stepResult.model,
						usage: stepResult.usage,
						durationMs: stepResult.durationMs,
						logPath,
						step: i + 1,
						toolCalls: stepResult.toolCalls,
						isError: false,
					});
					previous = stepResult.text;
				}

				if (chainResults.length === 0) {
					return {
						content: [{ type: "text", text: "Chain was empty." }],
						details: undefined,
					};
				}

				const chainDetails: SubagentDetails = {
					mode: "chain",
					results: chainResults,
				};
				const lastChainResult = chainResults[chainResults.length - 1];
				return {
					content: [{ type: "text", text: lastChainResult.text }],
					details: chainDetails,
				};
			}

			return {
				content: [{ type: "text", text: "No task specified." }],
				details: undefined,
			};
		},

		renderCall(args: any, theme: any) {
			// Chain mode
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " +
						theme.fg("accent", step.agent || args.agent || "anon") +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			// Parallel mode
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent || args.agent || "anon")}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			// Single mode
			const agentName = args.agent || "anon";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content?.[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const fg = theme.fg.bind(theme);

			// Aggregate usage across results
			const aggregateUsage = (results: SubagentResultItem[]) => {
				const total = { input: 0, output: 0, cost: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cost += r.usage.cost;
				}
				return total;
			};

			// Single mode
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const icon = r.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
					container.addChild(new Text(header, 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (r.toolCalls.length > 0) {
						for (const tc of r.toolCalls) {
							container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCallDisplay(tc.name, tc.args, fg), 0, 0));
						}
					}
					if (r.text && r.text !== "(no output)") {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(r.text.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					}
					const usageStr = formatUsageStats(r.usage, { durationMs: r.durationMs, model: r.model, logPath: r.logPath });
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				// Collapsed
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
				if (r.toolCalls.length === 0 && (!r.text || r.text === "(no output)")) {
					text += `\n${theme.fg("muted", "(no output)")}`;
				} else {
					if (r.toolCalls.length > 0) {
						text += `\n${renderToolCalls(r.toolCalls, fg, COLLAPSED_TOOL_COUNT)}`;
						if (r.toolCalls.length > COLLAPSED_TOOL_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					}
				}
				const usageStr = formatUsageStats(r.usage, { durationMs: r.durationMs, model: r.model, logPath: r.logPath });
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			// Chain mode
			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => !r.isError).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(
						icon + " " + theme.fg("toolTitle", theme.bold("chain ")) +
						theme.fg("accent", `${successCount}/${details.results.length} steps`),
						0, 0,
					));

					for (const r of details.results) {
						const rIcon = r.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
						container.addChild(new Spacer(1));
						container.addChild(new Text(
							`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`,
							0, 0,
						));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", truncate(r.task, 120)), 0, 0));
						for (const tc of r.toolCalls) {
							container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCallDisplay(tc.name, tc.args, fg), 0, 0));
						}
						if (r.text && r.text !== "(no output)") {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(r.text.trim(), 0, 0, mdTheme));
						}
						const stepUsage = formatUsageStats(r.usage, { durationMs: r.durationMs, model: r.model });
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const totalUsage = formatUsageStats(aggregateUsage(details.results));
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				// Collapsed
				let text = icon + " " + theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.toolCalls.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderToolCalls(r.toolCalls, fg, 5)}`;
				}
				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// Parallel mode
			if (details.mode === "parallel") {
				const successCount = details.results.filter((r) => !r.isError).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("warning", "◐");
				const status = `${successCount}/${details.results.length} tasks`;

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
						0, 0,
					));

					for (const r of details.results) {
						const rIcon = r.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
						container.addChild(new Spacer(1));
						container.addChild(new Text(
							`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`,
							0, 0,
						));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", truncate(r.task, 120)), 0, 0));
						for (const tc of r.toolCalls) {
							container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCallDisplay(tc.name, tc.args, fg), 0, 0));
						}
						if (r.text && r.text !== "(no output)") {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(r.text.trim(), 0, 0, mdTheme));
						}
						const taskUsage = formatUsageStats(r.usage, { durationMs: r.durationMs, model: r.model });
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const totalUsage = formatUsageStats(aggregateUsage(details.results));
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				// Collapsed
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = r.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.toolCalls.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderToolCalls(r.toolCalls, fg, 5)}`;
				}
				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// Fallback
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// -- LLM Tool: git_worktree --

	pi.registerTool({
		name: "git_worktree",
		label: "Git Worktree",
		description: [
			"Create and manage isolated git worktrees for safe experimentation.",
			"Worktrees are full checkouts sharing the repo's object store but with independent working directories and index.",
			"Use for: risky refactors, parallel experiments, building/testing alternate branches, scratch work.",
			"Worktrees live in /tmp/pi-worktrees/{repo}/ and are cleaned up on remove.",
			"After creating, use bash with cd to that path to work in the worktree.",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["create", "list", "remove", "remove_all"] as const, {
				description: "Action: create a worktree, list existing ones, remove one by name, or remove all",
			}),
			name: Type.Optional(Type.String({ description: "Worktree name (required for create/remove)" })),
			ref: Type.Optional(Type.String({ description: "Git ref to checkout: branch, tag, or commit (default: HEAD). For create only." })),
			new_branch: Type.Optional(Type.String({ description: "Create a new branch at ref instead of detached HEAD. For create only." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isGitRepo(ctx.cwd)) {
				return {
					content: [{ type: "text", text: "Not inside a git repository." }],
					details: undefined,
				};
			}

			switch (params.action) {
				case "create": {
					if (!params.name) {
						return {
							content: [{ type: "text", text: "Name is required for create. Provide a short descriptive name." }],
							details: undefined,
						};
					}

					const wtPath = createWorktree(params.name, ctx.cwd, {
						ref: params.ref,
						newBranch: params.new_branch,
					});

					if (!wtPath) {
						return {
							content: [{ type: "text", text: `Failed to create worktree "${params.name}". Check that the ref exists and the name isn't already a checked-out branch.` }],
							details: undefined,
							isError: true,
						};
					}

					const branch = params.new_branch
						? `branch: ${params.new_branch}`
						: `detached at ${params.ref || "HEAD"}`;

					return {
						content: [{
							type: "text",
							text: `Worktree "${params.name}" created.\nPath: ${wtPath}\nRef: ${branch}\n\nUse \`cd ${wtPath}\` in bash commands to work in this worktree.`,
						}],
						details: undefined,
					};
				}

				case "list": {
					const wts = listWorktrees(ctx.cwd);
					if (wts.length === 0) {
						return {
							content: [{ type: "text", text: "No pi-managed worktrees for this repository." }],
							details: undefined,
						};
					}

					const lines = wts.map((wt) => {
						const ref = wt.branch || `(detached ${wt.head})`;
						const dirtyMark = wt.dirty ? " [dirty]" : "";
						return `${wt.name}: ${ref}${dirtyMark}\n  ${wt.path}`;
					});

					return {
						content: [{ type: "text", text: `${wts.length} worktree(s):\n\n${lines.join("\n\n")}` }],
						details: undefined,
					};
				}

				case "remove": {
					if (!params.name) {
						return {
							content: [{ type: "text", text: "Name is required for remove." }],
							details: undefined,
						};
					}

					const wts = listWorktrees(ctx.cwd);
					const target = wts.find((w) => w.name === params.name);
					if (!target) {
						const available = wts.map((w) => w.name).join(", ") || "(none)";
						return {
							content: [{ type: "text", text: `Worktree "${params.name}" not found. Available: ${available}` }],
							details: undefined,
						};
					}

					removeWorktree(target.path, ctx.cwd);
					return {
						content: [{ type: "text", text: `Worktree "${params.name}" removed.` }],
						details: undefined,
					};
				}

				case "remove_all": {
					const count = removeAllWorktrees(ctx.cwd);
					return {
						content: [{ type: "text", text: count > 0 ? `Removed ${count} worktree(s).` : "No worktrees to remove." }],
						details: undefined,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: undefined,
					};
			}
		},
	});

	// -- Slash command: /worktrees --

	pi.registerCommand("worktrees", {
		description: "List pi-managed git worktrees",
		handler: async (_args, ctx) => {
			if (!isGitRepo(ctx.cwd)) {
				ctx.ui.notify("Not inside a git repository", "error");
				return;
			}

			const wts = listWorktrees(ctx.cwd);
			if (wts.length === 0) {
				ctx.ui.notify("No pi-managed worktrees", "info");
				return;
			}

			const lines = wts.map((wt) => {
				const ref = wt.branch || `(detached ${wt.head})`;
				const dirtyMark = wt.dirty ? " [dirty]" : "";
				return `${wt.name}: ${ref}${dirtyMark}\n  ${wt.path}`;
			});
			ctx.ui.notify(lines.join("\n\n"), "info");
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
