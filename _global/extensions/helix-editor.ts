/**
 * Helix-style Modal Editor
 *
 * Selection-first modal editing following Helix keybindings.
 *
 * Normal mode:
 *   h/j/k/l   - movement
 *   w/b       - word forward/backward
 *   i/a       - insert before/after cursor
 *   I/A       - insert at line start/end
 *   o/O       - open line below/above + insert
 *   d         - delete char under cursor
 *   x         - select entire line
 *   gh        - goto line start
 *   gl        - goto line end
 *   Escape    - pass through to Pi (abort agent, etc.)
 *
 * Insert mode:
 *   Escape    - return to normal mode
 *   All other keys pass through normally
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

class HelixEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";
	private pending: string | null = null; // for multi-key sequences like gh, gl

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				this.pending = null;
			} else {
				// In normal mode, escape passes through to Pi (abort agent, etc.)
				this.pending = null;
				super.handleInput(data);
			}
			return;
		}

		// Insert mode: pass everything through
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// Normal mode: handle pending multi-key sequences (g prefix)
		if (this.pending === "g") {
			this.pending = null;
			switch (data) {
				case "h": super.handleInput("\x01"); return; // line start (Ctrl+A)
				case "l": super.handleInput("\x05"); return; // line end (Ctrl+E)
				case "e": super.handleInput("\x1b[F"); return; // end of buffer
				case "g": super.handleInput("\x1b[H"); return; // start of buffer
				case "k": super.handleInput("\x1b[A"); return; // up (alias)
				case "j": super.handleInput("\x1b[B"); return; // down (alias)
				default: return; // unknown g-sequence, discard
			}
		}

		// Normal mode primary keys
		switch (data) {
			// Movement
			case "h": super.handleInput("\x1b[D"); return; // left
			case "j": super.handleInput("\x1b[B"); return; // down
			case "k": super.handleInput("\x1b[A"); return; // up
			case "l": super.handleInput("\x1b[C"); return; // right

			// Word movement
			case "w": super.handleInput("\x1bf"); return;  // word forward (Alt+f)
			case "b": super.handleInput("\x1bb"); return;  // word backward (Alt+b)
			case "e": super.handleInput("\x1bf"); return;  // end of word (same as word forward)

			// Insert mode transitions
			case "i":
				this.mode = "insert";
				return;
			case "a":
				this.mode = "insert";
				super.handleInput("\x1b[C"); // move right first
				return;
			case "I":
				this.mode = "insert";
				super.handleInput("\x01"); // line start
				return;
			case "A":
				this.mode = "insert";
				super.handleInput("\x05"); // line end
				return;
			case "o":
				super.handleInput("\x05");    // end of line
				super.handleInput("\r");      // newline
				this.mode = "insert";
				return;
			case "O":
				super.handleInput("\x01");    // start of line
				super.handleInput("\r");      // newline
				super.handleInput("\x1b[A");  // move up
				this.mode = "insert";
				return;

			// Editing
			case "d": super.handleInput("\x1b[3~"); return;  // delete char (Del)
			case "x": super.handleInput("\x01"); return;     // select line (go to start)

			// Goto prefix
			case "g":
				this.pending = "g";
				return;

			default:
				break;
		}

		// Pass through control sequences (Ctrl+C, Ctrl+D, etc.), drop printable chars
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		const label = this.mode === "normal"
			? (this.pending ? ` NOR g ` : " NOR ")
			: " INS ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new HelixEditor(tui, theme, kb));
	});
}
