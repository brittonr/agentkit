---
name: kagi-search
description: Search the web using Kagi. Use for web searches with Quick Answer AI summaries.
capabilities:
  - execute
---

# Usage

The tool is packaged as a Nix flake. The flake root is at `../../../` relative
to this skill directory. Resolve that to an absolute path, then run:

```bash
nix run <flake-root>#kagi-search -- "what is the capital of France"

# JSON output for parsing
nix run <flake-root>#kagi-search -- -j "search query" | jq '.results[0].url'

# Extract Quick Answer
nix run <flake-root>#kagi-search -- -j "search query" | jq '.quick_answer.markdown'

# Limit number of results
nix run <flake-root>#kagi-search -- -n 5 "search query"

# With explicit token
nix run <flake-root>#kagi-search -- -t "TOKEN" "search query"

# Enable debug logging
nix run <flake-root>#kagi-search -- -d "search query"
```

# Output Format

Results include:

- Quick Answer (AI-generated summary with references)
- Search results with title, URL, and snippet
