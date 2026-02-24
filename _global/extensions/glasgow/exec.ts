import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

let _pi: ExtensionAPI;
let _cwd: string;

export function init(pi: ExtensionAPI, cwd: string) {
	_pi = pi;
	_cwd = cwd;
}

export interface GlasgowResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed: boolean;
}

export async function glasgow(
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number }
): Promise<GlasgowResult> {
	const result = await _pi.exec(
		"nix-shell",
		["-p", "glasgow", "--run", `glasgow ${args.join(" ")}`],
		{
			signal: options?.signal,
			timeout: options?.timeout ?? 30000,
		}
	);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
		killed: result.killed,
	};
}

export function formatOutput(result: GlasgowResult): string {
	const output = (result.stdout + "\n" + result.stderr)
		.split("\n")
		.filter(
			(l) =>
				!l.startsWith("🔧") &&
				!l.startsWith("   Run:") &&
				!l.includes("Nix search path entry") &&
				l.trim() !== ""
		)
		.join("\n")
		.trim();
	const lines: string[] = [];
	if (output) lines.push(output);
	if (result.code !== 0 && result.code !== null) {
		lines.push(`Exit code: ${result.code}`);
	}
	return lines.join("\n") || "(no output)";
}
