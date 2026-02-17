**Name:** `nix`
**Description:** Nix package manager, flakes, and devshells. Use for running packages, building flakes, entering devshells, searching packages, and writing Nix expressions.
**Capabilities:** `execute`

---

## Quick Reference

### Run a package (without installing)

```bash
# From nixpkgs
nix run nixpkgs#hello
nix run nixpkgs#cowsay -- "hello"
nix run nixpkgs#python3 -- -c "print('hi')"

# From a flake (local)
nix run .
nix run .#myApp

# From a remote flake
nix run github:owner/repo
nix run github:owner/repo#package
```

### Temporary shell with packages

```bash
# Single package
nix shell nixpkgs#jq

# Multiple packages
nix shell nixpkgs#jq nixpkgs#curl nixpkgs#ripgrep

# Then use them in the session
nix shell nixpkgs#jq -c "echo '{\"a\":1}' | jq ."
```

### Enter a devshell

```bash
# Default devshell from current flake
nix develop

# Named devshell
nix develop .#myShell

# Run a command inside the devshell (without entering it)
nix develop -c bash -c "echo $PATH"
nix develop -c make build

# Remote flake devshell
nix develop github:owner/repo
```

### Build

```bash
# Build current flake's default package
nix build

# Build a specific output
nix build .#myPackage

# Build from nixpkgs
nix build nixpkgs#hello

# Build without creating ./result symlink
nix build --no-link

# Show build output path
nix build --print-out-paths
```

### Search packages

```bash
# Search nixpkgs
nix search nixpkgs hello
nix search nixpkgs "python.*requests"

# Search a flake
nix search .
```

### Evaluate Nix expressions

```bash
# Evaluate an expression
nix eval --expr '1 + 2'
nix eval --expr 'builtins.attrNames (import <nixpkgs> {})'

# Evaluate a flake attribute
nix eval .#packages.x86_64-linux.default.name
nix eval --json .#packages.x86_64-linux.default.meta

# Quick eval check (no build)
nix eval .#packages.x86_64-linux.default.outPath
```

### Flake commands

```bash
# Initialize a new flake
nix flake init
nix flake init -t templates#trivial

# Show flake outputs
nix flake show
nix flake show github:owner/repo

# Show flake metadata (inputs, revisions)
nix flake metadata

# Update all flake inputs
nix flake update

# Update a specific input
nix flake update nixpkgs

# Lock a specific input to a revision
nix flake lock --override-input nixpkgs github:NixOS/nixpkgs/nixos-24.11
```

### Misc useful commands

```bash
# Garbage collect old store paths
nix store gc

# Show why a package depends on another
nix why-depends .#myPackage nixpkgs#openssl

# Enter a REPL with flake loaded
nix repl .

# Show derivation details
nix derivation show .#myPackage

# Copy a closure to/from a remote store
nix copy --to ssh://host .#myPackage
```

---

## Flake Structure Reference

A `flake.nix` file has two main attributes: `inputs` and `outputs`.

```nix
{
  description = "My flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        # nix build / nix run
        packages.default = pkgs.hello;

        # nix develop
        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.go pkgs.gopls ];
          shellHook = ''
            echo "Go dev environment loaded"
          '';
        };

        # nix run .#myApp
        apps.default = {
          type = "app";
          program = "${pkgs.hello}/bin/hello";
        };
      }
    );
}
```

### Common output types

| Output | Used by | Purpose |
|---|---|---|
| `packages.<system>.default` | `nix build`, `nix run` | Default package |
| `packages.<system>.<name>` | `nix build .#<name>` | Named package |
| `devShells.<system>.default` | `nix develop` | Default dev environment |
| `devShells.<system>.<name>` | `nix develop .#<name>` | Named dev environment |
| `apps.<system>.default` | `nix run` | Default runnable app |
| `overlays.default` | Other flakes | Package overlay |
| `nixosConfigurations.<host>` | `nixos-rebuild` | NixOS system config |
| `nixosModules.default` | Other flakes | Reusable NixOS module |

---

## Devshell Patterns

### Basic devshell with packages

```nix
devShells.default = pkgs.mkShell {
  buildInputs = [
    pkgs.nodejs
    pkgs.nodePackages.typescript
    pkgs.nodePackages.prettier
  ];
};
```

### Devshell with environment variables

```nix
devShells.default = pkgs.mkShell {
  buildInputs = [ pkgs.postgresql ];
  env = {
    DATABASE_URL = "postgres://localhost:5432/mydb";
    NODE_ENV = "development";
  };
  shellHook = ''
    export PATH="$PWD/node_modules/.bin:$PATH"
  '';
};
```

### Multiple devshells

```nix
devShells = {
  default = pkgs.mkShell { buildInputs = [ pkgs.go ]; };
  frontend = pkgs.mkShell { buildInputs = [ pkgs.nodejs ]; };
  ci = pkgs.mkShell { buildInputs = [ pkgs.go pkgs.golangci-lint ]; };
};
# Usage: nix develop .#frontend
```

---

## Common Flags

| Flag | Effect |
|---|---|
| `--impure` | Allow access to env vars and mutable paths |
| `--no-link` | Don't create `./result` symlink |
| `--print-out-paths` | Print output store paths after build |
| `--refresh` | Ignore cache, re-evaluate |
| `--override-input NAME URL` | Override a flake input |
| `-L` / `--print-build-logs` | Show full build logs |
| `--json` | Output in JSON format (for eval/search) |
| `--accept-flake-config` | Accept `nixConfig` from untrusted flakes |

---

## Legacy (non-flake) Nix

```bash
# Install a package imperatively
nix-env -iA nixpkgs.hello

# Build a default.nix
nix-build

# Build a specific attribute
nix-build -A myPackage

# Enter a nix-shell (from shell.nix or default.nix)
nix-shell

# Enter a shell with specific packages
nix-shell -p python3 nodejs git

# Run a command in a nix-shell
nix-shell -p jq --run "echo '{}' | jq ."

# Evaluate an expression
nix-instantiate --eval -E '1 + 1'
```
