/**
 * Account switcher — switch between Anthropic/Claude accounts.
 *
 * Features:
 * - Named account profiles (Max subscriptions + API keys)
 * - Manual switching via /account command or Alt+A
 * - Automatic switching on rate limit with account probing
 *
 * Commands:
 *   /account              — show account selector
 *   /account <name>       — switch to named account
 *   /account save <name>  — save current auth as a named account
 *   /account list         — list all accounts
 *   /account delete <name> — remove a saved account
 *   /account status       — show current account info
 *   /account auto         — toggle automatic rate-limit switching
 *
 * Shortcut: Alt+A — cycle to next account
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ── Types ────────────────────────────────────────────────────────────────────

interface OAuthEntry {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
}

interface ApiKeyEntry {
	type: "api_key";
	key: string;
}

type AuthEntry = OAuthEntry | ApiKeyEntry;

interface AccountProfile {
	description?: string;
	auth: AuthEntry;
	savedAt: number;
}

interface AccountsConfig {
	active?: string;
	autoSwitch?: boolean;
	accounts: Record<string, AccountProfile>;
}

interface RateLimitCooldown {
	until: number;
	waitMs: number;
}

type ProbeResult =
	| { status: "ok" }
	| { status: "limited"; waitMs: number }
	| { status: "error" };

// ── Paths ────────────────────────────────────────────────────────────────────

const PI_DIR = join(process.env.HOME || "~", ".pi", "agent");
const AUTH_PATH = join(PI_DIR, "auth.json");
const ACCOUNTS_PATH = join(PI_DIR, "accounts.json");

// ── File helpers ─────────────────────────────────────────────────────────────

function readJson<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

function writeJsonSecure(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function readAuthFile(): Record<string, AuthEntry> | null {
	return readJson<Record<string, AuthEntry>>(AUTH_PATH);
}

function writeAuthFile(data: Record<string, AuthEntry>): void {
	writeJsonSecure(AUTH_PATH, data);
}

function readAccountsConfig(): AccountsConfig {
	const data = readJson<AccountsConfig>(ACCOUNTS_PATH);
	return data ?? { accounts: {} };
}

function writeAccountsConfig(config: AccountsConfig): void {
	writeJsonSecure(ACCOUNTS_PATH, config);
}

// ── Auth entry helpers ───────────────────────────────────────────────────────

function getAnthropicAuth(): AuthEntry | null {
	const auth = readAuthFile();
	if (!auth?.anthropic) return null;
	return auth.anthropic;
}

function setAnthropicAuth(entry: AuthEntry): void {
	const auth = readAuthFile() ?? {};
	auth.anthropic = entry;
	writeAuthFile(auth);
}

function describeAuth(entry: AuthEntry): string {
	if (entry.type === "oauth") {
		const now = Date.now();
		const remaining = entry.expires - now;
		const expired = remaining <= 0;
		const timeStr = expired
			? "expired"
			: remaining < 3600_000
				? `expires in ${Math.ceil(remaining / 60_000)}m`
				: `expires in ${Math.ceil(remaining / 3600_000)}h`;
		return `OAuth (${timeStr})`;
	}
	const key = entry.key;
	if (key.startsWith("!")) return `API key (shell cmd)`;
	if (key.startsWith("sk-")) return `API key (${key.slice(0, 12)}…)`;
	return `API key ($${key})`;
}

// ── Rate limit helpers ───────────────────────────────────────────────────────

function wasRateLimited(
	messages: Array<{ role?: string; stopReason?: string; errorMessage?: string }>,
): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			if (msg.stopReason !== "error") return false;
			const err = (msg.errorMessage ?? "").toLowerCase();
			return (
				err.includes("rate_limit") ||
				err.includes("rate limit") ||
				/\b429\b/.test(err)
			);
		}
	}
	return false;
}

function resolveKeyFromAuth(entry: AuthEntry): string | null {
	if (entry.type === "oauth") return entry.access;
	const key = entry.key;
	if (key.startsWith("!")) return null; // Shell command — can't resolve here
	if (key.startsWith("sk-") || key.startsWith("ant-")) return key; // Literal
	return process.env[key] || null; // Env var
}

function parseRateLimitWait(response: Response): number | null {
	const retryMs = response.headers.get("retry-after-ms");
	if (retryMs) {
		const ms = parseInt(retryMs, 10);
		if (ms > 0) return ms;
	}

	const retryAfter = response.headers.get("retry-after");
	if (retryAfter) {
		const s = parseInt(retryAfter, 10);
		if (s > 0) return s * 1000;
		const d = new Date(retryAfter);
		if (!isNaN(d.getTime())) return Math.max(1000, d.getTime() - Date.now());
	}

	for (const suffix of [
		"output-tokens-reset",
		"input-tokens-reset",
		"requests-reset",
	]) {
		const reset = response.headers.get(`anthropic-ratelimit-${suffix}`);
		if (reset) {
			const d = new Date(reset);
			if (!isNaN(d.getTime())) return Math.max(1000, d.getTime() - Date.now());
		}
	}

	return null;
}

async function probeAccountAuth(
	auth: AuthEntry,
	modelId: string,
	baseUrl = "https://api.anthropic.com",
): Promise<ProbeResult> {
	const apiKey = resolveKeyFromAuth(auth);
	if (!apiKey) return { status: "error" };

	try {
		const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: modelId,
				max_tokens: 1,
				messages: [{ role: "user", content: "." }],
			}),
		});

		if (response.ok) return { status: "ok" };

		if (response.status === 429) {
			const waitMs = parseRateLimitWait(response) ?? 60_000;
			return { status: "limited", waitMs };
		}

		// 401/403 = bad credentials, other = unknown
		return { status: "error" };
	} catch {
		return { status: "error" };
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
	const sec = Math.ceil(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let activeAccount: string | null = null;
	const rateLimitCooldowns = new Map<string, RateLimitCooldown>();

	// ── Status bar ───────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const config = readAccountsConfig();
		const autoOn = config.autoSwitch !== false && Object.keys(config.accounts).length >= 2;

		if (activeAccount) {
			const profile = config.accounts[activeAccount];
			const desc = profile?.description;
			const label = desc ? `${activeAccount} (${desc})` : activeAccount;
			const auto = autoOn ? " ⚡" : "";
			ctx.ui.setStatus("account", ctx.ui.theme.fg("accent", `${label}${auto}`));
		} else {
			ctx.ui.setStatus("account", undefined);
		}
		ctx.ui.setWidget("account", undefined);
	}

	// ── Switch logic ─────────────────────────────────────────────────────

	function switchTo(name: string, ctx: ExtensionContext): boolean {
		const config = readAccountsConfig();
		const profile = config.accounts[name];
		if (!profile) return false;

		setAnthropicAuth(profile.auth);

		config.active = name;
		writeAccountsConfig(config);

		activeAccount = name;
		updateStatus(ctx);
		return true;
	}

	// ── Restore on startup ───────────────────────────────────────────────

	function restoreState(ctx: ExtensionContext): void {
		const config = readAccountsConfig();
		if (config.active && config.accounts[config.active]) {
			activeAccount = config.active;
		}
		updateStatus(ctx);
	}

	// ── Auto-switch on rate limit ────────────────────────────────────────

	async function attemptAutoSwitch(
		ctx: ExtensionContext,
	): Promise<boolean> {
		const config = readAccountsConfig();
		const names = Object.keys(config.accounts);
		if (names.length < 2 || !activeAccount) return false;
		if (config.autoSwitch === false) return false;

		const modelId = ctx.model?.id ?? "claude-sonnet-4-20250514";
		const baseUrl = ctx.model?.baseUrl ?? "https://api.anthropic.com";
		const previousAccount = activeAccount;

		// Probe current account to get exact cooldown
		const currentProfile = config.accounts[activeAccount];
		if (currentProfile) {
			const probe = await probeAccountAuth(currentProfile.auth, modelId, baseUrl);
			const waitMs = probe.status === "limited" ? probe.waitMs : 60_000;
			rateLimitCooldowns.set(activeAccount, {
				until: Date.now() + waitMs,
				waitMs,
			});
		}

		// Find best alternative
		const alternatives = names.filter((n) => n !== activeAccount);
		let bestAccount: string | null = null;
		let bestWaitMs = Infinity;

		for (const name of alternatives) {
			// Check cooldown cache first
			const cooldown = rateLimitCooldowns.get(name);
			if (cooldown && Date.now() < cooldown.until) {
				const remaining = cooldown.until - Date.now();
				if (remaining < bestWaitMs) {
					bestAccount = name;
					bestWaitMs = remaining;
				}
				continue;
			}

			// Not in cooldown — probe it
			const profile = config.accounts[name];
			if (!profile) continue;

			if (ctx.hasUI) {
				ctx.ui.setWidget("account", [
					ctx.ui.theme.fg("warning", `Rate limited — probing "${name}"…`),
				]);
			}

			const probe = await probeAccountAuth(profile.auth, modelId, baseUrl);

			if (probe.status === "ok") {
				bestAccount = name;
				bestWaitMs = 0;
				rateLimitCooldowns.delete(name);
				break;
			}

			if (probe.status === "limited") {
				rateLimitCooldowns.set(name, {
					until: Date.now() + probe.waitMs,
					waitMs: probe.waitMs,
				});
				if (probe.waitMs < bestWaitMs) {
					bestAccount = name;
					bestWaitMs = probe.waitMs;
				}
			}
			// "error" → skip (bad creds, etc.)
		}

		if (!bestAccount) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Rate limited — no alternative accounts available",
					"warning",
				);
				ctx.ui.setWidget("account", undefined);
			}
			return false;
		}

		// If best alternative also needs to wait, show countdown
		if (bestWaitMs > 0) {
			// Check if current account's remaining wait is shorter
			const currentCooldown = rateLimitCooldowns.get(previousAccount);
			const currentRemaining = currentCooldown
				? Math.max(0, currentCooldown.until - Date.now())
				: Infinity;

			// If current account recovers sooner, wait on it instead
			if (currentRemaining < bestWaitMs) {
				bestAccount = previousAccount;
				bestWaitMs = currentRemaining;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(
					`All accounts rate limited — switching to "${bestAccount}" in ${formatDuration(bestWaitMs)}`,
					"warning",
				);
			}

			const endTime = Date.now() + bestWaitMs;
			const interval = setInterval(() => {
				const remaining = Math.max(0, endTime - Date.now());
				if (remaining <= 0) {
					clearInterval(interval);
					return;
				}
				if (ctx.hasUI) {
					ctx.ui.setWidget("account", [
						ctx.ui.theme.fg(
							"warning",
							`Rate limited — switching to "${bestAccount}" in ${formatDuration(remaining)}`,
						),
					]);
				}
			}, 1_000);

			await sleep(bestWaitMs);
			clearInterval(interval);
		}

		// Switch
		if (bestAccount === previousAccount) {
			// Waited on current account — clear cooldown, no switch needed
			rateLimitCooldowns.delete(previousAccount);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Rate limit expired on "${previousAccount}" — retrying`,
					"info",
				);
				ctx.ui.setWidget("account", undefined);
			}
		} else if (switchTo(bestAccount, ctx)) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Rate limited on "${previousAccount}" → switched to "${bestAccount}"`,
					"warning",
				);
			}
		} else {
			if (ctx.hasUI) ctx.ui.setWidget("account", undefined);
			return false;
		}

		return true;
	}

	// ── agent_end: auto-switch on rate limit ─────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		const messages = event.messages as Array<{
			role?: string;
			stopReason?: string;
			errorMessage?: string;
		}>;
		if (!wasRateLimited(messages)) return;

		const config = readAccountsConfig();
		if (config.autoSwitch === false) return;
		if (Object.keys(config.accounts).length < 2) return;

		const switched = await attemptAutoSwitch(ctx);
		if (switched) {
			// Signal to other extensions (e.g., mode/loop) that we handled it
			pi.events.emit("account:rate-limit-handled");

			pi.sendMessage(
				{
					customType: "account-switch-retry",
					content:
						"Your previous request was rate-limited. I've switched to a different account. Please continue with the previous task.",
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
	});

	// ── Account selector UI ──────────────────────────────────────────────

	async function showAccountSelector(
		ctx: ExtensionContext,
		config: AccountsConfig,
		names: string[],
	): Promise<string | null> {
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(" Switch Account ")) +
						theme.fg("dim", " Alt+A to cycle"),
					1,
					0,
				),
			);

			const items = names.map((n) => {
				const p = config.accounts[n];
				const current = n === activeAccount ? "● " : "  ";
				const desc = p.description || describeAuth(p.auth);
				return { value: n, label: `${current}${n}`, description: desc };
			});

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item: { value: string }) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(
				new Text(
					theme.fg("dim", " ↑↓ navigate · Enter select · Esc cancel"),
					1,
					0,
				),
			);
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	// ── Commands ─────────────────────────────────────────────────────────

	pi.registerCommand("account", {
		description:
			"Switch accounts: /account [name|save|list|delete|status|auto]",
		getArgumentCompletions: (prefix) => {
			const config = readAccountsConfig();
			const names = Object.keys(config.accounts);
			const subcommands = ["save", "list", "delete", "status", "auto"];
			const all = [...subcommands, ...names];
			const filtered = all.filter((n) => n.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((n) => ({ value: n, label: n }))
				: null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";

			// ── /account save <name> [description…] ─────────────────
			if (subcommand === "save") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify(
						'Usage: /account save <name> [description]\nExample: /account save personal "Max subscription"',
						"warning",
					);
					return;
				}

				const auth = getAnthropicAuth();
				if (!auth) {
					ctx.ui.notify(
						"No Anthropic credentials found in auth.json.\n" +
							"Use /login for Max, or set ANTHROPIC_API_KEY for API keys.",
						"warning",
					);
					return;
				}

				const description =
					parts.slice(2).join(" ").trim() || undefined;
				const config = readAccountsConfig();
				const existed = !!config.accounts[name];

				config.accounts[name] = {
					description,
					auth,
					savedAt: Date.now(),
				};
				config.active = name;
				writeAccountsConfig(config);

				activeAccount = name;
				updateStatus(ctx);

				const authType = describeAuth(auth);
				ctx.ui.notify(
					`${existed ? "Updated" : "Saved"} account "${name}" — ${authType}` +
						(description ? ` — ${description}` : ""),
					"info",
				);
				return;
			}

			// ── /account list ────────────────────────────────────────
			if (subcommand === "list") {
				const config = readAccountsConfig();
				const names = Object.keys(config.accounts);
				if (names.length === 0) {
					ctx.ui.notify(
						"No saved accounts.\n" +
							"1. /login to authenticate with an Anthropic account\n" +
							"2. /account save <name> to save it",
						"info",
					);
					return;
				}

				const autoStatus =
					config.autoSwitch !== false
						? "on"
						: "off";
				const lines = names.map((n) => {
					const p = config.accounts[n];
					const current = n === activeAccount ? " ●" : "";
					const desc = p.description ? ` — ${p.description}` : "";
					const authType = describeAuth(p.auth);
					const cooldown = rateLimitCooldowns.get(n);
					const limited =
						cooldown && Date.now() < cooldown.until
							? ` ⏳ ${formatDuration(cooldown.until - Date.now())}`
							: "";
					return `  ${n}${desc} [${authType}]${current}${limited}`;
				});
				ctx.ui.notify(
					`Accounts (auto-switch: ${autoStatus}):\n` +
						lines.join("\n"),
					"info",
				);
				return;
			}

			// ── /account delete <name> ───────────────────────────────
			if (subcommand === "delete") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify("Usage: /account delete <name>", "warning");
					return;
				}

				const config = readAccountsConfig();
				if (!config.accounts[name]) {
					ctx.ui.notify(`Account "${name}" not found`, "warning");
					return;
				}

				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Delete account?",
						`Remove saved account "${name}"?`,
					);
					if (!ok) return;
				}

				delete config.accounts[name];
				if (config.active === name) config.active = undefined;
				writeAccountsConfig(config);

				if (activeAccount === name) {
					activeAccount = null;
					updateStatus(ctx);
				}

				ctx.ui.notify(`Deleted account "${name}"`, "info");
				return;
			}

			// ── /account status ──────────────────────────────────────
			if (subcommand === "status") {
				const auth = getAnthropicAuth();
				const config = readAccountsConfig();
				const autoStatus =
					config.autoSwitch !== false
						? "on"
						: "off";
				const lines: string[] = [];

				lines.push(`Active account: ${activeAccount ?? "(none)"}`);
				if (auth) {
					lines.push(`Current auth: ${describeAuth(auth)}`);
				} else {
					lines.push("Current auth: none");
				}
				lines.push(`Saved accounts: ${Object.keys(config.accounts).length}`);
				lines.push(`Auto-switch: ${autoStatus}`);

				// Show cooldowns
				for (const [name, cooldown] of rateLimitCooldowns) {
					const remaining = cooldown.until - Date.now();
					if (remaining > 0) {
						lines.push(
							`  ⏳ ${name}: rate limited for ${formatDuration(remaining)}`,
						);
					}
				}

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// ── /account auto ────────────────────────────────────────
			if (subcommand === "auto") {
				const config = readAccountsConfig();
				const wasOn = config.autoSwitch !== false;
				config.autoSwitch = !wasOn;
				writeAccountsConfig(config);
				updateStatus(ctx);
				ctx.ui.notify(
					`Auto-switch on rate limit: ${!wasOn ? "enabled ⚡" : "disabled"}`,
					"info",
				);
				return;
			}

			// ── /account <name> — direct switch ──────────────────────
			if (subcommand) {
				const config = readAccountsConfig();
				if (config.accounts[subcommand]) {
					if (subcommand === activeAccount) {
						ctx.ui.notify(
							`Already on account "${subcommand}"`,
							"info",
						);
						return;
					}
					if (switchTo(subcommand, ctx)) {
						const profile = config.accounts[subcommand];
						ctx.ui.notify(
							`Switched to "${subcommand}" — ${describeAuth(profile.auth)}`,
							"info",
						);
					}
					return;
				}
				ctx.ui.notify(
					`Unknown: "${subcommand}"\n` +
						"Usage: /account [name|save|list|delete|status|auto]",
					"warning",
				);
				return;
			}

			// ── /account (no args) — show selector ──────────────────
			const config = readAccountsConfig();
			const names = Object.keys(config.accounts);

			if (names.length === 0) {
				ctx.ui.notify(
					"No saved accounts.\n" +
						"1. /login to authenticate with an Anthropic account\n" +
						"2. /account save <name> to save it",
					"info",
				);
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(
					`Active: ${activeAccount ?? "none"}. /account <name> to switch.`,
					"info",
				);
				return;
			}

			const selected = await showAccountSelector(ctx, config, names);
			if (selected && selected !== activeAccount) {
				if (switchTo(selected, ctx)) {
					const profile = config.accounts[selected];
					ctx.ui.notify(
						`Switched to "${selected}" — ${describeAuth(profile.auth)}`,
						"info",
					);
				}
			}
		},
	});

	// ── Shortcut: Alt+A — cycle accounts ─────────────────────────────────

	pi.registerShortcut("alt+a", {
		description: "Cycle to next Anthropic account",
		handler: async (ctx) => {
			const config = readAccountsConfig();
			const names = Object.keys(config.accounts);

			if (names.length < 2) {
				if (ctx.hasUI)
					ctx.ui.notify("Need 2+ saved accounts to cycle", "info");
				return;
			}

			const currentIdx = activeAccount
				? names.indexOf(activeAccount)
				: -1;
			const nextIdx = (currentIdx + 1) % names.length;
			const next = names[nextIdx];

			if (switchTo(next, ctx)) {
				const profile = config.accounts[next];
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Account: ${next} — ${describeAuth(profile.auth)}`,
						"info",
					);
				}
			}
		},
	});

	// ── Custom message renderer ──────────────────────────────────────────

	pi.registerMessageRenderer("account-switch-retry", (message, theme) => {
		return new Text(
			theme.fg("warning", "⚡ ") +
				theme.fg("dim", String(message.content)),
			1,
			0,
		);
	});

	// ── Session events ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreState(ctx);
	});
}
