import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function notify(title: string, body: string): void {
	// OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
	// Supported: Ghostty, iTerm2, WezTerm, rxvt-unicode
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function extractLastAssistantText(
	messages: Array<{ role?: string; content?: unknown }>,
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;

		const content = message.content;
		if (typeof content === "string") return content.trim() || null;

		if (Array.isArray(content)) {
			const text = content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part && typeof part === "object" && part.type === "text" && "text" in part,
				)
				.map((part) => part.text)
				.join("\n")
				.trim();
			return text || null;
		}

		return null;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event) => {
		const lastText = extractLastAssistantText(event.messages ?? []);
		const normalized = (lastText ?? "").replace(/\s+/g, " ").trim();

		if (!normalized) {
			notify("Ready for input", "");
			return;
		}

		const maxBody = 200;
		const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}...` : normalized;
		notify("\u03c0", body);
	});
}
