---
name: nix-prefetch-sri
description: Get SRI hash for a URL. Use when adding fetchurl/fetchFromGitHub resources to Nix expressions.
capabilities:
  - execute
---

# Usage

```bash
# Get SRI hash for any URL
nix-prefetch-sri <url>

# Example
nix-prefetch-sri https://example.com/archive.tar.gz
# sha256-...
```

Downloads the URL and computes the SRI hash (sha256) for use in Nix `fetchurl`, `fetchFromGitHub`, etc.
