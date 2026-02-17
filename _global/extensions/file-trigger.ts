import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

export default function (pi: ExtensionAPI) {
	const triggerFile = process.env.PI_TRIGGER_FILE || "/tmp/agent-trigger.txt";
	let watcher: fs.FSWatcher | undefined;

	pi.on("session_start", (_event, ctx) => {
		// Ensure the trigger file exists
		const dir = path.dirname(triggerFile);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		if (!fs.existsSync(triggerFile)) {
			fs.writeFileSync(triggerFile, "");
		}

		try {
			watcher = fs.watch(triggerFile, (eventType) => {
				if (eventType !== "change") return;

				try {
					const content = fs.readFileSync(triggerFile, "utf-8").trim();
					if (!content) return;

					// Clear the file after reading
					fs.writeFileSync(triggerFile, "");

					pi.sendMessage(
						{
							customType: "file-trigger",
							content: [{ type: "text", text: `[External trigger]: ${content}` }],
							display: "all",
							details: undefined,
						},
						{ triggerTurn: true },
					);
				} catch {
					// File may have been deleted between watch and read
				}
			});
		} catch {
			if (ctx.hasUI) {
				ctx.ui.notify(`Failed to watch trigger file: ${triggerFile}`, "warning");
			}
		}
	});

	pi.on("session_shutdown", () => {
		if (watcher) {
			watcher.close();
			watcher = undefined;
		}
	});
}
