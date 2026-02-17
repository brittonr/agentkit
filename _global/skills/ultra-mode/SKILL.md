---
name: ultra-mode
description: Maximum capability mode with deep thinking, parallel subagents, and comprehensive analysis. Use when tackling complex problems requiring thorough analysis, multi-faceted solutions, production-grade implementations, or when the user mentions "ultra", "maximum effort", "deep analysis", or "comprehensive solution".
capabilities:
  - execute
  - read_files
  - write_files
  - edit_files
  - search_code
  - glob
  - search_web
  - fetch_url
  - task
agents:
  claude:
    model: claude-opus-4-5-20251101
    tools:
      - Task
      - WebSearch
      - WebFetch
      - Read
      - Edit
      - Bash
      - Grep
      - Glob
---

# ULTRA MODE: Maximum Capability Analysis

When this skill is active, operate at maximum capability with deep thinking and parallel execution.

## Deep Thinking Directive

Think about problems with extreme depth and thoroughness. This warrants the longest, most detailed thinking. Consider:

- Multiple solution architectures
- Performance implications at scale
- Security considerations
- Edge cases and failure modes
- Alternative approaches that might typically be dismissed

Think harder about the tradeoffs. Think longer about the implementation details.

## Parallel Subagent Execution

Always run subagents in parallel when possible:

- Launch multiple Task agents simultaneously for independent research
- Use the Explore agent for codebase understanding
- Use the Plan agent for architectural decisions
- Run security analysis, documentation lookup, and code analysis concurrently

Run these simultaneously, not sequentially. Time is of the essence.

## MCP Server Utilization

Query all available external systems:

### Development Context
- Context7: Development documentation and reference

### Documentation & Knowledge
- Internal wikis: Find relevant documentation
- Web search: Get latest industry best practices

### Code Quality
- Run security scanners via MCP
- Check dependency vulnerabilities
- Analyze performance metrics

## Synthesis Protocol

After gathering ALL information:

1. Cross-reference findings from all sources
2. Identify conflicts and resolve them
3. Build a holistic solution that addresses all concerns
4. Provide implementation with full error handling
5. Include rollback strategy
6. Add monitoring and alerting recommendations

## Constraints

- NEVER create new markdown files unless explicitly requested
- Focus on production-grade solutions
- Include tests and validation
- Document significant decisions

## Success Criteria

Responses must:

- Demonstrate deep, thorough thinking
- Show evidence of parallel subagent usage
- Include data from MCP servers when available
- Provide production-grade solutions
- Include tests and validation approaches

This is ULTRA mode. Maximum effort. Maximum quality. No shortcuts.
