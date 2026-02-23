/**
 * Worktree isolation — every pi session runs in a fresh git worktree.
 *
 * During extension init (before session_start):
 *   1. Creates a detached worktree from HEAD
 *   2. Overrides all built-in tools with instances whose cwd is the worktree
 *   3. Calls process.chdir() so pi.exec() and child processes follow
 *
 * On session_shutdown:
 *   Removes the worktree.
 *
 * Skips if already inside a worktree (avoids nesting).
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	createGrepTool,
	createFindTool,
	createLsTool,
} from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

function git(args: string[], cwd: string): string {
	return execSync(["git", ...args].join(" "), {
		cwd,
		encoding: "utf8",
		timeout: 10_000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function isWorktree(cwd: string): boolean {
	try {
		const gitDir = git(["rev-parse", "--git-dir"], cwd);
		const commonDir = git(["rev-parse", "--git-common-dir"], cwd);
		return gitDir !== commonDir;
	} catch {
		return false;
	}
}

function isGitRepo(cwd: string): boolean {
	try {
		git(["rev-parse", "--show-toplevel"], cwd);
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	if (!isGitRepo(cwd) || isWorktree(cwd)) return;

	const toplevel = git(["rev-parse", "--show-toplevel"], cwd);
	const repoName = basename(toplevel);
	const base = join(tmpdir(), "pi-worktrees", repoName);
	const name = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const wtPath = join(base, name);

	try {
		mkdirSync(base, { recursive: true });
		git(["worktree", "add", "--detach", wtPath, "HEAD"], toplevel);
	} catch {
		return;
	}

	// Override all built-in tools to use worktree cwd
	const tools = [
		createBashTool(wtPath),
		createReadTool(wtPath),
		createWriteTool(wtPath),
		createEditTool(wtPath),
		createGrepTool(wtPath),
		createFindTool(wtPath),
		createLsTool(wtPath),
	];
	for (const tool of tools) {
		pi.registerTool(tool as any);
	}

	// Shift process cwd so pi.exec() and other extensions follow
	process.chdir(wtPath);

	// Cleanup on process exit (covers print mode where session_shutdown may not fire)
	function cleanup() {
		try {
			process.chdir(cwd);
		} catch {}

		try {
			execSync(`git -C "${toplevel}" worktree remove --force "${wtPath}"`, {
				stdio: "ignore",
				timeout: 5_000,
			});
		} catch {
			try {
				rmSync(wtPath, { recursive: true, force: true });
				execSync(`git -C "${toplevel}" worktree prune`, {
					stdio: "ignore",
					timeout: 5_000,
				});
			} catch {}
		}
	}

	process.on("exit", cleanup);

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(
			"worktree",
			ctx.ui.theme.fg("success", `wt: ${name}`),
		);
	});

	pi.on("session_shutdown", async () => {
		cleanup();
		process.removeListener("exit", cleanup);
	});
}
