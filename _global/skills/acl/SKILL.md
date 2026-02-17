---
name: acl
description: Analyze SOPS secret ownership and access control. Use to inspect who has access to which secrets.
capabilities:
  - execute
---

# Usage

```bash
# Show secret access control overview
acl

# Use basic (non-rich) output
acl --basic
```

Analyzes the `sops/` and `vars/` directories to show which keys have access to which secrets, displayed with rich terminal formatting.
