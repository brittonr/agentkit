import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROTECTED_PATHS = [".env", ".git/", "node_modules/", ".ssh/", "credentials", ".pi/"];

const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
	// Filesystem destruction
	{ pattern: /\brm\s+(-\w*\s+)*-\w*r\w*f/, label: "recursive force delete" },
	{ pattern: /\brm\s+(-\w*\s+)*-\w*f\w*r/, label: "recursive force delete" },
	{ pattern: /\brm\s+(-[^\s]*r|--recursive)/, label: "recursive delete" },
	{ pattern: /\bsudo\b/, label: "sudo" },
	{ pattern: /\bchmod\b.*777/, label: "world-writable permissions" },
	{ pattern: /\bchown\s+-R\b/, label: "recursive chown" },
	{ pattern: /\bmkfs\b/, label: "format filesystem" },
	{ pattern: /\bdd\s+.*of=\/dev\//, label: "raw device write" },
	{ pattern: />\s*\/dev\/[sh]d[a-z]/, label: "raw device redirect" },

	// Git destructive operations
	{ pattern: /\bgit\s+push\s+.*(-f\b|--force\b)/, label: "force push" },
	{ pattern: /\bgit\s+reset\s+--hard\b/, label: "hard reset" },
	{ pattern: /\bgit\s+clean\s+-[^\s]*f/, label: "git clean" },
	{ pattern: /\bgit\s+checkout\s+(\S+\s+)?--\s/, label: "git checkout (reset files)" },
	{ pattern: /\bgit\s+checkout\s+\.\s*($|[;&|])/, label: "git checkout (reset all files)" },
	{ pattern: /\bgit\s+restore\b/, label: "git restore" },

	// Remote code execution
	{ pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, label: "pipe curl to shell" },
	{ pattern: /\bwget\b.*\|\s*(ba)?sh\b/, label: "pipe wget to shell" },
	{ pattern: /\bssh\b/, label: "ssh" },

	// GitHub CLI mutations
	{ pattern: /\bgh\s+issue\s+create\b/, label: "create GitHub issue" },
	{ pattern: /\bgh\s+issue\s+(close|delete|edit|comment)\b/, label: "modify GitHub issue" },
	{ pattern: /\bgh\s+pr\s+create\b/, label: "create GitHub PR" },
	{ pattern: /\bgh\s+pr\s+(close|merge|edit|comment|review)\b/, label: "modify GitHub PR" },
	{ pattern: /\bgh\s+repo\s+(create|delete|rename|archive)\b/, label: "modify GitHub repo" },
	{ pattern: /\bgh\s+release\s+(create|delete|edit)\b/, label: "modify GitHub release" },

	// Infrastructure deployment
	{ pattern: /\bclan\s+machines\s+update\b/, label: "deploy to machine" },
];

function isProtectedPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return PROTECTED_PATHS.some(
		(p) => normalized.includes(p) || normalized.endsWith(p.replace(/\/$/, "")),
	);
}

function isDangerousCommand(command: string): string | undefined {
	const matched = DANGEROUS_PATTERNS.filter((p) => p.pattern.test(command));
	if (matched.length > 0) {
		return matched.map((m) => m.label).join(", ");
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
