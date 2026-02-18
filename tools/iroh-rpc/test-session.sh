#!/usr/bin/env bash
# Simple test session demonstrating iroh-rpc

set -e

BINARY="${1:-./result/bin/iroh-rpc}"

if [ ! -f "$BINARY" ]; then
    echo "Binary not found: $BINARY"
    echo "Usage: $0 [path-to-binary]"
    exit 1
fi

echo "=== Testing iroh-rpc ==="
echo

# Start daemon in background and pipe commands to it
{
    echo '{"id":"1","type":"status"}'
    sleep 1
    echo '{"id":"2","type":"peers"}'
    sleep 1
    echo '{"id":"3","type":"shutdown"}'
} | $BINARY 2>&1 | grep -E '^{' | jq .

echo "Commands:"
echo "  1. status"
echo "  2. peers"
echo "  3. shutdown"

echo
echo "=== Test complete ==="
