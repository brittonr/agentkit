import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { compact, DynamicBorder } from "@mariozechner/pi-coding-agent";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { Container, type SelectItem, SelectList, Text, type Component } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type LoopMode = "tests" | "custom" | "self";

interface LoopStateData {
	active: boolean;
	mode?: LoopMode;
	condition?: string;
	prompt?: string;
	summary?: string;
	loopCount?: number;
}

const LOOP_STATE_ENTRY = "loop-state";

const LOOP_PRESETS: readonly { value: LoopMode; label: string }[] = [
	{ value: "tests", label: "Until tests pass" },
	{ value: "custom", label: "Until custom condition" },
	{ value: "self", label: "Self driven (agent decides)" },
];

const SUMMARY_SYSTEM_PROMPT = `You summarize loop breakout conditions for a status widget.
Return a concise phrase (max 6 words) that says when the loop should stop.
Use plain text only, no quotes, no punctuation, no prefix.`;

function buildPrompt(mode: LoopMode, condition?: string): string {
	switch (mode) {
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

function getConditionText(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests": return "tests pass";
		case "custom": return condition?.trim() || "custom condition";
		case "self": return "you are done";
	}
}

function summarizeCondition(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests": return "tests pass";
		case "custom": {
			const s = condition?.trim() || "custom condition";
			return s.length > 48 ? `${s.slice(0, 45)}...` : s;
		}
		case "self": return "done";
	}
}

async function summarizeBreakoutCondition(
	ctx: ExtensionContext,
	mode: LoopMode,
	condition?: string,
): Promise<string> {
	const fallback = summarizeCondition(mode, condition);
	if (!ctx.model) return fallback;

	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return fallback;

	try {
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: getConditionText(mode, condition) }],
			timestamp: Date.now(),
		};

		const response = await complete(
			ctx.model,
			{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey },
		);

		if (response.stopReason === "aborted" || response.stopReason === "error") return fallback;

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();

		if (!summary) return fallback;
		return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
	} catch {
		return fallback;
	}
}

function updateStatus(ctx: ExtensionContext, state: LoopStateData): void {
	if (!ctx.hasUI) return;
	if (!state.active || !state.mode) {
		ctx.ui.setWidget("loop", undefined);
		return;
	}
	const turnText = `(turn ${state.loopCount ?? 0})`;
	const summary = state.summary?.trim();
	const text = summary
		? `Loop active: ${summary} ${turnText}`
		: `Loop active ${turnText}`;
	ctx.ui.setWidget("loop", [ctx.ui.theme.fg("accent", text)]);
}

function loadState(ctx: ExtensionContext): LoopStateData {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; customType?: string; data?: LoopStateData };
		if (entry.type === "custom" && entry.customType === LOOP_STATE_ENTRY && entry.data) {
			return entry.data;
		}
	}
	return { active: false };
}

export default function (pi: ExtensionAPI) {
	let loopState: LoopStateData = { active: false };

	function persistState(state: LoopStateData): void {
		pi.appendEntry(LOOP_STATE_ENTRY, state);
	}

	function setLoopState(state: LoopStateData, ctx: ExtensionContext): void {
		loopState = state;
		persistState(state);
		updateStatus(ctx, state);
	}

	function clearLoopState(ctx: ExtensionContext): void {
		loopState = { active: false };
		persistState(loopState);
		updateStatus(ctx, loopState);
	}

	function triggerLoopPrompt(ctx: ExtensionContext): void {
		if (!loopState.active || !loopState.mode || !loopState.prompt) return;
		if (ctx.hasPendingMessages()) return;

		const loopCount = (loopState.loopCount ?? 0) + 1;
		loopState = { ...loopState, loopCount };
		persistState(loopState);
		updateStatus(ctx, loopState);

		pi.sendMessage({
			customType: "loop",
			content: loopState.prompt,
			display: true,
		}, {
			deliverAs: "followUp",
			triggerTurn: true,
		});
	}

	function wasLastAssistantAborted(messages: Array<{ role?: string; stopReason?: string }>): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") return messages[i].stopReason === "aborted";
		}
		return false;
	}

	// -- Tool: signal_loop_success --

	pi.registerTool({
		name: "signal_loop_success",
		label: "Signal Loop Success",
		description:
			"Stop the active loop when the breakout condition is satisfied. " +
			"Only call this tool when explicitly instructed to do so by the user, tool, or system prompt.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!loopState.active) {
				return {
					content: [{ type: "text", text: "No active loop is running." }],
					details: undefined,
				};
			}

			clearLoopState(ctx);

			return {
				content: [{ type: "text", text: "Loop ended." }],
				details: undefined,
			};
		},
	});

	// -- Command: /loop --

	pi.registerCommand("loop", {
		description: "Start a follow-up loop: /loop tests | /loop custom <condition> | /loop self",
		handler: async (args, ctx) => {
			// Parse args
			let nextState: LoopStateData | null = null;
			const parts = args.trim().split(/\s+/);
			const mode = parts[0]?.toLowerCase();

			if (mode === "tests") {
				nextState = { active: true, mode: "tests", prompt: buildPrompt("tests") };
			} else if (mode === "self") {
				nextState = { active: true, mode: "self", prompt: buildPrompt("self") };
			} else if (mode === "custom" && parts.slice(1).join(" ").trim()) {
				const condition = parts.slice(1).join(" ").trim();
				nextState = { active: true, mode: "custom", condition, prompt: buildPrompt("custom", condition) };
			}

			// Show selector if no valid args
			if (!nextState && ctx.hasUI) {
				const items: SelectItem[] = LOOP_PRESETS.map((p) => ({
					value: p.value,
					label: p.label,
					description: "",
				}));

				const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
					container.addChild(new Text(theme.fg("accent", theme.bold("Select loop mode"))));

					const selectList = new SelectList(items, Math.min(items.length, 10), {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					});

					selectList.onSelect = (item) => done(item.value);
					selectList.onCancel = () => done(null);

					container.addChild(selectList);
					container.addChild(new Text(theme.fg("dim", "Enter to confirm, Esc to cancel")));
					container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

					return {
						render(width: number) { return container.render(width); },
						invalidate() { container.invalidate(); },
						handleInput(data: string) {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				});

				if (!selection) {
					ctx.ui.notify("Loop cancelled", "info");
					return;
				}

				if (selection === "tests") {
					nextState = { active: true, mode: "tests", prompt: buildPrompt("tests") };
				} else if (selection === "self") {
					nextState = { active: true, mode: "self", prompt: buildPrompt("self") };
				} else if (selection === "custom") {
					const condition = await ctx.ui.editor("Enter loop breakout condition:", "");
					if (!condition?.trim()) {
						ctx.ui.notify("Loop cancelled", "info");
						return;
					}
					nextState = {
						active: true,
						mode: "custom",
						condition: condition.trim(),
						prompt: buildPrompt("custom", condition.trim()),
					};
				}
			}

			if (!nextState) {
				ctx.ui.notify("Usage: /loop tests | /loop custom <condition> | /loop self", "warning");
				return;
			}

			// Confirm replace if already active
			if (loopState.active && ctx.hasUI) {
				const confirm = await ctx.ui.confirm("Replace active loop?", "A loop is already active. Replace it?");
				if (!confirm) {
					ctx.ui.notify("Loop unchanged", "info");
					return;
				}
			}

			setLoopState({ ...nextState, summary: undefined, loopCount: 0 }, ctx);
			ctx.ui.notify("Loop active", "info");
			triggerLoopPrompt(ctx);

			// Generate summary in background
			const { mode: loopMode, condition: loopCondition } = nextState;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, loopMode!, loopCondition);
				if (!loopState.active || loopState.mode !== loopMode) return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		},
	});

	// -- Event: agent_end -- continue loop or break on abort

	pi.on("agent_end", async (event, ctx) => {
		if (!loopState.active) return;

		if (ctx.hasUI && wasLastAssistantAborted(event.messages)) {
			const confirm = await ctx.ui.confirm(
				"Break active loop?",
				"Operation aborted. Break out of the loop?",
			);
			if (confirm) {
				clearLoopState(ctx);
				ctx.ui.notify("Loop ended", "info");
				return;
			}
		}

		triggerLoopPrompt(ctx);
	});

	// -- Event: session_before_compact -- preserve loop state in compaction

	pi.on("session_before_compact", async (event, ctx) => {
		if (!loopState.active || !loopState.mode || !ctx.model) return;
		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		if (!apiKey) return;

		const conditionText = getConditionText(loopState.mode, loopState.condition);
		const instructions = [
			event.customInstructions,
			`Loop active. Breakout condition: ${conditionText}. Preserve this loop state and breakout condition in the summary.`,
		]
			.filter(Boolean)
			.join("\n\n");

		try {
			const compaction = await compact(event.preparation, ctx.model, apiKey, instructions, event.signal);
			return { compaction };
		} catch {
			return;
		}
	});

	// -- Restore state on session start/switch --

	async function restoreLoopState(ctx: ExtensionContext): Promise<void> {
		loopState = loadState(ctx);
		updateStatus(ctx, loopState);

		if (loopState.active && loopState.mode && !loopState.summary) {
			const mode = loopState.mode;
			const condition = loopState.condition;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (!loopState.active || loopState.mode !== mode) return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await restoreLoopState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await restoreLoopState(ctx);
	});
}
