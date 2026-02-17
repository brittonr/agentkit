---
name: tigerstyle
description: This skill should be used when the user asks to "apply tiger style", "use tigerstyle", "follow tiger style principles", "write tiger style code", "tiger style review", or mentions Tiger Style coding philosophy, functional core imperative shell, assertion density, or Verus formal verification.
capabilities:
  - read_files
  - edit_files
---

# Tiger Style

Apply the Tiger Style coding philosophy when writing, reviewing, or refactoring code. Tiger Style prioritizes **safety**, **performance**, and **developer experience** through disciplined engineering practices.

Read the full Tiger Style guide at `references/tigerstyle.md` for complete details.

## Core Principles

### 1. Safety

- **Simple, explicit control flow.** Favor straightforward structures. Avoid recursion. Keep execution bounded and predictable.
- **Fixed limits.** Set explicit upper bounds on loops, queues, and data structures. Fail fast on violations.
- **Function length under 70 lines.** Each function does one thing well.
- **Centralize control flow.** Parent functions manage branching and state. Helper functions are pure, non-branching computations.
- **Functional Core, Imperative Shell.** Extract pure, deterministic business logic into functions with no I/O, no async/await, no external state mutation. Keep side effects (network, disk, time, randomness) in a thin shell layer. The shell calls the core; the core never calls the shell.
- **Explicitly sized types.** Use `u32`, `i64` not `usize`. Consistent behavior across platforms.
- **Static memory allocation.** Allocate at startup, avoid dynamic allocation after initialization.
- **Assertion density.** Target at least two assertions per non-trivial function. Assert positive AND negative space. Split compound assertions (`assert!(a); assert!(b);` not `assert!(a && b)`).
- **Compile-time assertions.** Use `const _: () = assert!(...)` to verify constant relationships before any code runs.
- **Handle ALL errors.** 92% of catastrophic failures come from incorrect error handling. Test error paths with equal rigor.
- **Buffer external events.** Don't react directly to external events. Process in controlled batches.
- **Decompose compound conditions.** Use nested `if`/early returns instead of complex boolean expressions.

### 2. Performance

- **Design for performance early.** The biggest wins (1000x) come from design decisions, not micro-optimizations.
- **Napkin math.** Back-of-the-envelope calculations to estimate performance and catch bottlenecks early.
- **Separate control plane from data plane.** Different optimization strategies for each.
- **Batch operations.** Amortize expensive operations across multiple items.
- **Resource priority:** Network > Disk > Memory > CPU. Optimize the slowest first.
- **CPU large work chunks.** Hand the CPU a batch, let it process in a tight loop.
- **Extract hot loops with primitive arguments.** No `&self`, no trait objects, no complex structs in hot inner loops.

### 3. Developer Experience

- **Naming:** `snake_case`, no abbreviations, acronyms as single words (`RpcHandler` not `RPCHandler`), include units (`latency_ms_max`), helper prefix convention (`process_batch_validate_entry`).
- **Organization:** Entry points and public API first, then private helpers. Callbacks last in parameter lists.
- **No duplicates or aliases.** Single source of truth for every piece of data.
- **Off-by-one prevention.** Indexes (0-based), counts (1-based), and sizes are distinct types.
- **Long-form CLI flags in scripts.** `--force` not `-f`, `--recursive` not `-r`.
- **Prefer Rust tooling.** `xshell`/`duct` over bash for automation.
- **Minimize external dependencies.**
- **Zero technical debt.** Do it right the first time.

## Formal Verification with Verus

For high-assurance pure functions, use the two-file pattern:

```
crates/my-crate/
  src/verified/       # Production pure functions (compiled by cargo)
    mod.rs
    lock.rs           # Pure logic: is_expired, compute_deadline
  src/lock.rs         # Imperative shell: async try_acquire, I/O
  verus/
    lib.rs            # Verus module root with invariant documentation
    lock_state_spec.rs  # Verus specs with ensures/requires clauses
```

Use Verus for: coordination primitives, state machine transitions, fencing token logic, overflow-sensitive arithmetic, any critical pure function.

## Applying Tiger Style

When writing new code:
1. Identify pure logic and separate it from I/O (Functional Core, Imperative Shell)
2. Add assertions (at least 2 per non-trivial function, positive and negative space)
3. Set explicit bounds on all loops and collections
4. Use saturating/checked arithmetic for overflow safety
5. Keep functions under 70 lines
6. Name things with units and qualifiers
7. Add `// Tiger Style:` comments explaining safety properties

When reviewing code:
1. Check assertion density and quality
2. Verify error paths are fully tested
3. Look for unbounded loops/queues
4. Check for proper separation of pure and effectful code
5. Verify compound conditions are decomposed
6. Confirm naming follows conventions

## Additional Resources

### Reference Files

For the complete Tiger Style guide with all examples and rationale:
- **`references/tigerstyle.md`** - Full Tiger Style specification (Version 0.1-dev)
