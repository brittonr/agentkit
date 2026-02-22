/**
 * Pure utility functions for plan mode.
 * Uses dual-check approach: destructive blocklist + safe allowlist.
 */

// Destructive commands blocked in plan mode (checked against ENTIRE command string)
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // redirect (but not heredoc)
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\bcargo\s+(build|run|install|publish)\b/i,
	/\bnix\s+(build|run|develop|profile)\b/i,
];

// Safe read-only commands allowed in plan mode (checked against start of command)
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*rg\b/,
	/^\s*ag\b/,
	/^\s*ack\b/,
	/^\s*find\b/,
	/^\s*fd\b/,
	/^\s*ls\b/,
	/^\s*tree\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*wc\b/,
	/^\s*diff\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*cut\b/,
	/^\s*tr\b/,
	/^\s*column\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*pwd\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*free\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
	/^\s*eza\b/,
	/^\s*tokei\b/,
	/^\s*cloc\b/,
	/^\s*scc\b/,
	/^\s*jq\b/,
	/^\s*yq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|tag|describe|blame|shortlog|rev-parse|config\s+--get|config\s+--list)\b/i,
	/^\s*git\s+ls-/i,
	/^\s*cargo\s+(check|clippy|doc|metadata|tree)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*node\s+(--version|-e)\b/i,
	/^\s*python\s+(--version|-c)\b/i,
	/^\s*nix\s+(eval|flake\s+(show|metadata))\b/i,
	/^\s*npx\s+tsc\s+--noEmit/i,
];

/**
 * Dual-check: command must match a safe pattern AND must not match any
 * destructive pattern. The destructive check runs against the entire
 * command string, catching semicolons, subshells, backticks, &&, ||, etc.
 */
export function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(trimmed));
	return !isDestructive && isSafe;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove inline code
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 80) {
		cleaned = `${cleaned.slice(0, 77)}...`;
	}
	return cleaned;
}

/**
 * Extract todo items from a message. Only extracts numbered steps
 * that appear under a "Plan:" header to avoid picking up random
 * numbered lists from code examples or error output.
 */
export function extractTodoItems(text: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = text.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = text.slice(text.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const rawText = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (rawText.length > 5 && !rawText.startsWith("`") && !rawText.startsWith("/") && !rawText.startsWith("-")) {
			const cleaned = cleanStepText(rawText);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

/**
 * Extract [DONE:n] step numbers from message text.
 */
export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/**
 * Mark todo items as completed based on [DONE:n] markers in text.
 * Mutates items in place. Returns count of newly completed steps.
 */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	let count = 0;
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			count++;
		}
	}
	return count;
}

export function formatTodoList(items: TodoItem[]): string {
	if (items.length === 0) return "No plan steps found.";

	const lines = items.map((item) => {
		const marker = item.completed ? "[x]" : "[ ]";
		return `  ${marker} ${item.step}. ${item.text}`;
	});

	const done = items.filter((i) => i.completed).length;
	const total = items.length;
	lines.push(`\n  Progress: ${done}/${total} steps completed`);

	return lines.join("\n");
}
