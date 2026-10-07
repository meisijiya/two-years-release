#!/bin/bash
# 验 deploy.sh 写 env 那条命令在**真实执行路径**下会展开成真值。
#
# ── 为什么需要它 ─────────────────────────────────────────────────────
# deploy.sh 把每步命令存进数组，最后用 `eval "${PLAN_C[$i]}"` 执行。
# eval 会把数组里**已经转义过一次**的引号再处理一遍，于是同一段引号在
# 「直接执行」与「eval 执行」下结果不同。这类错误有三个特征，恰好都很难靠
# 读代码发现：
#   ① `bash -n` 过得去（语法完全合法）
#   ② dry-run 全绿（它只打印，不执行）
#   ③ 真部署会**成功退出**，但 env 文件里躺着字面量 `$DOOR_PASSWORD` ——
#      systemd 拿到无效配置，下次 restart 才炸，而那可能已经是开门当天。
#
# 所以它验的是**结果**（值对不对），不是**语法**（能不能过 bash -n）。
#
# ── 这条脚本自己踩过的坑 ────────────────────────────────────────────
# 前三次验证都失败，但**全是验证脚本自己的错**，不是 deploy.sh 的：
# 我凭理解重写了一遍 deploy.sh 的逻辑，于是测的是一个从没存在过的代码。
# 现在改成**从 deploy.sh 的 dry-run 输出里取那条命令**，不手抄、不重写 ——
# 测的才是它真正会跑的那一串。
#
# 用法：bash scripts/deploy-verify/verify-env-expansion.sh
# ⚠️ 这里**故意不加 `set -u`**。真实部署场景里，一个写错的变量名
# （例如 $DOOR_PASSWORD 拼成 $DOOR_PASSWORD_DUMMY）不会让部署中止 ——
# 它展开成**空串**，部署照样成功退出，而 env 文件里躺着一个空值。
# 那种失败要等到 systemd 拿它去 restart 才暴露，很可能已经是开门当天。
# 加上 `-u` 反而会把这个脚本自己先杀掉，让「部署会写坏 env」这条
# 真正的失效模式**测不出来**（变异存活就是这么发现的）。
set -o pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$(mktemp -d)"
ENV_FILE="$OUT/two-years.env"
trap 'rm -rf "$OUT"' EXIT

export DOOR_PASSWORD=11111111
export HERO_PASSWORD=22222222
export OBSERVER_PASSWORD=observe-me-9
export BIRTH_YEAR=2004

# 1) 让 deploy.sh 打印它的计划（dry-run 默认，什么都不改）
plan=$(cd "$REPO" && DOOR_PASSWORD=11111111 HERO_PASSWORD=22222222 \
       OBSERVER_PASSWORD=observe-me-9 bash deploy/deploy.sh 2>&1)

# 2) 从计划输出里挑出「写 env」那一条（它是 $ 后面紧跟的那行）
cmd=$(printf '%s\n' "$plan" | grep -A0 'umask 077' | head -1)
# 计划输出里前缀是 "       $ "，去掉
cmd=$(printf '%s' "$cmd" | sed -e 's/^ *\$ *//' -e 's/^\$ //')

echo "=== 从 deploy.sh dry-run 输出里取到的原始命令 ==="
echo "$cmd"
echo

if [ -z "$cmd" ]; then
  echo "FAIL: 没取到命令"
  exit 1
fi

# 3) 走同一条 eval 路径。只把**落盘路径**换成本机临时目录 ——
#    参数形态一个字节都不动，否则测的就不是 deploy.sh 真正会跑的那条命令了。
stripped="${cmd#*&& }"
stripped="umask 077 && ${stripped}"
stripped=$(printf '%s' "$stripped" | sed -e 's/ && chown.*$//' -e "s#/etc/two-years/two-years.env#${ENV_FILE}#")

export PORT=8300
export DATA_DIR=/opt/two-years/data
eval "$stripped"

echo "=== eval 之后 env 文件的内容 ==="
cat "$ENV_FILE"
echo "=== 自检 ==="
rc=0
if grep -q '\$' "$ENV_FILE"; then
  echo "FAIL: 仍有未展开的 \$"
  rc=1
fi
for pair in "PORT:8300" "DATA_DIR:/opt/two-years/data" "BIRTH_YEAR:2004" \
            "DOOR_PASSWORD:11111111" "HERO_PASSWORD:22222222" "OBSERVER_PASSWORD:observe-me-9"; do
  k="${pair%%:*}"; want="${pair##*:}"
  got=$(grep "^${k}=" "$ENV_FILE" | cut -d= -f2-)
  if [ "$got" != "$want" ]; then
    echo "FAIL: $k 期望 [$want] 实得 [$got]"
    rc=1
  fi
done
[ "$rc" -eq 0 ] && echo "RESULT: 全部展开成真值" || echo "RESULT: 展开不正确"
exit "$rc"
