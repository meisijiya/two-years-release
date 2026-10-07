#!/usr/bin/env bash
#
# 搭一个**只绑回环**的测试实例，用来做线上 e2e。
#
# 为什么要它：礼物还没组装，线上验证要往库里塞标记数据、要让双方各传几张照片。
# 在生产实例（8300）上做这件事，标记会污染真实数据、照片会落进正式库。
# 所以另起一个同代码、不同数据目录、不同端口的实例，只监听 127.0.0.1，
# 从外面只能靠 SSH 端口转发进来 —— nginx 看不到它，安全组也不需要放行。
#
# 它**不碰**生产：不同目录、不同端口、不同 unit、不同的数据目录，
# 全程不碰防火墙、不碰 nginx、不碰 two-years.service。
#
# 完整流程（线上 e2e 怎么跑）：
#   1. 本地：node scripts/e2e/seed.mjs --dir <种子目录>
#            tar -czf /tmp/ty-seed.tgz -C <种子目录> two-years.db photos
#            scp /tmp/ty-seed.tgz <host>:/tmp/
#   2. 远端：scp deploy/test-instance.sh <host>:/tmp/
#            sudo bash /tmp/test-instance.sh up
#            sudo bash /tmp/test-instance.sh seed      # 解包那份 tar
#   3. 本地：ssh -N -L 18301:127.0.0.1:8301 <host>      # 隧道
#            node scripts/e2e/check.mjs --dir <种子目录> --locked --base http://127.0.0.1:18301
#            node scripts/e2e/browser.mjs --dir <种子目录> --base http://127.0.0.1:18301
#            （browser.mjs 会自己读 /api/status：锁着就跑布置台那一段，开门就跑阅读流那一段）
#   4. 收尾：sudo bash /tmp/test-instance.sh down
#
# 公网预览（给人手工对照两个视角）：
#   装 deploy/nginx/two-years-preview-8443.conf，并在云控制台放行 8443/tcp，
#   然后开 https://<主域名>:8443/  —— 登录进去看的是**对方**写的东西。
#   ⚠️ 这一步会让一个用真生日做口令的实例上公网。生产实例不受影响。
#
#   sudo bash test-instance.sh up      # 起（固定开门 + 只听回环）
#   sudo bash test-instance.sh seed     # 灌种子数据（用 /tmp 里传进来的 tar）
#   sudo bash test-instance.sh status   # 看状态
#   sudo bash ty-test-instance.sh down    # 拆（连同数据目录）
#
# 退出码：0 成功 / 1 硬失败。**不碰防火墙、不碰 nginx、不碰生产 unit。**
set -euo pipefail

TEST_NAME="two-years-test"
TEST_APP="/opt/${TEST_NAME}"
TEST_ENV_DIR="/etc/${TEST_NAME}"
# ⚠️ 文件名**必须**叫 two-years.env，不能叫 two-years-test.env：
# 下面的 sed 是从生产 unit 改路径来的（EnvironmentFile=/etc/two-years/two-years.env
# → /etc/two-years-test/two-years.env）。两处名字对不上，服务会以
# 「Failed to load environment files: No such file or directory」起不来 ——
# 报的是「资源不足」，跟真正的原因隔了三层，最容易往错误方向查。
TEST_ENV_FILE="${TEST_ENV_DIR}/two-years.env"
TEST_UNIT="/etc/systemd/system/${TEST_NAME}.service"
TEST_PORT="${TEST_PORT:-8301}"
TEST_DATA="${TEST_APP}/data"
SEED_TGZ="${SEED_TGZ:-/tmp/ty-seed.tgz}"

# 预览入口：**固定开门**（时间在开门后 1 分钟）。
#
# 为什么需要它：生产与这个实例用**同一个系统时钟**，而 10-5 之前时钟就在锁那边。
# 锁着的时候两人登录后落在布置台，只能看自己折的东西 —— 那**对照不出对方视角**。
# 而改系统时钟会连带影响同机跑着的别的项目（这里有 opencode、n8n、docker 若干），
# 设一个「开门后门」进产品代码更糟：那等于在生产目录里放一个能开门的文件。
#
# 所以这个文件**只由本脚本生成到测试实例目录**，产品代码一个字没动，
# /opt/two-years 下不存在它。做法与 e2e 脚本一致：createApp({ now }) 注入时钟。
PREVIEW_ENTRY="${TEST_APP}/server-preview.js"

log() { printf '[ty-test] %s\n' "$*"; }
die() { printf '[ty-test][硬失败] %s\n' "$*" >&2; exit 1; }

# ── 起 ──────────────────────────────────────────────────────────────
up() {
  [ "$(id -u)" = 0 ] || die "必须 root"

  # 代码从生产目录整份复制：两边跑的是**同一份字节**，避免「测的和上的不是一个东西」
  if [ ! -d "$TEST_APP" ]; then
    log "从 /opt/two-years 复制一份到 ${TEST_APP}"
    mkdir -p "$TEST_APP"
    # node_modules 一并带过去：sharp 的原生模块与平台绑定，重新 npm i 更慢也更容易出错
    tar -C /opt/two-years -cf - --exclude=data --exclude=.scratch . | tar -C "$TEST_APP" -xf -
  else
    log "代码目录已存在，只刷新源码与脚本（node_modules 保持原样）"
    for d in src public scripts test deploy; do
      [ -d "/opt/two-years/$d" ] && rm -rf "${TEST_APP:?}/$d" && cp -a "/opt/two-years/$d" "$TEST_APP/$d"
    done
    for f in package.json package-lock.json CONSTRAINTS.md; do
      [ -f "/opt/two-years/$f" ] && cp -a "/opt/two-years/$f" "$TEST_APP/$f"
    done
  fi

  id two-years >/dev/null 2>&1 || die "用户 two-years 不存在，先跑生产部署"
  mkdir -p "$TEST_DATA"
  chown -R two-years:two-years "$TEST_APP"
  chmod 700 "$TEST_DATA"

  # ⚠️ 密码**必须**与生产不同吗？不。测试实例只绑回环、从 SSH 隧道进，
  #    沿用同一组生日反而让 e2e 脚本不用带第二套凭据。
  #    但 OBSERVER_PASSWORD 要显式给：它决定 e2e 拿哪个 PIN 进门。
  #
  # ⚠️ 生日**不写死在这里**：口令是产品定义（CONSTRAINTS.md §3）但它是两个人的
  #    真实凭据，仓库里不该有一份拷贝。三项都从环境变量注入，缺一个就地退出 ——
  #    `:?` 让「忘了注入」当场炸，而不是把字面量 <口令> 写进 env 文件、
  #    起一个没人能登录的实例：
  #      sudo env DOOR_PASSWORD=… HERO_PASSWORD=… OBSERVER_PASSWORD=… bash test-instance.sh up
  install -d -m 700 -o root -g root "$TEST_ENV_DIR"
  cat > "$TEST_ENV_FILE" <<EOF
HOST=127.0.0.1
PORT=${TEST_PORT}
DATA_DIR=${TEST_DATA}
DOOR_PASSWORD=${DOOR_PASSWORD:?必须注入 DOOR_PASSWORD}
HERO_PASSWORD=${HERO_PASSWORD:?必须注入 HERO_PASSWORD}
OBSERVER_PASSWORD=${OBSERVER_PASSWORD:?必须注入 OBSERVER_PASSWORD}
EOF
  chown root:root "$TEST_ENV_FILE"
  chmod 600 "$TEST_ENV_FILE"
  log "env 写好：${TEST_ENV_FILE}（600 root）"

  # ---- 预览入口：固定开门，且**永远只听回环** ----
  cat > "$PREVIEW_ENTRY" <<'PREVIEW_EOF'
/**
 * 观察者预览入口 —— **只存在于测试实例目录**。
 *
 * 与 src/server.js 的差别只有一个：时钟。
 *   src/server.js        now = systemClock            （10-5 之前 → 锁着）
 *   server-preview.js    now = () => UNLOCK_AT + 60s  （永远开门）
 *
 * 这么做的原因：要在开门前对照两个视角，就必须让两边都能看到对方。
 * 改系统时钟会波及同机跑着的别的项目；给产品代码加「开门开关」等于在生产
 * 目录里放一个后门 —— 两条都更糟。产品代码一个字没动。
 *
 * 绑死 127.0.0.1：外部一律经 nginx（trust proxy=1 的前提，见 src/app.js）。
 */
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./src/app.js";
import { openDb } from "./src/db.js";
import { UNLOCK_AT } from "./src/clock.js";

const DATA_DIR = process.env.DATA_DIR;
const PORT = Number(process.env.PORT || 8301);
const HOST = "127.0.0.1";

const photos = path.join(DATA_DIR, "photos");
fs.mkdirSync(photos, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(photos, 0o700);

const db = openDb(path.join(DATA_DIR, "two-years.db"));
const app = createApp({ db, now: () => UNLOCK_AT + 60_000, bindHost: HOST, dataDir: DATA_DIR });
app.listen(PORT, HOST, () => {
  console.log(`[two-years-test] 预览（固定开门）${HOST}:${PORT}  data=${DATA_DIR}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
PREVIEW_EOF
  chown two-years:two-years "$PREVIEW_ENTRY"
  log "预览入口写好：${PREVIEW_ENTRY}（固定开门，只听回环）"

  # unit：与生产同款，改 ExecStart 指到预览入口，并只改目录、数据路径、端口无关（端口在 env 里）
  sed -e "s#/opt/two-years#${TEST_APP}#g" \
      -e "s#/etc/two-years/#${TEST_ENV_DIR}/#g" \
      -e "s#SyslogIdentifier=two-years#SyslogIdentifier=${TEST_NAME}#" \
      -e "s#Description=.*#Description=${TEST_NAME}（观察者预览，固定开门，只绑回环）#" \
      -e "s#src/server.js#server-preview.js#" \
      /etc/systemd/system/two-years.service > "$TEST_UNIT"
  chmod 644 "$TEST_UNIT"

  systemctl daemon-reload
  systemctl enable "$TEST_NAME" >/dev/null 2>&1 || true
  systemctl restart "$TEST_NAME"

  # 自检：轮询到 /api/status 有应答为止（启动要编译 sharp 与建库，别只等一拍）
  for i in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${TEST_PORT}/api/status" >/dev/null 2>&1; then
      log "起来了：http://127.0.0.1:${TEST_PORT}"
      systemctl is-active "$TEST_NAME"
      # 绑定确认：只能有回环，不能是 0.0.0.0
      if ss -ltn 2>/dev/null | grep -qE "0\.0\.0\.0:${TEST_PORT}"; then
        die "测试实例绑到了 0.0.0.0:${TEST_PORT}，这不对"
      fi
      log "绑定确认：只听回环"
      return 0
    fi
    sleep 0.5
  done
  systemctl status "$TEST_NAME" --no-pager -n 30 || true
  die "起不来（40 轮轮询都没应答）"
}

# ── 灌种子 ───────────────────────────────────────────────────────────
seed() {
  [ "$(id -u)" = 0 ] || die "必须 root"
  [ -f "$SEED_TGZ" ] || die "找不到 ${SEED_TGZ}"

  # 必须先停：SQLite 开着的时候把库换掉，句柄还指着旧 inode
  systemctl stop "$TEST_NAME"
  log "服务已停（换库必须停，否则句柄指着旧文件）"

  rm -rf "${TEST_DATA:?}/photos"
  mkdir -p "$TEST_DATA/photos"
  # tar 里是 db/photos/… 相对结构，解到 data 底下
  tar -C "$TEST_DATA" -xzf "$SEED_TGZ"
  chown -R two-years:two-years "$TEST_DATA"
  chmod 700 "$TEST_DATA" "$TEST_DATA/photos"
  log "种子已灌入 ${TEST_DATA}"

  systemctl start "$TEST_NAME"
  for i in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${TEST_PORT}/api/status" >/dev/null 2>&1; then
      log "重新起来了"
      return 0
    fi
    sleep 0.5
  done
  die "灌完种子起不来"
}

# ── 状态 / 拆 ───────────────────────────────────────────────────────
status() {
  systemctl is-active "$TEST_NAME" || true
  systemctl is-enabled "$TEST_NAME" || true
  ss -ltn 2>/dev/null | grep -E ":${TEST_PORT}\b" || echo "(没在监听 ${TEST_PORT})"
  echo "--- 数据目录 ---"
  ls -la "$TEST_DATA" 2>/dev/null | head -20
  echo "--- 最近日志 ---"
  journalctl -u "$TEST_NAME" --no-pager -n 15 || true
}

down() {
  [ "$(id -u)" = 0 ] || die "必须 root"
  systemctl stop "$TEST_NAME" 2>/dev/null || true
  systemctl disable "$TEST_NAME" >/dev/null 2>&1 || true
  rm -f "$TEST_UNIT"
  rm -rf "$TEST_APP" "$TEST_ENV_DIR"
  systemctl daemon-reload
  systemctl reset-failed "$TEST_NAME" 2>/dev/null || true
  log "已拆干净：unit / 目录 / env 都删了"
  log "生产实例一个字没动（/opt/two-years 与 two-years.service 原样）"
}

case "${1:-}" in
  up) up ;;
  seed) seed ;;
  status) status ;;
  down) down ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
