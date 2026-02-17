import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isSafeCommand, extractTodoItems, markCompletedSteps, formatTodoList, type TodoItem } from "./utils.js";

const READ_ONLY_TOOLS = [
	"read",
	"grep",
	"find",
	"glob",
	"ls",
	"search",
	"list_files",
	"read_file",
	"search_files",
	"list_directory",
];

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

Format your plan as a numbered list:
1. First step
2. Second step
3. Third step

When you've finished exploring and creating the plan, end your message with the plan.

During execution mode, mark completed steps with [DONE:n] where n is the step number.
`;

export default function (pi: ExtensionAPI) {
	let planModeActive = false;
	let savedTools: string[] | undefined;
	let planItems: TodoItem[] = [];
	let completedSteps: number[] = [];

	function activatePlanMode(ctx: { hasUI: boolean; ui: { notify: (msg: string, type: string) => void; setStatus: (key: string, text: string | undefined) => void } }) {
		if (planModeActive) return;

		planModeActive = true;
		savedTools = pi.getActiveTools();

		// Restrict to read-only tools from the currently active set
		const allTools = pi.getAllTools().map((t) => t.name);
		const readOnlyActive = allTools.filter((t) => READ_ONLY_TOOLS.includes(t));
		// Always include bash since we filter commands individually
		if (allTools.includes("bash")) readOnlyActive.push("bash");
		if (allTools.includes("shell")) readOnlyActive.push("shell");

		pi.setActiveTools(readOnlyActive);

		if (ctx.hasUI) {
			ctx.ui.setStatus("plan-mode", "PLAN MODE");
			ctx.ui.notify("Plan mode activated -- read-only exploration", "info");
		}
	}

	function deactivatePlanMode(ctx: { hasUI: boolean; ui: { notify: (msg: string, type: string) => void; setStatus: (key: string, text: string | undefined) => void } }) {
		if (!planModeActive) return;

		planModeActive = false;
		if (savedTools) {
			pi.setActiveTools(savedTools);
			savedTools = undefined;
		}

		if (ctx.hasUI) {
			ctx.ui.setStatus("plan-mode", undefined);
			ctx.ui.notify("Plan mode deactivated -- full tools restored", "info");
		}
	}

	// Toggle command
	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration with step tracking)",
		handler: async (_args: string, ctx) => {
			if (planModeActive) {
				deactivatePlanMode(ctx);
			} else {
				activatePlanMode(ctx);
			}
		},
	});

	// Keyboard shortcut: Ctrl+Alt+P
	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan mode",
		handler: async (_event, ctx) => {
			if (planModeActive) {
				deactivatePlanMode(ctx);
			} else {
				activatePlanMode(ctx);
			}
		},
	});

	// View plan progress
	pi.registerCommand("todos", {
		description: "View current plan progress",
		handler: async (_args: string, ctx) => {
			if (planItems.length === 0) {
				ctx.ui.notify("No plan steps recorded yet. Use /plan to enter plan mode first.", "info");
				return;
			}
			const updated = markCompletedSteps(planItems, completedSteps);
			ctx.ui.notify(formatTodoList(updated), "info");
		},
	});

	// Inject plan-mode context into system prompt
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!planModeActive) return;

		const existing = ctx.getSystemPrompt();
		return { systemPrompt: existing + "\n" + PLAN_MODE_PROMPT };
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeActive) return;

		const toolName = "name" in event ? (event.name as string) : "";
		const params = "params" in event ? (event.params as Record<string, unknown>) : {};

		if (toolName === "bash" || toolName === "shell" || toolName === "execute") {
			const command = (params.command || params.cmd || "") as string;
			if (command && !isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command "${command.slice(0, 80)}..." is not in the safe command allowlist. Only read-only commands are permitted.`,
				};
			}
		}

		// Block all writing tools explicitly
		const writingTools = ["write", "edit", "create_file", "write_file", "patch", "delete", "remove", "move", "rename"];
		if (writingTools.includes(toolName)) {
			return {
				block: true,
				reason: `Plan mode: "${toolName}" is a write operation. Only read-only tools are available in plan mode.`,
			};
		}
	});

	// Track [DONE:n] markers in assistant messages
	pi.on("turn_end", async (event) => {
		if (planModeActive) return; // Only track during execution mode

		const content = "content" in event ? (event.content as string) : "";
		if (!content) return;

		const doneMatches = content.matchAll(/\[DONE:(\d+)\]/g);
		for (const match of doneMatches) {
			const step = parseInt(match[1], 10) - 1; // Convert to 0-indexed
			if (!completedSteps.includes(step)) {
				completedSteps.push(step);
			}
		}
	});

	// Extract plan from agent output when plan mode ends
	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeActive) return;
		if (!ctx.hasUI) return;

		// Extract plan from the last assistant message
		const entries = ctx.sessionManager.getEntries();
		let lastAssistantText = "";
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = entry.message.content;
				if (Array.isArray(content)) {
					lastAssistantText = content
						.filter((c: { type: string }) => c.type === "text")
						.map((c: { text: string }) => c.text)
						.join("\n");
				} else if (typeof content === "string") {
					lastAssistantText = content;
				}
				break;
			}
		}

		const extracted = extractTodoItems(lastAssistantText);
		if (extracted.length > 0) {
			planItems = extracted;
			completedSteps = [];

			// Persist plan steps
			pi.appendEntry("plan-mode-steps", {
				steps: extracted.map((s) => s.text),
				timestamp: Date.now(),
			});
		}

		// Offer choice to user
		const choice = await ctx.ui.select("Plan complete. What would you like to do?", [
			{ label: "Execute plan (exit plan mode)", value: "execute" },
			{ label: "Refine plan (stay in plan mode)", value: "refine" },
			{ label: "Stay in plan mode", value: "stay" },
		]);

		if (choice === "execute") {
			deactivatePlanMode(ctx);
			if (extracted.length > 0) {
				ctx.ui.notify(`Plan loaded with ${extracted.length} steps. Use /todos to track progress.`, "info");
			}
		} else if (choice === "refine") {
			// Stay in plan mode, agent will continue
			ctx.ui.notify("Continuing in plan mode for refinement", "info");
		}
		// "stay" -- do nothing
	});
}
