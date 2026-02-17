import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
}
