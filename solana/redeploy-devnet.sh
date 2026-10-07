#!/usr/bin/env bash
# 后台任务：等待领水 -> 部署 tinyworld 到 devnet -> 验证
set -x
export PATH="/c/Users/tiger/bin:$PATH"
KEYPAIR="/c/Users/tiger/.config/solana/id.json"
PROG_KEY="/d/agent/tinyworld/solana/target/deploy/tinyworld-keypair.json"
SO="/d/agent/tinyworld/solana/target/deploy/tinyworld.so"
PROG_ID="5JEXwXv9VqiKnokZ8sRVkxM4ws6BwHcFH67rL3YKhVKp"

need_sol=3
for i in $(seq 1 20); do
  bal=$(solana balance --url devnet 2>/dev/null | awk '{print $1}')
  echo "attempt $i, balance=$bal"
  awk "BEGIN{exit !($bal >= $need_sol)}" 2>/dev/null && break
  solana airdrop 2 --url devnet
  sleep 480
done

bal=$(solana balance --url devnet 2>/dev/null | awk '{print $1}')
awk "BEGIN{exit !($bal >= 1)}" 2>/dev/null || { echo "AIRDROP_FAILED balance=$bal"; exit 1; }

echo "=== deploying ==="
solana program deploy "$SO" --program-id "$PROG_KEY" --url devnet
echo "=== verify ==="
solana program show "$PROG_ID" --url devnet | head -10
echo "DEPLOY_DONE"
