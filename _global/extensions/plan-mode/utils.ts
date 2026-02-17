// Safe read-only commands allowed in plan mode
const SAFE_COMMAND_PREFIXES = [
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"diff",
	"grep",
	"rg",
	"ag",
	"ack",
	"find",
	"fd",
	"ls",
	"tree",
	"file",
	"stat",
	"du",
	"df",
	"which",
	"whereis",
	"type",
	"echo",
	"printf",
	"pwd",
	"env",
	"printenv",
	"uname",
	"whoami",
	"id",
	"date",
	"git log",
	"git show",
	"git diff",
	"git status",
	"git branch",
	"git tag",
	"git remote",
	"git rev-parse",
	"git ls-files",
	"git ls-tree",
	"git blame",
	"git shortlog",
	"git describe",
	"git config --get",
	"git config --list",
	"cargo check",
	"cargo clippy",
	"cargo doc",
	"cargo metadata",
	"cargo tree",
	"npm list",
	"npm info",
	"npm view",
	"npx tsc --noEmit",
	"node -e",
	"python -c",
	"jq",
	"yq",
	"sed -n",
	"awk",
	"sort",
	"uniq",
	"cut",
	"tr",
	"column",
	"bat",
	"exa",
	"eza",
	"tokei",
	"cloc",
	"scc",
	"nix eval",
	"nix flake show",
	"nix flake metadata",
];

export function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();

	// Handle piped commands: each segment must be safe
	const segments = trimmed.split(/\s*\|\s*/);
	return segments.every((segment) => {
		const seg = segment.trim();
		// Handle environment variable prefixes like `FOO=bar cmd`
		const withoutEnvVars = seg.replace(/^(\w+=\S+\s+)+/, "");
		return SAFE_COMMAND_PREFIXES.some(
			(prefix) =>
				withoutEnvVars === prefix ||
				withoutEnvVars.startsWith(prefix + " ") ||
				withoutEnvVars.startsWith(prefix + "\t"),
		);
	});
}

export interface TodoItem {
	index: number;
	text: string;
	done: boolean;
}

export function extractTodoItems(text: string): TodoItem[] {
	const items: TodoItem[] = [];
	// Match patterns like:
	//   1. Some task
	//   - [ ] Some task
	//   - [x] Completed task
	//   [DONE:1] Some task
	const lines = text.split("\n");
	let index = 0;

	for (const line of lines) {
		const trimmed = line.trim();

		// Numbered list: "1. Task description"
		const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
		if (numberedMatch) {
			const taskText = numberedMatch[2];
			const done = /^\[DONE(?::\d+)?\]/.test(taskText) || /^~~/.test(taskText);
			items.push({ index: index++, text: taskText.replace(/^\[DONE(?::\d+)?\]\s*/, ""), done });
			continue;
		}

		// Checkbox: "- [ ] Task" or "- [x] Task"
		const checkboxMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(.+)/);
		if (checkboxMatch) {
			items.push({
				index: index++,
				text: checkboxMatch[2],
				done: checkboxMatch[1].toLowerCase() === "x",
			});
			continue;
		}
	}

	return items;
}

export function markCompletedSteps(items: TodoItem[], completedIndices: number[]): TodoItem[] {
	return items.map((item) => ({
		...item,
		done: item.done || completedIndices.includes(item.index),
	}));
}

export function formatTodoList(items: TodoItem[]): string {
	if (items.length === 0) return "No plan steps found.";

	const lines = items.map((item) => {
		const marker = item.done ? "[x]" : "[ ]";
		return `  ${marker} ${item.index + 1}. ${item.text}`;
	});

	const done = items.filter((i) => i.done).length;
	const total = items.length;
	lines.push(`\n  Progress: ${done}/${total} steps completed`);

	return lines.join("\n");
}
