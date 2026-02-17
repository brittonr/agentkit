# vLLM Deployment Plan: ArliAI/gpt-oss-120b-Derestricted on aspen1

**Created:** 2026-01-14
**Target Machine:** aspen1 (AMD Ryzen AI MAX+ 395 with Radeon 8060S)
**Model:** ArliAI/gpt-oss-120b-Derestricted

---

## Executive Summary

This plan outlines deploying a 120B parameter MoE (Mixture of Experts) model on aspen1, which features the AMD Strix Halo APU with up to 128GB unified memory. The model uses MXFP4 quantization and only activates 5.1B parameters per inference, making it feasible on this hardware.

---

## 1. Hardware Analysis

### aspen1 Specifications
| Component | Value |
|-----------|-------|
| CPU | AMD Ryzen AI MAX+ 395 |
| GPU | AMD Radeon 8060S (gfx1151) |
| Memory | 128GB LPDDR5X unified memory |
| Storage | Samsung SSD 990 PRO 4TB |
| Architecture | Strix Halo APU |
| ROCm Target | gfx1151 |

### Model Requirements
| Metric | Value |
|--------|-------|
| Total Parameters | 117B |
| Active Parameters | 5.1B (MoE sparse) |
| Quantization | MXFP4 |
| Minimum VRAM | 80GB (single H100) |
| Estimated on Strix Halo | ~85-95GB GTT allocation |

### Compatibility Assessment

**VERDICT: FEASIBLE WITH CAVEATS**

The Strix Halo can allocate ~115-120GB of unified memory as GPU GTT (Graphics Translation Table), which exceeds the model's ~80GB requirement. However:

1. ROCm support is immature (use ROCm 7.0 or TheRock nightlies)
2. Kernel 6.16.9+ required for full memory visibility
3. Known instability after extended inference sessions
4. vLLM requires the `gptoss` build variant

---

## 2. Required System Changes

### A. Kernel Boot Parameters

Add to `/etc/default/grub` (handled via NixOS):
```
amd_iommu=off amdgpu.gttsize=117760
```

- `amd_iommu=off`: ~6% memory read improvement
- `amdgpu.gttsize=117760`: Allocates ~115GB for GPU compute

### B. NixOS Configuration Changes

```nix
# machines/aspen1/configuration.nix additions
{
  boot.kernelParams = [
    "amd_iommu=off"
    "amdgpu.gttsize=117760"  # ~115GB for GPU
  ];

  # Ensure kernel version >= 6.16.9
  boot.kernelPackages = pkgs.linuxPackages_latest;

  # udev rules for GPU access
  services.udev.extraRules = ''
    SUBSYSTEM=="kfd", GROUP="render", MODE="0666"
    SUBSYSTEM=="drm", KERNEL=="card[0-9]*", GROUP="render", MODE="0666"
    SUBSYSTEM=="drm", KERNEL=="renderD[0-9]*", GROUP="render", MODE="0666"
  '';
}
```

### C. ROCm Environment Updates

The existing `inventory/tags/amd-gpu.nix` needs enhancement:

```nix
# Additional environment variables for vLLM
environment.variables = {
  HSA_ENABLE_SDMA = "0";  # Stability improvement
  HSA_OVERRIDE_GFX_VERSION = "11.5.1";  # Ensure gfx1151 is recognized
  PYTORCH_ROCM_ARCH = "gfx1151";
};
```

---

## 3. vLLM Service Configuration

### Option A: Use Existing LLM Module

Update `/home/brittonr/git/onix-core/inventory/services/llm.nix`:

```nix
{
  instances = {
    "llm" = {
      module.name = "llm";
      module.input = "self";

      roles.server = {
        tags."llm" = { };
        settings = {
          serviceType = "vllm";
          port = 8000;
          host = "0.0.0.0";
          enableGPU = true;
          model = "ArliAI/gpt-oss-120b-Derestricted";

          extraArgs = [
            "--max-model-len" "4096"
            "--gpu-memory-utilization" "0.85"
            "--max-num-seqs" "4"
            "--tensor-parallel-size" "1"
            "--enforce-eager"  # Required for ROCm stability
          ];
        };
      };
    };
  };
}
```

### Option B: Create Dedicated Instance

Create `/home/brittonr/git/onix-core/inventory/services/llm-gptoss.nix`:

```nix
_: {
  instances = {
    "llm-gptoss" = {
      module.name = "llm";
      module.input = "self";

      roles.server = {
        machines."aspen1" = { };  # Direct machine assignment
        settings = {
          serviceType = "vllm";
          port = 8000;
          host = "0.0.0.0";
          enableGPU = true;
          model = "ArliAI/gpt-oss-120b-Derestricted";

          extraArgs = [
            "--max-model-len" "4096"
            "--gpu-memory-utilization" "0.85"
            "--max-num-seqs" "4"
            "--enforce-eager"
            "--dtype" "bfloat16"
          ];
        };
      };
    };
  };
}
```

---

## 4. LLM Module Enhancements

The current `modules/llm/default.nix` needs updates for ROCm:

### Required Changes

```nix
# In systemd.services.vllm definition
environment = lib.mkMerge [
  (lib.mkIf enableGPU {
    CUDA_VISIBLE_DEVICES = "0";  # NVIDIA
  })
  {
    # ROCm/HIP environment
    HSA_ENABLE_SDMA = "0";
    HIP_VISIBLE_DEVICES = "0";
    PYTORCH_ROCM_ARCH = "gfx1151";
    HSA_OVERRIDE_GFX_VERSION = "11.5.1";
  }
];

serviceConfig = {
  # Add GPU group access
  SupplementaryGroups = [ "render" "video" ];

  # Increase memory limits
  MemoryMax = "infinity";

  # Device access
  DeviceAllow = [
    "/dev/kfd rw"
    "/dev/dri/renderD128 rw"
    "/dev/dri/card0 rw"
  ];
};
```

### vLLM Package Override

The standard nixpkgs vLLM may not have gptoss support. Options:

1. **Build from source** with gptoss patches
2. **Use OCI container** with pre-built vLLM
3. **Nix overlay** for custom vLLM build

---

## 5. Deployment Steps

### Phase 1: System Preparation (Day 1)

1. Update boot parameters in `machines/aspen1/configuration.nix`
2. Ensure kernel 6.16+ is installed
3. Add udev rules for GPU access
4. Deploy: `clan machines update aspen1`
5. Reboot aspen1
6. Verify GTT allocation: `cat /sys/class/drm/card*/device/mem_info_gtt_total`

### Phase 2: ROCm Validation (Day 1-2)

1. SSH to aspen1
2. Run `rocminfo` - verify gfx1151 detected
3. Run `rocm-smi` - verify GPU monitoring works
4. Test HIP: `hipconfig --check`
5. Check memory: expect ~115GB available

### Phase 3: vLLM Setup (Day 2-3)

**Option A: Native NixOS**
1. Update llm module with ROCm support
2. Configure service instance
3. Deploy: `clan machines update aspen1`
4. Monitor: `journalctl -u vllm -f`

**Option B: Container (Recommended for stability)**
```bash
# On aspen1
podman run -d \
  --name vllm-gptoss \
  --device /dev/kfd \
  --device /dev/dri \
  -p 8000:8000 \
  -v /var/lib/vllm/models:/models \
  -e HSA_ENABLE_SDMA=0 \
  -e HIP_VISIBLE_DEVICES=0 \
  rocm/vllm:latest \
  vllm serve ArliAI/gpt-oss-120b-Derestricted \
    --host 0.0.0.0 \
    --port 8000 \
    --max-model-len 4096 \
    --gpu-memory-utilization 0.85 \
    --enforce-eager
```

### Phase 4: Validation (Day 3)

```bash
# Test inference endpoint
curl http://aspen1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ArliAI/gpt-oss-120b-Derestricted",
    "messages": [{"role": "user", "content": "Hello, world!"}]
  }'
```

---

## 6. Performance Expectations

Based on Strix Halo benchmarks:

| Metric | Expected Value |
|--------|---------------|
| Context Loading | 30-60 seconds |
| Throughput | 10-20 tok/s |
| First Token Latency | 2-5 seconds |
| Max Context | 4096 tokens (conservative) |
| Max Concurrent | 2-4 requests |

### Optimization Options

1. **Reduce context**: `--max-model-len 2048` for faster responses
2. **Limit concurrency**: `--max-num-seqs 2` for stability
3. **Memory tuning**: `--gpu-memory-utilization 0.80` if instability occurs

---

## 7. Monitoring and Alerting

### Add to Prometheus Config

```nix
# In prometheus service configuration
scrapeConfigs = [
  {
    job_name = "vllm";
    static_configs = [{
      targets = [ "aspen1:8000" ];
    }];
    metrics_path = "/metrics";
  }
];
```

### Key Metrics to Watch

- `vllm_num_requests_running` - active inference requests
- `vllm_gpu_cache_usage_percent` - KV cache utilization
- `vllm_num_generation_tokens_total` - throughput
- `amd_gpu_utilization_percent` - GPU compute usage
- `amd_gpu_memory_utilization_percent` - GTT usage

---

## 8. Known Issues and Mitigations

| Issue | Mitigation |
|-------|------------|
| ROCm memory visibility limited to 15GB | Kernel 6.16.9+ required |
| Instability after 4-5 conversation turns | Implement request queuing, periodic service restart |
| vLLM ROCm build missing gptoss | Use container or build from source |
| High memory pressure | Limit concurrent requests, reduce context |
| Slow model loading | Pre-download model, use `--no-mmap` equivalent |

### Stability Watchdog

```nix
# Add to systemd service
serviceConfig = {
  WatchdogSec = "300";  # 5 minute watchdog
  Restart = "always";
  RestartSec = "30";

  # Auto-restart after X requests
  ExecStartPost = "${pkgs.writeShellScript "vllm-monitor" ''
    # Monitor and restart if needed
  ''}";
};
```

---

## 9. Rollback Strategy

1. **Service Level**: `systemctl stop vllm` on aspen1
2. **Configuration Level**: Revert to ollama: change `serviceType = "ollama"` in inventory
3. **Full Rollback**: `clan machines update aspen1` with previous config
4. **Emergency**: Boot previous NixOS generation from GRUB

---

## 10. Security Considerations

1. **Network**: vLLM binds to 0.0.0.0 - ensure Tailscale-only access
2. **Model**: ArliAI/gpt-oss-120b-Derestricted has removed safety filters
3. **API**: No authentication by default - add reverse proxy or API gateway
4. **GPU Access**: Service runs with render/video group permissions

### Recommended: Add Traefik Reverse Proxy

```nix
# Route through existing traefik setup
services.traefik.dynamicConfigOptions.http = {
  routers.vllm = {
    rule = "Host(`llm.aspen1.local`)";
    service = "vllm";
    middlewares = [ "auth" ];
  };
  services.vllm.loadBalancer.servers = [
    { url = "http://127.0.0.1:8000"; }
  ];
};
```

---

## 11. Alternative Approaches

### A. Use llama.cpp Instead of vLLM

More stable on ROCm, but lower throughput:

```bash
llama-cli -m /models/gpt-oss-120b.gguf \
  --no-mmap -ngl 99 \
  --ctx-size 4096 \
  --server --host 0.0.0.0 --port 8080
```

### B. Hybrid Deployment

- vLLM for high-throughput batch inference
- llama.cpp for interactive chat (more stable)

### C. Cloud Fallback

If local stability is insufficient:
- Use Tailscale exit node to cloud vLLM instance
- Configure client to fallback automatically

---

## 12. Success Criteria

- [ ] aspen1 boots with 115GB GTT allocation
- [ ] ROCm detects gfx1151 GPU
- [ ] vLLM loads ArliAI/gpt-oss-120b-Derestricted
- [ ] API responds to inference requests
- [ ] Prometheus metrics available
- [ ] Stable operation for 1 hour continuous use
- [ ] Response latency under 5 seconds TTFT

---

## References

- [vLLM Documentation](https://docs.vllm.ai/en/stable/)
- [Strix Halo LLM Setup Guide](https://github.com/Gygeek/Framework-strix-halo-llm-setup)
- [ArliAI gpt-oss-120b-Derestricted](https://huggingface.co/ArliAI/gpt-oss-120b-Derestricted)
- [ROCm Compatibility Matrix](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html)
- [GPT-OSS Deployment Guide](https://simplismart.ai/blog/deploy-gpt-oss-120b-h100-vllm)
- [Phoronix ROCm 7.0 Strix Halo Benchmarks](https://www.phoronix.com/review/amd-rocm-7-strix-halo)
