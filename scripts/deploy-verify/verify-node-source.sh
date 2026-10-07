#!/usr/bin/env bash
#
# 验 deploy.sh 的 node 守卫：**被检查的对象**必须与**真正执行的对象**是同一个。
#
# ⚠️ 为什么这道门禁存在（2026-10-04 真机实测挖出来的）
#
#    deploy.sh 早先查的是 PATH 上的裸 `node`。而目标机器的 PATH 上是系统 Node
#    **v20**，unit 里写死的却是 **/opt/node24/bin/node**（v24）—— 原因就写在
#    two-years.service 里：同机还跑着别的项目用系统 Node，不能升级它。
#    后果不是「少查了一项」，是**部署脚本恒定拒绝它自己要部署的那台机器**：
#    真机 dry-run 实测 `!! node 主版本要 ≥ 22，现在是 v20.20.2`，退出码 1；
#    同一份脚本只要把 /opt/node24/bin 加进 PATH 才退出 0。
#
#    为什么 `npm run verify` 逮不到：开发机的 node 本来就够新，
#    无论查 PATH 还是查单元，结论都是「过」。**出问题的形态在开发机上不存在。**
#    所以这里不能靠真实 node，必须造一个「说自己是 v20 的假 node」当夹具。
#
# 判据不是语法，是行为：每组都真跑一遍 deploy.sh 的 dry-run，看退出码。
# 故意**不**加 set -u：真部署里变量名写错会展开成空串、部署照常成功退出，
# 而 -u 会让验证脚本自己先死，把真正要防的失效模式测不出来。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_SH="${REPO_ROOT}/deploy/deploy.sh"
UNIT_SRC="${REPO_ROOT}/deploy/two-years.service"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
# 两个 helper 都**自己校验参数个数**。少了参数就在这里当场退出，
# 而不是让 printf 打出一个空值、然后照常 pass++ —— 那正是「结论行不是由失败
# 标志推导」的形状：断言看起来成立了，其实什么都没验。
# 同样地，ok/bad 的通过与否只由匹配到的那条判据决定，不接受「顺手就算过」。
ok()   { [ "$#" -eq 2 ] || { echo "  [脚本自身出错] ok() 需要 2 个参数，收到 $# 个" >&2; exit 99; }
         printf '  [OK]   %-46s %s\n' "$1" "$2"; pass=$((pass+1)); }
bad()  { [ "$#" -eq 3 ] || { echo "  [脚本自身出错] bad() 需要 3 个参数，收到 $# 个" >&2; exit 99; }
         printf '  [FAIL] %-46s %s（期望 %s）\n' "$1" "$2" "$3"; fail=$((fail+1)); }

# 造一个假的 node：`-v` 打印指定版本，别的什么都不做。
# deploy.sh 在 dry-run 里只调 `node -v`，所以这样足够真实。
make_fake_node() { # 目录 版本串
  mkdir -p "$1"
  cat > "$1/node" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-v" ]; then echo "$2"; exit 0; fi
exit 0
EOF
  chmod +x "$1/node"
}

# 铺一个最小仓库：deploy/ + src/server.js + public/index.html
# deploy.sh 的 REPO_DIR 是从 BASH_SOURCE 往上两级推出来的，所以这三样必须齐。
make_repo() { # 根目录 单元里的ExecStart
  local root="$1" execstart="$2"
  mkdir -p "$root/deploy" "$root/src" "$root/public"
  cp "$DEPLOY_SH" "$root/deploy/deploy.sh"
  cp "$UNIT_SRC" "$root/deploy/two-years.service"
  sed -i "s|^ExecStart=.*|ExecStart=$execstart|" "$root/deploy/two-years.service"
  # deploy.sh:101 会 grep 这个字面量来确认默认绑定是回环
  printf 'const HOST = process.env.HOST || "127.0.0.1";\n' > "$root/src/server.js"
  printf '<!doctype html>\n' > "$root/public/index.html"
}

run_deploy() { # 根目录 fake-node目录 -> 打印退出码
  local root="$1" fake="$2" rc
  ( cd "$root" \
    && PATH="${fake}:${PATH}" \
    DOOR_PASSWORD=11111111 HERO_PASSWORD=22222202 OBSERVER_PASSWORD=observe-9 \
    APP_DIR=/opt/two-years DATA_DIR=/opt/two-years/data \
    bash deploy/deploy.sh >"$WORK/out.log" 2>&1 )
  rc=$?
  LAST_LOG="$WORK/out.log"
  return $rc
}

echo "=== node 守卫：被检查的对象必须等于被执行的对象 ==="

# ── 夹具 1：PATH 上是 v20，单元指 v24（目标机器的真实形态）──────────
echo "[1] PATH=v20，单元=/opt/node24/bin/node —— 期望放行（退出码 0）"
make_fake_node "$WORK/fake20" "v20.20.2"
make_fake_node "$WORK/fake24" "v24.4.0"
mkdir -p "$WORK/opt/node24/bin" && cp "$WORK/fake24/node" "$WORK/opt/node24/bin/node"
make_repo "$WORK/r1" "$WORK/opt/node24/bin/node"
run_deploy "$WORK/r1" "$WORK/fake20"; rc=$?
if [ "$rc" = 0 ]; then ok "PATH 旧 / 单元新 → 放行" "$rc"
else bad "PATH 旧 / 单元新 → 放行" "$rc" 0; sed -n '1,6p' "$LAST_LOG" | sed 's/^/         /'; fi
# 关键：它必须查的是单元那个 v24，而不是 PATH 的 v20
if grep -q 'v24.4.0' "$LAST_LOG"; then ok "被检查的是单元里的 v24" "头部打印了 v24.4.0"
else bad "被检查的是单元里的 v24" "头部没有 v24.4.0" "v24.4.0"; fi
if grep -q 'ExecStart' "$LAST_LOG"; then ok "头部点名了取值来源" "含 ExecStart"
else bad "头部点名了取值来源" "不含 ExecStart" "ExecStart"; fi

# ── 夹具 2：PATH 上是 v20，单元也指 v20 —— 期望报红 ──────────────────
echo "[2] PATH=v20，单元=/usr/bin/node —— 期望报红（退出码 1）"
mkdir -p "$WORK/usr/bin" && cp "$WORK/fake20/node" "$WORK/usr/bin/node"
make_repo "$WORK/r2" "$WORK/usr/bin/node"
run_deploy "$WORK/r2" "$WORK/fake20"; rc=$?
if [ "$rc" = 1 ]; then ok "单元指旧 node → 报红" "$rc"
else bad "单元指旧 node → 报红" "$rc" 1; fi
if grep -q 'ExecStart' "$LAST_LOG"; then ok "报红消息点名了来源" "含 ExecStart"
else bad "报红消息点名了来源" "不含 ExecStart" "ExecStart"; fi

# ── 夹具 3：单元指向不存在的路径 —— 期望**明说**退回 PATH 并因 v20 报红 ──
echo "[3] 单元指向不存在的 node —— 期望明说退回 PATH，且因 v20 报红"
make_repo "$WORK/r3" "$WORK/opt/node-nope/bin/node"
run_deploy "$WORK/r3" "$WORK/fake20"; rc=$?
if [ "$rc" = 1 ]; then ok "取不到单元的 node → 报红" "$rc"
else bad "取不到单元的 node → 报红" "$rc" 1; fi
if grep -q 'PATH 上的 node' "$LAST_LOG"; then ok "明说退回的是 PATH 上的 node" "消息含「PATH 上的 node」"
else bad "明说退回的是 PATH 上的 node" "消息没提退回" "PATH 上的 node"; sed -n '1,6p' "$LAST_LOG" | sed 's/^/         /'; fi

# ── 夹具 4：回归 —— 两侧都是 v24，放行 ──────────────────────────────
echo "[4] PATH=v24，单元=v24 —— 期望放行"
make_repo "$WORK/r4" "$WORK/opt/node24/bin/node"
run_deploy "$WORK/r4" "$WORK/fake24"; rc=$?
if [ "$rc" = 0 ]; then ok "两侧都新 → 放行" "$rc"
else bad "两侧都新 → 放行" "$rc" 0; sed -n '1,6p' "$LAST_LOG" | sed 's/^/         /'; fi

echo
echo "=== 结论：$pass 条通过 / $fail 条失败 ==="
[ "$fail" -eq 0 ] || exit 1
exit 0
