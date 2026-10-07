#!/usr/bin/env bash
#
# two-years 部署脚本（工单 06）
#
# 它**在目标机器上跑**，全程不 ssh、不 scp、不 curl 任何远端：
# 仓库已经 checkout 到服务器之后，在仓库根目录执行它。
# 本票（工单 06）只在本机 dry-run 过，从未连过 <公网IP> 或任何服务器。
#
#   用法：
#     DOOR_PASSWORD=... HERO_PASSWORD=... deploy/deploy.sh            # 打印计划，不动手（默认）
#     DOOR_PASSWORD=... HERO_PASSWORD=... deploy/deploy.sh --execute # 真的执行
#
#   默认就是 dry-run：不加 --execute 一个字节都不改。
#
# 硬失败条件（任一不满足就地退出 1，绝不"先跑起来再说"）：
#   1. DOOR_PASSWORD / HERO_PASSWORD 没有显式注入
#   2. 密码不是 4 位月日或 8 位完整生日
#   3. DATA_DIR 落在 public/ 之内 —— 照片会被 express.static 零鉴权直出，时间锁当场作废
#   4. --execute 但不是 root
#   5. node 主版本 < 22（node:sqlite 需要）
#   6. 要部署的这份 src/server.js 默认绑定不是 127.0.0.1 —— 公网能直连进程，
#      HTTPS 与按 IP 限流都绕得过去，4 位生日就直接暴露在爆破面上了
#
# ⚠️ 早先还有一条「两者不得等于源码缺省值 <口令>」，**已移除**，理由见下面第 1 节。
#    密码就是对方的生日，那是产品定义（CONSTRAINTS.md §3），不是没换掉的临时值。
#
# 退出码：0 计划已打印（dry-run 正常）/ 1 硬失败 / 2 执行中出错。
set -euo pipefail

SERVICE_NAME="two-years"
UNIT_NAME="${SERVICE_NAME}.service"
APP_DIR="${APP_DIR:-/opt/two-years}"                 # 与 unit 里的 WorkingDirectory 一致
ENV_DIR="/etc/${SERVICE_NAME}"
ENV_FILE="${ENV_DIR}/${SERVICE_NAME}.env"
DATA_DIR="${DATA_DIR:-${APP_DIR}/data}"
PORT="${PORT:-8300}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EXECUTE=0
for a in "$@"; do
  case "$a" in
    --execute) EXECUTE=1 ;;
    --dry-run) EXECUTE=0 ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "不认识的参数：$a（只有 --execute / --dry-run）" >&2; exit 1 ;;
  esac
done

die() { echo "!! $*"; echo "   部署没有开始：上面这条不满足，脚本就地退出了。"; exit 1; }

# ── 1. 密码：必须显式注入，且必须是生日 ─────────────────────────────
[ -n "${DOOR_PASSWORD:-}" ] || die "DOOR_PASSWORD 没有注入。对方的生日必须由环境变量显式给出（deploy/two-years.env.example 是模板，不是来源）。"
[ -n "${HERO_PASSWORD:-}" ] || die "HERO_PASSWORD 没有注入。同上，两个都要。"
# 观察者 PIN 同样必填，且**不能与任何一方的生日相同**。
# ⚠️ 这一条是补的：src/observer-auth.js 的缺省值曾经与【改这里：heroCode】的口令同值，
#    而 deploy.sh 写的 env 里从来没有 OBSERVER_PASSWORD 这个键 ——
#    于是线上一直在用缺省值，而「部署时应当显式给」这句话从没兑现过。
#    现在 src 侧已无缺省（拿不到就抛），所以这一行必须存在，
#    否则观察者入口会在部署后直接不可用，且没人会发现（它不在任何导航里）。
[ -n "${OBSERVER_PASSWORD:-}" ] || die "OBSERVER_PASSWORD 没有注入。观察者入口绕过时间锁、一次能读全双方内容，凭据不能有缺省。"

for v in DOOR_PASSWORD HERO_PASSWORD; do
  val="${!v}"
  [[ "$val" =~ ^[0-9]{4}$|^[0-9]{8}$ ]] || die "$v 不是 4 位月日或 8 位完整生日（现在这串是：$val）。"
done

# 观察者 PIN 的形态与生日无关（它是测试开关，不是门），但仍要求非空且够长。
[[ "${#OBSERVER_PASSWORD}" -ge 6 ]] || die "OBSERVER_PASSWORD 至少 6 位（现在 ${#OBSERVER_PASSWORD} 位）。它不是生日，所以不必是纯数字 —— 但别短到能被一次爆破打掉。"

# 三个值两两不同：同值等于一把钥匙开两个门，而观察者那扇门绕过时间锁。
for pair in "DOOR_PASSWORD:HERO_PASSWORD" "DOOR_PASSWORD:OBSERVER_PASSWORD" "HERO_PASSWORD:OBSERVER_PASSWORD"; do
  a="${pair%%:*}"; b="${pair##*:}"
  [ "${!a}" != "${!b}" ] || die "$a 与 $b 同值 —— 一把钥匙开两个门，而观察者入口不受时间锁约束。三个值必须两两不同。"
done

# 出生年份：只用于把 4 位月日补成 8 位（CONSTRAINTS §3 的容错），
# 登录时不校验年份，所以它错了不会让口令失效，但会让 8 位形态对不上。
# 显式写进 env 而不是靠源码缺省 —— 它本身就是个人数据的一部分。
BIRTH_YEAR="${BIRTH_YEAR:-2004}"
[[ "$BIRTH_YEAR" =~ ^[0-9]{4}$ ]] || die "BIRTH_YEAR 必须是 4 位年份（现在这串是：$BIRTH_YEAR）。"
export BIRTH_YEAR

# 密码**就是**生日，这是产品定义（CONSTRAINTS.md §3），不是「还没换掉的缺省值」。
#
# 早先这里有一条「不得等于 <口令>」的硬失败，理由是「部署形态是公网 IP + 裸 HTTP，
# 缺省值等于把内容挂在全网扫得到的地方」。**那个前提已经不成立**，照留着只会挡住产品本身：
#   · 现在是主域名 + 有效 HTTPS（不是裸 HTTP）
#   · 应用只绑回环 127.0.0.1，公网压根碰不到进程
#   · 爆破由「同 IP 5 次错锁 10 分钟」挡着，且按**真实客户端**算（src/app.js 的 trust proxy=1）
#   · 未到 2026-10-05 之前所有读接口一律 404
#
# 生日只有 4 位这件事，靠的不是「换个更长的密码」：8 位完整生日和 4 位月日是**同一个生日**，
# 容错逻辑（CONSTRAINTS §3「剥掉非数字后同时接受两种」）会同时接受，写成 <8位完整生日>
# 一位熵都不增加。所以下面把补偿控制做成硬检查，而不是换个密码糊弄过去。

# 补偿控制之一：部署的这一份代码，默认绑定必须是回环。
# 有人把 src/server.js 的默认值改回 0.0.0.0，公网就能直连进程，HTTPS 与限流一起绕过去 ——
# 那时「生日只有 4 位」才真的成了问题。这里在部署时拦一次。
if ! grep -q 'HOST || "127\.0\.0\.1"' "${REPO_DIR}/src/server.js"; then
  die "src/server.js 的默认绑定不是 127.0.0.1。公网能直连进程，HTTPS 与按 IP 限流都绕得过去。先改回回环。"
fi

# ── 2. 位置：跑在仓库里，unit 的路径对得上 ─────────────────────────
[ -f "${REPO_DIR}/public/index.html" ] || die "这不像仓库根目录（${REPO_DIR} 下没有 public/index.html）。"
[ -f "${REPO_DIR}/deploy/${UNIT_NAME}" ] || die "找不到 ${REPO_DIR}/deploy/${UNIT_NAME}。"
[ "$APP_DIR" = "/opt/two-years" ] || die "APP_DIR=${APP_DIR} 与 unit 里写死的 WorkingDirectory=/opt/two-years 不一致。先改 deploy/${UNIT_NAME}，再改这里。"

# ── 3. 照片目录：绝不落在静态根里（CONSTRAINTS.md §2）─────────────
# 相对路径先按当前目录展开：人在仓库里敲 DATA_DIR=public/data 是最常犯的一错，
# 光比字符串前缀抓不到「展开之后」落在 public/ 里的那种。
case "$DATA_DIR" in
  /*) : ;;
  *) DATA_DIR="$PWD/$DATA_DIR" ;;
esac
DATA_DIR="${DATA_DIR%/}"
# **必须先 realpath -m 归一化再比**。只做字符串前缀比较时，这四种写法全部穿透
# （实测 exit 0 出完整计划）：`./public`、`.//public`、`x/../public`、`/opt/two-years/./public`。
# realpath -m 解析 `..`、`.` 与重复斜杠，不要求路径存在。
if command -v realpath >/dev/null 2>&1; then
  DATA_DIR="$(realpath -m -- "$DATA_DIR")"
  # 三个都要查：部署时真正的静态根是 $APP_DIR/public，本机自测时是 $REPO_DIR/public。
  # 只查其中一个就等于把另外两个放行——这正是「单一守卫覆盖不全」的形状。
  #
  # 查**两个路径**：$DATA_DIR 本身，以及 $DATA_DIR/photos。
  # 照片落在后者（src/photos.js 的 photosDirFor），而 realpath -m 只解析
  # $DATA_DIR 这条路径上的软链——「data/photos 是指向 public/ 的符号链接」
  # 在这里同样是完全看不出来的形态。只查前者等于给后者开了个口子。
  #
  # ⚠️ **已知的边界**：归一化之后做的是**字符串比较**，对「同一目录的两种拼写」
  # 敏感。开发时用 Git Bash 撞到过：MSYS 把 cwd 记成 `/c/Users/...`，
  # 而 junction 目标被解析成 `/tmp/...`，同一目录两种拼写就比不出来了。
  # Linux 上是同类形态（经另一条软链路径进入、链接目标用第三种拼写）。
  # 前提是有文件系统写权限，不是远程可利用；真出现时的兜底是运行时那条断言
  # （src/photos.js 的 assertPhotosOutsideStatic）与「照片永不进 public/」这条纪律。
  for base in "$REPO_DIR" "$PWD" "$APP_DIR"; do
    pub="$(realpath -m -- "${base}/public")"
    for candidate in "$DATA_DIR" "$DATA_DIR/photos"; do
      case "$(realpath -m -- "$candidate")" in
        "$pub"|"$pub"/*) die "DATA_DIR=${DATA_DIR} 里的 $(basename "$candidate") 解析到 ${pub}（已 realpath -m 归一化）。照片会被 express.static 零鉴权直出，时间锁当场作废且不报任何错。若这是软链接造成的，删掉它或换 DATA_DIR。" ;;
      esac
    done
  done
else
  # 没有 realpath 就**解析不了软链**，这条分支天生比上面弱一档。
  # 明说清楚：它至少还拦得住字面形态，但链接形态在这里一定漏。
  echo "警告：没有 realpath，DATA_DIR 守卫退化成字符串比较，'./public' 这类写法可能穿透，且**完全无法识别软链接**。" >&2
  for base in "$REPO_DIR" "$PWD" "$APP_DIR"; do
    for candidate in "$DATA_DIR" "$DATA_DIR/photos"; do
      case "$candidate" in
        "${base}/public"|"${base}/public/"*) die "DATA_DIR=${DATA_DIR} 里的 $(basename "$candidate") 落在 ${base}/public 里。照片会被 express.static 零鉴权直出。" ;;
      esac
    done
  done
fi

# ── 4. node：node:sqlite 需要 22.5+ ──────────────────────────────
# ⚠️ 这里查的必须是**单元 ExecStart 里实际用的那个 node**，不能查 PATH 上的。
#
#    本机 PATH 上是系统 Node **v20**，而 unit 里写死的是 **/opt/node24/bin/node**（v24）——
#    原因就写在 two-years.service:22-26：同机还跑着别的项目用系统 Node，
#    不能升级它，只能给这个服务单装一份。
#
#    早先这里查的是裸 `node`。后果不是「少了一道检查」，而是
#    **部署脚本会拒绝它自己要部署的那台机器**：2026-10-04 在真机上拿线上真实
#    env 的值跑 dry-run，实测 `!! node 主版本要 ≥ 22，现在是 v20.20.2`，退出码 1；
#    同一份脚本只要把 /opt/node24/bin 加进 PATH 才退出 0。
#    也就是说「部署前的检查」在目标机器上恒为红，而 `bash -n`、
#    226 个测试、check:env-expand 全都发现不了 —— 它们都不在这台机器上跑。
#
#    从单元里取可执行文件，是为了让「被检查的对象」与「真正执行的对象」
#    永远是同一个。两处各自硬编码路径，迟早再次分叉：这次分叉已经发生过一次。
NODE_BIN=""
UNIT_PATH="${REPO_DIR}/deploy/${UNIT_NAME}"
if [ -f "$UNIT_PATH" ]; then
  # 取 ExecStart 的第一个词。先剥掉 systemd 的前缀字符（-@+!:，如 `-node` 表示
  # 启动失败也继续、`@node` 指定 argv0），再跳过 `--flag` 与 `VAR=val`。
  NODE_BIN="$(sed -n 's/^[[:space:]]*ExecStart[[:space:]]*=[[:space:]]*//p' "$UNIT_PATH" \
              | head -1 \
              | awk '{for (i=1; i<=NF; i++) if ($i !~ /^[-@+!:]/ && $i !~ /^-/ && $i !~ /^[A-Za-z_][A-Za-z0-9_]*=/) { print $i; exit }}')"
fi

if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  NODE_V="$("$NODE_BIN" -v 2>/dev/null || true)"
  NODE_SRC="$NODE_BIN（取自 ${UNIT_NAME} 的 ExecStart）"
else
  # 单元没写、写的路径不存在、或者这台机器上还没装那份 node —— 退回 PATH。
  # 退回时要**说出来**：悄悄换一个被检查的对象，正是本节要修的那类 bug。
  NODE_V="$(node -v 2>/dev/null || true)"
  NODE_SRC="PATH 上的 node（${UNIT_NAME} 的 ExecStart 没能取到可执行文件）"
  if [ "$EXECUTE" = 1 ] && [ ! -x "${NODE_BIN:-}" ] && [ -n "$NODE_BIN" ]; then
    die "单元 ${UNIT_NAME} 的 ExecStart 指向 ${NODE_BIN}，但它在执行时不存在。装上它再部署 —— 别让 systemd 去跑一个不存在的解释器。"
  fi
fi

if [ -z "$NODE_V" ]; then
  # dry-run 承诺「只打印计划」，没装 node 不该在这里就死——那会让
  # 「第一次：只打印计划」根本跑不了。留占位继续，真执行时再硬失败。
  [ "$EXECUTE" = 1 ] && die "机器上没有 node（查的是 ${NODE_SRC}）。"
  NODE_V="（没装，执行时会失败）"
fi
NODE_MAJOR="${NODE_V#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
# 占位串不是整数，拿它做 -ge 会让 bash 报 "integer expression expected"，
# 然后被 || die 吞掉——于是 dry-run 在没装 node 的机器上直接失败，自相矛盾。
if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]]; then
  [ "$NODE_MAJOR" -ge 22 ] || die "node 主版本要 ≥ 22（node:sqlite），查到的是 $NODE_V（来源：$NODE_SRC）。"
elif [ "$EXECUTE" = 1 ]; then
  die "认不出 node 版本（$NODE_V，来源：$NODE_SRC），执行前请先装 node ≥ 22.5。"
fi

[ "$EXECUTE" = 1 ] && [ "$(id -u)" != 0 ] && die "--execute 需要 root：会建系统用户、写 /etc、开 systemd。用 sudo 跑。"

# ── 自检：必须**轮询**，不能只探一次 ─────────────────────────────────
#
# Type=simple 的含义是「exec 成功就算起来了」，systemctl restart 立刻返回，
# 而进程还要一段时间才 bind 上端口（实测 527–531ms，五次一致）。
#
# curl 遇到 ECONNREFUSED 是**当场**失败的，`-m 5` 是总时限、不是重试次数。
# 于是「restart 完立刻 curl 一次」是一次抛硬币：红的时候服务其实好好的，
# 而它偏偏是部署的最后一步 —— 一个随机变红的最后一步，训练出来的习惯是忽略它。
#
# 这不是理论：本次部署第 8 步就是这么红的，而 systemctl is-active 返回 active、
# 日志显示已 listening、手工 curl 立刻拿到 200。
selfcheck() {
  local deadline=$((SECONDS + 20)) why="" got_up=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! systemctl is-active --quiet "$SERVICE_NAME"; then
      why="服务不是 active（journalctl -u ${SERVICE_NAME} 看日志）"
    else
      got_up=1
      if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:${PORT}/api/status" 2>/dev/null; then
        return 0
      fi
      why="服务已 active，但 127.0.0.1:${PORT}/api/status 还没答话"
    fi
    sleep 0.2
  done
  [ "$got_up" = 1 ] || why="服务始终没能变成 active（journalctl -u ${SERVICE_NAME} 看日志）"
  echo "自检失败：${why}（已等 20 秒）" >&2
  return 1
}

# ── 5. 计划：先全部打印，再决定动不动手 ───────────────────────────
PLAN_D=(); PLAN_C=()
add() { PLAN_D+=("$1"); PLAN_C+=("$2"); }

add "建系统用户（不存在才建；应用不该以 root 跑）" \
    "id -u ${SERVICE_NAME} >/dev/null 2>&1 || useradd --system --home-dir ${APP_DIR} --shell /usr/sbin/nologin ${SERVICE_NAME}"
add "写数据目录，photos 权限 700（照片唯一的家）" \
    "install -d -m 0700 -o ${SERVICE_NAME} -g ${SERVICE_NAME} ${DATA_DIR} ${DATA_DIR}/photos"
add "备份旧 env 文件（如果上一版还在）" \
    "[ -f ${ENV_FILE} ] && cp -p ${ENV_FILE} ${ENV_FILE}.bak || true"
add "写 /etc/${SERVICE_NAME}/${SERVICE_NAME}.env（0600 root:root；密码不留在仓库里）" \
    "install -d -m 0700 -o root -g root ${ENV_DIR} && umask 077 && printf 'HOST=127.0.0.1\nPORT=%s\nDATA_DIR=%s\nBIRTH_YEAR=%s\nDOOR_PASSWORD=%s\nHERO_PASSWORD=%s\nOBSERVER_PASSWORD=%s\n' '${PORT}' '${DATA_DIR}' \"\${BIRTH_YEAR}\" \"\${DOOR_PASSWORD}\" \"\${HERO_PASSWORD}\" \"\${OBSERVER_PASSWORD}\" > ${ENV_FILE} && chown root:root ${ENV_FILE} && chmod 0600 ${ENV_FILE}"
add "装 systemd unit" \
    "install -m 0644 -o root -g root ${REPO_DIR}/deploy/${UNIT_NAME} /etc/systemd/system/${UNIT_NAME}"
add "重新加载并开机自启" \
    "systemctl daemon-reload && systemctl enable ${UNIT_NAME}"
add "启动（Restart=always 在 unit 里）" \
    "systemctl restart ${UNIT_NAME}"
add "自检：轮询等服务真答话（最多 20 秒，不是 restart 完就探一次）" \
    "selfcheck"

echo "two-years 部署计划"
echo "  仓库      ${REPO_DIR}"
echo "  应用目录  ${APP_DIR}"
echo "  数据目录  ${DATA_DIR}"
echo "  端口      ${PORT}"
echo "  密码      DOOR_PASSWORD=<已注入 ${#DOOR_PASSWORD} 位> · HERO_PASSWORD=<已注入 ${#HERO_PASSWORD} 位>（不回显原值）"
# 把被检查的 node 连同它的来源一起打出来。查的和跑的不是同一个，是本脚本
# 曾经栽过的那个坑（见第 4 节），所以这里要让人一眼看出「查的是哪一个」。
echo "  node      ${NODE_V}  ← ${NODE_SRC}"
echo
echo "将要做的 ${#PLAN_D[@]} 步："
for i in "${!PLAN_D[@]}"; do printf '  %d) %s\n       $ %s\n' "$((i+1))" "${PLAN_D[$i]}" "${PLAN_C[$i]}"; done
echo
echo "明确不做（本脚本一次都不碰）：不改防火墙、不动 nginx/apache、不碰 8300 之外的端口、"
echo "不删旧数据目录、不 ssh/scp 任何主机。防火墙是人工步骤，见 deploy/README.md。"

if [ "$EXECUTE" != 1 ]; then
  echo
  echo "dry-run：以上都**没有**执行。确认无误后加 --execute 再跑一次。"
  exit 0
fi

echo
echo "开始执行。"
for i in "${!PLAN_C[@]}"; do
  printf '  [%d/%d] %s … ' "$((i+1))" "${#PLAN_C[@]}" "${PLAN_D[$i]}"
  if eval "${PLAN_C[$i]}" >/dev/null 2>&1; then echo "OK"; else echo "失败"; echo "      $ ${PLAN_C[$i]}"; exit 2; fi
done
echo
echo "部署完成。自检日志：systemctl status ${UNIT_NAME} --no-pager"
echo
echo "**不要**开放 ${PORT}/tcp。"
echo "应用只绑 127.0.0.1，对外入口是本机 nginx（主域名 + HTTPS）。"
echo "开了 ${PORT} 等于在公网 IP 上另开一个裸 HTTP 入口：可以绕开证书直达应用，"
echo "那时 cookie 不带 Secure（src/auth.js 的 isSecureRequest），凭据明文发一次。"
echo "确认对外只有 443：ss -lntp | grep ${PORT} 应当只看到 127.0.0.1:${PORT}。"
