---
name: cloud
description: Cloud infrastructure management via OpenTofu/Terranix. Use for AWS infrastructure provisioning.
capabilities:
  - execute
---

# Usage

```bash
# Show current infrastructure status
cloud status

# Create/update infrastructure
cloud create

# Destroy infrastructure
cloud destroy
```

Requires AWS credentials in `.env` file (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY). Uses Terranix to generate Terraform configs and OpenTofu to apply them.
