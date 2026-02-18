# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|

## User Preferences
- Loop extension lives at `_global/extensions/loop.ts`

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
- `ctx.ui.select()` in `agent_end` returns `undefined` on Escape — must handle that case or user gets stuck with no way to reach the prompt
- Falling through agent_end without deactivating plan mode = user trapped forever — always default to normal mode on cancel/dismiss

## Domain Notes
- This is an agentkit repo with pi coding agent extensions
- Extensions use `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`
- pi docs at `/nix/store/sjs88v3zzlxzh1r1qyj5ls78if894q1f-pi-0.52.12/lib/node_modules/@mariozechner/pi-coding-agent/docs/`
- User uses Anthropic API directly (not Bedrock/proxy) — rate limit probing works
