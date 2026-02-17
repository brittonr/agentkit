---
name: vars
description: Analyze clan vars ownership and structure. Use to inspect variable definitions across machines.
capabilities:
  - execute
---

# Usage

```bash
# Show vars ownership overview
vars

# Use basic (non-rich) output
vars --basic
```

Analyzes the `vars/` directory structure to show variable ownership per machine and shared vars.
