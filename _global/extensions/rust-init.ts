/**
 * rust-init: LLM-callable tool to scaffold a Rust project.
 *
 * Creates a fully configured Rust project with:
 * - Nix flake + Crane for reproducible builds
 * - Nightly toolchain (edition 2024)
 * - Mold linker via clang
 * - cargo-nextest (3 profiles)
 * - madsim (simulation testing, behind feature flag)
 * - Verus formal verification scaffolding
 * - snafu + thiserror error handling
 * - Preferred crates (tokio, serde, tracing, clap, etc.)
 * - rustfmt, clippy, cargo config
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

const rustToolchain = `\
[toolchain]
channel = "nightly"
components = ["rust-src", "rustfmt", "clippy"]
profile = "default"
`;

function cargoToml(name: string, isBin: boolean) {
  const binSection = isBin
    ? `\n[[bin]]\nname = "${name}"\npath = "src/main.rs"\n`
    : "";
  return `\
[package]
name = "${name}"
version = "0.1.0"
edition = "2024"
license = "AGPL-3.0-or-later"
${binSection}
[dependencies]
tokio = { version = "1", features = ["full"] }
futures = "0.3"
async-trait = "0.1"
serde = { version = "1.0", features = ["derive", "rc"] }
serde_json = "1.0"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
clap = { version = "4", features = ["derive", "env"] }
thiserror = "2.0"
snafu = "0.8"
bytes = "1"
chrono = "0.4"
rand = "0.9"
hex = "0.4"
url = "2"
parking_lot = "0.12"

# Optional simulation testing
madsim = { version = "0.2", features = ["macros"], optional = true }

# Optional property-based testing
bolero = { version = "0.13", optional = true }
bolero-generator = { version = "0.13", optional = true }
proptest = { version = "1.0", optional = true }

[dev-dependencies]
pretty_assertions = "1.0"
tempfile = "3"
criterion = { version = "0.5", features = ["html_reports", "async_tokio"] }
tokio-test = "0.4"

[features]
default = []
simulation = ["dep:madsim"]
property-testing = ["dep:bolero", "dep:bolero-generator", "dep:proptest"]
`;
}

const cargoConfig = `\
[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold", "-C", "link-arg=-Wl,--allow-multiple-definition"]

[target.aarch64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold", "-C", "link-arg=-Wl,--allow-multiple-definition"]

[target.x86_64-apple-darwin]
rustflags = ["-C", "link-arg=-Wl,-multiply_defined,suppress"]

[target.aarch64-apple-darwin]
rustflags = ["-C", "link-arg=-Wl,-multiply_defined,suppress"]
`;

const rustfmtToml = `\
unstable_features = true
edition = "2024"
max_width = 120

reorder_imports = true
imports_granularity = "Item"
group_imports = "StdExternalCrate"

fn_params_layout = "Tall"
fn_call_width = 100

where_single_line = true
trailing_comma = "Vertical"
overflow_delimited_expr = true
wrap_comments = true
comment_width = 100
chain_width = 100
inline_attribute_width = 0
merge_derives = false
`;

const clippyToml = `\
too-many-arguments-threshold = 10
cognitive-complexity-threshold = 25
`;

const nextestToml = `\
[profile.default]
test-threads = 1
fail-fast = true
slow-timeout = { period = "60s" }

[profile.quick]
test-threads = "num-cpus"
fail-fast = true
slow-timeout = { period = "30s" }
default-filter = "not test(proptest) & not test(chaos) & not test(madsim) & not test(simulation)"

[profile.ci]
test-threads = 1
fail-fast = false
retries = 1
slow-timeout = { period = "120s" }
`;

function flakeNix(name: string) {
  return `\
{
  description = "${name} — Rust project built with Crane";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    crane.url = "github:ipetkov/crane";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, crane, rust-overlay, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;

        # Common source filtering
        src = craneLib.cleanCargoSource ./.;

        # Common build inputs
        nativeBuildInputs = with pkgs; [
          pkg-config
          clang
          mold
        ];

        buildInputs = with pkgs; [
          openssl
        ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
          pkgs.darwin.apple_sdk.frameworks.Security
          pkgs.darwin.apple_sdk.frameworks.SystemConfiguration
        ];

        # Build just the cargo dependencies for caching
        cargoArtifacts = craneLib.buildDepsOnly {
          inherit src nativeBuildInputs buildInputs;
        };

        # Build the actual package
        ${name} = craneLib.buildPackage {
          inherit src cargoArtifacts nativeBuildInputs buildInputs;
        };
      in
      {
        packages = {
          default = ${name};
          ${name} = ${name};
        };

        checks = {
          inherit ${name};

          # Run tests with nextest
          nextest = craneLib.cargoNextest {
            inherit src cargoArtifacts nativeBuildInputs buildInputs;
            partitions = 1;
            partitionType = "count";
          };

          # Clippy lints
          clippy = craneLib.cargoClippy {
            inherit src cargoArtifacts nativeBuildInputs buildInputs;
            cargoClippyExtraArgs = "--all-targets -- -D warnings";
          };

          # Format check
          fmt = craneLib.cargoFmt {
            inherit src;
          };
        };

        devShells.default = craneLib.devShell {
          inherit buildInputs;

          packages = with pkgs; [
            cargo-nextest
            cargo-watch
            rust-analyzer
          ];

          # Ensure the nightly toolchain is available
          inputsFrom = [ ${name} ];
        };
      }
    );
}
`;
}

const envrc = `\
use flake
`;

const gitignore = `\
# Build
target/
coverage/
doc/

# Nix
result*
.direnv/

# IDE
.idea/
.vscode/
*.swp
*.swo

# Runtime
*.redb
*.sock
data/
`;

function readmeMd(name: string) {
  return `\
# ${name}

## Development

\`\`\`bash
nix develop          # enter devshell
cargo check          # verify compilation
cargo nextest run    # run tests
nix flake check      # full CI (build + test + clippy + fmt)
\`\`\`

## Verification

\`\`\`bash
verus verus/example_spec.rs
\`\`\`
`;
}

const errorRs = `\
use snafu::prelude::*;

#[derive(Debug, Snafu)]
#[snafu(visibility(pub))]
pub enum Error {
    #[snafu(display("configuration error: {message}"))]
    Config { message: String },

    #[snafu(display("I/O error: {source}"))]
    Io { source: std::io::Error },
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
`;

function mainRs(name: string) {
  return `\
use clap::Parser;
use snafu::prelude::*;
use tracing::info;

mod error;
use error::Result;

#[derive(Parser, Debug)]
#[command(name = "${name}", about = "${name}")]
struct Args {
    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,
}

#[snafu::report]
#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(if args.verbose {
                    tracing::Level::DEBUG.into()
                } else {
                    tracing::Level::INFO.into()
                }),
        )
        .init();

    info!("starting ${name}");

    Ok(())
}
`;
}

const libRs = `\
pub mod error;

#[cfg(test)]
mod tests {
    #[test]
    fn it_works() {
        assert_eq!(2 + 2, 4);
    }
}
`;

const verusReadme = `\
# Verus Specifications

This directory contains [Verus](https://verus-lang.github.io/verus/guide/) formal
verification specs for this project.

Each \`*_spec.rs\` file defines invariants, preconditions, and postconditions that
are machine-checked by the Verus verifier.

## Running verification

\`\`\`bash
# If verus is in your devShell:
verus verus/example_spec.rs
\`\`\`
`;

const verusExampleSpec = `\
use vstd::prelude::*;

verus! {
    /// Example specification — replace with real invariants.
    pub open spec fn valid_state(x: int) -> bool {
        x >= 0
    }

    pub proof fn valid_state_is_non_negative(x: int)
        requires valid_state(x),
        ensures x >= 0,
    {
    }
}

fn main() {}
`;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "rust_init",
    label: "Rust Init",
    description:
      "Scaffold a new Rust project with nix/crane, nextest, madsim, verus, snafu, " +
      "and preferred crates. Creates all config files and source scaffolding in a " +
      "new directory under the current working directory.",
    parameters: Type.Object({
      name: Type.String({
        description: "Project name (used for directory, package name, and binary name)",
      }),
      kind: StringEnum(["bin", "lib"] as const, {
        description: 'Project kind: "bin" for a binary crate, "lib" for a library crate. Defaults to "bin".',
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { name, kind } = params;
      const isBin = kind !== "lib";
      const root = join(ctx.cwd, name);

      if (existsSync(root)) {
        return {
          content: [{ type: "text" as const, text: `Error: directory '${root}' already exists.` }],
          isError: true,
          details: {},
        };
      }

      // Create directory tree
      const dirs = [
        root,
        join(root, ".cargo"),
        join(root, ".config"),
        join(root, "src"),
        join(root, "verus"),
      ];
      for (const d of dirs) mkdirSync(d, { recursive: true });

      // Write files
      const files: [string, string][] = [
        ["rust-toolchain.toml", rustToolchain],
        ["Cargo.toml", cargoToml(name, isBin)],
        [".cargo/config.toml", cargoConfig],
        ["rustfmt.toml", rustfmtToml],
        ["clippy.toml", clippyToml],
        [".config/nextest.toml", nextestToml],
        ["flake.nix", flakeNix(name)],
        [".envrc", envrc],
        [".gitignore", gitignore],
        ["README.md", readmeMd(name)],
        ["src/error.rs", errorRs],
        ["verus/README.md", verusReadme],
        ["verus/example_spec.rs", verusExampleSpec],
      ];

      if (isBin) {
        files.push(["src/main.rs", mainRs(name)]);
        files.push(["src/lib.rs", libRs]);
      } else {
        files.push(["src/lib.rs", libRs]);
      }

      for (const [rel, content] of files) {
        writeFileSync(join(root, rel), content, "utf-8");
      }

      // git init + generate lock files
      const cmds = [
        `cd "${root}" && git init -q`,
        `cd "${root}" && cargo generate-lockfile 2>&1`,
      ];
      const cmdOutput: string[] = [];
      for (const cmd of cmds) {
        try {
          const result = await pi.exec("bash", ["-c", cmd], { timeout: 60_000 });
          if (result.stdout) cmdOutput.push(result.stdout.trim());
          if (result.stderr) cmdOutput.push(result.stderr.trim());
        } catch (e: any) {
          cmdOutput.push(`warning: ${cmd} failed: ${e.message}`);
        }
      }

      const created = files.map(([rel]) => rel);
      const summary = [
        `Created Rust ${isBin ? "binary" : "library"} project: ${name}/`,
        "",
        "Files:",
        ...created.map((f) => `  ${f}`),
        "",
        "Features:",
        "  • Nightly Rust, edition 2024, AGPL-3.0-or-later",
        "  • Nix flake + Crane (reproducible builds, nextest check, clippy check) + direnv",
        "  • Mold linker via clang",
        "  • cargo-nextest (default, quick, ci profiles)",
        "  • madsim (behind 'simulation' feature flag)",
        "  • Verus scaffolding (verus/example_spec.rs)",
        "  • snafu + thiserror error handling",
        "  • tokio, serde, tracing, clap, futures, chrono, rand, bytes, parking_lot",
        "  • rustfmt (nightly, 120 width, item-granularity imports)",
        "  • clippy (relaxed thresholds: 10 args, 25 cognitive complexity)",
        "",
        "Next steps:",
        `  cd ${name}`,
        "  nix develop          # enter devshell",
        "  cargo check          # verify compilation",
        "  cargo nextest run    # run tests",
        "  nix flake check      # full CI (build + test + clippy + fmt)",
      ];

      if (cmdOutput.length > 0) {
        summary.push("", "Command output:", ...cmdOutput.map((l) => `  ${l}`));
      }

      return {
        content: [{ type: "text" as const, text: summary.join("\n") }],
        details: { name, kind, files: created },
      };
    },
  });
}
