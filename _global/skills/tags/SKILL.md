---
name: tags
description: Analyze machine tag assignments. Use to see which tags apply to which machines.
capabilities:
  - execute
---

# Usage

```bash
# Show tag-to-machine mappings
tags

# Use basic (non-rich) output
tags --basic
```

Analyzes `inventory/core/machines.nix` to show which tags are assigned to each machine and which machines share tags.
