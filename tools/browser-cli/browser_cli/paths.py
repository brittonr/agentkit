"""Path utilities for browser-cli."""

import os
from pathlib import Path


def get_socket_path() -> Path:
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        return Path(runtime_dir) / "browser-cli.sock"

    cache_home = os.environ.get("XDG_CACHE_HOME")
    if not cache_home:
        cache_home = str(Path.home() / ".cache")
    fallback_dir = Path(cache_home) / "browser-cli"
    fallback_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    fallback_dir.chmod(0o700)
    return fallback_dir / "browser-cli.sock"
