/**
 * 工单 01 · 骨架与门禁 —— 真 HTTP、真 SQLite、真开门常量。
 * 全部从外部可观察：HTTP 状态码、响应体、数据库里真实的表。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { startTestServer, client, JUST_BEFORE, AT_UNLOCK, TEST_SECRET } from "./helpers.js";
import { UNLOCK_AT } from "../src/clock.js";
import { openDb, BUSY_TIMEOUT_MS } from "../src/db.js";

/** 把 epoch 换算成东八区字段；只读 getUTC*，所以结果与运行机器的时区无关 */
function asEast8(epoch) {
  const d = new Date(epoch + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

test("开门时刻是东八区 2026-10-05T00:00:00", () => {
  assert.equal(asEast8(UNLOCK_AT), "2026-10-05 00:00:00");
});

test("开门判定不随运行机器的时区变化", () => {
  // 在子进程里真的调 isUnlocked，而不是只把一个 number 换个时区重新格式化。
  // 只有判定逻辑本身在 TZ=UTC / America/New_York / Asia/Shanghai 下给同样结果，
  // 才说明它没读设备时区。
  const script = `
    import(${JSON.stringify(new URL("../src/clock.js", import.meta.url).href)}).then(m => {
      const probe = [m.UNLOCK_AT - 1, m.UNLOCK_AT, m.UNLOCK_AT + 1].map(m.isUnlocked).join(",");
      process.stdout.write(m.UNLOCK_AT + "|" + probe + "|" + m.countdown(m.UNLOCK_AT - 86400000).days);
    })`;
  const expected = `${UNLOCK_AT}|false,true,true|1`;
  for (const tz of ["UTC", "America/New_York", "Asia/Shanghai", "Pacific/Kiritimati"]) {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    });
    assert.equal(r.status, 0, `TZ=${tz} 跑不起来: ${r.stderr}`);
    assert.equal(r.stdout, expected, `TZ=${tz} 的开门判定与其他时区不一致`);
  }
});

test("建库后七张表都在，两个代号已就位", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const tables = s.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  assert.deepEqual(tables, [
    "entry",
    "login_fail",
    "person",
    "photo",
    "session",
    "shared",
    "wish",
  ]);

  const people = s.db.prepare("SELECT id, code FROM person ORDER BY id").all();
  assert.deepEqual(people.map((p) => ({ id: p.id, code: p.code })), [
    { id: "door", code: "【改这里：doorCode】" },
    { id: "hero", code: "【改这里：heroCode】" },
  ]);
});

test("无会话时 /api/me 返 401", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const c = client(s.base);

  const res = await c.get("/api/me");
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "no_session");
});

test("/api/status 跟着注入的时钟走", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const c = client(s.base);

  s.setNow(JUST_BEFORE);
  let r = await c.get("/api/status");
  assert.equal(r.status, 200);
  assert.equal(r.body.unlocked, false);
  assert.equal(r.body.unlockAt, AT_UNLOCK);

  s.setNow(AT_UNLOCK);
  r = await c.get("/api/status");
  assert.equal(r.body.unlocked, true, "整点就开门，不多等一毫秒");
});

test("时间锁闸门可被证伪：锁住 404，开门 200", async (t) => {
  // 两侧都断言，缺一不可。
  // 只断言「未解锁 → 404」的话，闸门整个删掉测试照样绿：那个 404 来自
  // 「路由不存在」，不是「闸门挡住」，两者不可区分。
  const s = await startTestServer();
  t.after(() => s.close());
  const c = client(s.base);

  s.setNow(JUST_BEFORE);
  for (const p of ["/api/shared", "/api/wish"]) {
    const res = await c.get(p);
    assert.equal(res.status, 404, `${p} 在未解锁时不该存在`);
  }

  s.setNow(AT_UNLOCK);
  // 开门后这两条也要有会话才可达：未鉴权的 200 就是共同层泄漏（工单 04 复审 HIGH-1）。
  await c.post("/api/login", { code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD });
  for (const p of ["/api/shared", "/api/wish"]) {
    const res = await c.get(p);
    assert.equal(res.status, 200, `${p} 开门后必须可达——否则上面的 404 证明不了闸门`);
  }
});

test("闸门不能用路径大小写绕过去", async (t) => {
  // Express 路由默认大小写不敏感；闸门若用大小写敏感的前缀比较，
  // `/API/SHARED` 会直接命中真实路由，把内容漏出去。
  const s = await startTestServer();
  t.after(() => s.close());
  const c = client(s.base);

  s.setNow(JUST_BEFORE);
  for (const p of ["/API/shared", "/Api/Shared", "/api/WISH", "/api/shared/"]) {
    const res = await c.get(p);
    assert.equal(res.status, 404, `${p} 绕过了闸门`);
  }
});

/* ====================================================================== *
 * 抢不到锁时会等，而不是当场死
 *
 * SQLite 的 busy_timeout 缺省是 **0**：抢不到锁立刻抛 database is locked。
 * 生产是单进程（systemd 只 ExecStart 一个 node），本来碰不到；但这两种情况会：
 *   1. systemd 重启时旧进程还没退干净，新进程先起来 —— 启动失败，
 *      而且错在启动，日志里是「database is locked」，看不出跟什么有关。
 *   2. 按 RUNBOOK §4 手改 wish 表时忘了 systemctl stop。
 * 两条都发生在 10-5 当天，且都不该以「起不来」收场。
 *
 * 这条测试**真的制造竞争**：子进程握着一把排他锁，主进程同时写。
 * busy_timeout=0 时主进程会当场抛错；设了才会等。
 * ====================================================================== */

const holdLock = `
  const { DatabaseSync } = require("node:sqlite");
  // 注意：\`node -e "code" arg\` 的 process.argv[1] 就是第一个用户参数
  // （\`node script.js arg\` 才是 argv[2]）——写错下标这里会拿到 undefined。
  const db = new DatabaseSync(process.argv[1]);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("BEGIN EXCLUSIVE");
  process.stdout.write("locked\\n");
  setTimeout(() => { db.exec("COMMIT"); db.close(); }, 1200);
`;

test("另一个连接握着排他锁时，写操作会等锁而不是当场抛 database is locked", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "two-years-busy-"));
  const file = path.join(dir, "busy.db");
  const db = openDb(file);
  /** 收尾必须一个钩子做完：子进程还开着库文件时删目录会 EPERM。 */
  let child = null;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once("exit", r));
    }
    try {
      db.close();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });

  // 真的读回这个连接上的设置，而不是断言源码里有这行 pragma
  assert.equal(
    db.prepare("PRAGMA busy_timeout").get().timeout,
    BUSY_TIMEOUT_MS,
    "这条连接上没设上 busy_timeout",
  );

  // 子进程握排他锁 1.2 秒
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", holdLock, file], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (b) => String(b).includes("locked") && resolve());
    child.on("error", reject);
    setTimeout(() => reject(new Error("子进程没拿到锁")), 8000);
  });

  // 此刻锁被别人握着。这句在 busy_timeout=0 时是**立刻**抛的。
  const t0 = Date.now();
  db.prepare("INSERT INTO person(id, code, role) VALUES('probe','探针','角色')").run();
  const waited = Date.now() - t0;

  assert.ok(
    waited >= 300,
    `等了 ${waited}ms——太短，说明并没有真在等锁（busy_timeout 可能没生效）`,
  );
  assert.equal(
    db.prepare("SELECT code FROM person WHERE id='probe'").get().code,
    "探针",
    "等完之后这条写入必须真的落到库里，不能只是没抛异常",
  );
  t.diagnostic(`等锁 ${waited}ms 后写入成功（上限 ${BUSY_TIMEOUT_MS}ms）`);
});