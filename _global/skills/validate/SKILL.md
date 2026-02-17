---
name: validate
description: Run all validation checks (nix fmt + pre-commit hooks). Use before committing changes.
capabilities:
  - execute
---

# Usage

```bash
# Run all checks
validate
```

Runs in sequence:
1. `nix fmt` - format all Nix files
2. `pre-commit run --all-files` - run all pre-commit hooks (deadnix, statix, treefmt)
