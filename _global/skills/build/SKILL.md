---
name: build
description: Build a NixOS machine configuration locally. Use to test machine builds before deploying.
capabilities:
  - execute
---

# Usage

```bash
# Build a specific machine configuration
build <machine-name>

# Examples
build britton-fw
build britton-gpd
```

Uses `nom build` if available (for prettier output), otherwise falls back to `nix build`.

Builds `.#nixosConfigurations.<machine-name>.config.system.build.toplevel`.

For a faster eval-only check (no build), use:
```bash
nix eval .#nixosConfigurations.<machine-name>.config.system.build.toplevel.outPath
```
