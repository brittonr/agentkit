import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, estimateTokens } from "@mariozechner/pi-coding-agent";
import { Container, Text, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

function getAgentDir(): string {
	for (const [k, v] of Object.entries(process.env)) {
		if (k.endsWith("_CODING_AGENT_DIR") && v) {
			if (v === "~") return os.homedir();
			if (v.startsWith("~/")) return path.join(os.homedir(), v.slice(2));
			return v;
		}
	}
	return path.join(os.homedir(), ".pi", "agent");
}

function loadProjectContextFiles(cwd: string): Array<{ path: string; tokens: number; bytes: number }> {
	const out: Array<{ path: string; tokens: number; bytes: number }> = [];
	const seen = new Set<string>();

	const loadFromDir = (dir: string) => {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const p = path.join(dir, name);
			if (!fs.existsSync(p) || seen.has(p)) continue;
			try {
				const content = fs.readFileSync(p, "utf-8");
				seen.add(p);
				out.push({ path: p, tokens: estimateTokens(content), bytes: Buffer.byteLength(content) });
				return; // Only one per dir
			} catch { /* skip */ }
		}
	};

	loadFromDir(getAgentDir());

	// Walk from root to cwd
	const stack: string[] = [];
	let current = path.resolve(cwd);
	while (true) {
		stack.push(current);
		const parent = path.resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}
	stack.reverse();
	for (const dir of stack) loadFromDir(dir);

	return out;
}

function shortenPath(p: string, cwd: string): string {
	const rp = path.resolve(p);
	const rc = path.resolve(cwd);
	if (rp === rc) return ".";
	if (rp.startsWith(rc + path.sep)) return "./" + rp.slice(rc.length + 1);
	return rp;
}

function extractCostTotal(usage: any): number {
	if (!usage) return 0;
	const c = usage?.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	const t = c?.total;
	if (typeof t === "number") return Number.isFinite(t) ? t : 0;
	return 0;
}

function sumSessionUsage(ctx: ExtensionCommandContext): { totalTokens: number; totalCost: number } {
	let input = 0;
	let output = 0;
	let totalCost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if ((entry as any)?.type !== "message") continue;
		const msg = (entry as any)?.message;
		if (!msg || msg.role !== "assistant") continue;
		const usage = msg.usage;
		if (!usage) continue;
		input += Number(usage.inputTokens ?? 0) || 0;
		output += Number(usage.outputTokens ?? 0) || 0;
		totalCost += extractCostTotal(usage);
	}

	return { totalTokens: input + output, totalCost };
}

function renderUsageBar(
	theme: Theme,
	parts: { system: number; tools: number; convo: number; remaining: number },
	total: number,
	width: number,
): string {
	const w = Math.max(10, width);
	if (total <= 0) return "";

	const toCols = (n: number) => Math.round((n / total) * w);
	let sys = toCols(parts.system);
	let tools = toCols(parts.tools);
	let con = toCols(parts.convo);
	let rem = w - sys - tools - con;
	if (rem < 0) rem = 0;
	while (sys + tools + con + rem < w) rem++;
	while (sys + tools + con + rem > w && rem > 0) rem--;

	const block = "\u2588";
	return (
		theme.fg("accent", block.repeat(sys)) +
		theme.fg("warning", block.repeat(tools)) +
		theme.fg("success", block.repeat(con)) +
		theme.fg("dim", block.repeat(rem))
	);
}

class ContextView implements Component {
	private container: Container;
	private body: Text;
	private theme: Theme;
	private data: ContextViewData;
	private cwd: string;
	private onDone: () => void;
	private cachedWidth?: number;

	constructor(tui: TUI, theme: Theme, data: ContextViewData, cwd: string, onDone: () => void) {
		this.theme = theme;
		this.data = data;
		this.cwd = cwd;
		this.onDone = onDone;

		this.container = new Container();
		this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.container.addChild(
			new Text(
				theme.fg("accent", theme.bold("Context")) + theme.fg("dim", "  (Esc/q/Enter to close)"),
				1,
				0,
			),
		);
		this.container.addChild(new Text("", 1, 0));
		this.body = new Text("", 1, 0);
		this.container.addChild(this.body);
		this.container.addChild(new Text("", 1, 0));
		this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	private rebuild(width: number): void {
		const muted = (s: string) => this.theme.fg("muted", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const text = (s: string) => this.theme.fg("text", s);
		const lines: string[] = [];

		if (!this.data.usage) {
			lines.push(muted("Window: ") + dim("(unknown)"));
		} else {
			const u = this.data.usage;
			lines.push(
				muted("Window: ") +
					text(`~${u.effectiveTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()}`) +
					muted(`  (${u.percent.toFixed(1)}% used, ~${u.remainingTokens.toLocaleString()} left)`),
			);

			const barWidth = Math.max(10, Math.min(36, width - 10));
			const sysInMessages = Math.min(u.systemPromptTokens, u.messageTokens);
			const convoInMessages = Math.max(0, u.messageTokens - sysInMessages);
			const bar =
				renderUsageBar(
					this.theme,
					{
						system: sysInMessages,
						tools: u.toolsTokens,
						convo: convoInMessages,
						remaining: u.remainingTokens,
					},
					u.contextWindow,
					barWidth,
				) +
				" " +
				dim("sys") + this.theme.fg("accent", "\u2588") + " " +
				dim("tools") + this.theme.fg("warning", "\u2588") + " " +
				dim("convo") + this.theme.fg("success", "\u2588") + " " +
				dim("free") + this.theme.fg("dim", "\u2588");
			lines.push(bar);
		}

		lines.push("");

		if (this.data.usage) {
			const u = this.data.usage;
			lines.push(
				muted("System: ") +
					text(`~${u.systemPromptTokens.toLocaleString()} tok`) +
					muted(` (AGENTS ~${u.agentTokens.toLocaleString()})`),
			);
			lines.push(
				muted("Tools:  ") +
					text(`~${u.toolsTokens.toLocaleString()} tok`) +
					muted(` (${u.activeTools} active)`),
			);
		}

		const agentPaths = this.data.agentFiles.map((f) => shortenPath(f, this.cwd));
		lines.push(
			muted(`AGENTS (${agentPaths.length}): `) +
				text(agentPaths.length ? agentPaths.join(", ") : "(none)"),
		);
		lines.push("");

		lines.push(
			muted(`Extensions (${this.data.extensions.length}): `) +
				text(this.data.extensions.length ? this.data.extensions.join(", ") : "(none)"),
		);

		lines.push(
			muted(`Skills (${this.data.skills.length}): `) +
				text(this.data.skills.length ? this.data.skills.join(", ") : "(none)"),
		);
		lines.push("");

		lines.push(
			muted("Session: ") +
				text(`${this.data.session.totalTokens.toLocaleString()} tokens`) +
				muted(" \u00b7 ") +
				text(formatUsd(this.data.session.totalCost)),
		);

		this.body.setText(lines.join("\n"));
		this.cachedWidth = width;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) {
			this.onDone();
		}
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth !== width) this.rebuild(width);
		return this.container.render(width);
	}
}

interface ContextViewData {
	usage: {
		messageTokens: number;
		contextWindow: number;
		effectiveTokens: number;
		percent: number;
		remainingTokens: number;
		systemPromptTokens: number;
		agentTokens: number;
		toolsTokens: number;
		activeTools: number;
	} | null;
	agentFiles: string[];
	extensions: string[];
	skills: string[];
	session: { totalTokens: number; totalCost: number };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show loaded context overview (window usage, extensions, skills, session cost)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const commands = pi.getCommands();
			const extensionCmds = commands.filter((c) => c.source === "extension");
			const skillCmds = commands.filter((c) => c.source === "skill");

			// Group extension commands by file
			const extensionsByPath = new Map<string, string[]>();
			for (const c of extensionCmds) {
				const p = c.path ?? "<unknown>";
				const arr = extensionsByPath.get(p) ?? [];
				arr.push(c.name);
				extensionsByPath.set(p, arr);
			}
			const extensionFiles = [...extensionsByPath.keys()]
				.map((p) => (p === "<unknown>" ? p : path.basename(p)))
				.sort();

			const skills = skillCmds
				.map((c) => (c.name.startsWith("skill:") ? c.name.slice(6) : c.name))
				.sort();

			const agentFiles = loadProjectContextFiles(ctx.cwd);
			const agentTokens = agentFiles.reduce((a, f) => a + f.tokens, 0);

			const systemPrompt = ctx.getSystemPrompt();
			const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;

			const usage = ctx.getContextUsage();
			const messageTokens = usage?.tokens ?? 0;
			const ctxWindow = usage?.contextWindow ?? 0;

			// Approximate tool definition token impact
			const TOOL_FUDGE = 1.5;
			const activeToolNames = pi.getActiveTools();
			const toolInfoByName = new Map(pi.getAllTools().map((t) => [t.name, t] as const));
			let toolsTokens = 0;
			for (const name of activeToolNames) {
				const info = toolInfoByName.get(name);
				const blob = `${name}\n${info?.description ?? ""}`;
				toolsTokens += estimateTokens(blob);
			}
			toolsTokens = Math.round(toolsTokens * TOOL_FUDGE);

			const effectiveTokens = messageTokens + toolsTokens;
			const percent = ctxWindow > 0 ? (effectiveTokens / ctxWindow) * 100 : 0;
			const remainingTokens = ctxWindow > 0 ? Math.max(0, ctxWindow - effectiveTokens) : 0;

			const sessionUsage = sumSessionUsage(ctx);

			const viewData: ContextViewData = {
				usage: usage
					? {
							messageTokens,
							contextWindow: ctxWindow,
							effectiveTokens,
							percent,
							remainingTokens,
							systemPromptTokens,
							agentTokens,
							toolsTokens,
							activeTools: activeToolNames.length,
						}
					: null,
				agentFiles: agentFiles.map((f) => f.path),
				extensions: extensionFiles,
				skills,
				session: sessionUsage,
			};

			if (!ctx.hasUI) {
				const lines: string[] = ["Context"];
				if (viewData.usage) {
					lines.push(`Window: ~${effectiveTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} (${percent.toFixed(1)}% used)`);
				}
				lines.push(`Extensions (${extensionFiles.length}): ${extensionFiles.join(", ") || "(none)"}`);
				lines.push(`Skills (${skills.length}): ${skills.join(", ") || "(none)"}`);
				lines.push(`Session: ${sessionUsage.totalTokens.toLocaleString()} tokens, ${formatUsd(sessionUsage.totalCost)}`);
				pi.sendMessage({ customType: "context", content: lines.join("\n"), display: true }, { triggerTurn: false });
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return new ContextView(tui, theme, viewData, ctx.cwd, done);
			});
		},
	});
}
