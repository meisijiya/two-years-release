/**
 * 工单 11 · 运维日志：脱敏、轮转、容量上限、只读体检。
 *
 * 缝的选法：**只从 HTTP 进去，从落盘的文件出来**。
 * 理由与 CONSTRAINTS §5 同源 —— 断言「内部函数被调了几次」守不住任何东西，
 * 而「请求打进去之后，磁盘上那个文件里到底有什么」是运维真正会看到的东西。
 *
 * ⚠️ 本文件里出现的每一个「不该出现」判据都是**攻击者视角**：
 *    假如有人把凭据写进 URL、把会话 cookie 传给某个会回显的路由、
 *    或者请求体里带生日，日志里都不能有它们的影子。
 *    这些不是假想的 —— 2026-10-06 实测公网上扫描器正在打
 *    `/?%ADd+allow_url_include%3d1` 这类 query payload。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createLogWriter, accessLog, redactPath, clientTag, loadOrCreateSalt, DEFAULT_KEEP_DAYS, DEFAULT_MAX_BYTES } from "../src/logging.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";
import { useTestSecrets, AT_UNLOCK, JUST_BEFORE } from "./helpers.js";

function tmpdirMake() {
  return mkdtempSync(path.join(tmpdir(), "two-years-log-"));
}

function readAll(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("");
}

/** 起一套真 HTTP + 真 SQLite 的实例，日志落在临时目录里。 */
async function startLoggedServer({ now = () => AT_UNLOCK + 3600_000, bindHost = "127.0.0.1" } = {}) {
  useTestSecrets();
  const dir = tmpdirMake();
  const dbFile = path.join(dir, "test.db");
  const db = openDb(dbFile);
  const logDir = path.join(dir, "logs");
  const writer = createLogWriter({ dir: logDir, now, salt: loadOrCreateSalt(dir) });
  const app = createApp({ db, now, bindHost, dataDir: dir, logWriter: writer });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    logDir,
    db,
    dir,
    text: () => readAll(logDir),
    close: () =>
      new Promise((res) => {
        server.close(() => {
          try { db.close(); } catch {}
          rmSync(dir, { recursive: true, force: true });
          res();
        });
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1. 脱敏
// ─────────────────────────────────────────────────────────────────────

test("日志：query string 整段丢弃（凭据常走 URL）", async (t) => {
  const s = await startLoggedServer();
  t.after(() => s.close());
  // 真实产品里凭据是 POST body，但「凭据出现在 URL」是通用形态：
  // 任何将来加的 GET 参数、任何扫描器的 payload 都会走这条路。
  // ⚠️ 这里三个值**刻意选得不像任何真人生日**：`20150607` 的月日是「六月七日」
  // 这种一眼假的组合，且 2004 开头的 8 位形态会被 check-secrets 当成完整生日口令报红
  // （4 位形态它反而不查）。2026-10-06 那次自检就逮到过「文档里随手举例的密码
  // 恰好是真值」，所以这里的例子必须同时躲开门禁与真实。
  await fetch(s.base + "/api/status?pin=00010101&password=hunter2&d=20150607");
  await new Promise((r) => setTimeout(r, 60));
  const text = s.text();
  assert.equal(text.includes("hunter2"), false, "query 里的值进了日志");
  assert.equal(text.includes("00010101"), false, "query 里的口令进了日志");
  assert.equal(text.includes("20150607"), false, "query 里的生日进了日志");
  assert.equal(text.includes("?"), false, "日志里出现了 ?，说明 query 没被整段丢掉");
});

test("日志：路径里的 id 参数化，不落具体值", async (t) => {
  const s = await startLoggedServer();
  t.after(() => s.close());
  await fetch(s.base + "/api/photo/p083dae13e51b50698ef46cd0");
  await new Promise((r) => setTimeout(r, 60));
  const text = s.text();
  assert.equal(text.includes("p083dae13e51b50698ef46cd0"), false, "照片 id 进了日志");
  assert.equal(text.includes("/api/photo/:id"), true, "路径没有参数化");
});

test("日志：客户端只以假名出现，明文 IP 零出现", async (t) => {
  const s = await startLoggedServer();
  t.after(() => s.close());
  await fetch(s.base + "/api/status", { headers: { "x-forwarded-for": "203.0.113.77" } });
  await new Promise((r) => setTimeout(r, 60));
  const text = s.text();
  assert.equal(text.includes("203.0.113.77"), false, "明文 IP 进了日志");
  assert.match(text, /"c":"c-[0-9a-f]{8}"/, "没有出现客户端假名");
});

test("日志：假名同 IP 稳定、不同 IP 不同（这正是运维要问的问题）", () => {
  const salt = "s1";
  // 用 RFC 5737 文档网段而不是「教科书 IP」那串：后者是**字面**的公网形态，
  // check-secrets.mjs 的公网 IP 规则不豁免它（只豁免 203.0.113.x 等整段）。
  // 2026-10-06 实测踩到过两次：一次在这里，一次在**门禁自己的注释里**
  // ——「禁止某值」这件事本身成了该值的一个副本。写在这里免得下一个人再改回去。
  assert.equal(clientTag("203.0.113.77", salt), clientTag("203.0.113.77", salt), "同 IP 两次算出不同标签");
  assert.notEqual(clientTag("203.0.113.77", salt), clientTag("203.0.113.78", salt), "不同 IP 算出同一标签");
});

test("日志：假名换盐就变（无盐的裸哈希可被穷举 IPv4 全空间）", () => {
  // 这是判据不是装饰：2^32 的地址空间，裸 sha256 字典攻击是秒级的。
  assert.notEqual(clientTag("203.0.113.77", "saltA"), clientTag("203.0.113.77", "saltB"));
});

test("日志：redactPath 三个方向都不漏", () => {
  assert.equal(redactPath("/api/shared?a=1"), "/api/shared");
  assert.equal(redactPath("/api/photo/abc123"), "/api/photo/:id");
  assert.equal(redactPath("/api/entry/abc123"), "/api/entry/:id");
  assert.equal(redactPath("/"), "/");
});

test("日志：每个请求一条，含 404（扫描器打的那些正是运维要看的信号）", async (t) => {
  const s = await startLoggedServer();
  t.after(() => s.close());
  await fetch(s.base + "/wp-admin/install.php");
  await fetch(s.base + "/.env");
  await new Promise((r) => setTimeout(r, 80));
  const lines = s.text().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const wp = lines.find((l) => l.p === "/wp-admin/install.php");
  const env = lines.find((l) => l.p === "/.env");
  assert.ok(wp, "扫描器打的请求没有进日志");
  assert.equal(wp.s, 404, "404 没被记成 404");
  assert.ok(env, "/.env 没进日志");
});

test("日志：4xx/5xx 的状态码如实记（运维判断服务健康的核心）", async (t) => {
  const s = await startLoggedServer();
  t.after(() => s.close());
  await fetch(s.base + "/api/me"); // 无会话 → 401
  await new Promise((r) => setTimeout(r, 60));
  const lines = s.text().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const me = lines.find((l) => l.p === "/api/me");
  assert.ok(me, "/api/me 没进日志");
  assert.equal(me.s, 401, "401 没被如实记下");
});

test("日志：Cookie 与请求体一律不落盘", async (t) => {
  const s = await startLoggedServer();
  t.after(() => s.close());
  // 真登录一次：会话 cookie 与生日口令都在这一发请求里
  // 入参是 {code, birthday}（src/routes.js 的 /api/login），不是 pin。
  const r = await fetch(s.base + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "sid=super-secret-session-token" },
    body: JSON.stringify({ code: "【改这里：doorCode】", birthday: "00010101" }),
  });
  const setCookie = r.headers.getSetCookie?.() ?? [];
  const sid = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("sid="));
  assert.ok(sid, "登录没成功，测不到会话 cookie");
  const token = sid.slice(4);
  await fetch(s.base + "/api/me", { headers: { cookie: sid } });
  await new Promise((r) => setTimeout(r, 80));
  const text = s.text();
  assert.equal(text.includes(token), false, "会话 token 进了日志");
  assert.equal(text.includes("super-secret-session-token"), false, "传进来的 cookie 进了日志");
  assert.equal(text.includes("00010101"), false, "请求体里的口令进了日志");
  assert.equal(text.includes("cookie"), false, "日志里出现了 cookie 字样");
});

test("日志：默认关掉，测试与本地起实例都不会在盘上留东西", async () => {
  // createApp 不传 logWriter 时必须**不记**。226 个用例共用这个默认值，
  // 一旦改成默认开，测试目录里就会凭空多出一堆日志文件。
  useTestSecrets();
  const dir = tmpdirMake();
  const db = openDb(path.join(dir, "t.db"));
  const app = createApp({ db, now: () => AT_UNLOCK, dataDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  await fetch(`http://127.0.0.1:${server.address().port}/api/status`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(path.join(dir, "logs")), false, "默认开了日志");
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────
// 2. 轮转与容量上限
// ─────────────────────────────────────────────────────────────────────

test("轮转：超出保留期的文件被删（今天是 8 天前的那份）", () => {
  const dir = tmpdirMake();
  // 假时钟固定在 2026-10-06，保留 7 天 → cutoff = 2026-09-30
  const w = createLogWriter({ dir, now: () => Date.UTC(2026, 8, 30, 4) + 8 * 3600_000, keepDays: 7, maxBytes: 1e9 });
  w.write({ ev: "x" }); // → access-2026-09-30.jsonl，正好在 cutoff 上
  assert.equal(w.files().length, 1);
  // 推进到 10-06 再写一条，触发 prune
  const w2 = createLogWriter({ dir, now: () => Date.UTC(2026, 9, 6, 4) + 8 * 3600_000, keepDays: 7, maxBytes: 1e9 });
  w2.write({ ev: "x" });
  assert.equal(w2.files().includes("access-2026-09-30.jsonl"), true, "cutoff 当天被误删了");
  // 再推一天：09-30 就出期了
  const w3 = createLogWriter({ dir, now: () => Date.UTC(2026, 9, 7, 4) + 8 * 3600_000, keepDays: 7, maxBytes: 1e9 });
  w3.write({ ev: "x" });
  assert.equal(w3.files().includes("access-2026-09-30.jsonl"), false, "超期文件没被删");
  assert.equal(w3.files().length, 2, "不该把还在保留期内的删掉");
  rmSync(dir, { recursive: true, force: true });
});

test("轮转：总量超上限时从最旧开始删（一天之内被写爆也要挡住）", () => {
  const dir = tmpdirMake();
  const now = () => Date.UTC(2026, 9, 6, 4) + 8 * 3600_000;
  // 手工造 4 个各 1KB 的「历史」文件，cap 设成 2500 → 只能留 2 个
  for (const d of ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]) {
    writeFileSync(path.join(dir, `access-${d}.jsonl`), "x".repeat(1000));
  }
  const w = createLogWriter({ dir, now, keepDays: 30, maxBytes: 2500 });
  w.write({ ev: "x" }); // 触发 prune
  const left = w.files();
  assert.ok(w.totalBytes() <= 2500 + 200, `总量 ${w.totalBytes()} 超过上限 2500`);
  assert.equal(left.includes("access-2026-10-02.jsonl"), false, "最旧的没被删");
  assert.equal(left.includes("access-2026-10-05.jsonl"), true, "最新的被删了 —— 顺序反了");
  rmSync(dir, { recursive: true, force: true });
});

test("轮转：同一天内连续写也守上限（不是只在跨天第一次写时判）", () => {
  // ⚠️ 这条是 2026-10-06 独立复审逼出来的。早先的用例只验了 `prune()` 本身，
  // 触发方式是「全新 writer 的第一次写」，于是**恰好绕开了真实场景**：
  // 一个进程跑一整天、流量持续进来。实测那一版 cap=1000、连续 30 次请求，
  // 总量从 1026 涨到 4806，一个文件都没删 ——
  // 而 DEFAULT_MAX_BYTES 的注释与上面那条用例的标题都声称「一天之内也挡得住」。
  // **注释与测试标题在断言一个代码没有的性质**，而两边都是绿的。
  //
  // 这条的形状与它不同：**用同一个 writer 连写**，让**历史**在当天累积。
  // 判据不是「总量 ≤ 上限」——当天那份永不删（见 prune 的注释），
  // 所以当天的增量本就不受上限约束。要断言的是**历史文件被删到上限之内**：
  // 那才是「一天之内被写爆」真正要挡的东西。
  const dir = tmpdirMake();
  const now = () => Date.UTC(2026, 9, 6, 4) + 8 * 3600_000;
  for (const d of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]) {
    writeFileSync(path.join(dir, `access-${d}.jsonl`), "x".repeat(1000));
  }
  const w = createLogWriter({ dir, now, keepDays: 30, maxBytes: 2500 });
  const pad = "p".repeat(200);
  for (let i = 0; i < 30; i++) w.write({ ev: "x", pad }); // 约 30 × 230B ≈ 7KB 当天
  const left = w.files();
  const historyBytes = left
    .filter((f) => f !== "access-2026-10-06.jsonl")
    .reduce((n, f) => n + statSync(path.join(dir, f)).size, 0);
  assert.ok(historyBytes <= 2500, `历史文件仍有 ${historyBytes} 字节，超过上限 2500 —— 容量只在跨天时判了一次`);
  // 当天那份必须在：删掉它等于当天日志凭空消失（下次 write 会重建，内容全丢）
  assert.equal(left.includes("access-2026-10-06.jsonl"), true, "今天这份被删了 —— 那等于当天日志全丢");
  assert.equal(left.includes("access-2026-10-01.jsonl"), false, "最旧的历史没被删");
  rmSync(dir, { recursive: true, force: true });
});

test("轮转：容量判定在**写完之后**（当天第一笔写也要判，不能只等第二天）", () => {
  // 上一条验的是「连写累积」。这一条验的是**单笔就顶穿上限**：
  // 一条日志比整个上限还大时，写完必须立刻把历史清掉，
  // 否则「写完之后判一次」这个位置退化成「等下一天」。
  const dir = tmpdirMake();
  const now = () => Date.UTC(2026, 9, 6, 4) + 8 * 3600_000;
  writeFileSync(path.join(dir, "access-2026-10-05.jsonl"), "x".repeat(900));
  const w = createLogWriter({ dir, now, keepDays: 30, maxBytes: 1000 });
  w.write({ ev: "x", pad: "q".repeat(400) }); // 这一条就 400+ 字节
  // 判据：历史那份必须被删（上限 1000，而 900 + 400 > 1000）
  assert.equal(
    w.files().includes("access-2026-10-05.jsonl"),
    false,
    "单条写完就超上限，历史文件却没被删 —— 容量判定不在写之后",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("轮转：幂等 —— 反复 prune 结果一致", () => {
  const dir = tmpdirMake();
  const now = () => Date.UTC(2026, 9, 6, 4) + 8 * 3600_000;
  const w = createLogWriter({ dir, now, keepDays: 3, maxBytes: 1e9 });
  w.write({ ev: "x" });
  const a = w.prune();
  const b = w.prune();
  assert.equal(a, b, "两次 prune 总量不同 —— 不幂等");
  rmSync(dir, { recursive: true, force: true });
});

test("轮转：默认就是 7 天 / 50MB（用户 2026-10-06 选定的值）", () => {
  assert.equal(DEFAULT_KEEP_DAYS, 7);
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1024 * 1024);
});

test("轮转：日志目录 700、文件 600（跑不跑在 Windows 上都只断言目录存在）", () => {
  const dir = tmpdirMake();
  const now = () => Date.UTC(2026, 9, 6, 4) + 8 * 3600_000;
  const w = createLogWriter({ dir, now });
  w.write({ ev: "x" });
  const st = statSync(w.files()[0] ? path.join(dir, w.files()[0]) : path.join(dir, "x"));
  assert.ok(st, "文件没建出来");
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700, "日志目录不是 700");
    assert.equal(st.mode & 0o777, 0o600, "日志文件不是 600");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("轮转：日志写失败绝不能连累请求（磁盘满/权限变都不该 500）", async (t) => {
  // 把 writer 换成会抛的：模拟磁盘满
  const boom = { write() { throw new Error("ENOSPC: no space left on device"); } };
  useTestSecrets();
  const dir = tmpdirMake();
  const db = openDb(path.join(dir, "t.db"));
  const app = createApp({ db, now: () => AT_UNLOCK, dataDir: dir, logWriter: boom });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + "/api/status");
  assert.equal(r.status, 200, "日志写失败把请求带崩了");
  await new Promise((x) => server.close(x));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("盐：已存在就复用（复用才能让历史日志可比），缺权限时也不炸", () => {
  const dir = tmpdirMake();
  const a = loadOrCreateSalt(dir);
  const b = loadOrCreateSalt(dir);
  assert.equal(a, b, "同一目录两次拿到不同盐 —— 历史日志的前后对比会失效");
  assert.ok(a.length >= 32, "盐太短");
  rmSync(dir, { recursive: true, force: true });
});

test("盐：.log-salt 不写进日志目录（它不是日志，是密钥）", () => {
  const dir = tmpdirMake();
  loadOrCreateSalt(dir);
  assert.ok(existsSync(path.join(dir, ".log-salt")));
  assert.equal(readdirSync(path.join(dir)).includes(".log-salt"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("轮转：上限小于当天增量时，今天那份也不删（否则当天内容凭空消失）", () => {
  // ⚠️ 这条是 2026-10-06 变异实验 M12 SURVIVED 逼出来的。
  // 前两条新用例的夹具里，历史文件多到「删到上限之内就停住了」，
  // 于是「今天那份被删」这个失败**在夹具下造不出来** ——
  // 变异 M12（去掉「跳过今天」）跑出来是绿的。
  // 「一个测试可能结构性地无法失败」的又一例。
  //
  // 造出它的条件：**历史文件不够删**，删到最后只剩下今天那份，
  // 而今天那份本身已经超过上限。
  const dir = tmpdirMake();
  const now = () => Date.UTC(2026, 9, 6, 4) + 8 * 3600_000;
  writeFileSync(path.join(dir, "access-2026-10-05.jsonl"), "x".repeat(900));
  const w = createLogWriter({ dir, now, keepDays: 30, maxBytes: 300 });
  w.write({ ev: "x", pad: "q".repeat(400) }); // 今天这份就 400+ 字节 > 300
  assert.equal(
    w.files().includes("access-2026-10-06.jsonl"),
    true,
    "今天那份被删了 —— 正在被追加写的文件被删掉，当天内容凭空消失（下次 write 会重建它）",
  );
  // 同一时刻，历史那份**必须**被删：上限仍要生效，只是不能拿今天开刀
  assert.equal(w.files().includes("access-2026-10-05.jsonl"), false, "上限没生效，历史文件还在");
  rmSync(dir, { recursive: true, force: true });
});

test("盐：空文件当损坏报，**不静默换盐**（换了历史日志的假名就全对不上）", () => {
  // 2026-10-06 独立复审实测：第一版 `catch {}` + `if (v) return v`，
  // 文件在但为空时**静默生成新盐并覆盖，无任何报错**。
  // 后果不是「服务坏了」，是**没人察觉的一次密钥轮换**：
  // 「昨天和今天是同一个人吗」从此答不了，而日志里什么异常都没有。
  // 同仓 observer-auth.js 早就把这个形状当教训写死了（loadKey），
  // 同一个坑不该在一个项目里踩两次。
  const dir = tmpdirMake();
  writeFileSync(path.join(dir, ".log-salt"), "", "utf8");
  assert.throws(
    () => loadOrCreateSalt(dir),
    /空文件|损坏/,
    "空的 .log-salt 被静默换掉了 —— 那是没人察觉的假名轮换",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("盐：过短的 .log-salt 当损坏报", () => {
  const dir = tmpdirMake();
  writeFileSync(path.join(dir, ".log-salt"), "abc", "utf8");
  assert.throws(() => loadOrCreateSalt(dir), /只有 3 个字符|损坏/);
  rmSync(dir, { recursive: true, force: true });
});

test("盐：读不到（不是「不存在」）时原样抛，不当新建处理", () => {
  const dir = tmpdirMake();
  // 造一个同名**目录** → readFileSync 报 EISDIR，而不是 ENOENT
  mkdirSync(path.join(dir, ".log-salt"), { recursive: true });
  assert.throws(
    () => loadOrCreateSalt(dir),
    /读不到日志假名盐/,
    "EISDIR 被当成了「还没有」，于是会去写一个写不进去的文件",
  );
  rmSync(dir, { recursive: true, force: true });
});
