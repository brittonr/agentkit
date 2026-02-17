# Codebase Analysis Report - Ultra Mode

**Date**: 2026-01-05
**Scope**: Full infrastructure audit of onix-core NixOS repository
**Analysis Method**: Deep parallel agent exploration + external documentation synthesis

---

## Executive Summary

The onix-core repository demonstrates **sophisticated and modern practices** for NixOS infrastructure management using clan-core. The architecture shows thoughtful design with flake-parts partitions, perInstance service modules, and comprehensive monitoring. However, there are significant opportunities for improvement in code deduplication, security hardening, and organizational consistency.

### Key Statistics
- **331 Nix files** across 6.8 MB
- **9 machines** across 3 users
- **19 custom clan service modules**
- **21 tags** for configuration grouping
- **159 home-profile files** across 4 users
- **142 SOPS-encrypted secrets** + 28 public value files

---

## Critical Improvements (High Priority)

### 1. Machine Configuration Consolidation

**Problem**: Machine configs are 150-252 lines when they should be 50-70 lines max.

| File | Lines | Issue |
|------|-------|-------|
| `machines/britton-gpd/configuration.nix` | 252 | Too large, mixed concerns |
| `machines/britton-fw/configuration.nix` | 188 | Duplicated patterns |
| `machines/alex-fw/configuration.nix` | 178 | Repeats from britton-fw |

**Duplicated patterns identified**:
- `vm.swappiness`, `vm.dirty_ratio` kernel sysctl (6+ lines, 3 machines)
- `zramSwap` configuration (3 machines identical)
- `keyd` and `greetd` settings (4 machines)
- GRUB2 wallpaper fetchurl pattern (3 machines)
- Nix substituters configuration (2 machines)

**Solution**: Create new tags:
- `perf-tuning` - kernel sysctl optimizations
- `zram-swap` - zram configuration (extract from ssd-optimization)
- `laptop-ui` - keyd + greetd + tuigreet
- `grub-wallpaper` - GRUB theme with fetchurl
- `remote-builders` - distributed build configuration

### 2. Security: SOPS Configuration

**Problems identified**:

1. **Inconsistent file permissions**:
   - Most secrets: `rw-r--r--` (644) - TOO PERMISSIVE
   - One secret: `rw-------` (600) - CORRECT

2. **Missing `.sops.yaml`**: No declarative access control policies

3. **No rotation tracking**: Secrets lack creation/rotation metadata

**Immediate actions**:
```bash
# Fix permissions on all SOPS secret files
find /home/brittonr/git/onix-core/sops/secrets -type f -name "secret" -exec chmod 600 {} \;
```

Create `.sops.yaml` at repository root:
```yaml
creation_rules:
  - path_regex: ^sops/secrets/.*
    key_groups:
      - age:
        - *admins
  - path_regex: ^vars/per-machine/([^/]+)/.*
    key_groups:
      - age:
        - *\1  # Machine-specific key
        - *admins
```

### 3. Flake Input Deduplication

**Problems**:
- Two separate `nixvim` inputs (duplicate)
- `devblog` input doesn't follow nixpkgs
- Empty `parts/vm-checks.nix` file

**Solution**:
```nix
# In flake.nix, consolidate nixvim:
adeci-nixvim = {
  url = "github:adeci/nixvim-config";
  inputs.nixpkgs.follows = "nixpkgs";
  inputs.nixvim.follows = "nixvim";  # Add this
};

# Add follows to devblog if you control that repo
devblog = {
  url = "github:adeci/devblog";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

### 4. Module Code Duplication

**Major duplications across modules**:

| Pattern | Locations | Lines |
|---------|-----------|-------|
| SSH key generators | 6 modules | ~30 lines each |
| Nginx reverse proxy | 4 modules | ~40 lines each |
| Firewall opening | 15 modules | ~5 lines each |
| Vars generator scripts | 6 modules | ~20 lines each |

**Solution**: Create `modules/_lib/default.nix`:
```nix
{ lib }:
{
  mkSshKeyGenerator = { instanceName, owner ? "root", group ? "root" }: {
    # Shared SSH key generation logic
  };

  mkNginxProxy = { domain, port, enableSSL ? true }: {
    # Shared nginx proxy configuration
  };

  mkOpenFirewall = { ports, openFirewall ? true }: {
    # Conditional firewall opening
  };
}
```

---

## Medium Priority Improvements

### 5. Home-Profile Deduplication

**Identical files found**:
- `alex/base/atuin.nix` = `brittonr/base/atuin.nix` (38 lines)
- Shell aliases overlap significantly (44+ shared aliases)

**Solution**: Create shared profile base:
```
inventory/home-profiles/
├── _shared/
│   ├── atuin.nix       # Common atuin config
│   ├── aliases.nix     # Shared shell aliases
│   └── git-base.nix    # Common git settings
├── alex/
│   └── base/
│       └── default.nix # imports ../_shared/atuin.nix
├── brittonr/
│   └── ...
```

### 6. Service IP Hardcoding

**Problem**: Services reference each other by hardcoded Tailscale IPs:
- `seaweedfs.nix`: `100.92.36.3`, `100.110.43.11`
- `homepage-dashboard.nix`: Multiple hardcoded IPs
- `prometheus.nix`: Static discovery IPs

**Solution**: Create service registry in `inventory/core/services-registry.nix`:
```nix
{
  grafana = { host = "britton-fw"; port = 3000; };
  prometheus = { host = "britton-fw"; port = 9090; };
  loki = { host = "britton-fw"; port = 3100; };
  # ... etc
}
```

Then reference via `config.services-registry.grafana.url`

### 7. Tag Organization

**Issues**:
- 21 tags for 9 machines (high ratio)
- Service-specific tags mixed with role tags
- Naming inconsistency (`ssd-optimization` vs `cross-compile`)

**Consolidation opportunities**:
- `prometheus` + `monitoring` + `homepage-server` → `monitoring-stack`
- `static-test` + `static-demo` → should be service instances, not tags
- `traefik-blr` + `traefik-desktop` → parameterized via service config

### 8. Module Hardcoded Values

**Examples found**:
- `pixiecore/default.nix:191`: Hardcoded Harmonia cache key
- `tailscale-traefik/default.nix:145`: Hardcoded Cloudflare DNS resolvers
- `wiki-js/default.nix:687`: Hardcoded admin email
- `llm/default.nix:272`: Unsafe package references without validation

**Solution**: All hardcoded values should become configurable options with sensible defaults.

### 9. Large Embedded Content

**Files with embedded scripts/configs that should be extracted**:

| Module | Content | Lines |
|--------|---------|-------|
| `wiki-js/default.nix` | SQL migration | 167 lines |
| `pixiecore/default.nix` | Python API server | ~70 lines |
| `prometheus.nix` (service) | Alert rules YAML | 170+ lines |

**Solution**: Extract to separate files:
- `modules/wiki-js/migration.sql`
- `modules/pixiecore/api-server.py`
- `inventory/services/prometheus-alerts.nix`

---

## Low Priority Improvements

### 10. Empty/Stub Files

**Files to address**:
- `parts/vm-checks.nix` - entirely commented out
- `modules/llm/default.nix:114-118` - commented ollama config
- 4 commented services in `inventory/services/default.nix`

**Action**: Remove or document why disabled.

### 11. Documentation Gaps

**Missing documentation**:
- Home-profile structure explanation
- Tag naming conventions
- Service module patterns guide
- Secret rotation procedures
- Machine onboarding checklist

### 12. Roster Configuration Density

**Problem**: `inventory/core/roster.nix` is 416 lines mixing:
- User definitions
- Machine customizations
- Monitor configurations
- homeManagerOptions

**Solution**: Split into:
- `roster/users.nix` - User definitions
- `roster/machine-overrides.nix` - Per-machine customizations
- `roster/displays.nix` - Monitor configurations

### 13. Pre-commit Security Hooks

**Missing**:
- Secret leak detection
- SOPS file validation
- Hardcoded credential patterns

**Add to `.pre-commit-config.yaml`**:
```yaml
- repo: https://github.com/gitleaks/gitleaks
  rev: v8.18.1
  hooks:
    - id: gitleaks
```

---

## Architecture Recommendations

### Adopt Dendritic Pattern

Based on [Migrating to Clan and Dendritic Architecture](https://blog.stark.pub/posts/clan-migration/):

1. All features as flake-parts modules in `modules/`
2. Expose `nixosModules.<name>` and `homeModules.<name>`
3. Machines compose by importing modules
4. Use import-tree for automatic discovery

### Create Machine Templates

```nix
# inventory/templates/laptop.nix
{ config, ... }: {
  imports = [
    config.flake.nixosModules.laptop-ui
    config.flake.nixosModules.perf-tuning
    config.flake.nixosModules.zram-swap
  ];
  # Common laptop settings
}
```

### Implement Secret Rotation Policy

| Secret Type | Rotation Period |
|-------------|-----------------|
| Tailscale auth keys | 30 days |
| API tokens | 90 days |
| SSH keys | Annual |
| Admin passwords | 6 months |

---

## Validation Results

```
$ nix flake check
  All checks passed (with warnings for unknown outputs: debug, analysisTools, clanTools, allSystems)

$ validate
  nix fmt: 118 files formatted (0 changed)
  pre-commit: All hooks passed (deadnix, statix, treefmt)
```

Current codebase is **valid and passes all checks**.

---

## Summary: Prioritized Action Items

### Immediate (This Week)
1. Fix SOPS secret file permissions (chmod 600)
2. Create `.sops.yaml` access control policy
3. Remove empty `parts/vm-checks.nix` or add TODO

### Short-term (This Month)
4. Consolidate duplicate nixvim inputs
5. Extract common tags (perf-tuning, laptop-ui, zram-swap)
6. Create `modules/_lib/` helper module
7. Extract shared home-profile configurations

### Medium-term (This Quarter)
8. Create service registry for IP management
9. Split large modules (wiki-js SQL, prometheus alerts)
10. Document module patterns and onboarding
11. Implement secret rotation automation

### Long-term (Backlog)
12. Adopt full dendritic architecture
13. Create machine templates
14. Add comprehensive integration tests
15. Implement service discovery via DNS/Tailscale

---

## Sources

- [Clan.lol Documentation](https://docs.clan.lol/)
- [Clan Flake-Parts Guide](https://docs.clan.lol/guides/flake-parts/)
- [SOPS-nix Best Practices (2025)](https://michael.stapelberg.ch/posts/2025-08-24-secret-management-with-sops-nix/)
- [Dendritic Architecture Migration](https://blog.stark.pub/posts/clan-migration/)
- [Flake-Parts Documentation](https://flake.parts/)
- [sops-nix GitHub](https://github.com/Mic92/sops-nix)
