import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
  const STATUS_KEY = "git-dirty";
  const inZellij = !!process.env.ZELLIJ_SESSION_NAME;

  function zellijRenamePane(title: string) {
    if (!inZellij) return;
    try {
      pi.exec("zellij", ["action", "rename-pane", title]);
    } catch {
      // zellij CLI unavailable, ignore
    }
  }

  async function getGitBranch(cwd: string): Promise<string> {
    try {
      const result = await pi.exec(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd }
      );
      return result.stdout.trim();
    } catch {
      return "";
    }
  }

  async function updateGitStatus(ctx: any) {
    try {
      const result = await pi.exec("git", ["status", "--porcelain"], {
        cwd: ctx.cwd,
      });
      const dirty = result.stdout.trim().length > 0;
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      const branch = await getGitBranch(ctx.cwd);
      const dir = basename(ctx.cwd);

      const piStatus = dirty
        ? `git: ${lines.length} dirty`
        : "git: clean";

      const zellijTitle = branch
        ? `pi | ${dir} [${branch}${dirty ? "*" : ""}]`
        : `pi | ${dir}`;

      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, piStatus);
      }
      zellijRenamePane(zellijTitle);
    } catch {
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, "git: n/a");
      }
      zellijRenamePane("pi");
    }
  }

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

  pi.on("session_shutdown", async (_event, ctx) => {
    // Reset pane name on exit so Zellij reverts to default
    zellijRenamePane("");
  });

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
        // Get list of changed files for tab navigation
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

        // Get full diff
        const diffResult = await pi.exec(
          "git",
          ["diff", "--color=never", ...(staged ? ["--staged"] : []), ...fileArgs],
          { cwd: ctx.cwd },
        );
        const fullDiff = diffResult.stdout;

        // Parse diff into per-file sections
        const fileDiffs = parseDiffByFile(fullDiff);

        // Show the TUI viewer
        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          let scrollY = 0;
          let fileIndex = -1; // -1 = show all files
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
            const viewHeight = tui.terminal.rows - 4; // header + footer + borders

            if (matchesKey(data, "q") || matchesKey(data, "escape")) {
              cleanup();
              done();
              return { consume: true };
            }

            // Scroll
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

            // File navigation
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

            // Jump to next/prev hunk
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

              // Header
              const fileNav = fileDiffs.length > 1
                ? ` [${fileIndex === -1 ? "all" : `${fileIndex + 1}/${fileDiffs.length}`}]`
                : "";
              const headerText = ` git diff${scopeLabel}: ${label}${fileNav} `;
              const header = theme.fg("accent", theme.bold(truncateToWidth(headerText, width - 2)));
              const border = theme.fg("border", "\u2500".repeat(width));

              // Visible lines
              const visible = lines.slice(scrollY, scrollY + viewHeight);
              const rendered = visible.map((line) => colorDiffLine(line, theme, width));

              // Pad short content
              while (rendered.length < viewHeight) {
                rendered.push(theme.fg("dim", "~").padEnd(width));
              }

              // Footer
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

          // Poll for input-triggered redraws
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
      // Extract filename from "diff --git a/foo b/foo"
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
