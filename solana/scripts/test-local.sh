#!/usr/bin/env bash
# 本地全量测试（Windows Git Bash）
# 用法: bash scripts/test-local.sh
# 说明:
#  - 本机 solana-test-validator 直接由 `anchor test` 拉起时会因
#    validator.log 符号链接权限（os error 1314）崩溃，因此这里手动
#    以 --log 方式启动 validator，再跑 `anchor test --skip-local-validator`。
#  - C:/Users/tiger/bin/solana.exe 是一个 shim：剥离 anchor-cli 0.31
#    传给 solana-cli 1.18 不支持的 deploy 参数
#    （--with-compute-unit-price/--max-sign-attempts/--use-rpc）。
#  - platform-tools(v1.39) 工具链的 cargo 也是 shim，自动注入
#    --ignore-rust-version（rustc 1.72 编译 solana 2.x 依赖树所需）。
#  - 必须等 validator 出到 slot >= 1 再跑测试：getHealth 返回 ok 时
#    validator 可能还在处理 genesis（slot=0），此时 deploy / initializeConfig
#    会因系统程序 AccountAlreadyInUse（custom program error 0x0）失败。
#  - 跑完后会 taskkill validator；重跑前务必清账本（脚本已处理），否则
#    上次运行铸造的名称/账户残留会导致 NameTaken 等假失败。
set -e
cd "$(dirname "$0")/.."

cleanup() { taskkill //F //IM solana-test-validator.exe 2>/dev/null || true; }
trap cleanup EXIT

taskkill //F //IM solana-test-validator.exe 2>/dev/null || true
taskkill //F //IM solana.exe 2>/dev/null || true
sleep 4
rm -rf test-ledger

( solana-test-validator --reset --log \
    --rpc-port 8899 --faucet-port 9900 \
    --gossip-port 8001 --gossip-host 127.0.0.1 \
    > validator-stdout.log 2>&1 & )

# 等 slot >= 30（getHealth=ok 不够：genesis 后早期 slot 出块不稳，
# 立刻跑会出现 TransactionExpiredTimeoutError / Program is not deployed 等假失败）
for i in $(seq 1 90); do
  h=$(curl -s -m 2 -X POST http://127.0.0.1:8899 \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}')
  s=$(curl -s -m 2 -X POST http://127.0.0.1:8899 \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | grep -o '"result":[0-9]*' | grep -o '[0-9]*')
  if echo "$h" | grep -q '"ok"' && [ -n "$s" ] && [ "$s" -ge 30 ]; then
    echo "validator is warm (slot $s)"
    break
  fi
  sleep 2
done

export PATH="/c/Users/tiger/bin:$PATH"
anchor test --skip-local-validator
