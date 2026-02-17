---
name: roster
description: Analyze user roster configurations. Use to inspect user definitions, roles, and profile assignments.
capabilities:
  - execute
---

# Usage

```bash
# Show user roster overview
roster

# Use basic (non-rich) output
roster --basic
```

Analyzes `inventory/core/roster.nix` to show user definitions, per-machine roles (owner/admin/basic/service), group memberships, and home-manager profile assignments.
