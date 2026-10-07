#!/usr/bin/env bash
#
# 8300 端口只读探测（工单 06 · SPEC §五「服务器尚未探测」）
#
# 开工第一步要问的三件事：端口占没占、上面有没有别的服务、防火墙放没放行。
# 本脚本**只读**：不启停任何服务、不改任何防火墙规则、不删任何文件，
# 也**只连 127.0.0.1**（本机 HTTP 自检）—— 不 ssh、不 ping、不 curl 任何远端地址。
#
#   用法：
#     deploy/probe-8300.sh              # 打印报告，退出码 0
#     deploy/probe-8300.sh --strict     # 有冲突就退出码 2
#     deploy/probe-8300.sh --port 8080  # 换一个端口看
#
# 查不到的工具（没装 ss / 没有 root 看 ufw）一律报「未知」并说清为什么，
# 不用「没报错」冒充「没问题」。
#
# 退出码：0 探测完成 / 2 --strict 且有冲突 / 1 参数不对
set -uo pipefail

SERVICE_NAME="two-years"
PORT=8300
STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --port) [ $# -ge 2 ] || { echo "--port 后面要跟端口号"; exit 1; }; PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数：$1（只有 --strict / --port N）"; exit 1 ;;
  esac
done
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { echo "端口不是数字：$PORT"; exit 1; }

CONFLICT=""
# 报「未知」而不是假装没问题：查不到就说查不到
unknown() { echo "  ？ $1"; }
has() { command -v "$1" >/dev/null 2>&1; }

echo "=== two-years · ${PORT} 端口只读探测 ==="
echo "时间 $(date '+%Y-%m-%d %H:%M:%S %z')    主机 $(hostname)    用户 $(id -un)"
echo "只读声明：没有启停服务、没有改防火墙规则、没有连任何远端（HTTP 自检只打 127.0.0.1）"
echo

# ── 1. 端口有没有被占 ────────────────────────────────────────────
echo "[1/5] 端口 ${PORT} 的监听情况"
LISTEN=""
if has ss; then
  LISTEN="$(ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}[[:space:]]" || true)"
elif has netstat; then
  LISTEN="$(netstat -ltnp 2>/dev/null | grep -E "[:.]${PORT}[[:space:]]" || true)"
elif has lsof; then
  LISTEN="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
else
  unknown "本机没有 ss / netstat / lsof（apt install iproute2），这一项查不了"
fi
if [ -n "$LISTEN" ]; then
  echo "$LISTEN" | sed 's/^/  /'
  if echo "$LISTEN" | grep -qi node; then
    echo "  → 监听者是 node：很可能就是本应用，不是冲突。"
  else
    echo "  → 监听者不是 node。部署前先查清是谁，别把别人的服务顶掉。"
    CONFLICT="${CONFLICT}${PORT} 已被非 node 进程占用"
  fi
else
  echo "  没有人监听 ${PORT} —— 端口是空的。"
fi
echo

# ── 2. 上面有没有已经在跑的东西 ──────────────────────────────────
echo "[2/5] 本机服务"
if has systemctl && [ -d /run/systemd/system ]; then
  if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
    ACTIVE="$(systemctl is-active "${SERVICE_NAME}" 2>/dev/null || true)"
    ENABLED="$(systemctl is-enabled "${SERVICE_NAME}" 2>/dev/null || true)"
    echo "  ${SERVICE_NAME}.service 已装：active=${ACTIVE:-?} enabled=${ENABLED:-?}"
    [ "${ACTIVE:-}" = "active" ] || CONFLICT="${CONFLICT}${SERVICE_NAME}.service 装着但没在跑"
  else
    echo "  ${SERVICE_NAME}.service 未安装（全新部署）"
  fi
  echo "  在跑的相关服务："
  UNITS="$(systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null \
    | grep -iE "two-years|nginx|apache|caddy|node|pm2" || true)"
  [ -n "$UNITS" ] && echo "$UNITS" | sed 's/^/    /' || echo "    （没有 nginx / apache / caddy / node / pm2 之类的常驻服务）"
else
  unknown "这台机器上没有 systemd（容器？开发机？）—— 目标服务器上应该有"
fi
echo

# ── 3. 防火墙放没放行 ────────────────────────────────────────────
echo "[3/5] 防火墙（只读查询，不改任何规则）"
FW_SEEN=0
if has ufw; then
  FW_SEEN=1
  OUT="$(ufw status 2>&1 || true)"
  if [ -n "$OUT" ]; then echo "$OUT" | sed 's/^/  /'; else unknown "ufw 查不到（多半要 root：sudo ufw status）"; fi
fi
if has firewall-cmd; then
  FW_SEEN=1
  OUT="$(firewall-cmd --state 2>&1 || true)"
  if [ -n "$OUT" ]; then echo "$OUT" | sed 's/^/  firewalld /'; else unknown "firewalld 查不到（多半要 root）"; fi
  firewall-cmd --list-all 2>/dev/null | sed 's/^/  /' || true
fi
if has iptables; then
  FW_SEEN=1
  OUT="$(iptables -S 2>&1 | grep -E "${PORT}|^-P INPUT" || true)"
  if [ -n "$OUT" ]; then echo "$OUT" | sed 's/^/  /'; else unknown "iptables 规则读不到（多半要 root：sudo iptables -S）"; fi
fi
[ "$FW_SEEN" = 1 ] || unknown "本机没有 ufw / firewall-cmd / iptables，这一项查不了（云厂商安全组另算）"
echo "  注：本机都放行了也不等于外网能连 —— 云厂商安全组是控制台上的另一件事。"
echo

# ── 4. 本机 HTTP 自检：只连 127.0.0.1 ────────────────────────────
echo "[4/5] 本机 http://127.0.0.1:${PORT}/api/status（只连回环）"
if [ -z "$LISTEN" ]; then
  echo "  跳过：${PORT} 都没有人监听，没什么可问的。"
elif has curl; then
  CODE="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/status" 2>/dev/null || echo 000)"
  echo "  HTTP ${CODE}（200 = 服务在答话）"
  [ "$CODE" = "200" ] || CONFLICT="${CONFLICT}本机 ${PORT} 答的不是 200（实际 ${CODE}）"
else
  unknown "本机没有 curl，这一项查不了"
fi
echo

# ── 5. 机器扛不扛得住 ────────────────────────────────────────────
echo "[5/5] 资源"
if has df; then df -h . 2>/dev/null | sed 's/^/  /' || unknown "df 读不到"; else unknown "没有 df"; fi
if has free; then free -m 2>/dev/null | sed 's/^/  /' || unknown "free 读不到（macOS 用 vm_stat）"; else unknown "没有 free"; fi
echo "  node: $(node -v 2>/dev/null || echo '没装')"
echo

# ── 结论 ─────────────────────────────────────────────────────────
if [ -n "$CONFLICT" ]; then
  echo "结论：先解决这些再部署 ——${CONFLICT}"
  if [ "$STRICT" = 1 ]; then exit 2; fi
  exit 0
fi
echo "结论：${PORT} 看起来是空的，没有同名服务挡路。放行端口是人工步骤，deploy.sh 明确不做。"
exit 0
