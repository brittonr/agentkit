# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|

## User Preferences
- Mode extension lives at `_global/extensions/mode.ts` (was loop.ts)
- User prefers command-based loop activation (`/loop tests|self|custom <condition>`) over menu-based selection
- Shortcuts cycling to loop should arm "pending" state, not auto-fire — user's next message defines the loop context

## Patterns That Work
- pi's `AssistantMessage` has `stopReason` and `errorMessage` fields — use `errorMessage` to detect specific error types like rate limits
- `stopReason` values: `"stop" | "length" | "toolUse" | "error" | "aborted"`
- `ctx.model` has `provider`, `baseUrl`, `api`, `id`, `headers` — enough to make direct API calls
- `ctx.modelRegistry.getApiKey(model)` to get API key for direct requests
- Anthropic rate limit headers: `retry-after`, `retry-after-ms`, `anthropic-ratelimit-*-reset` (RFC 3339)
- Anthropic uses `anthropic-ratelimit-*` prefix, NOT `x-ratelimit-*`
- Anthropic rate limits are hourly token budgets, not just per-minute
- Can probe Anthropic API with minimal request to read rate limit headers from 429 response

## Patterns That Don't Work
- Checking message content blocks for error text — errors are in `errorMessage` field, not content
- Short backoff (30s) for Anthropic rate limits — hourly limits need longer waits (60s+ with exponential)
- Relying on pi's internal retry to surface retry-after headers — they're consumed internally
- `pi.registerShortcut` handler takes `(ctx)` NOT `(event, ctx)` — only one arg, unlike event handlers
- **`ctx.ui.select()` only accepts `string[]`, NOT `{label, value}[]` objects** — passing objects causes them to stringify as `"[object Object]"`, so comparisons like `choice === "execute"` silently fail. Use plain strings and compare against the exact string. (For rich options use `ctx.ui.custom()` with `SelectList` component instead.)
- Falling through agent_end without deactivating plan mode = user trapped forever — always default to normal mode on cancel/dismiss. Invert the logic: check for explicit "stay" choices first, make the `else` branch always exit plan mode.
- **`ctrl+m` as a shortcut conflicts with Enter** — in legacy terminals, `Ctrl+M` sends `\r` (same byte as Enter). This breaks: (1) the shortcut fires on every Enter press, (2) Enter in SelectList/mode selector re-triggers the shortcut instead of confirming selection, (3) Helix editor's insert mode Enter conflicts. Use `alt+m` instead. Even with Kitty protocol, the 3-mode cycle (normal→plan→loop) means the second press goes to loop (shows menu) instead of back to normal. Use a direct toggle (normal↔plan) for the quick shortcut.
- **Auto-starting loop on shortcut cycle is bad UX** — `activateLoop` with self-driven immediately fires `triggerLoopPrompt` which sends a generic "continue until done" message. Agent has no context and immediately calls `signal_loop_success`. Solution: arm loop in "pending" state via shortcut, capture user's first message in `before_agent_start` to set the actual loop prompt.
- **Plan extractor grabs any numbered list** — `extractTodoItems` matched all `1. foo` lines in the assistant response, including instructions, examples, and menu options. When plan-to-loop fired, it looped on garbage steps. Fix: wrap plan in `<!-- PLAN -->` / `<!-- /PLAN -->` markers and only extract from within them.
- **Step picker filters state but agent sees full plan in chat history** — when Execute mode loads filtered steps into `state.planItems`, the agent still sees the original unfiltered plan in conversation. Must inject selected steps via `before_agent_start` system prompt so the agent knows which steps to execute.
- **Plan extraction only checked last assistant message** — tool calls split a response across multiple messages. The `<!-- PLAN -->` markers end up in an earlier message while the last message has unrelated numbered lists. Fix: search ALL assistant messages, prefer the one containing plan markers.
- **`<!-- PLAN -->` HTML comment markers get stripped** — pi's message processing strips HTML comments from content before storing. The extraction never finds them. Use `[PLAN]` / `[/PLAN]` bracket markers instead which survive markdown processing.

## Domain Notes
- This is an agentkit repo with pi coding agent extensions
- Extensions use `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`
- pi docs at `/nix/store/sjs88v3zzlxzh1r1qyj5ls78if894q1f-pi-0.52.12/lib/node_modules/@mariozechner/pi-coding-agent/docs/`
- User uses Anthropic API directly (not Bedrock/proxy) — rate limit probing works
