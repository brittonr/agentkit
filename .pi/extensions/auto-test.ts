import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Auto-test hook: after the agent finishes, detects which project(s) were
 * affected by file changes and runs only the relevant, scoped tests.
 *
 * Supported ecosystems:
 *   Rust      — cargo test -p <crate> (nextest if available), workspace-aware
 *   Node/TS   — npm/yarn/pnpm test, scoped to nearest package.json
 *   Python    — pytest scoped to package directory
 *   Go        — go test ./affected/package/...
 *   Nix       — nix flake check (only when .nix files change)
 *   Make/Just — fallback: make test / just test
 */

// Files that never need testing
const SKIP_RE =
  /\.(md|txt|rst|adoc|png|jpg|jpeg|gif|svg|ico|webp|pdf|doc|docx|csv|log|lock)$|^\.git\//i;

interface PlannedCheck {
  key: string;
  label: string;
  command: string;
}

interface CheckResult {
  label: string;
  passed: boolean;
  output: string;
}

interface CargoPackageInfo {
  name: string;
  dir: string; // directory containing the crate's Cargo.toml
}

interface CargoWorkspace {
  root: string;
  packages: CargoPackageInfo[];
}

interface DetectionCache {
  cargoWorkspaces: Map<string, CargoWorkspace | null>;
  hasNextest: boolean | null;
  hasPytest: boolean | null;
  repoRoot: string;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let autoFix = true;
  const MAX_FIX_ATTEMPTS = 3;
  let fixAttempts = 0;
  let inFixCycle = false;
  const changedFiles = new Set<string>();

  // --- Track file mutations ---

  pi.on("tool_call", async (event) => {
    if (!enabled) return;
    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath: string | undefined = event.input?.path;
      if (filePath) changedFiles.add(filePath);
    }
  });

  // --- Run checks after agent finishes ---

  pi.on("agent_end", async (_event, ctx) => {
    if (!enabled || changedFiles.size === 0) return;

    // Reset fix counter on user-initiated runs (not our auto-fix cycles)
    if (!inFixCycle) {
      fixAttempts = 0;
    }
    inFixCycle = false;

    const files = [...changedFiles];
    changedFiles.clear();

    // Init cache
    let repoRoot = ctx.cwd;
    try {
      const git = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
        timeout: 5000,
      });
      if (git.code === 0) repoRoot = git.stdout.trim();
    } catch {}

    const cache: DetectionCache = {
      cargoWorkspaces: new Map(),
      hasNextest: null,
      hasPytest: null,
      repoRoot,
    };

    const checks = await planChecks(pi, files, ctx.cwd, cache);
    if (checks.length === 0) return;

    const labels = checks.map((c) => c.label).join(", ");
    ctx.ui.setStatus("auto-test", `Running: ${labels}`);

    const results: CheckResult[] = [];

    for (const check of checks) {
      ctx.ui.setStatus("auto-test", `Running: ${check.label}...`);
      try {
        const r = await pi.exec("bash", ["-c", check.command], {
          timeout: 180_000,
        });
        results.push({
          label: check.label,
          passed: r.code === 0,
          output: (r.stdout + "\n" + r.stderr).trim(),
        });
      } catch (err: any) {
        results.push({
          label: check.label,
          passed: false,
          output: `Execution error: ${err.message}`,
        });
      }
    }

    ctx.ui.setStatus("auto-test", undefined);

    const passed = results.filter((r) => r.passed);
    const failed = results.filter((r) => !r.passed);

    if (failed.length === 0) {
      if (fixAttempts > 0) {
        ctx.ui.notify(
          `✅ All checks passed after ${fixAttempts} auto-fix attempt${fixAttempts > 1 ? "s" : ""}: ${passed.map((r) => r.label).join(", ")}`,
          "info"
        );
        fixAttempts = 0;
      } else {
        ctx.ui.notify(
          `✅ All checks passed: ${passed.map((r) => r.label).join(", ")}`,
          "info"
        );
      }
    } else {
      const failureSummary = failed
        .map((r) => {
          const tail = r.output.split("\n").slice(-40).join("\n");
          return `### ${r.label}\n\`\`\`\n${tail}\n\`\`\``;
        })
        .join("\n\n");

      const passedNote =
        passed.length > 0
          ? `\n\nPassed: ${passed.map((r) => r.label).join(", ")}`
          : "";

      // Auto-fix: trigger agent to fix failures
      if (autoFix && fixAttempts < MAX_FIX_ATTEMPTS) {
        fixAttempts++;
        inFixCycle = true;

        ctx.ui.notify(
          `🔧 Auto-fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}: ${failed.map((r) => r.label).join(", ")}`,
          "warning"
        );

        pi.sendMessage(
          {
            customType: "auto-test",
            content: `Auto-test failure (auto-fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}) after changes to: ${files.join(", ")}\n\n${failureSummary}${passedNote}\n\nFix these test failures. Look at the error output carefully, identify the root cause, and make the minimal changes needed to fix the issue. Do NOT just suppress or skip tests.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" }
        );
      } else {
        // Report-only: either auto-fix is off or we've exhausted attempts
        const exhausted = autoFix && fixAttempts >= MAX_FIX_ATTEMPTS;

        ctx.ui.notify(
          exhausted
            ? `❌ Auto-fix exhausted (${MAX_FIX_ATTEMPTS} attempts): ${failed.map((r) => r.label).join(", ")}`
            : `❌ Failed: ${failed.map((r) => r.label).join(", ")}`,
          "error"
        );

        const header = exhausted
          ? `Auto-test still failing after ${MAX_FIX_ATTEMPTS} auto-fix attempts. Changes to: ${files.join(", ")}`
          : `Auto-test results after changes to: ${files.join(", ")}`;

        pi.sendMessage(
          {
            customType: "auto-test",
            content: `${header}\n\n${failureSummary}${passedNote}\n\nPlease review and fix the failures manually.`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "followUp" }
        );

        fixAttempts = 0;
      }
    }
  });

  // --- Toggle commands ---

  pi.registerCommand("auto-test", {
    description: "Toggle auto-test hook on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(
        `🧪 Auto-test ${enabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  });

  pi.registerCommand("auto-fix", {
    description: "Toggle auto-fix (agent auto-fixes test failures) on/off",
    handler: async (_args, ctx) => {
      autoFix = !autoFix;
      ctx.ui.notify(
        `🔧 Auto-fix ${autoFix ? "enabled" : "disabled"} (max ${MAX_FIX_ATTEMPTS} attempts)`,
        "info"
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `🧪 Auto-test active, auto-fix ${autoFix ? "on" : "off"} (/auto-test, /auto-fix to toggle)`,
      "info"
    );
  });
}

// ============================================================
// Check planning — map changed files → scoped test commands
// ============================================================

async function planChecks(
  pi: ExtensionAPI,
  files: string[],
  cwd: string,
  cache: DetectionCache
): Promise<PlannedCheck[]> {
  const checks = new Map<string, PlannedCheck>();

  for (const file of files) {
    if (SKIP_RE.test(file)) continue;

    const absFile = path.resolve(cwd, file);
    const found = await checksForFile(pi, absFile, cache);

    for (const check of found) {
      if (!checks.has(check.key)) checks.set(check.key, check);
    }
  }

  return [...checks.values()];
}

async function checksForFile(
  pi: ExtensionAPI,
  absFile: string,
  cache: DetectionCache
): Promise<PlannedCheck[]> {
  const results: PlannedCheck[] = [];
  const repoRoot = cache.repoRoot;
  let dir = path.dirname(absFile);

  // Walk up from file → repo root looking for project markers
  while (true) {
    // Rust
    if (exists(dir, "Cargo.toml")) {
      const c = await rustCheck(pi, absFile, dir, cache);
      if (c) results.push(c);
      break;
    }

    // Node / TypeScript
    if (exists(dir, "package.json")) {
      const c = nodeCheck(absFile, dir);
      if (c) results.push(c);
      break;
    }

    // Python
    if (exists(dir, "pyproject.toml") || exists(dir, "setup.py") || exists(dir, "setup.cfg")) {
      const c = await pythonCheck(pi, absFile, dir, cache);
      if (c) results.push(c);
      break;
    }

    // Go
    if (exists(dir, "go.mod")) {
      const c = goCheck(absFile, dir);
      if (c) results.push(c);
      break;
    }

    if (dir === repoRoot || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }

  // Nix: .nix file changes trigger flake evaluation
  if (
    absFile.endsWith(".nix") &&
    exists(repoRoot, "flake.nix")
  ) {
    results.push({
      key: `nix:${repoRoot}`,
      label: "nix flake check",
      command: `cd ${esc(repoRoot)} && nix flake check 2>&1`,
    });
  }

  // Fallback: Makefile / justfile at repo root
  if (results.length === 0) {
    const c = await makeCheck(pi, repoRoot);
    if (c) results.push(c);
  }

  return results;
}

// ============================================================
// Rust
// ============================================================

async function rustCheck(
  pi: ExtensionAPI,
  absFile: string,
  cargoDir: string,
  cache: DetectionCache
): Promise<PlannedCheck | null> {
  // Resolve workspace (cargo metadata finds the workspace root from any member)
  let ws = cache.cargoWorkspaces.get(cargoDir);
  if (ws === undefined) {
    ws = await loadCargoWorkspace(pi, cargoDir);
    cache.cargoWorkspaces.set(cargoDir, ws);
    if (ws) cache.cargoWorkspaces.set(ws.root, ws);
  }

  // Detect nextest
  if (cache.hasNextest === null) {
    try {
      const r = await pi.exec("cargo", ["nextest", "--version"], {
        timeout: 5000,
      });
      cache.hasNextest = r.code === 0;
    } catch {
      cache.hasNextest = false;
    }
  }

  const sub = cache.hasNextest ? "nextest run" : "test";
  const root = ws?.root ?? cargoDir;

  // Workspace with multiple packages → scope to affected crate
  if (ws && ws.packages.length > 1) {
    const pkg = ws.packages.find(
      (p) =>
        absFile.startsWith(p.dir + path.sep) ||
        path.dirname(absFile) === p.dir
    );

    if (pkg) {
      return {
        key: `rust:${root}:${pkg.name}`,
        label: `cargo test -p ${pkg.name}`,
        command: `cd ${esc(root)} && cargo ${sub} -p ${pkg.name} 2>&1`,
      };
    }
  }

  // Single crate or file doesn't map to a known package
  return {
    key: `rust:${root}`,
    label: "cargo test",
    command: `cd ${esc(root)} && cargo ${sub} 2>&1`,
  };
}

async function loadCargoWorkspace(
  pi: ExtensionAPI,
  dir: string
): Promise<CargoWorkspace | null> {
  try {
    const r = await pi.exec(
      "bash",
      ["-c", `cd ${esc(dir)} && cargo metadata --no-deps --format-version 1 2>/dev/null`],
      { timeout: 15_000 }
    );
    if (r.code !== 0) return null;

    const meta = JSON.parse(r.stdout);
    return {
      root: meta.workspace_root,
      packages: meta.packages.map((p: any) => ({
        name: p.name,
        dir: path.dirname(p.manifest_path),
      })),
    };
  } catch {
    return null;
  }
}

// ============================================================
// Node / TypeScript
// ============================================================

function nodeCheck(absFile: string, pkgDir: string): PlannedCheck | null {
  try {
    const raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw);

    const testScript: string | undefined = pkg.scripts?.test;
    if (!testScript || testScript.includes("no test specified")) return null;

    // Detect package manager
    const runner = exists(pkgDir, "pnpm-lock.yaml")
      ? "pnpm"
      : exists(pkgDir, "yarn.lock")
        ? "yarn"
        : "npm";

    const name = pkg.name || path.basename(pkgDir);

    return {
      key: `node:${pkgDir}`,
      label: `${runner} test (${name})`,
      command: `cd ${esc(pkgDir)} && ${runner} test 2>&1`,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Python
// ============================================================

async function pythonCheck(
  pi: ExtensionAPI,
  absFile: string,
  projectDir: string,
  cache: DetectionCache
): Promise<PlannedCheck | null> {
  // Check if any test files exist in this project
  try {
    const r = await pi.exec(
      "find",
      [
        projectDir,
        "-maxdepth", "4",
        "(", "-name", "test_*.py", "-o", "-name", "*_test.py",
        "-o", "-name", "conftest.py",
        "-o", "-type", "d", "-name", "tests", ")",
        "-not", "-path", "*/.*",
        "-print", "-quit",
      ],
      { timeout: 5000 }
    );
    if (!r.stdout.trim()) return null;
  } catch {
    return null;
  }

  // Detect pytest
  if (cache.hasPytest === null) {
    try {
      const r = await pi.exec("bash", ["-c", `cd ${esc(projectDir)} && python -m pytest --version 2>/dev/null`], {
        timeout: 5000,
      });
      cache.hasPytest = r.code === 0;
    } catch {
      cache.hasPytest = false;
    }
  }

  if (!cache.hasPytest) return null;

  const name = path.basename(projectDir);

  return {
    key: `python:${projectDir}`,
    label: `pytest (${name})`,
    command: `cd ${esc(projectDir)} && python -m pytest 2>&1`,
  };
}

// ============================================================
// Go
// ============================================================

function goCheck(absFile: string, goModDir: string): PlannedCheck | null {
  const fileDir = path.dirname(absFile);
  const rel = path.relative(goModDir, fileDir);
  const goPkg = rel === "" ? "./..." : `./${rel}/...`;

  return {
    key: `go:${goModDir}:${rel || "."}`,
    label: `go test ${goPkg}`,
    command: `cd ${esc(goModDir)} && go test ${goPkg} 2>&1`,
  };
}

// ============================================================
// Makefile / justfile fallback
// ============================================================

async function makeCheck(
  pi: ExtensionAPI,
  dir: string
): Promise<PlannedCheck | null> {
  // Makefile with `test` target
  if (exists(dir, "Makefile")) {
    try {
      const r = await pi.exec("bash", ["-c", `cd ${esc(dir)} && make -n test 2>/dev/null`], {
        timeout: 5000,
      });
      if (r.code === 0) {
        return {
          key: `make:${dir}`,
          label: "make test",
          command: `cd ${esc(dir)} && make test 2>&1`,
        };
      }
    } catch {}
  }

  // justfile with `test` recipe
  if (exists(dir, "justfile") || exists(dir, "Justfile")) {
    try {
      const r = await pi.exec("bash", ["-c", `cd ${esc(dir)} && just --summary 2>/dev/null`], {
        timeout: 5000,
      });
      if (r.code === 0 && r.stdout.includes("test")) {
        return {
          key: `just:${dir}`,
          label: "just test",
          command: `cd ${esc(dir)} && just test 2>&1`,
        };
      }
    } catch {}
  }

  return null;
}

// ============================================================
// Utilities
// ============================================================

function exists(dir: string, name: string): boolean {
  try {
    fs.accessSync(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

function esc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
