import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROTECTED_PATHS = [".env", ".git/", "node_modules/", ".ssh/", "credentials", ".pi/"];

const DANGEROUS_PATTERNS = [
	/\brm\s+(-\w*\s+)*-\w*r\w*f/,  // rm -rf variants
	/\brm\s+(-\w*\s+)*-\w*f\w*r/,  // rm -fr variants
	/\bsudo\s+/,
	/\bchmod\s+777\b/,
	/\bchown\s+-R\b/,
	/\bmkfs\b/,
	/\bdd\s+.*of=\/dev\//,
	/\b>\s*\/dev\/sd/,
	/\bgit\s+push\s+.*--force\b/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\s+-[a-z]*f/,
];

function isProtectedPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return PROTECTED_PATHS.some(
		(p) => normalized.includes(p) || normalized.endsWith(p.replace(/\/$/, "")),
	);
}

function isDangerousCommand(command: string): string | undefined {
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(command)) {
			return pattern.source;
		}
	}
	return undefined;
}

async function checkDirtyRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"], { cwd });
	return code === 0 && stdout.trim().length > 0;
}

export default function (pi: ExtensionAPI) {
	// Block writes to protected paths and confirm dangerous commands
	pi.on("tool_call", async (event, ctx) => {
		const toolName = "name" in event ? (event.name as string) : "";
		const params = "params" in event ? (event.params as Record<string, unknown>) : {};

		// Check file-writing tools for protected paths
		const writingTools = ["write", "edit", "create_file", "write_file", "patch"];
		if (writingTools.includes(toolName)) {
			const filePath = (params.file_path || params.path || params.filename || "") as string;
			if (filePath && isProtectedPath(filePath)) {
				return {
					block: true,
					reason: `Blocked: writing to protected path "${filePath}". Protected paths include: ${PROTECTED_PATHS.join(", ")}`,
				};
			}
		}

		// Check bash commands for dangerous patterns
		if (toolName === "bash" || toolName === "shell" || toolName === "execute") {
			const command = (params.command || params.cmd || "") as string;
			if (!command) return;

			// Check for protected path access in commands
			if (isProtectedPath(command)) {
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: "Blocked: command targets a protected path",
					};
				}
				const proceed = await ctx.ui.confirm(
					"Protected Path",
					`This command accesses a protected path:\n\n${command}\n\nAllow execution?`,
				);
				if (!proceed) {
					return {
						block: true,
						reason: "User blocked command targeting protected path",
					};
				}
			}

			// Check for dangerous command patterns
			const dangerMatch = isDangerousCommand(command);
			if (dangerMatch) {
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `Blocked: potentially destructive command matching pattern: ${dangerMatch}`,
					};
				}
				const proceed = await ctx.ui.confirm(
					"Destructive Command",
					`This command matches a dangerous pattern:\n\n${command}\n\nAre you sure you want to allow this?`,
				);
				if (!proceed) {
					return {
						block: true,
						reason: "User blocked destructive command",
					};
				}
			}
		}
	});

	// Check for dirty repo before session switch
	pi.on("session_before_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const dirty = await checkDirtyRepo(pi, ctx.cwd);
		if (!dirty) return;

		const proceed = await ctx.ui.confirm(
			"Uncommitted Changes",
			"Your repository has uncommitted changes. Switching sessions may cause you to lose track of these changes.\n\nSwitch anyway?",
		);
		if (!proceed) {
			return { cancel: true };
		}
	});

	// Check for dirty repo before fork
	pi.on("session_before_fork", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const dirty = await checkDirtyRepo(pi, ctx.cwd);
		if (!dirty) return;

		const proceed = await ctx.ui.confirm(
			"Uncommitted Changes",
			"Your repository has uncommitted changes. Forking will create a new branch from this point.\n\nFork anyway?",
		);
		if (!proceed) {
			return { cancel: true };
		}
	});
}
