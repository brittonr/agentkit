---
name: web-fetch
description: Fetch web pages and API endpoints. Use for downloading web content, calling REST APIs, or grabbing raw HTML/JSON from URLs.
capabilities:
  - execute
---

# Usage

The tool is packaged as a Nix flake. The flake root is at `../../../` relative
to this skill directory. Resolve that to an absolute path, then run:

```bash
# Fetch a web page (auto-extracts readable content from HTML)
nix run <flake-root>#web-fetch -- https://example.com

# Fetch JSON from API with JSON output format
nix run <flake-root>#web-fetch -- --json https://api.example.com/data

# POST request with JSON body
nix run <flake-root>#web-fetch -- --method POST --data '{"key":"value"}' https://api.example.com/endpoint

# Show response headers
nix run <flake-root>#web-fetch -- --headers https://example.com

# Custom headers
nix run <flake-root>#web-fetch -- --header "Authorization: Bearer TOKEN" https://api.example.com/protected

# Save output to file
nix run <flake-root>#web-fetch -- --output output.html https://example.com

# Set timeout (in seconds)
nix run <flake-root>#web-fetch -- --timeout 30 https://slow-api.example.com

# Get raw HTML (skip content extraction)
nix run <flake-root>#web-fetch -- --raw https://example.com

# PUT request with data
nix run <flake-root>#web-fetch -- --method PUT --data '{"update":"value"}' https://api.example.com/resource

# Multiple headers
nix run <flake-root>#web-fetch -- --header "Content-Type: application/json" --header "X-API-Key: abc123" https://api.example.com
```

# Output Format

**HTML Pages:**
- Automatically extracts readable content (removes scripts, navigation, ads, etc.)
- Returns clean text suitable for LLM processing
- Use `--raw` flag to get unprocessed HTML

**JSON Responses:**
- Automatically detects JSON and pretty-prints
- Preserves structure for easy parsing

**Headers:**
- Use `--headers` flag to include HTTP response headers
- Headers shown before body content

**Files:**
- Use `--output filename` or `-o filename` to save response to file instead of stdout

**JSON Output:**
- Use `--json` flag to get structured JSON output with metadata
- Includes status, content_type, size, and extracted content
