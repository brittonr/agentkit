---
name: clan
description: Clan CLI for infrastructure management. Use for machine operations, secrets, and vars.
capabilities:
  - execute
---

# Usage

```bash
# List all machines
clan machines list

# Deploy to a machine
clan machines update <machine-name>

# Manage secrets
clan secrets set <secret-name>
clan secrets get <secret-name>

# Generate vars/secrets for a machine
clan vars generate --machine <machine-name>

# Show clan help
clan --help
```

See https://docs.clan.lol/ for full documentation.
