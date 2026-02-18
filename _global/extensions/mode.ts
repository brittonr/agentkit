/**
 * Unified mode switcher: Normal ↔ Plan ↔ Loop
 *
 * Shortcut: Ctrl+. — cycle through modes directly (Normal → Plan → Loop)
 * Shortcut: Alt+M  — cycle through modes directly (Normal → Plan → Loop)
 * Command:  /mode [normal|plan|loop] — switch or open selector
 * Command:  /loop [tests|self|custom <condition>] — start a loop
 * Command:  /todos — view plan step progress
 *
 * Modes:
 *   Normal — full tools, standard operation
 *   Plan   — read-only exploration, numbered step planning
 *   Loop   — continuous agent turns until breakout condition
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { compact, DynamicBorder, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, SettingsList, Text, type SelectItem, type SettingItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────────────

type Mode = "normal" | "plan" | "loop";
type LoopVariant = "tests" | "custom" | "self";

interface ModeState {
	mode: Mode;
	// Plan
	savedTools?: string[];
	planItems?: TodoItem[];
	completedSteps?: number[];
	// Loop
	loopPending?: boolean; // armed via shortcut, awaiting user's first message
	loopVariant?: LoopVariant;
	loopCondition?: string;
	loopPrompt?: string;
	loopSummary?: string;
	loopCount?: number;
	rateLimitRetries?: number;
}

interface TodoItem {
	index: number;
	text: string;
	done: boolean;
}

const STATE_KEY = "mode-state";

// ── Read-only tool allowlist ─────────────────────────────────────────────────

const READ_ONLY_TOOLS = [
	"read", "grep", "find", "glob", "ls", "search",
	"list_files", "read_file", "search_files", "list_directory",
];

const SAFE_COMMAND_PREFIXES = [
	"cat", "head", "tail", "less", "more", "wc", "diff",
	"grep", "rg", "ag", "ack", "find", "fd", "ls", "tree",
	"file", "stat", "du", "df", "which", "whereis", "type",
	"echo", "printf", "pwd", "env", "printenv", "uname", "whoami", "id", "date",
	"git log", "git show", "git diff", "git status", "git branch",
	"git tag", "git remote", "git rev-parse", "git ls-files",
	"git ls-tree", "git blame", "git shortlog", "git describe",
	"git config --get", "git config --list",
	"cargo check", "cargo clippy", "cargo doc", "cargo metadata", "cargo tree",
	"npm list", "npm info", "npm view", "npx tsc --noEmit",
	"node -e", "python -c", "jq", "yq", "sed -n", "awk",
	"sort", "uniq", "cut", "tr", "column", "bat", "exa", "eza",
	"tokei", "cloc", "scc",
	"nix eval", "nix flake show", "nix flake metadata",
];

// ── Prompts ──────────────────────────────────────────────────────────────────

const PLAN_MARKER_START = "<!-- PLAN -->";
const PLAN_MARKER_END = "<!-- /PLAN -->";

const PLAN_MODE_PROMPT = `
You are currently in PLAN MODE (read-only exploration).

In this mode:
- You can ONLY use read-only tools (read, grep, find, ls, glob, search)
- Shell commands are restricted to safe, non-modifying commands
- You CANNOT write, edit, create, or delete any files
- You CANNOT run modifying shell commands (git commit, npm install, etc.)

Your job is to:
1. Explore the codebase to understand the problem
2. Identify the files and areas that need changes
3. Create a numbered step-by-step plan for implementation

When you've finished exploring, output your final plan wrapped in markers:

${PLAN_MARKER_START}
1. First step
2. Second step
3. Third step
${PLAN_MARKER_END}

IMPORTANT: Only the numbered list inside ${PLAN_MARKER_START} / ${PLAN_MARKER_END} markers will be extracted as plan steps. Do not put other numbered lists inside these markers.

During execution mode, mark completed steps with [DONE:n] where n is the step number.
`;

// ── UI items ─────────────────────────────────────────────────────────────────

const MODE_ITEMS: SelectItem[] = [
	{ value: "normal", label: "Normal", description: "Full tools, standard operation" },
	{ value: "plan", label: "Plan", description: "Read-only exploration + step planning" },
	{ value: "loop", label: "Loop", description: "Continuous loop until condition met" },
];



// ── Helpers ──────────────────────────────────────────────────────────────────

function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();

	// Block shell redirects and command chaining that could write files
	if (/[>]|&&|;|`|\$\(/.test(trimmed)) return false;

	const segments = trimmed.split(/\s*\|\s*/);
	return segments.every((segment) => {
		const seg = segment.trim().replace(/^(\w+=\S+\s+)+/, "");
		return SAFE_COMMAND_PREFIXES.some(
			(p) => seg === p || seg.startsWith(p + " ") || seg.startsWith(p + "\t"),
		);
	});
}

function buildLoopPrompt(variant: LoopVariant, condition?: string): string {
	switch (variant) {
		case "tests":
			return (
				"Run all tests. If they are passing, call the signal_loop_success tool. " +
				"Otherwise continue until the tests pass."
			);
		case "custom": {
			const c = condition?.trim() || "the custom condition is satisfied";
			return (
				`Continue until the following condition is satisfied: ${c}. ` +
				"When it is satisfied, call the signal_loop_success tool."
			);
		}
		case "self":
			return "Continue until you are done. When finished, call the signal_loop_success tool.";
	}
}

function loopSummaryText(variant: LoopVariant, condition?: string): string {
	switch (variant) {
		case "tests": return "tests pass";
		case "custom": {
			const c = condition?.trim() || "custom";
			return c.length > 30 ? c.slice(0, 27) + "..." : c;
		}
		case "self": return "self-driven";
	}
}

function extractTodoItems(text: string): TodoItem[] {
	// Extract only from within plan markers if present
	const markerStart = text.indexOf(PLAN_MARKER_START);
	const markerEnd = text.indexOf(PLAN_MARKER_END);
	const source = (markerStart !== -1 && markerEnd !== -1 && markerEnd > markerStart)
		? text.slice(markerStart + PLAN_MARKER_START.length, markerEnd)
		: text;

	const items: TodoItem[] = [];
	let index = 0;
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		const numbered = trimmed.match(/^(\d+)\.\s+(.+)/);
		if (numbered) {
			const taskText = numbered[2];
			const done = /^\[DONE(?::\d+)?\]/.test(taskText) || /^~~/.test(taskText);
			const cleanText = taskText.replace(/^\[DONE(?::\d+)?\]\s*/, "").replace(/^~+\s*/, "").replace(/~+$/, "");
			items.push({ index: index++, text: cleanText, done });
			continue;
		}
		const checkbox = trimmed.match(/^-\s+\[([ xX])\]\s+(.+)/);
		if (checkbox) {
			items.push({ index: index++, text: checkbox[2], done: checkbox[1].toLowerCase() === "x" });
		}
	}
	return items;
}

function formatTodoList(items: TodoItem[], completedSteps: number[]): string {
	if (items.length === 0) return "No plan steps found.";
	const lines = items.map((item) => {
		const done = item.done || completedSteps.includes(item.index);
		return `  ${done ? "[x]" : "[ ]"} ${item.index + 1}. ${item.text}`;
	});
	const doneCount = items.filter((item, _i) => item.done || completedSteps.includes(item.index)).length;
	lines.push(`\n  Progress: ${doneCount}/${items.length} steps completed`);
	return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
	const sec = Math.ceil(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function getBackoffMs(retryCount: number): number {
	return Math.min(60_000 * Math.pow(2, Math.min(retryCount, 3)), 900_000);
}

function wasRateLimited(messages: Array<{ role?: string; stopReason?: string; errorMessage?: string }>): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			if (msg.stopReason !== "error") return false;
			const err = (msg.errorMessage ?? "").toLowerCase();
			return err.includes("rate_limit") || err.includes("rate limit") || /\b429\b/.test(err);
		}
	}
	return false;
}

function wasAborted(messages: Array<{ role?: string; stopReason?: string }>): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return messages[i].stopReason === "aborted";
	}
	return false;
}

/**
 * Probe Anthropic API for exact rate-limit reset timing.
 */
async function probeRateLimitWait(ctx: ExtensionContext): Promise<number | null> {
	const model = ctx.model;
	if (!model || model.api !== "anthropic-messages") return null;

	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) return null;

	try {
		const url = `${model.baseUrl.replace(/\/+$/, "")}/v1/messages`;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				...(model.headers || {}),
			},
			body: JSON.stringify({ model: model.id, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
		});

		if (response.ok) return 0;

		if (response.status === 429) {
			const retryMs = response.headers.get("retry-after-ms");
			if (retryMs) { const ms = parseInt(retryMs, 10); if (ms > 0) return ms; }

			const retryAfter = response.headers.get("retry-after");
			if (retryAfter) {
				const s = parseInt(retryAfter, 10);
				if (s > 0) return s * 1000;
				const d = new Date(retryAfter);
				if (!isNaN(d.getTime())) return Math.max(1000, d.getTime() - Date.now());
			}

			for (const suffix of ["output-tokens-reset", "input-tokens-reset", "requests-reset"]) {
				const reset = response.headers.get(`anthropic-ratelimit-${suffix}`);
				if (reset) {
					const d = new Date(reset);
					if (!isNaN(d.getTime())) return Math.max(1000, d.getTime() - Date.now());
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

// Survives across sessions (module-level). Set before newSession() to
// carry the plan into the fresh session where it becomes a loop prompt.
let pendingPlanLoop: { planItems: TodoItem[]; prompt: string } | null = null;

export default function (pi: ExtensionAPI) {
	let state: ModeState = { mode: "normal" };

	// newSession() is only available on ExtensionCommandContext, but we need
	// it from agent_end (which gets ExtensionContext). Capture the function
	// from any command context so we can call it later.
	let newSessionFn: ((options?: any) => Promise<{ cancelled: boolean }>) | null = null;

	// ── Persistence ──────────────────────────────────────────────────────────

	function persist(): void {
		pi.appendEntry(STATE_KEY, state);
	}

	function loadState(ctx: ExtensionContext): ModeState {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type: string; customType?: string; data?: ModeState };
			if (e.type === "custom" && e.customType === STATE_KEY && e.data) return e.data;
		}
		return { mode: "normal" };
	}

	// ── Status bar ───────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		switch (state.mode) {
			case "normal":
				ctx.ui.setStatus("mode", "mode: normal");
				ctx.ui.setWidget("mode", undefined);
				break;

			case "plan":
				ctx.ui.setStatus("mode", ctx.ui.theme.fg("warning", "mode: plan"));
				ctx.ui.setWidget("mode", undefined);
				break;

			case "loop": {
				ctx.ui.setStatus("mode", ctx.ui.theme.fg("accent", "mode: loop"));
				if (state.loopPending) {
					ctx.ui.setWidget("mode", [
						ctx.ui.theme.fg("accent", "Loop: awaiting prompt — type your loop task"),
					]);
				} else {
					const summary = state.loopSummary || loopSummaryText(state.loopVariant!, state.loopCondition);
					const turn = state.loopCount ?? 0;
					ctx.ui.setWidget("mode", [
						ctx.ui.theme.fg("accent", `Loop: ${summary} (turn ${turn})`),
					]);
				}
				break;
			}
		}
	}

	// ── Mode transitions ─────────────────────────────────────────────────────

	function activateNormal(ctx: ExtensionContext): void {
		// Restore tools if leaving plan mode
		if (state.mode === "plan") {
			if (state.savedTools) {
				pi.setActiveTools(state.savedTools);
			} else {
				// Fallback: restore all tools
				pi.setActiveTools(pi.getAllTools().map((t) => t.name));
			}
		}
		state = {
			mode: "normal",
			planItems: state.planItems,
			completedSteps: state.completedSteps,
		};
		persist();
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify("Mode: Normal — full tools restored", "info");
	}

	function activatePlan(ctx: ExtensionContext): void {
		// Save current tools before restricting
		const savedTools = state.mode !== "plan" ? pi.getActiveTools() : state.savedTools;

		// Restrict to read-only
		const allTools = pi.getAllTools().map((t) => t.name);
		const readOnly = allTools.filter((t) => READ_ONLY_TOOLS.includes(t));
		if (allTools.includes("bash")) readOnly.push("bash");
		if (allTools.includes("shell")) readOnly.push("shell");
		pi.setActiveTools(readOnly);

		state = {
			mode: "plan",
			savedTools,
			planItems: state.planItems,
			completedSteps: state.completedSteps,
		};
		persist();
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify("Mode: Plan — read-only exploration", "info");
	}

	function activateLoop(ctx: ExtensionContext, variant: LoopVariant, condition?: string, autoStart = true): void {
		// Restore tools if leaving plan mode
		if (state.mode === "plan") {
			if (state.savedTools) {
				pi.setActiveTools(state.savedTools);
			} else {
				pi.setActiveTools(pi.getAllTools().map((t) => t.name));
			}
		}

		const prompt = buildLoopPrompt(variant, condition);
		const summary = loopSummaryText(variant, condition);

		state = {
			mode: "loop",
			planItems: state.planItems,
			completedSteps: state.completedSteps,
			loopVariant: variant,
			loopCondition: condition,
			loopPrompt: prompt,
			loopSummary: summary,
			loopCount: 0,
			rateLimitRetries: 0,
		};
		persist();
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Mode: Loop — ${summary}`, "info");

		if (autoStart) triggerLoopPrompt(ctx);
	}

	function armLoopPending(ctx: ExtensionContext): void {
		// Restore tools if leaving plan mode
		if (state.mode === "plan") {
			if (state.savedTools) {
				pi.setActiveTools(state.savedTools);
			} else {
				pi.setActiveTools(pi.getAllTools().map((t) => t.name));
			}
		}

		state = {
			mode: "loop",
			loopPending: true,
			planItems: state.planItems,
			completedSteps: state.completedSteps,
			loopCount: 0,
			rateLimitRetries: 0,
		};
		persist();
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify("Mode: Loop — type your loop task to begin", "info");
	}

	function triggerLoopPrompt(ctx: ExtensionContext): void {
		if (state.mode !== "loop" || !state.loopPrompt) return;
		if (ctx.hasPendingMessages()) return;

		state = { ...state, loopCount: (state.loopCount ?? 0) + 1 };
		persist();
		updateStatus(ctx);

		pi.sendMessage(
			{ customType: "mode-loop", content: state.loopPrompt, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	// ── Mode selector UI ─────────────────────────────────────────────────────

	async function showModeSelector(ctx: ExtensionContext): Promise<Mode | null> {
		if (!ctx.hasUI) return null;

		return ctx.ui.custom<Mode | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(" Mode ")) +
					theme.fg("dim", " Ctrl+. to cycle"),
					1, 0,
				),
			);

			const items = MODE_ITEMS.map((item) => ({
				...item,
				label: (item.value === state.mode ? "● " : "  ") + item.label,
			}));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value as Mode);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", " ↑↓ navigate · Enter select · Esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	// ── Step picker UI ───────────────────────────────────────────────────────

	async function showStepPicker(ctx: ExtensionContext, steps: TodoItem[]): Promise<TodoItem[] | null> {
		if (!ctx.hasUI || steps.length === 0) return null;

		// Track which steps are enabled (all on by default)
		const enabled = new Set<number>(steps.map((_, i) => i));

		return ctx.ui.custom<TodoItem[] | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			container.addChild(new Text(
				theme.fg("accent", theme.bold(" Select steps ")) +
				theme.fg("dim", `${enabled.size}/${steps.length}`),
				1, 0,
			));

			const items: SettingItem[] = steps.map((step, i) => ({
				id: String(i),
				label: `${i + 1}. ${step.text}`,
				currentValue: "on",
				values: ["on", "off"],
			}));

			const settingsList = new SettingsList(
				items,
				Math.min(steps.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					const idx = parseInt(id, 10);
					if (newValue === "on") {
						enabled.add(idx);
					} else {
						enabled.delete(idx);
					}
					// Update header count
					container.invalidate();
				},
				() => {
					// Close — return selected steps
					if (enabled.size === 0) {
						done(null);
					} else {
						done(steps.filter((_, i) => enabled.has(i)));
					}
				},
			);

			container.addChild(settingsList);
			container.addChild(new Text(
				theme.fg("dim", " ↑↓ navigate · ←→ toggle · Esc confirm"),
				1, 0,
			));
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	// ── Switch dispatch ──────────────────────────────────────────────────────

	async function switchMode(target: Mode, ctx: ExtensionContext): Promise<void> {
		if (target === state.mode) {
			if (ctx.hasUI) ctx.ui.notify(`Already in ${target} mode`, "info");
			return;
		}

		switch (target) {
			case "normal":
				activateNormal(ctx);
				break;

			case "plan":
				activatePlan(ctx);
				break;

			case "loop": {
				if (ctx.hasUI) ctx.ui.notify("Use /loop tests | /loop self | /loop custom <condition>", "info");
				break;
			}
		}
	}

	// ── Quick cycle ──────────────────────────────────────────────────────────

	const MODE_ORDER: Mode[] = ["normal", "plan", "loop"];

	function nextMode(): Mode {
		const idx = MODE_ORDER.indexOf(state.mode);
		return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
	}

	// ── Tool: signal_loop_success ────────────────────────────────────────────

	pi.registerTool({
		name: "signal_loop_success",
		label: "Signal Loop Success",
		description:
			"Stop the active loop when the breakout condition is satisfied. " +
			"Only call this tool when explicitly instructed to do so by the user, tool, or system prompt.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (state.mode !== "loop") {
				return { content: [{ type: "text", text: "No active loop." }], details: undefined };
			}
			activateNormal(ctx);
			return { content: [{ type: "text", text: "Loop ended successfully." }], details: undefined };
		},
	});

	// ── Command: /mode ───────────────────────────────────────────────────────

	pi.registerCommand("mode", {
		description: "Switch mode: /mode [normal|plan|loop]",
		handler: async (args, ctx) => {
			// Capture newSession for use in agent_end (where only ExtensionContext is available)
			if (!newSessionFn && "newSession" in ctx) newSessionFn = ctx.newSession.bind(ctx);

			const arg = args.trim().toLowerCase();

			if (arg === "normal" || arg === "plan" || arg === "loop") {
				await switchMode(arg, ctx);
				return;
			}

			// No argument → show selector
			if (!ctx.hasUI) {
				ctx.ui.notify(`Current: ${state.mode}. Usage: /mode normal|plan|loop`, "info");
				return;
			}

			const selected = await showModeSelector(ctx);
			if (selected) await switchMode(selected, ctx);
		},
	});

	// ── Command: /todos ──────────────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "View current plan progress",
		handler: async (_args, ctx) => {
			if (!newSessionFn && "newSession" in ctx) newSessionFn = ctx.newSession.bind(ctx);

			const items = state.planItems ?? [];
			if (items.length === 0) {
				ctx.ui.notify("No plan steps recorded yet. Switch to Plan mode first.", "info");
				return;
			}
			ctx.ui.notify(formatTodoList(items, state.completedSteps ?? []), "info");
		},
	});

	// ── Command: /loop ───────────────────────────────────────────────────────

	pi.registerCommand("loop", {
		description: "Start a loop: /loop tests | /loop self | /loop custom <condition>",
		handler: async (args, ctx) => {
			if (!newSessionFn && "newSession" in ctx) newSessionFn = ctx.newSession.bind(ctx);

			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /loop tests | /loop self | /loop custom <condition>", "info");
				return;
			}

			// Confirm replace if already looping
			if (state.mode === "loop" && ctx.hasUI) {
				const ok = await ctx.ui.confirm("Replace loop?", "A loop is already active. Replace it?");
				if (!ok) return;
			}

			const parts = trimmed.split(/\s+/);
			const variant = parts[0].toLowerCase();

			if (variant === "tests") {
				activateLoop(ctx, "tests");
			} else if (variant === "self") {
				activateLoop(ctx, "self");
			} else if (variant === "custom") {
				const condition = parts.slice(1).join(" ").trim();
				if (!condition) {
					// No inline condition — open editor
					const edited = await ctx.ui.editor("Breakout condition:", "");
					if (!edited?.trim()) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					activateLoop(ctx, "custom", edited.trim());
				} else {
					activateLoop(ctx, "custom", condition);
				}
			} else {
				ctx.ui.notify("Unknown loop type. Usage: /loop tests | /loop self | /loop custom <condition>", "warning");
			}
		},
	});

	// ── Shortcut: Ctrl+. ─────────────────────────────────────────────────────
	// NOTE: registerShortcut handler takes (ctx) — NOT (event, ctx)

	pi.registerShortcut("ctrl+.", {
		description: "Cycle mode: Normal → Plan → Loop",
		handler: async (ctx) => {
			if (!newSessionFn && ctx && "newSession" in ctx) newSessionFn = (ctx as any).newSession.bind(ctx);

			const next = nextMode();
			if (next === "loop") {
				armLoopPending(ctx);
			} else {
				await switchMode(next, ctx);
			}
		},
	});

	// ── Shortcut: Alt+M ──────────────────────────────────────────────────────
	// Cycle through all modes: Normal → Plan → Loop → Normal
	// Avoids Ctrl+M which is the same byte as Enter (\r) in legacy terminals
	// and conflicts with Helix editor / SelectList Enter handling.
	// NOTE: registerShortcut handler takes (ctx) — NOT (event, ctx)

	pi.registerShortcut("alt+m", {
		description: "Cycle mode: Normal → Plan → Loop",
		handler: async (ctx) => {
			if (!newSessionFn && ctx && "newSession" in ctx) newSessionFn = (ctx as any).newSession.bind(ctx);

			const next = nextMode();
			if (next === "loop") {
				armLoopPending(ctx);
			} else {
				await switchMode(next, ctx);
			}
		},
	});

	// ── Hook: before_agent_start (plan mode prompt + loop pending capture) ───

	pi.on("before_agent_start", async (event, ctx) => {
		// Plan mode: inject read-only system prompt
		if (state.mode === "plan") {
			const existing = ctx.getSystemPrompt();
			return { systemPrompt: existing + "\n" + PLAN_MODE_PROMPT };
		}

		// Loop pending: user's first message becomes the loop prompt
		if (state.mode === "loop" && state.loopPending && event.prompt) {
			const userPrompt = event.prompt.trim();
			const loopPrompt = userPrompt +
				"\n\nWhen the task is complete, call the signal_loop_success tool. " +
				"If not yet done, continue working.";
			const summary = userPrompt.length > 30 ? userPrompt.slice(0, 27) + "..." : userPrompt;

			state = {
				...state,
				loopPending: false,
				loopVariant: "custom",
				loopCondition: userPrompt,
				loopPrompt: loopPrompt,
				loopSummary: summary,
			};
			persist();
			updateStatus(ctx);
		}
	});

	// ── Hook: tool_call (plan mode write blocking) ───────────────────────────

	pi.on("tool_call", async (event) => {
		if (state.mode !== "plan") return;

		const toolName = "name" in event ? (event.name as string) : "";
		const params = "params" in event ? (event.params as Record<string, unknown>) : {};

		// Block unsafe shell commands
		if (toolName === "bash" || toolName === "shell" || toolName === "execute") {
			const command = (params.command || params.cmd || "") as string;
			if (command && !isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: "${command.slice(0, 80)}" blocked — only read-only commands allowed.`,
				};
			}
		}

		// Block all write tools
		const writeTools = ["write", "edit", "create_file", "write_file", "patch", "delete", "remove", "move", "rename"];
		if (writeTools.includes(toolName)) {
			return { block: true, reason: `Plan mode: "${toolName}" blocked — read-only mode active.` };
		}
	});

	// ── Hook: turn_end (track [DONE:n] markers) ──────────────────────────────

	pi.on("turn_end", async (event) => {
		if (state.mode === "plan") return; // Only track during execution

		let content = "";
		if ("content" in event) {
			if (typeof event.content === "string") {
				content = event.content;
			} else if (Array.isArray(event.content)) {
				content = (event.content as any[])
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			}
		}
		if (!content) return;

		const completedSteps = [...(state.completedSteps ?? [])];
		let changed = false;

		for (const match of content.matchAll(/\[DONE:(\d+)\]/g)) {
			const step = parseInt(match[1], 10) - 1;
			if (!completedSteps.includes(step)) {
				completedSteps.push(step);
				changed = true;
			}
		}

		if (changed) {
			state = { ...state, completedSteps };
			persist();
		}
	});

	// ── Hook: agent_end (plan: extract steps + offer choice; loop: continue) ─

	pi.on("agent_end", async (event, ctx) => {
		if (!newSessionFn && "newSession" in ctx) newSessionFn = (ctx as any).newSession.bind(ctx);

		// ── Plan mode: extract plan, offer choice ────────────────────────
		if (state.mode === "plan" && ctx.hasUI) {
			const entries = ctx.sessionManager.getEntries();
			let lastText = "";
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as any;
				if (entry?.type === "message" && entry.message?.role === "assistant") {
					const c = entry.message.content;
					if (Array.isArray(c)) {
						lastText = c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
					} else if (typeof c === "string") {
						lastText = c;
					}
					break;
				}
			}

			const extracted = extractTodoItems(lastText);
			if (extracted.length > 0) {
				state = { ...state, planItems: extracted, completedSteps: [] };
				persist();
				pi.appendEntry("plan-steps", { steps: extracted.map((s) => s.text), timestamp: Date.now() });
			}

			const allPlanSteps = extracted.length > 0 ? extracted : (state.planItems ?? []);
			const hasPlan = allPlanSteps.length > 0;

			// ctx.ui.select() only accepts string[] — NOT objects with {label, value}
			const OPT_EXECUTE = "Execute plan (switch to Normal)";
			const OPT_LOOP = "Loop plan (fresh context)";
			const OPT_REFINE = "Refine plan (stay in Plan)";
			const OPT_STAY = "Stay in Plan mode";

			const options: string[] = [OPT_EXECUTE];
			if (hasPlan) options.push(OPT_LOOP);
			options.push(OPT_REFINE, OPT_STAY);

			const choice = await ctx.ui.select("Plan complete. What next?", options);

			// Fail-safe: only stay in plan mode for explicit refine/stay choices.
			// Everything else (including undefined/null from Escape, or unexpected
			// values) exits plan mode so the user is never trapped.
			if (choice === OPT_REFINE) {
				ctx.ui.notify("Continuing in Plan mode for refinement", "info");
			} else if (choice === OPT_STAY) {
				// Do nothing, user explicitly chose to stay
			} else if (choice === OPT_EXECUTE || choice === OPT_LOOP) {
				// Pick which steps to include (skip picker if only 1 step)
				let selectedSteps = allPlanSteps;
				if (hasPlan && allPlanSteps.length > 1) {
					const picked = await showStepPicker(ctx, allPlanSteps);
					if (!picked) {
						activateNormal(ctx);
						ctx.ui.notify("No steps selected — returning to normal mode", "info");
						return;
					}
					selectedSteps = picked;
				}

				// Re-index selected steps
				const reindexed = selectedSteps.map((s, i) => ({ ...s, index: i }));

				if (choice === OPT_LOOP) {
					const stepList = reindexed.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
					const prompt =
						"Execute the following plan step by step. After completing each step, " +
						"briefly confirm what was done. When ALL steps are complete and verified, " +
						"call the signal_loop_success tool.\n\n" + stepList;

					pendingPlanLoop = { planItems: reindexed, prompt };

					if (newSessionFn) {
						newSessionFn();
					} else {
						activateNormal(ctx);
						activateLoop(ctx, "custom", "all plan steps complete");
						state = { ...state, loopPrompt: prompt, loopSummary: `plan (${reindexed.length} steps)` };
						persist();
						updateStatus(ctx);
						triggerLoopPrompt(ctx);
					}
				} else {
					// Execute in normal mode
					state = { ...state, planItems: reindexed, completedSteps: [] };
					persist();
					activateNormal(ctx);
					ctx.ui.notify(`Plan loaded: ${reindexed.length} steps. Use /todos to track.`, "info");
				}
			} else {
				// Default: escape or unexpected — exit plan mode
				activateNormal(ctx);
				ctx.ui.notify("Plan mode dismissed — returning to normal mode", "info");
			}
			return;
		}

		// ── Loop mode: continue or handle errors ─────────────────────────
		if (state.mode !== "loop") return;

		const messages = event.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;

		// Handle abort
		if (wasAborted(messages) && ctx.hasUI) {
			const brk = await ctx.ui.confirm("Break loop?", "Agent was aborted. Exit loop?");
			if (brk) {
				activateNormal(ctx);
				return;
			}
		}

		// Handle rate limit with countdown
		if (wasRateLimited(messages)) {
			const retries = (state.rateLimitRetries ?? 0) + 1;
			state = { ...state, rateLimitRetries: retries };
			persist();

			// Probe API for exact wait, fall back to exponential backoff
			const probed = await probeRateLimitWait(ctx);
			const backoffMs = probed ?? getBackoffMs(retries - 1);

			if (backoffMs <= 0) {
				state = { ...state, rateLimitRetries: 0 };
				persist();
				triggerLoopPrompt(ctx);
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`Rate limited — waiting ${formatDuration(backoffMs)}`, "warning");

				const endTime = Date.now() + backoffMs;
				const interval = setInterval(() => {
					if (state.mode !== "loop") { clearInterval(interval); return; }
					const remaining = Math.max(0, endTime - Date.now());
					ctx.ui.setWidget("mode", [
						ctx.ui.theme.fg("warning", `Loop: rate limited, retry in ${formatDuration(remaining)}`),
					]);
				}, 1_000);

				await sleep(backoffMs);
				clearInterval(interval);
			} else {
				await sleep(backoffMs);
			}

			if (state.mode !== "loop") return;
			updateStatus(ctx);
		} else if (state.rateLimitRetries) {
			state = { ...state, rateLimitRetries: 0 };
			persist();
		}

		triggerLoopPrompt(ctx);
	});

	// ── Hook: session_before_compact (preserve loop state) ───────────────────

	pi.on("session_before_compact", async (event, ctx) => {
		if (state.mode !== "loop" || !ctx.model) return;

		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		if (!apiKey) return;

		const conditionText = state.loopSummary || loopSummaryText(state.loopVariant!, state.loopCondition);
		const instructions = [
			event.customInstructions,
			`Loop active. Breakout: ${conditionText}. Preserve loop state in summary.`,
		].filter(Boolean).join("\n\n");

		try {
			const compaction = await compact(event.preparation, ctx.model, apiKey, instructions, event.signal);
			return { compaction };
		} catch {
			return;
		}
	});

	// ── Restore on session start / switch ────────────────────────────────────

	async function restoreState(ctx: ExtensionContext): Promise<void> {
		state = loadState(ctx);

		if (state.mode === "plan") {
			// Refresh savedTools to match current session's full tool set
			state.savedTools = pi.getActiveTools();
			// Then restrict to read-only
			const allTools = pi.getAllTools().map((t) => t.name);
			const readOnly = allTools.filter((t) => READ_ONLY_TOOLS.includes(t));
			if (allTools.includes("bash")) readOnly.push("bash");
			if (allTools.includes("shell")) readOnly.push("shell");
			pi.setActiveTools(readOnly);
		}

		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		// Check for a plan-to-loop handoff from the previous session
		if (pendingPlanLoop) {
			const { planItems, prompt } = pendingPlanLoop;
			pendingPlanLoop = null;

			state = {
				mode: "loop",
				planItems,
				completedSteps: [],
				loopVariant: "custom",
				loopCondition: "all plan steps complete",
				loopPrompt: prompt,
				loopSummary: `plan (${planItems.length} steps)`,
				loopCount: 0,
				rateLimitRetries: 0,
			};
			persist();
			updateStatus(ctx);
			if (ctx.hasUI) ctx.ui.notify(`Loop started — executing ${planItems.length}-step plan`, "info");
			triggerLoopPrompt(ctx);
			return;
		}

		await restoreState(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => { await restoreState(ctx); });
}
