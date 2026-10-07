/**
 * 门禁第 3 步：依赖就位 + 服务真能起 + 时间锁闸门真的在关。
 *
 * init.sh 与 npm run verify 共用这一份实现——两套逻辑早晚会漂移。
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEST_SECRET, useTestSecrets } from "../test/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = false;
function must(label, ok, detail = "") {
  if (ok) {
    console.log(`  OK   ${label}`);
  } else {
    failed = true;
    console.error(`  FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

/** 本机第一个非回环 IPv4。找不到就返回 null——调用方必须据此说「没验」，不能当成通过。 */
function lanIPv4() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      // Node 18+ 的 family 可能是数字 4，也可能是字符串 "IPv4"，两种都认。
      if ((ni.family === "IPv4" || ni.family === 4) && !ni.internal) return ni.address;
    }
  }
  return null;
}

/** 真去连一次：连得上 true，连不上/超时 false。 */
function canConnect(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(ms);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/**
 * 门禁**注入**时钟，绝不用真时钟。
 *
 * 用真时钟的话，「未解锁 → 404」这条断言会在 2026-10-05T00:00:00+08:00 开门那一刻
 * 自动失效，标准门禁在礼物当天变红——而人在当天看到红门禁，最可能做的反应
 * 就是把闸门删掉。门禁不能自己给自己判死刑。
 *
 * 取样点写死绝对 epoch，不从被测常量推导：推导出来的取样点会让断言自指，
 * 开门时刻被改成「提前 8 小时」时整套测试仍然全绿。
 */
const JUST_BEFORE = 1791129600000 - 1000; // 2026-10-05T00:00+08:00 前 1 秒
const AT_UNLOCK = 1791129600000; // 2026-10-05T00:00+08:00 整

// ---- 依赖 ----
for (const dep of ["express", "multer", "sharp", "node:sqlite"]) {
  try {
    await import(dep);
    must(`依赖 ${dep}`, true);
  } catch (e) {
    must(`依赖 ${dep}`, false, e.message);
  }
}

// 开门时刻是绝对值，写死在这里对着——门禁自己也得钉住它，
// 不能只靠单元测试。改错 8 小时就是提前开门，礼物当天直接作废。
const { UNLOCK_AT, UNLOCK_LABEL } = await import("../src/clock.js");
must(`开门时刻 epoch == 1791129600000（东八区 ${UNLOCK_LABEL}）`, UNLOCK_AT === AT_UNLOCK, "实际 " + UNLOCK_AT);

if (failed) {
  console.error("依赖缺失或开门时刻不对，先跑 npm install / 检查 src/clock.js");
  process.exit(1);
}

// ---- 服务可启动 ----
/**
 * 口令**必须在建 app 之前**注入。src/auth.js 没有缺省值了：拿不到就抛，
 * 进程起不来。门禁自己也不例外 —— 下面的 server.js 子进程同样要显式给。
 * 值取 test/helpers.js 的人造测试口令（那里还有一条断言挡着「别把真生日当测试值」）。
 *
 * ⚠️ **但不能用 `useTestSecrets()` 在本文件里注入** —— auth.js 的 `BIRTH_YEAR`
 *    在**模块顶层**求值，而 ESM 的 import 先于本文件任何顶层代码执行，
 *    这里的调用永远晚一步。注入必须用 `node --import ./test/preload-secrets.mjs`，
 *    见 package.json 的 boot 脚本。
 *
 * 这里仍然 import 它，是为了复用那份「别拿真生日当测试值」的断言。
 */
void useTestSecrets; // 注入由 --import 完成；这里只借用它的断言。

const { createApp } = await import("../src/app.js");
const { openDb } = await import("../src/db.js");

const dir = mkdtempSync(path.join(tmpdir(), "two-years-gate-"));
let server;
let db;
try {
  db = openDb(path.join(dir, "gate.db"));
  must("空目录自动建库", true);

  server = createApp({ db, now: () => JUST_BEFORE, dataDir: dir }).listen(0, "127.0.0.1");
  await once(server, "listening");
  must("真 HTTP 监听", true);

  // ---- dataDir 是必填的：漏传必须**当场**炸，而不是默默写进某个默认目录 ----
  //
  // 真实事故：dataDir 早先有默认值 path.join(ROOT, "data")。测试与门禁里的
  // createApp 都没传它，于是观察者的签名密钥被写进了那个目录。在服务器上
  // ROOT 就是 /opt/two-years，也就是**生产数据目录**；以 root 跑一次门禁，
  // 那个文件就成了 root:root 600，服务随后以 two-years 身份起不来，生产停摆。
  //
  // 这条断言的判别力：把 dataDir 的必填检查去掉，它立刻就红。
  let reason2 = "";
  try {
    createApp({ db, now: () => JUST_BEFORE });
    reason2 = "createApp 漏传 dataDir 竟然不报错——默认值又回来了";
  } catch (e) {
    if (!/dataDir/.test(String(e?.message))) reason2 = `报的不是 dataDir，是：${e?.message}`;
  }
  must("漏传 dataDir 时 createApp 当场拒绝启动（默认值曾把密钥写进生产目录）", !reason2, reason2);

  const base = "http://127.0.0.1:" + server.address().port;

  const me = await fetch(base + "/api/me");
  must("无会话 /api/me → 401", me.status === 401, "实际 " + me.status);

  // 闸门必须同时满足两侧，缺一不可：
  //   锁住 → 404（证明闸门在关）
  //   开门 → 200（证明闸门后面确实有路由，而不是「路由不存在」蒙出来的 404）
  // 只断言前半句的话，把闸门整个删掉门禁照样绿。
  const lockedShared = await fetch(base + "/api/shared");
  must("未解锁 /api/shared → 404", lockedShared.status === 404, "实际 " + lockedShared.status);

  const lockedWish = await fetch(base + "/api/wish");
  must("未解锁 /api/wish → 404", lockedWish.status === 404, "实际 " + lockedWish.status);

  const upper = await fetch(base + "/API/SHARED");
  must("未解锁 /API/SHARED → 404（大小写绕不过去）", upper.status === 404, "实际 " + upper.status);

  // 换到开门那一刻：必须放行。这一侧用真时钟是验不出来的。
  const door = server.close();
  await door;
  server = createApp({ db, now: () => AT_UNLOCK, dataDir: dir }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base2 = "http://127.0.0.1:" + server.address().port;

  // 开门后**匿名**仍然不许读到共同层：公网 IP + 裸 HTTP，扫到端口就能打到这里。
  // 工单 04 复审 HIGH-1 就是这么漏的——曾经无鉴权直接 200。
  const anonOpen = await fetch(base2 + "/api/shared");
  must("已开门 /api/shared 匿名 → 401（共同层不是公开资源）", anonOpen.status === 401, "实际 " + anonOpen.status);

  // 登录后才可达。
  const loginRes = await fetch(base2 + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD }),
  });
  const sid = (loginRes.headers.getSetCookie?.() ?? []).find((h) => h.startsWith("sid="))?.split(";")[0] ?? "";
  const openShared = await fetch(base2 + "/api/shared", { headers: { cookie: sid } });
  must("已开门 /api/shared 登录后 → 200", openShared.status === 200, "实际 " + openShared.status);

  // 约定也一样：开门后匿名不许读
  const anonWish = await fetch(base2 + "/api/wish");
  must("已开门 /api/wish 匿名 → 401", anonWish.status === 401, "实际 " + anonWish.status);
  const openWish = await fetch(base2 + "/api/wish", { headers: { cookie: sid } });
  must("已开门 /api/wish 登录后 → 200", openWish.status === 200, "实际 " + openWish.status);

  // 未解锁时约定**写侧是开的**（SPEC §四：她要能提前写）。写侧只影响自己的数据。
  const early = await fetch(base2 + "/api/wish", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sid },
    body: JSON.stringify({ text: "一起去海边" }),
  });
  must("未开门 POST /api/wish → 2xx（她要能提前写）", early.status >= 200 && early.status < 300, "实际 " + early.status);
} catch (e) {
  must("服务启动", false, e.message);
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (db) db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---- 照片目录不得落在静态根里 ----
// DATA_DIR 是环境变量，任何一次指向 public/ 内的部署都会让照片零鉴权直出。
// 这里真造一个「库文件在静态根内」的实例，确认服务**拒绝启动**。
{
  const badPublic = mkdtempSync(path.join(tmpdir(), "two-years-badpublic-"));
  let reason = "";
  let badDb = null;
  try {
    badDb = openDb(path.join(badPublic, "two-years.db"));
    const s = createApp({ db: badDb, publicDir: badPublic, dataDir: dir }).listen(0, "127.0.0.1");
    s.close();
    reason = "服务照常启动了，照片目录的自检形同虚设";
  } catch (e) {
    reason = e.message || "";
  } finally {
    // Windows 上文件还开着就删不掉，必须先关库
    if (badDb) {
      try {
        badDb.close();
      } catch {}
    }
  }
  must(
    "库文件落在静态根里时服务拒绝启动（照片不会被零鉴权直出）",
    /静态资源目录/.test(reason),
    reason,
  );
  rmSync(badPublic, { recursive: true, force: true });
}

if (failed) {
  console.error("门禁未通过");
  process.exit(1);
}

// ---- 生产入口 src/server.js ----
// createApp 跑得通不代表 server.js 跑得通：端口、data 目录、照片 700 权限、信号处理
// 都在这个文件里，而 10-5 当天跑的就是它。真起一个子进程探活。
{
  const runDir = mkdtempSync(path.join(tmpdir(), "two-years-srv-"));
  const port = 18000 + Math.floor(Math.random() * 2000);
  // ⚠️ 三个凭据必须显式注入。src/auth.js 与 src/observer-auth.js 现在**没有缺省值**，
  //    只给 PORT / DATA_DIR 的子进程会在 ensureCredentials 那里抛、一行日志都打不出来 ——
  //    于是「生产入口能起真监听」这条会红在一个与端口、权限、信号都无关的地方。
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: runDir,
      DOOR_PASSWORD: TEST_SECRET.DOOR_PASSWORD,
      HERO_PASSWORD: TEST_SECRET.HERO_PASSWORD,
      OBSERVER_PASSWORD: TEST_SECRET.OBSERVER_PASSWORD,
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: path.resolve(ROOT),
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b.toString()));
  child.stderr.on("data", (b) => (out += b.toString()));

  const alive = await Promise.race([
    new Promise((res) => setTimeout(() => res(false), 8000)),
    new Promise((res) => {
      const tick = setInterval(async () => {
        if (out.includes("listening on")) {
          clearInterval(tick);
          res(true);
        }
      }, 100);
    }),
  ]).finally(() => {});

  let status = null;
  if (alive) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`);
      status = r.status;
    } catch {}
  }
  must("生产入口 src/server.js 能起真监听", alive && status === 200, out.trim().slice(0, 400));
  must("启动时自动建出 data/ 与 photos 目录", existsSync(path.join(runDir, "photos")));

  // ---- 绑定地址：默认必须是回环，且**实测**外部连不上 ----
  //
  // 部署形态是 nginx 在同一台机器上反代。绑 0.0.0.0 等于在公网 IP 上另开一个
  // 裸 HTTP 入口：浏览器可以直接打 http://<公网IP>:8300 绕开证书，那时
  // src/auth.js 的 isSecureRequest 判定为明文、cookie 不带 Secure，凭据明文发一次。
  //
  // 光断言「默认值是 127.0.0.1」是查字符串，证明不了运行时行为。这里真去连
  // 本机的非回环 IPv4：绑回环时必然连不上，绑 0.0.0.0 时必然连得上——
  // 两条实现可区分，这条断言才有判别力。
  if (alive) {
    const lan = lanIPv4();
    if (lan) {
      const reachable = await canConnect(lan, port);
      must(
        `非回环地址 ${lan} 连不上（绑的是回环，不是 0.0.0.0）`,
        !reachable,
        "外部能直连 = 公网上的裸 HTTP 入口，HTTPS 被绕开",
      );
    } else {
      // 没有非回环 IPv4（WSL、部分容器网络）就**明说没验**，不假装通过。
      console.log("  SKIP 本机没有非回环 IPv4，「外部连不上」这半条未验证");
    }
    must("日志里写的是实际绑的地址", out.includes("listening on 127.0.0.1:"), out.trim().slice(0, 200));
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  if (!child.killed) child.kill("SIGKILL");
  rmSync(runDir, { recursive: true, force: true });
}

if (failed) {
  console.error("门禁未通过");
  process.exit(1);
}
console.log("boot OK — 服务起得来，生产入口起得来，时间锁闸门在关");
