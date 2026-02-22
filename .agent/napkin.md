# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-02-22 | user | Commit messages were conversational garbage like `[pi] Here's the summary:`, `[pi] Work in progress`, `[pi] All four fixes verified:` — just pasting chat responses as commit msgs | Focus on WHY not WHAT. Imperative mood. No conventional commit prefixes. Optional context prefix when it adds clarity. Paragraphs not bullets. Never start with `[pi]`. Never use conversational text. |
| 2026-02-22 | root cause | auto-commit.ts extension was the culprit — session_shutdown hook grabbed first line of last assistant message, prepended `[pi]`, used as commit msg. Nuked the extension entirely. | Never auto-generate commit messages from chat text. If auto-commit is ever re-added, it must look at the diff and follow commit message rules. |
| 2026-02-22 | swarm audit | Reviewer falsely claimed exit handler doesn't close log fd — it does (line ~882) | Always verify reviewer claims against actual code before acting on them |
| 2026-02-22 | swarm audit | Reviewer claimed path traversal in worktree safeName — regex `[^\w.-]+` replaces `/` with `_`, so it's safe | Trace regex behavior mentally before trusting security claims |

## User Preferences
- Mode extension lives at `_global/extensions/mode.ts` (was loop.ts)
- User prefers command-based loop activation (`/loop tests|self|custom <condition>`) over menu-based selection
- Shortcuts cycling to loop should arm "pending" state, not auto-fire — user's next message defines the loop context

## Mode Extension Audit — Fixes Applied
1. tool_call: use `event.toolName`/`event.input` (not `event.name`/`event.params`)
2. turn_end: use `event.message` (not `event.content` which doesn't exist)
3. registerShortcut: cleaned up — handler gets ExtensionContext, not ExtensionCommandContext; removed broken newSessionFn capture
4. Context typing: removed `(ctx as any)` casts from agent_end; only command handlers capture newSessionFn
5. TodoItem shape: `{ step: number; text: string; completed: boolean }` matching official (was `index`/`done`)
6. extractTodoItems: requires `[PLAN]`/`[/PLAN]` markers OR `Plan:` header — no longer grabs any numbered list

## Plan Mode Audit Round 2 — Fixes Applied (2026-02-22)
1. **Double-fire loop fix**: `activateLoop(..., false)` in fallback path, set correct prompt BEFORE triggering
2. **Safe command security**: Removed `node -e`, `python -c`, `jq`, `awk`, `sed -n` from SAFE_COMMAND_PREFIXES; added `find -delete/-exec` blocking; added `<(` process substitution blocking; added `LD_PRELOAD`/`LD_LIBRARY_PATH` blocking; added explicit `||` blocking
3. **newSessionFn await + cancel**: `await newSessionFn()`, clear `pendingPlanLoop` on cancel
4. **Plan injection gated**: Added `executingPlan` flag — plan steps only injected in `before_agent_start` when actively executing, not every normal-mode turn. Set by `/plan start` and Execute choice. Auto-clears when all steps complete.
5. **Context filter**: Added `context` hook to strip stale plan messages (`plan-start`, `mode-loop`, etc.) when not in plan mode and not executing
6. **Mode selector Loop**: Now arms `loopPending` instead of just showing help text
7. **Separate transient retry counter**: `transientRetries` field independent from `rateLimitRetries`, both reset on success
8. **Step picker UX**: Esc = cancel (returns null), Enter = confirm selection

## Swarm Extension Audit — Fixes Applied
Round 1 (9 fixes): worker death cleanup, chain abort, stdin write safety, dead worker filtering, log pruning, render efficiency, handleLine logging, agent-ignored warning, progress interval safety  
Round 2 (8 fixes): spawn resource leak guard, status reset on RPC failure (/task + delegate_task), per-task usage delta, proc.on("error") for missing binary, refreshAgents cache fix, waitForWorkerIdle rejects on death, unused Theme import removed, clear lastAssistantText between tasks
Round 3 (8 fixes — TUI rewrite): swarmDepth moved to module scope (was ReferenceError from runEphemeral), /swarm TUI uses handleInput instead of tui.addInputListener (which doesn't exist in API), tui.terminal.rows→process.stdout.rows, all render lines truncated to width, invalidate() is proper no-op (stateless render), dispose() simplified to just clearInterval, removed isKeyRelease import, removed componentRef indirection

## Patterns That Work
- pi's `AssistantMessage` has `stopReason` and `errorMessage` fields — use `errorMessage` to detect specific error types like rate limits
- `stopReason` values: `"stop" | "length" | "toolUse" | "error" | "aborted"`
- `ctx.model` has `provider`, `baseUrl`, `api`, `id`, `headers` — enough to make direct API calls
- `ctx.modelRegistry.getApiKey(model)` to get API key for direct requests
- Anthropic rate limit headers: `retry-after`, `retry-after-ms`, `anthropic-ratelimit-*-reset` (RFC 3339)
- Anthropic uses `anthropic-ratelimit-*` prefix, NOT `x-ratelimit-*`
- Anthropic rate limits are hourly token budgets, not just per-minute
- Can probe Anthropic API with minimal request to read rate limit headers from 429 response

## Commit Message Rules
Focus on WHY, not WHAT. Imperative mood. Concise. No conventional commit
prefixes (no `feat:`, `fix:`, etc). Use a context prefix only when it adds
clarity (e.g. `docs:`, `cli:`). Body uses paragraphs, not bullet points.

NEVER start with `[pi]`. NEVER use conversational text like "Here's the
summary", "Work in progress", "Done.", "All fixes verified". Describe what
changed in the code, not what you told the user. Read the diff first.

## Patterns That Don't Work
- **`tui.addInputListener` does NOT exist** — the scout confirmed it's not in the TUI API at all. Components must implement `handleInput?(data: string): void` on the Component interface. Input is routed by the TUI to the focused component's handleInput method. Call `tui.requestRender()` after state changes.
- **`tui.terminal.rows` is undocumented** — use `process.stdout.rows` for terminal height instead
- **`invalidate()` must NOT trigger renders** — it should only clear cached render state. Use `tui.requestRender()` separately (e.g. from setInterval or handleInput)
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
- **Plan marker search matches prose mentions** — `indexOf("[PLAN]")` and `find()` match the FIRST occurrence across ALL assistant messages in the session. Earlier messages discussing the markers (e.g. `` `[PLAN]` / `[/PLAN]` ``) get matched instead of the actual plan block. Fix: use `findLast()` and `lastIndexOf()` to find the most recent occurrence.

## Model Name Gotchas
- pi 0.52.12 has Sonnet 4 up to `claude-sonnet-4-5`, NOT `claude-sonnet-4-6` (Opus 4-6 exists, Sonnet 4-6 does not)
- `claude-opus-4` (bare, no suffix) doesn't resolve — must use `claude-opus-4-0`, `claude-opus-4-6`, etc.
- Always verify model names with `pi --list-models` before putting them in agent definitions
- When models fail, the spawned pi process exits immediately with `Model "..." not found` on stderr — producing 0 tokens, no error in the tool result (just "(no output)")

## Domain Notes
- This is an agentkit repo with pi coding agent extensions
- Extensions use `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`
- pi docs at `/nix/store/sjs88v3zzlxzh1r1qyj5ls78if894q1f-pi-0.52.12/lib/node_modules/@mariozechner/pi-coding-agent/docs/`
- User uses Anthropic API directly (not Bedrock/proxy) — rate limit probing works
- User has Claude Max subscription (OAuth in auth.json), may also use API keys
- `~/.pi/agent/auth.json` stores credentials: `{ "type": "oauth", ... }` or `{ "type": "api_key", ... }` per provider
- auth.json is `0600` permissions — must preserve when writing
- Account switcher at `_global/extensions/account-switcher.ts` — manages named profiles in `~/.pi/agent/accounts.json`, swaps `anthropic` entry in auth.json on switch
- Account switcher auto-switches on rate limit: probes alternatives, switches to available one, sends retry follow-up
- Coordination between account-switcher and mode extensions via `pi.events.emit("account:rate-limit-handled")` — mode.ts checks flag to skip its own rate limit handler in loop mode, preventing double-retries
- OAuth access token works directly as API key for probing (`x-api-key` header)
- Node `--check` is the reliable syntax checker for .ts files (naive brace counting fails on template literals)
- Extensions in `_global/extensions/` need a symlink in `~/.pi/agent/extensions/` to be discovered by pi — other extensions all use this pattern
