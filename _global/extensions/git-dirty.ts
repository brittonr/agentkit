/**
 * Git status extension
 *
 * Shows a rich git status in the bottom bar:
 *   git: main ✓                     ← clean
 *   git: main ↑2 +1 *3 ?2 +42/-17  ← ahead 2, 1 staged, 3 modified, 2 untracked, diff
 *
 * Components:
 *   branch  — current branch or detached HEAD
 *   ↑N ↓M   — commits ahead/behind upstream
 *   +N      — staged files
 *   *N      — unstaged modified files
 *   ?N      — untracked files
 *   !N      — conflicted files
 *   +A/-R   — lines added/removed (green/red)
 *   ✓       — working tree is clean
 *
 * Uses a single `git status --porcelain=v2 --branch` call for branch info
 * and file states, plus `git diff --shortstat HEAD` for line-level diff.
 *
 * Also:
 *   - Renames the Zellij pane to show branch + dirty indicator
 *   - /dirty  — show dirty file list
 *   - /diff   — scrollable diff viewer with per-file navigation
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { basename } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface GitInfo {
	branch: string;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicted: number;
	added: number;    // lines added (diff)
	removed: number;  // lines removed (diff)
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseGitStatus(output: string): Omit<GitInfo, "added" | "removed"> {
	let branch = "";
	let ahead = 0;
	let behind = 0;
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let conflicted = 0;

	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.head ")) {
			branch = line.slice("# branch.head ".length).trim();
		} else if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+)\s+-(\d+)/);
			if (match) {
				ahead = parseInt(match[1], 10);
				behind = parseInt(match[2], 10);
			}
		} else if (line.startsWith("u ")) {
			// Unmerged entry
			conflicted++;
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			// Ordinary or rename entry: "1 XY ..." or "2 XY ..."
			const xy = line.split(" ")[1];
			if (xy && xy.length >= 2) {
				const x = xy[0]; // index (staged)
				const y = xy[1]; // worktree (unstaged)
				if (x !== ".") staged++;
				if (y !== ".") modified++;
			}
		} else if (line.startsWith("? ")) {
			untracked++;
		}
	}

	return { branch, ahead, behind, staged, modified, untracked, conflicted };
}

function parseDiffShortstat(output: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	const addMatch = output.match(/(\d+)\s+insertion/);
	const remMatch = output.match(/(\d+)\s+deletion/);
	if (addMatch) added = parseInt(addMatch[1], 10);
	if (remMatch) removed = parseInt(remMatch[1], 10);
	return { added, removed };
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatStatus(info: GitInfo, theme: Theme): string {
	const parts: string[] = [];

	// Branch
	parts.push(theme.fg("text", `git: ${info.branch || "HEAD"}`));

	const dirty = info.staged + info.modified + info.untracked + info.conflicted > 0;

	if (!dirty && info.added === 0 && info.removed === 0) {
		// Clean
		parts.push(theme.fg("success", "✓"));
	} else {
		// Ahead / behind
		if (info.ahead > 0)  parts.push(theme.fg("accent", `↑${info.ahead}`));
		if (info.behind > 0) parts.push(theme.fg("warning", `↓${info.behind}`));

		// File counts
		if (info.staged > 0)    parts.push(theme.fg("success", `+${info.staged}`));
		if (info.modified > 0)  parts.push(theme.fg("warning", `*${info.modified}`));
		if (info.untracked > 0) parts.push(theme.fg("muted", `?${info.untracked}`));
		if (info.conflicted > 0) parts.push(theme.fg("error", `!${info.conflicted}`));

		// Diff stat (lines)
		if (info.added > 0 || info.removed > 0) {
			const diffParts: string[] = [];
			if (info.added > 0)   diffParts.push(theme.fg("success", `+${info.added}`));
			if (info.removed > 0) diffParts.push(theme.fg("error", `-${info.removed}`));
			parts.push(diffParts.join(theme.fg("dim", "/")));
		}
	}

	// Ahead/behind even when clean
	if (!dirty && (info.ahead > 0 || info.behind > 0)) {
		// Remove the ✓ we just added and replace with ahead/behind
		parts.pop();
		if (info.ahead > 0)  parts.push(theme.fg("accent", `↑${info.ahead}`));
		if (info.behind > 0) parts.push(theme.fg("warning", `↓${info.behind}`));
		parts.push(theme.fg("success", "✓"));
	}

	return parts.join(" ");
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const STATUS_KEY = "git-dirty";
	const inZellij = !!process.env.ZELLIJ_SESSION_NAME;

	function zellijRenamePane(title: string) {
		if (!inZellij) return;
		try {
			pi.exec("zellij", ["action", "rename-pane", title]);
		} catch {
			// zellij CLI unavailable
		}
	}

	async function updateGitStatus(ctx: ExtensionContext): Promise<void> {
		try {
			// Single call for branch + ahead/behind + all file states
			const statusResult = await pi.exec(
				"git", ["status", "--porcelain=v2", "--branch"],
				{ cwd: ctx.cwd },
			);
			const info = parseGitStatus(statusResult.stdout);

			// Line-level diff stat: compare working tree to HEAD
			let added = 0;
			let removed = 0;
			try {
				const diffResult = await pi.exec(
					"git", ["diff", "--shortstat", "HEAD"],
					{ cwd: ctx.cwd },
				);
				const diff = parseDiffShortstat(diffResult.stdout);
				added = diff.added;
				removed = diff.removed;
			} catch {
				// Initial commit or other edge case — try without HEAD
				try {
					const diffResult = await pi.exec(
						"git", ["diff", "--shortstat"],
						{ cwd: ctx.cwd },
					);
					const diff = parseDiffShortstat(diffResult.stdout);
					added = diff.added;
					removed = diff.removed;
				} catch {
					// No diff available
				}
			}

			const fullInfo: GitInfo = { ...info, added, removed };
			const dirty = info.staged + info.modified + info.untracked + info.conflicted > 0;
			const dir = basename(ctx.cwd);

			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, formatStatus(fullInfo, ctx.ui.theme));
			}

			// Zellij pane title
			const zellijTitle = info.branch
				? `pi | ${dir} [${info.branch}${dirty ? "*" : ""}]`
				: `pi | ${dir}`;
			zellijRenamePane(zellijTitle);
		} catch {
			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, "git: n/a");
			}
			zellijRenamePane("pi");
		}
	}

	// ── Lifecycle hooks ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		await updateGitStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await updateGitStatus(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (
			event.toolName === "bash" ||
			event.toolName === "write" ||
			event.toolName === "edit"
		) {
			await updateGitStatus(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		zellijRenamePane("");
	});

	// ── Commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("dirty", {
		description: "Show git dirty status",
		handler: async (_args, ctx) => {
			try {
				const result = await pi.exec("git", ["status", "--short"], {
					cwd: ctx.cwd,
				});
				const output = result.stdout.trim();
				if (output.length === 0) {
					ctx.ui.notify("Working tree is clean", "success");
				} else {
					ctx.ui.notify(`Dirty files:\n${output}`, "warning");
				}
			} catch {
				ctx.ui.notify("Not a git repository", "error");
			}
		},
	});

	pi.registerCommand("diff", {
		description: "Show git diff in a scrollable viewer. Usage: /diff [file] [--staged]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const staged = parts.includes("--staged");
			const fileArgs = parts.filter((p) => p !== "--staged");

			try {
				const nameResult = await pi.exec(
					"git",
					["diff", "--name-only", ...(staged ? ["--staged"] : []), ...fileArgs],
					{ cwd: ctx.cwd },
				);
				const changedFiles = nameResult.stdout.trim().split("\n").filter(Boolean);

				if (changedFiles.length === 0) {
					const scope = staged ? "staged" : "unstaged";
					ctx.ui.notify(`No ${scope} changes`, "info");
					return;
				}

				const diffResult = await pi.exec(
					"git",
					["diff", "--color=never", ...(staged ? ["--staged"] : []), ...fileArgs],
					{ cwd: ctx.cwd },
				);
				const fullDiff = diffResult.stdout;
				const fileDiffs = parseDiffByFile(fullDiff);

				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
					let scrollY = 0;
					let fileIndex = -1;
					let needsRender = false;

					function currentLines(): string[] {
						if (fileIndex === -1) return fullDiff.split("\n");
						const fd = fileDiffs[fileIndex];
						return fd ? fd.lines : [];
					}

					function currentLabel(): string {
						if (fileIndex === -1) return `All files (${changedFiles.length})`;
						return changedFiles[fileIndex] || "unknown";
					}

					const cleanup = tui.addInputListener((data) => {
						const lines = currentLines();
						const viewHeight = tui.terminal.rows - 4;

						if (matchesKey(data, "q") || matchesKey(data, "escape")) {
							cleanup();
							done();
							return { consume: true };
						}

						if (matchesKey(data, "j") || matchesKey(data, "down")) {
							scrollY = Math.min(scrollY + 1, Math.max(0, lines.length - viewHeight));
							needsRender = true;
							return { consume: true };
						}
						if (matchesKey(data, "k") || matchesKey(data, "up")) {
							scrollY = Math.max(0, scrollY - 1);
							needsRender = true;
							return { consume: true };
						}
						if (matchesKey(data, "d") || matchesKey(data, "pagedown")) {
							scrollY = Math.min(scrollY + Math.floor(viewHeight / 2), Math.max(0, lines.length - viewHeight));
							needsRender = true;
							return { consume: true };
						}
						if (matchesKey(data, "u") || matchesKey(data, "pageup")) {
							scrollY = Math.max(0, scrollY - Math.floor(viewHeight / 2));
							needsRender = true;
							return { consume: true };
						}
						if (matchesKey(data, "g") || matchesKey(data, "home")) {
							scrollY = 0;
							needsRender = true;
							return { consume: true };
						}
						if (matchesKey(data, "shift+g") || matchesKey(data, "end")) {
							scrollY = Math.max(0, lines.length - viewHeight);
							needsRender = true;
							return { consume: true };
						}

						if (matchesKey(data, "tab") || matchesKey(data, "l") || matchesKey(data, "right")) {
							fileIndex = fileIndex >= fileDiffs.length - 1 ? -1 : fileIndex + 1;
							scrollY = 0;
							needsRender = true;
							return { consume: true };
						}
						if (matchesKey(data, "shift+tab") || matchesKey(data, "h") || matchesKey(data, "left")) {
							fileIndex = fileIndex <= -1 ? fileDiffs.length - 1 : fileIndex - 1;
							scrollY = 0;
							needsRender = true;
							return { consume: true };
						}

						if (matchesKey(data, "n")) {
							const ls = currentLines();
							for (let i = scrollY + 1; i < ls.length; i++) {
								if (ls[i].startsWith("@@")) { scrollY = i; break; }
							}
							needsRender = true;
							return { consume: true };
						}
						if (matchesKey(data, "shift+n")) {
							const ls = currentLines();
							for (let i = scrollY - 1; i >= 0; i--) {
								if (ls[i].startsWith("@@")) { scrollY = i; break; }
							}
							needsRender = true;
							return { consume: true };
						}

						return undefined;
					});

					const component: Component & { dispose(): void } = {
						render(width: number): string[] {
							const lines = currentLines();
							const viewHeight = tui.terminal.rows - 4;
							const label = currentLabel();
							const scopeLabel = staged ? " (staged)" : "";

							const fileNav = fileDiffs.length > 1
								? ` [${fileIndex === -1 ? "all" : `${fileIndex + 1}/${fileDiffs.length}`}]`
								: "";
							const headerText = ` git diff${scopeLabel}: ${label}${fileNav} `;
							const header = theme.fg("accent", theme.bold(truncateToWidth(headerText, width - 2)));
							const border = theme.fg("border", "\u2500".repeat(width));

							const visible = lines.slice(scrollY, scrollY + viewHeight);
							const rendered = visible.map((line) => colorDiffLine(line, theme, width));

							while (rendered.length < viewHeight) {
								rendered.push(theme.fg("dim", "~").padEnd(width));
							}

							const pos = lines.length > 0
								? `${scrollY + 1}-${Math.min(scrollY + viewHeight, lines.length)}/${lines.length}`
								: "empty";
							const pct = lines.length > 0
								? `${Math.round(((scrollY + viewHeight) / lines.length) * 100)}%`
								: "";
							const keys = "q:close  j/k:scroll  h/l:file  n/N:hunk  d/u:page  g/G:top/end";
							const footerLeft = theme.fg("muted", ` ${keys}`);
							const footerRight = theme.fg("dim", `${pos} ${pct} `);
							const footerPad = Math.max(0, width - keys.length - pos.length - pct.length - 4);
							const footer = footerLeft + " ".repeat(footerPad) + footerRight;

							return [header, border, ...rendered, border, footer];
						},

						invalidate() {
							needsRender = false;
							tui.requestRender(true);
						},

						dispose() {
							cleanup();
						},
					};

					const interval = setInterval(() => {
						if (needsRender) component.invalidate();
					}, 16);

					const origDispose = component.dispose;
					component.dispose = () => {
						clearInterval(interval);
						origDispose();
					};

					return component;
				}, { overlay: true });
			} catch {
				ctx.ui.notify("Not a git repository or diff failed", "error");
			}
		},
	});
}

// ── Diff viewer helpers ──────────────────────────────────────────────────────

interface FileDiff {
	filename: string;
	lines: string[];
}

function parseDiffByFile(diff: string): FileDiff[] {
	const result: FileDiff[] = [];
	const lines = diff.split("\n");
	let current: FileDiff | undefined;

	for (const line of lines) {
		if (line.startsWith("diff --git")) {
			const match = line.match(/diff --git a\/.+ b\/(.+)/);
			const filename = match ? match[1] : "unknown";
			current = { filename, lines: [line] };
			result.push(current);
		} else if (current) {
			current.lines.push(line);
		}
	}

	return result;
}

function colorDiffLine(line: string, theme: Theme, width: number): string {
	const truncated = truncateToWidth(line, width - 1);

	if (line.startsWith("+++ ") || line.startsWith("--- ")) {
		return theme.bold(theme.fg("muted", truncated));
	}
	if (line.startsWith("+")) {
		return theme.fg("toolDiffAdded", truncated);
	}
	if (line.startsWith("-")) {
		return theme.fg("toolDiffRemoved", truncated);
	}
	if (line.startsWith("@@")) {
		return theme.fg("accent", truncated);
	}
	if (line.startsWith("diff --git")) {
		return theme.bold(theme.fg("text", truncated));
	}
	return theme.fg("toolDiffContext", truncated);
}
