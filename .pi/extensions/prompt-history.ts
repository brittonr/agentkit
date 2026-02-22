/**
 * Prompt History — persists editor history to .pi/prompt-history.jsonl
 * so up-arrow recalls prompts from previous sessions in the same repo.
 *
 * The built-in Editor already supports up/down arrow history navigation.
 * This extension just saves prompts to disk and reloads them on startup.
 */
import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

interface PromptEntry {
	text: string;
	timestamp: number;
}

export default function (pi: ExtensionAPI) {
	let cwd: string;

	function historyPath(): string {
		const dir = join(cwd, ".pi");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return join(dir, "prompt-history.jsonl");
	}

	function loadHistory(): PromptEntry[] {
		const path = historyPath();
		if (!existsSync(path)) return [];
		try {
			return readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	}

	function savePrompt(text: string) {
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("/")) return;
		const entry: PromptEntry = { text: trimmed, timestamp: Date.now() };
		appendFileSync(historyPath(), JSON.stringify(entry) + "\n");
	}

	// Save every submitted prompt to disk
	pi.on("input", async (event, _ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		savePrompt(event.text);
		return { action: "continue" as const };
	});

	// Replace editor with one that loads persisted history
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new CustomEditor(tui, theme, keybindings);

			// Load saved prompts into editor history (oldest first so newest = up-arrow first)
			const entries = loadHistory();
			const seen = new Set<string>();
			for (const entry of entries) {
				const t = entry.text.trim();
				if (!seen.has(t)) {
					seen.add(t);
					editor.addToHistory(t);
				}
			}

			return editor;
		});
	});
}
