#!/usr/bin/env bash
# testnet 冒烟测试：注册两件演示装备 -> 铸身份 -> 铸部件 -> 穿戴 -> 查询。
# 用法: ./scripts/smoke-test.sh <contract_account_id> [identity_name]
set -euo pipefail

CONTRACT_ID="${1:?usage: smoke-test.sh <contract_account_id> [identity_name]}"
NAME="${2:-smoke-$(date +%s)}"
NETWORK="${NETWORK:-testnet}"
SENDER="$(near config show network-config $NETWORK 2>/dev/null | grep -i account_id | awk '{print $2}')"
SENDER="${SENDER:-$CONTRACT_ID}"

call() {
  near contract call-function as-transaction "$CONTRACT_ID" "$1" \
    json-args "$2" prepaid-gas '30 Tgas' attached-deposit "${3:-0 NEAR}" \
    network-config "$NETWORK" sign-with-keychain send
}

view() {
  near contract call-function as-read-only "$CONTRACT_ID" "$1" \
    json-args "$2" network-config "$NETWORK" now
}

echo "== register parts =="
call register_part '{"part_id": "1001", "slot": 0, "rarity": 1, "max_supply": "100"}'
call register_part '{"part_id": "2001", "slot": 1, "rarity": 1, "max_supply": "100"}'

echo "== mint identity: $NAME =="
call mint_identity "{\"name\": \"$NAME\"}"

echo "== mint + equip parts =="
call mint_part "{\"to\": \"$SENDER\", \"part_id\": \"1001\", \"amount\": \"1\"}"
TOKEN_ID=$(view get_identity_by_owner "{\"account_id\": \"$SENDER\"}" | python -c "import sys,json; print(json.loads(sys.stdin.read())['token_id'])")
call equip "{\"token_id\": \"$TOKEN_ID\", \"part_id\": \"1001\", \"slot\": 0}"

echo "== identity =="
view get_identity "{\"token_id\": \"$TOKEN_ID\"}"
