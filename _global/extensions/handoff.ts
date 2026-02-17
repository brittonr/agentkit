import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Hand off context to a new focused session with an AI-generated summary",
		handler: async (args: string, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal description>", "warning");
				return;
			}

			// Gather conversation history
			const entries = ctx.sessionManager.getEntries();
			const conversationParts: string[] = [];

			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (msg.role === "user" || msg.role === "assistant") {
					const text = msg.content
						? (Array.isArray(msg.content)
								? msg.content
										.filter((c: { type: string }) => c.type === "text")
										.map((c: { text: string }) => c.text)
										.join("\n")
								: String(msg.content))
						: "";
					if (text.trim()) {
						conversationParts.push(`[${msg.role}]: ${text.slice(0, 2000)}`);
					}
				}
			}

			const conversationText = conversationParts.slice(-30).join("\n\n");

			// Generate summary via AI
			ctx.ui.setWorkingMessage("Generating handoff summary...");

			let summary: string;
			try {
				const model = ctx.model;
				if (!model) {
					ctx.ui.notify("No model available for summarization", "error");
					ctx.ui.setWorkingMessage(undefined);
					return;
				}

				const result = await complete(model, {
					systemPrompt: `You are creating a context handoff for a coding assistant. Generate a concise but complete summary that another session can use to continue work. Include:
1. What was being worked on (files, features, bugs)
2. Key decisions made and their rationale
3. Current state (what's done, what remains)
4. The specific goal for the new session

Format as a clear prompt that can be pasted into a new session.`,
					messages: [
						{
							role: "user",
							content: `Goal for new session: ${goal}\n\nConversation to summarize:\n${conversationText}`,
							timestamp: Date.now(),
						},
					],
				});

				summary = result.content
					.filter((c) => c.type === "text")
					.map((c) => "text" in c ? c.text : "")
					.join("\n");
			} catch (err) {
				ctx.ui.setWorkingMessage(undefined);
				ctx.ui.notify(`Failed to generate summary: ${err}`, "error");
				return;
			}

			ctx.ui.setWorkingMessage(undefined);

			if (!summary.trim()) {
				ctx.ui.notify("Generated summary was empty", "error");
				return;
			}

			// Let user review and edit the summary
			const edited = await ctx.ui.editor("Review and edit handoff prompt:", summary);
			if (!edited || !edited.trim()) {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}

			// Create a new session with the handoff prompt
			ctx.newSession();
			ctx.ui.setEditorText(edited);
			ctx.ui.notify("Handoff ready -- press Enter to start the new session", "info");
		},
	});
}
