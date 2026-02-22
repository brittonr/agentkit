/**
 * Clear Context Extension
 *
 * Registers /clear command that starts a fresh session,
 * completely resetting context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Clear context — start a fresh session",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
