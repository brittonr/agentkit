---
name: integration-testing-vms
description: |
  Write and run NixOS VM integration tests using testers.runNixOSTest.
  Use when creating multi-machine test scenarios, testing NixOS configurations,
  or debugging VM-based integration tests with QEMU.
---

# NixOS VM Integration Testing

Write reproducible integration tests for NixOS configurations using
`testers.runNixOSTest` (or `pkgs.nixosTest`) and QEMU virtual machines.

## Core Pattern

```nix
let
  nixpkgs = fetchTarball "https://github.com/NixOS/nixpkgs/tarball/nixos-24.11";
  pkgs = import nixpkgs { config = {}; overlays = []; };
in

pkgs.testers.runNixOSTest {
  name = "test-name";
  nodes = {
    machine1 = { config, pkgs, ... }: {
      # NixOS configuration
    };
    machine2 = { config, pkgs, ... }: {
      # NixOS configuration
    };
  };
  testScript = { nodes, ... }: ''
    # Python test script — machines accessible by node name
  '';
}
```

### Required attributes

| Attribute | Description |
|-----------|-------------|
| `name` | Descriptive test name |
| `nodes` | Set of named NixOS configurations (each becomes a VM) |
| `testScript` | Python script (string or function taking `{ nodes, ... }`) |

### Optional attributes

| Attribute | Description |
|-----------|-------------|
| `system` | Target system type, e.g. `"x86_64-linux"` |
| `skipLint` | Set `true` to disable Python linting of testScript |

## Running Tests

```bash
# Build and run
nix-build my-test.nix

# Interactive Python shell (for debugging)
$(nix-build -A driverInteractive my-test.nix)/bin/nixos-test-driver
```

### Interactive shell commands

```python
start_all()                # Start all VMs
machine.start()            # Start a specific VM
machine.shell_interact()   # Drop into a shell on the VM
test_script()              # Run the full testScript
join_all()                 # Keep all VMs alive (use after start_all)
```

### Debugging with nix repl

```bash
nix repl ./nixos/tests/login.nix
# Then inspect: driver.outPath
```

### Re-running cached tests

Successful tests are cached in the Nix store. To force re-run:

```bash
result=$(readlink -f ./result) rm ./result && nix-store --delete $result
```

## Python Test API (machine objects)

Each node name becomes a Python object with these methods:

```python
machine.wait_for_unit("default.target")          # Wait for systemd unit
machine.succeed("command")                        # Run command, assert exit 0
machine.fail("command")                           # Run command, assert non-zero exit
machine.wait_for_open_port(80)                    # Wait for TCP port
machine.wait_until_succeeds("cmd")               # Retry command until exit 0
machine.sleep(N)                                  # Sleep N seconds
machine.screenshot("name")                        # Save screenshot (in result dir)
machine.shell_interact()                          # Interactive shell (debug only)
```

Test script has superuser rights in VMs. Use `su -- user -c 'cmd'` to run as
a specific user. Full Python is available — import `json`, `sys`, use
assertions, etc.

## Patterns

### Shared modules across nodes

Extract common config into a module to avoid duplication:

```nix
let
  sharedModule = {
    virtualisation.graphics = false;  # headless — good for CI
  };
in
pkgs.testers.runNixOSTest {
  nodes.server = { imports = [ sharedModule ]; /* ... */ };
  nodes.client = { imports = [ sharedModule ]; /* ... */ };
  # ...
}
```

### testScript as function (access node config)

When `testScript` is a function, it receives `{ nodes, ... }` to access
evaluated NixOS config values:

```nix
testScript = { nodes, ... }: let
  user = nodes.machine.config.users.users.alice;
  uid = toString user.uid;
in ''
  machine.succeed("id -u ${user.name} | grep ${uid}")
'';
```

### Python assertions in testScript

```nix
testScript = ''
  import json

  start_all()
  server.wait_for_open_port(3000)

  actual = json.loads(client.succeed("curl http://server:3000/todos"))
  expected = [{"id": 1, "done": False, "task": "example", "due": None}]
  assert expected == actual, f"unexpected response: {actual}"
'';
```

### Headless / CI configuration

Disable graphics when running without a display:

```nix
virtualisation.graphics = false;
```

## Examples

### Single machine — user package access

```nix
pkgs.testers.runNixOSTest {
  name = "minimal-test";

  nodes.machine = { config, pkgs, ... }: {
    users.users.alice = {
      isNormalUser = true;
      extraGroups = [ "wheel" ];
      packages = with pkgs; [ firefox tree ];
    };
    system.stateVersion = "24.11";
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.succeed("su -- alice -c 'which firefox'")
    machine.fail("su -- root -c 'which firefox'")
  '';
}
```

### Multi-machine — client/server (nginx)

```nix
pkgs.testers.runNixOSTest {
  name = "client-server-test";

  nodes.server = { pkgs, ... }: {
    networking.firewall.allowedTCPPorts = [ 80 ];
    services.nginx = {
      enable = true;
      virtualHosts."server" = {};
    };
  };

  nodes.client = { pkgs, ... }: {
    environment.systemPackages = with pkgs; [ curl ];
  };

  testScript = ''
    server.wait_for_unit("default.target")
    client.wait_for_unit("default.target")
    client.succeed("curl http://server/ | grep -o \"Welcome to nginx!\"")
  '';
}
```

### Multi-machine — PostgreSQL + PostgREST with Python assertions

```nix
let
  database      = "postgres";
  schema        = "api";
  table         = "todos";
  username      = "authenticator";
  password      = "mysecretpassword";
  postgrestPort = 3000;

  sharedModule = { virtualisation.graphics = false; };
in
pkgs.testers.runNixOSTest {
  name = "postgres-test";
  skipLint = true;

  nodes.server = { config, pkgs, ... }: {
    imports = [ sharedModule ];
    networking.firewall.allowedTCPPorts = [ postgrestPort ];
    services.postgresql = {
      enable = true;
      initialScript = pkgs.writeText "init.sql" ''
        create schema ${schema};
        create table ${schema}.${table} (
          id serial primary key,
          done boolean not null default false,
          task text not null,
          due timestamptz
        );
        insert into ${schema}.${table} (task) values ('finish tutorial');
        create role web_anon nologin;
        grant usage on schema ${schema} to web_anon;
        grant select on ${schema}.${table} to web_anon;
        create role ${username} inherit login password '${password}';
        grant web_anon to ${username};
      '';
    };
    systemd.services.postgrest = {
      wantedBy = [ "multi-user.target" ];
      after = [ "postgresql.service" ];
      script = let
        conf = pkgs.writeText "postgrest.conf" ''
          db-uri = "postgres://${username}:${password}@localhost:${toString config.services.postgresql.settings.port}/${database}"
          db-schema = "${schema}"
          db-anon-role = "${username}"
        '';
      in "${pkgs.haskellPackages.postgrest}/bin/postgrest ${conf}";
      serviceConfig.User = username;
    };
    users.users."${username}".isSystemUser = true;
  };

  nodes.client = { imports = [ sharedModule ]; };

  testScript = ''
    import json
    start_all()
    server.wait_for_open_port(${toString postgrestPort})
    actual = json.loads(
      client.succeed("curl http://server:${toString postgrestPort}/${table}")
    )
    assert actual[0]["task"] == "finish tutorial"
  '';
}
```

### Wayland application testing (GNOME + Firefox)

Testing Wayland apps requires autologin, autostart, GNOME unsafe mode for
the Eval API, and dbus queries to detect open windows.

Key configuration pieces:

```nix
nodes.machine = { pkgs, ... }: {
  # Desktop with autologin
  services.xserver.enable = true;
  services.xserver.displayManager.gdm.enable = true;
  services.xserver.desktopManager.gnome.enable = true;
  services.xserver.displayManager.autoLogin.enable = true;
  services.xserver.displayManager.autoLogin.user = "alice";

  users.users.alice = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    uid = 1000;  # Pin UID for dbus path
  };

  # Auto-start the application after login
  environment.systemPackages = [
    (pkgs.makeAutostartItem {
      name = "firefox";
      package = pkgs.firefox;
    })
  ];

  # Enable gnome-shell Eval API (unsafe mode)
  systemd.user.services."org.gnome.Shell@wayland" = {
    serviceConfig.ExecStart = [
      ""  # Clear default ExecStart
      "${pkgs.gnome.gnome-shell}/bin/gnome-shell --unsafe-mode"
    ];
  };
};
```

Query open windows via GNOME dbus in testScript:

```nix
testScript = { nodes, ... }: let
  user = nodes.machine.config.users.users.alice;
  bus = "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${toString user.uid}/bus";
  gdbus = "${bus} gdbus";
  su = command: "su - ${user.name} -c '${command}'";
  gseval = "call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval";
  wmClass = su "${gdbus} ${gseval} global.display.focus_window.wm_class";
in ''
  machine.wait_until_succeeds("${wmClass} | grep -q 'firefox'")
  machine.sleep(20)
  machine.screenshot("screen")
'';
```

## Troubleshooting

- **QEMU window pitch black / no prompt:** Check output for `malformed JSON string` errors. Purge VM state: `rm -rf /tmp/vm-state-<VM_NAME>`
- **`virtualisation.vlans` not creating expected interfaces:** (1) Override `virtualisation.qemu.networkingOptions` to remove the default `user` NIC. (2) Interfaces start from `eth1`, not `eth0`.
- **Test won't re-run:** Results are cached. See "Re-running cached tests" above.

## CI Notes

- VM tests require hardware acceleration (KVM). Many CIs lack this.
- Set `virtualisation.graphics = false;` in nodes for headless environments.
- For GitHub Actions, see [cachix/install-nix-action](https://github.com/cachix/install-nix-action#how-do-i-run-nixos-tests) to disable hardware acceleration.
- Tests run on any Linux machine, not just NixOS.

## References

- [NixOS test options](https://nixos.org/manual/nixos/stable/index.html#sec-test-options-reference)
- [Machine object methods](https://nixos.org/manual/nixos/stable/index.html#ssec-machine-objects)
- [NixOS test examples in nixpkgs](https://github.com/NixOS/nixpkgs/tree/master/nixos/tests)
- [Matrix/IRC bridge test](https://github.com/NixOS/nixpkgs/blob/master/nixos/tests/matrix/appservice-irc.nix) — good complex example
- [QEMU monitor sendkey reference](https://en.wikibooks.org/wiki/QEMU/Monitor#sendkey_keys)
