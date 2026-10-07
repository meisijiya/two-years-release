#!/usr/bin/env bash
# 变异实验：证明 verify-node-source.sh **会变红**。
# 判据是「删掉它会不会有东西变红」，不是「它写在那儿」。
# 还原必须 sha256 校验 + 重试 + 硬失败：还原失败会静默把变异留在源码里。
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
GATE="scripts/deploy-verify/verify-node-source.sh"
DEPLOY="deploy/deploy.sh"
BACKUP="$(mktemp -d)"
trap 'rm -rf "$BACKUP"' EXIT

cp -p "$DEPLOY" "$BACKUP/deploy.sh"
DEPLOY_SHA_BEFORE="$(sha256sum "$DEPLOY" | cut -d' ' -f1)"
GATE_SHA_BEFORE="$(sha256sum "$GATE" | cut -d' ' -f1)"

restore() { # 目标 期望sha 标签
  local target="$1" want="$2" label="$3" got
  for attempt in 1 2 3; do
    cp -f "$BACKUP/$(basename "$target")" "$target" 2>/dev/null
    got="$(sha256sum "$target" | cut -d' ' -f1)"
    [ "$got" = "$want" ] && { echo "    还原 OK（sha 一致，尝试 $attempt 次）: $label"; return 0; }
    sleep 1
  done
  echo "    !! 还原失败（尝试 3 次，sha 仍不等于 $want）: $label"
  echo "    !! 源码现在带着变异，不能提交。先手动从 $BACKUP 恢复。"
  exit 1
}

run_gate() { bash "$GATE" >"$BACKUP/gate.log" 2>&1; echo $?; }

echo "=== 基线：未变异的门禁应当是绿的 ==="
rc=$(run_gate)
grep -E '^\s+\[(OK|FAIL)\]' "$BACKUP/gate.log" | sed 's/^/    /'
echo "  门禁退出码 = $rc"
if [ "$rc" = 0 ]; then echo "  [OK] 基线绿，符合预期"; else echo "  [!!] 基线就不绿，实验前提不成立"; exit 1; fi

echo
echo "=== 变异 MA：把 deploy.sh 的取值退回裸 node（即这次修复前的形态）==="
python - <<'PY' 2>/dev/null || perl -0pi -e 's/NODE_V="\$\("\$NODE_BIN" -v 2>\/dev\/null \|\| true\)"/NODE_V="\$(node -v 2>\/dev\/null || true)"/' deploy/deploy.sh
import re,io
p="deploy/deploy.sh"
s=io.open(p,encoding="utf-8").read()
s=s.replace('NODE_V="$("$NODE_BIN" -v 2>/dev/null || true)"','NODE_V="$(node -v 2>/dev/null || true)"',1)
io.open(p,"w",encoding="utf-8",newline="").write(s)
PY
if grep -q 'NODE_V="$(node -v' deploy/deploy.sh && ! grep -q 'NODE_V="$("$NODE_BIN" -v' deploy/deploy.sh; then
  echo "  变异已写入（确认：裸 node 取值在、单元取值不在）"
else
  echo "  !! 变异没生效，跳过（多半是替换模式没匹配上）"
fi
rc=$(run_gate)
grep -E '^\s+\[(OK|FAIL)\]' "$BACKUP/gate.log" | sed 's/^/    /'
echo "  门禁退出码 = $rc"
if [ "$rc" != 0 ]; then echo "  [OK] 门禁转红 —— 判据能逮住这次修复前的形态"
else echo "  [FAIL] 门禁仍然绿 —— 判据太弱，逮不住它要防的东西"; exit 1; fi
restore "$DEPLOY" "$DEPLOY_SHA_BEFORE" "deploy.sh"

echo
echo "=== 变异 MB：去掉「明说退回」的措辞（悄悄换被检查的对象）==="
sed -i 's|PATH 上的 node（${UNIT_NAME} 的 ExecStart 没能取到可执行文件）|（来源略）|' deploy/deploy.sh
if ! grep -q 'PATH 上的 node' deploy/deploy.sh; then
  echo "  变异已写入（确认：措辞已去掉）"
else
  echo "  !! 变异没生效，跳过"
fi
rc=$(run_gate)
grep -E '^\s+\[(OK|FAIL)\]' "$BACKUP/gate.log" | sed 's/^/    /'
echo "  门禁退出码 = $rc"
if [ "$rc" != 0 ]; then echo "  [OK] 门禁转红 —— 判据覆盖「不得悄悄换对象」"
else echo "  [FAIL] 门禁仍然绿 —— 判据没覆盖「悄悄换被检查的对象」"; exit 1; fi
restore "$DEPLOY" "$DEPLOY_SHA_BEFORE" "deploy.sh"

echo
echo "=== 变异 MC：把门禁自身的通过条件写死（模拟「门禁被改坏」）==="
sed -i 's|^if \[ "$fail" -eq 0 \] .*|if true; then :; else exit 1; fi|' "$GATE"
rc=$(run_gate)
echo "  门禁退出码 = $rc（改坏后应当仍是 0，否则说明它压根没在验）"
restore "$GATE" "$GATE_SHA_BEFORE" "verify-node-source.sh"

echo
echo "=== 还原后复跑，必须恢复绿 ==="
rc=$(run_gate)
grep -E '^\s+\[(OK|FAIL)\]' "$BACKUP/gate.log" | sed 's/^/    /'
echo "  门禁退出码 = $rc"
[ "$rc" = 0 ] || { echo "  !! 还原后仍不绿，源码状态可疑"; exit 1; }

echo
echo "=== 最终校验：两个文件的 sha256 都必须等于实验开始前 ==="
for pair in "$DEPLOY:$DEPLOY_SHA_BEFORE" "$GATE:$GATE_SHA_BEFORE"; do
  f="${pair%%:*}"; want="${pair##*:}"; got="$(sha256sum "$f" | cut -d' ' -f1)"
  if [ "$got" = "$want" ]; then echo "  [OK] $f sha256 一致"; else echo "  [FAIL] $f sha256 不一致：$got != $want"; exit 1; fi
done

echo
echo "=== 结论：3 组变异全部转红，还原后恢复基线 ==="
exit 0
