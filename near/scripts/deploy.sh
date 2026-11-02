#!/usr/bin/env bash
# 构建并部署 TinyWorld NEAR 合约到 testnet。
# 用法: ./scripts/deploy.sh <contract_account_id> [network=testnet]
set -euo pipefail

cd "$(dirname "$0")/.."
CONTRACT_ID="${1:?usage: deploy.sh <contract_account_id> [network]}"
NETWORK="${2:-testnet}"

cargo build --target wasm32-unknown-unknown --release
WASM="target/wasm32-unknown-unknown/release/tinyworld_near.wasm"

echo "deploying $WASM to $CONTRACT_ID ($NETWORK) ..."
near contract deploy "$CONTRACT_ID" use-file "$WASM" \
  with-init-call new json-args "{\"owner_id\": \"$CONTRACT_ID\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-keychain send

echo "done. verify with:"
echo "  near contract call-function as-read-only $CONTRACT_ID nft_metadata json-args '{}' network-config $NETWORK now"
