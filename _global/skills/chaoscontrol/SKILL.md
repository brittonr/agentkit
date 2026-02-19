---
name: chaoscontrol
description: >
  Deterministic hypervisor for simulation testing of distributed systems.
  Use when working in the chaoscontrol repo — building, testing, exploring,
  replaying, writing guest programs, or modifying the VMM. Covers workspace
  structure, build commands, key APIs, fault injection, coverage, and common
  pitfalls.
---

# ChaosControl

Deterministic x86_64 VMM built on KVM + rust-vmm. Enables Antithesis-style
simulation testing: snapshot/fork VMs, inject faults, explore state space
with coverage guidance, replay and triage bugs with full determinism.

## Workspace Layout

```
crates/
  chaoscontrol-protocol/   # Wire format (no_std, zero deps)
  chaoscontrol-sdk/         # Guest SDK (no_std default, std feature)
  chaoscontrol-fault/       # Fault engine + property oracle
  chaoscontrol-vmm/         # VM, CPU, devices, controller, snapshots
  chaoscontrol-trace/       # eBPF tracing + determinism verification
  chaoscontrol-explore/     # Coverage-guided exploration engine
  chaoscontrol-replay/      # Recording, replay, time-travel debugger, triage
  chaoscontrol-guest/       # Minimal SDK-instrumented guest binary
  chaoscontrol-raft-guest/  # 3-node Raft consensus guest (dogfood target)
guest/                      # Pre-built initrd images
scripts/                    # Guest build + trace test scripts
tools/tracing/              # bpftrace scripts for KVM debugging
docs/                       # Design documents
```

### Dependency Graph

```
protocol (no_std)
  ├── sdk (guest-side, no_std + std)
  ├── fault (host-side engine)
  │     └── vmm (VM + devices + controller)
  │           ├── explore (coverage-guided search)
  │           └── replay (recording + triage)
  └── trace (eBPF, independent)
```

## Build Commands

**All cargo commands must run inside the Nix devshell:**

```bash
# Enter devshell (required for clang, musl, libbpf)
nix develop

# Or run a single command without entering the shell
nix develop --command bash -c "cargo build --release"
```

### Common Commands

```bash
# Build everything
cargo build --release

# Run all tests (616+ tests, no /dev/kvm needed for unit tests)
cargo test

# Run tests for a specific crate
cargo test -p chaoscontrol-vmm
cargo test -p chaoscontrol-raft-guest --lib

# Clippy (deny warnings — matches CI)
cargo clippy --all-targets -- -D warnings

# Format
cargo fmt --all

# Nix checks (build + clippy + fmt + tests, no /dev/kvm in sandbox)
nix flake check
```

### Run Binaries

```bash
# Boot a kernel (needs vmlinux ELF, NOT bzImage)
cargo run --bin boot -- result-dev/vmlinux guest/initrd.gz

# Snapshot demo
cargo run --release --bin snapshot_demo -- result-dev/vmlinux guest/initrd.gz

# Run SDK guest tests (requires /dev/kvm)
cargo run --release --bin sdk_guest_test -- result-dev/vmlinux guest/initrd-sdk.gz

# Integration tests (requires /dev/kvm)
cargo run --release --bin integration_test -- result-dev/vmlinux guest/initrd-sdk.gz
```

### Build Guest Programs

```bash
# Build SDK guest → guest/initrd-sdk.gz
nix develop --command bash -c "scripts/build-guest.sh"

# Build Raft guest → guest/initrd-raft.gz
nix develop --command bash -c "scripts/build-raft-guest.sh"
```

Guest binaries are statically linked with musl (`x86_64-unknown-linux-musl`).
The musl linker is set in `.cargo/config.toml`.

## CLI Tools

### chaoscontrol-explore

```bash
# Coverage-guided exploration
cargo run --release --bin chaoscontrol-explore -- run \
  --kernel result-dev/vmlinux \
  --initrd guest/initrd-raft.gz \
  --vms 3 --rounds 200 --branches 16 \
  --ticks 1000 --quantum 100 \
  --seed 42 --output results/

# Resume from checkpoint
cargo run --release --bin chaoscontrol-explore -- resume \
  --corpus results/ --rounds 500 \
  [--kernel path] [--initrd path]
```

### chaoscontrol-replay

```bash
# Replay a recording
cargo run --release --bin chaoscontrol-replay -- replay \
  --recording session.json [--checkpoint <id>] [--ticks <n>]

# Triage a bug (markdown or JSON report)
cargo run --release --bin chaoscontrol-replay -- triage \
  --recording session.json --bug-id 1 --format markdown

# Show recording metadata
cargo run --release --bin chaoscontrol-replay -- info \
  --recording session.json

# List events with optional filter
cargo run --release --bin chaoscontrol-replay -- events \
  --recording session.json [--filter faults|assertions|bugs] \
  [--from <tick>] [--to <tick>]

# Debug at specific tick
cargo run --release --bin chaoscontrol-replay -- debug \
  --recording session.json --tick <n>
```

### chaoscontrol-trace

```bash
# Live eBPF trace (requires sudo)
sudo chaoscontrol-trace live --pid <VMM_PID> --output trace.json

# Verify determinism between two traces
chaoscontrol-trace verify --trace-a run1.json --trace-b run2.json

# Summarize a trace
chaoscontrol-trace summary --trace run1.json
```

## Key APIs

### Guest SDK (`chaoscontrol-sdk`)

```rust
use chaoscontrol_sdk::{assert, coverage, lifecycle, random};

// Signal ready — gates fault injection
lifecycle::setup_complete(&[("role", "leader"), ("nodes", "3")]);

// Safety properties (immediate failure if violated)
assert::always(leader_count <= 1, "election safety", &[("term", &format!("{}", term))]);

// Liveness properties (fail if never true across ALL runs)
assert::sometimes(committed > 0, "value committed", &[]);

// Reachability
assert::reachable("leader elected", &[]);
assert::unreachable("split brain", &[]);

// Deterministic randomness (seeded by VMM)
let choice = random::random_choice(4);  // 0..3
let val = random::get_random();         // u64

// Coverage (AFL-style edge tracking)
coverage::init();
coverage::record_edge(location_id);

// Structured events
lifecycle::send_event("commit", &[("index", "42"), ("value", "x")]);
```

Macros with auto-generated location IDs:
```rust
cc_assert_always!(cond, "message");
cc_assert_sometimes!(cond, "message");
cc_assert_reachable!("message");
cc_assert_unreachable!("message");
```

### VMM (`chaoscontrol-vmm`)

```rust
use chaoscontrol_vmm::{DeterministicVm, VmConfig, CpuConfig};

// Create and boot a VM
let config = VmConfig::default();  // 256MB, 3GHz TSC, deterministic cmdline
let mut vm = DeterministicVm::new(config)?;
vm.load_kernel("result-dev/vmlinux", Some("guest/initrd.gz"))?;

// Run modes
vm.run()?;                              // Run until exit
let output = vm.run_until("pattern")?;  // Run until serial matches
let (exits, idle) = vm.run_bounded(100_000)?;  // Bounded by exit count

// State access
let tsc = vm.virtual_tsc();
let exits = vm.exit_count();
let serial = vm.take_serial_output();

// Snapshots
let snap = vm.snapshot()?;
vm.restore(&snap)?;

// Coverage
vm.clear_coverage_bitmap();
let bitmap = vm.read_coverage_bitmap();

// Fault engine
vm.fault_engine_mut().force_setup_complete();
vm.fault_engine_mut().set_schedule(schedule);
let faults = vm.fault_engine_mut().poll_faults(virtual_ns);
```

### Multi-VM Controller (`chaoscontrol-vmm::controller`)

```rust
use chaoscontrol_vmm::{SimulationController, SimulationConfig};

let config = SimulationConfig {
    num_vms: 3,
    vm_config: VmConfig::default(),
    kernel_path: "result-dev/vmlinux".into(),
    initrd_path: Some("guest/initrd-raft.gz".into()),
    seed: 42,
};
let mut ctrl = SimulationController::new(config)?;

// Run N ticks (relative, not absolute)
ctrl.run(1000)?;

// Round-robin step
let result = ctrl.step_round()?;

// Snapshot/restore all VMs
let snap = ctrl.snapshot_all()?;
ctrl.restore_all(&snap)?;

// Network faults
// Network faults (via fault schedule — preferred)
// Or direct fabric access:
ctrl.network_mut().send(0, 1, vec![42], ctrl.tick());
let can_reach = ctrl.network().can_reach(0, 1);

// Fault schedule
ctrl.set_schedule(schedule);
ctrl.force_setup_complete();  // For tests without SDK
```

### Fault Engine (`chaoscontrol-fault`)

```rust
use chaoscontrol_fault::{FaultScheduleBuilder, Fault};

let schedule = FaultScheduleBuilder::new()
    .at_ns(1_000_000, Fault::NetworkPartition {
        side_a: vec![0], side_b: vec![1, 2],
    })
    .at_ns(2_000_000, Fault::NetworkJitter {
        target: 0, jitter_ns: 50_000_000,       // ±50ms
    })
    .at_ns(2_000_000, Fault::NetworkBandwidth {
        target: 1, bytes_per_sec: 1_000_000,     // 1 MB/s
    })
    .at_ns(3_000_000, Fault::PacketDuplicate {
        target: 0, rate_ppm: 100_000,            // 10%
    })
    .at_ns(5_000_000, Fault::ProcessKill { target: 1 })
    .at_ns(8_000_000, Fault::NetworkHeal)
    .at_ns(10_000_000, Fault::ClockSkew {
        target: 0, offset_ns: 500_000,
    })
    .build();
```

**Fault variants:**
- Network: `NetworkPartition`, `NetworkLatency`, `NetworkJitter`, `NetworkBandwidth`, `PacketLoss`, `PacketCorruption`, `PacketReorder`, `PacketDuplicate`, `NetworkHeal`
- Disk: `DiskReadError`, `DiskWriteError`, `DiskTornWrite`, `DiskCorruption`, `DiskFull`
- Process: `ProcessKill`, `ProcessPause`, `ProcessRestart`
- Clock: `ClockSkew`, `ClockJump`
- Resources: `MemoryPressure`

### Exploration (`chaoscontrol-explore`)

```rust
use chaoscontrol_explore::{Explorer, ExplorerConfig};

let config = ExplorerConfig {
    num_vms: 3,
    kernel_path: "result-dev/vmlinux".into(),
    initrd_path: Some("guest/initrd-raft.gz".into()),
    seed: 42,
    branch_factor: 8,
    ticks_per_branch: 1000,
    max_rounds: 200,
    max_frontier: 50,
    quantum: 100,
    ..Default::default()
};
let mut explorer = Explorer::new(config)?;
let report = explorer.run()?;

// Resume from checkpoint
let checkpoint = load_checkpoint("results/checkpoint.json")?;
let mut explorer = Explorer::from_checkpoint(checkpoint, None, None, 500)?;
```

### Replay (`chaoscontrol-replay`)

```rust
use chaoscontrol_replay::{Debugger, EventFilter, TriageEngine, load_recording};

let recording = load_recording("session.json")?;

// Time-travel debugger
let mut dbg = Debugger::new(&recording);
dbg.goto_bug(1);
dbg.rewind(100);
dbg.step_forward(10);
dbg.next_event(EventFilter::FailedAssertion);

// Triage
let report = TriageEngine::triage(&recording, 1);
```

## Architecture Notes

### Transport: Guest ↔ VMM

1. Guest writes `HypercallPage` (4096 bytes, repr C) to GPA `0xFE000`
2. Guest executes `outb(0x510, 0)` → KVM IoOut exit
3. VMM reads page from guest memory, dispatches to `FaultEngine`
4. VMM writes result (u64 + status byte) back to page
5. Guest reads response and continues

### Coverage Bitmap

- 64KB at GPA `0xE0000` (BIOS reserved area in E820 gap)
- AFL-style: `prev_location XOR cur_location` → index → saturating 8-bit counter
- Guest signals active via `outb(0x511, 0)`
- VMM clears before each branch, reads after

### Determinism Mechanisms

| Source | Solution |
|--------|----------|
| RDRAND/RDSEED | Filtered from CPUID; guest uses seeded ChaCha20 via SDK |
| TSC (time stamp counter) | `sync_tsc_to_guest()` overwrites IA32_TSC MSR before every vcpu.run() |
| KVM clock | Reset to 0 at startup; `hide_hypervisor=true` prevents kvm-clock driver |
| PIT (timer) | KVM PIT suppressed; `DeterministicPit` delivers IRQ 0 deterministically |
| KASLR | `nokaslr` in kernel cmdline |
| SMP | `nosmp` — single vCPU only |
| Stack randomization | `randomize_kstack_offset=off norandmaps` |

### Kernel Cmdline (default)

```
clocksource=tsc tsc=reliable lpj=6000000 nokaslr noapic nosmp
randomize_kstack_offset=off norandmaps kfence.sample_interval=0
no_hash_pointers
```

### Virtio MMIO Devices

| Device | ID | IRQ | Base Address | Notes |
|--------|----|-----|-------------|-------|
| virtio-blk | 2 | 5 | 0xD000_0000 | 16MB in-memory block device |
| virtio-net | 1 | 6 | 0xD000_1000 | Simulated network with fault injection |
| virtio-rng | 4 | 7 | 0xD000_2000 | Deterministic entropy (ChaCha20) |

### Memory Layout

| Region | Address | Purpose |
|--------|---------|---------|
| GDT | 0x500 | Boot GDT |
| IDT | 0x520 | Boot IDT |
| Zero page | 0x7000 | Linux boot params |
| Stack | 0x8FF0 | Boot stack pointer |
| PML4 | 0x9000 | Page tables (identity-mapped) |
| Cmdline | 0x20000 | Kernel command line |
| Coverage bitmap | 0xE0000 | 64KB AFL coverage |
| Hypercall page | 0xFE000 | 4KB SDK transport |
| Kernel | 0x100000 | Linux kernel (HIMEM_START) |

## Writing Guest Programs

Guest binaries run as PID 1 (init) in a minimal Linux VM. Pattern:

```rust
// crates/chaoscontrol-my-guest/src/main.rs
use chaoscontrol_sdk::{assert, coverage, lifecycle, random};

fn main() {
    // Mount devtmpfs for SDK std transport (/dev/mem, /dev/port)
    unsafe {
        libc::mount(
            b"devtmpfs\0".as_ptr().cast(),
            b"/dev\0".as_ptr().cast(),
            b"devtmpfs\0".as_ptr().cast(),
            0, std::ptr::null(),
        );
    }

    coverage::init();
    lifecycle::setup_complete(&[("app", "my-guest")]);

    // Main workload — must loop forever (VMM controls horizon)
    loop {
        let choice = random::random_choice(4);
        coverage::record_edge(choice);

        // Do work based on choice...

        // Assert invariants
        assert::always(invariant_holds(), "my invariant", &[]);
        assert::sometimes(progress_made(), "liveness", &[]);
    }
}
```

**Build**: Add crate to workspace, create build script modeled on
`scripts/build-guest.sh`, target `x86_64-unknown-linux-musl`.

**Key rules:**
- Guest must loop forever — no "workload complete" pattern
- All randomness via SDK (`random::random_choice`, `random::get_random`)
- Call `setup_complete()` before assertions (gates fault injection)
- Call `coverage::init()` early for coverage tracking
- Mount devtmpfs for `/dev/mem` and `/dev/port` (SDK std transport)

## Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| Using bzImage for kernel | Use vmlinux (ELF) from `result-dev/vmlinux` |
| Running cargo outside nix devshell | `nix develop --command bash -c "cargo ..."` |
| Faults don't fire in tests | Call `force_setup_complete()` — faults gated by SDK setup |
| `controller.run(N)` seems wrong | N is relative ticks, not absolute |
| Guest exits after workload | Guest must loop forever; VMM controls execution horizon |
| Coverage shows 0 edges | Call `coverage::init()` in guest; check `coverage_active()` |
| Snapshot/restore TSC mismatch | VmSnapshot must save/restore VirtualTsc (already fixed) |
| BPF tracepoint struct mismatch | Verify against `/sys/kernel/tracing/events/<subsys>/<event>/format` |
| bpftrace needs sudo | NixOS: `security.sudo.extraRules` with full nix store path |
| `CARGO_TARGET_DIR` set by nix | Build scripts must respect `$CARGO_TARGET_DIR` (defaults to `~/.cargo-target`) |
| AMD CPUs lack CPUID leaf 0x15 | VMM injects it for deterministic TSC calibration |
| Borrow conflicts with `&mut self` | Move `self.rand()` calls outside `&mut self.nodes[i]` borrow scope |
| HashMap non-determinism | Use BTreeMap in oracle and any determinism-critical code |

## Testing Patterns

### Unit Tests (no KVM needed)

```bash
cargo test                                    # All unit tests
cargo test -p chaoscontrol-fault              # Single crate
cargo test -p chaoscontrol-raft-guest --lib   # Lib tests only
cargo test -p chaoscontrol-vmm -- virtio      # Filter by name
```

### Integration Tests (require /dev/kvm + kernel)

```bash
cargo run --release --bin integration_test -- result-dev/vmlinux guest/initrd-sdk.gz
cargo run --release --bin sdk_guest_test -- result-dev/vmlinux guest/initrd-sdk.gz
```

### eBPF Trace Tests

```bash
nix develop --command bash -c "scripts/test-trace.sh"
```

### Raft Guest Tests

The `chaoscontrol-raft-guest` crate has a `lib.rs` with pure Raft logic
(no SDK deps) and ~78 tests covering all state transitions, safety invariants,
and determinism. Run with:

```bash
cargo test -p chaoscontrol-raft-guest --lib
```

## Verified Modules

Pure functions extracted for formal verification with Verus live in
`src/verified/` within the VMM and trace crates:

- `chaoscontrol-vmm/src/verified/cpu.rs` — TSC arithmetic, CPUID encoding
- `chaoscontrol-trace/src/verified/events.rs` — event determinism comparison
- `chaoscontrol-trace/src/verified/verifier.rs` — divergence detection

Pattern: pure function in `verified/`, imperative shell delegates to it.
Every verified function has `debug_assert!` preconditions and postconditions.
