/**
 * 工单 02 · 时间锁·文字层 —— 后端线。
 *
 * 全部从外部可观察：HTTP 状态码、响应体、cookie 属性、数据库里真实的行。
 * 不断言内部函数被调用了几次，不断言模块结构。
 *
 * 时间戳断言全部打在注入的时钟上：created 必须是注入值，真实 Date.now()
 * 一旦混进业务代码，这里立刻红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startTestServer, client, JUST_BEFORE, AT_UNLOCK, TEST_SECRET } from "./helpers.js";
import { UNLOCK_AT } from "../src/clock.js";

/**
 * SPEC §一：【改这里：doorCode】用【改这里：heroCode】的生日进门，【改这里：heroCode】用【改这里：doorCode】的生日进门。
 *
 * `full` 就是注入 process.env 的那串 8 位测试口令（test/helpers.js 的 TEST_SECRET），
 * `short` 是 `birthdayForms` 从它切出来的 4 位月日（auth.js: digits.slice(4)）。
 * 两个键都留着：`birthdayForms` 的 8 位分支与 4 位分支各要一份数据，
 * 把 short 也换成 8 位的话，4 位那条路就没有测试数据了。
 */
const DOOR = { code: "【改这里：doorCode】", short: "0101", full: TEST_SECRET.DOOR_PASSWORD };
const HERO = { code: "【改这里：heroCode】", short: "0202", full: TEST_SECRET.HERO_PASSWORD };

/** 登录并返回带会话的客户端 */
async function login(base, who, birthday = who.short) {
  const c = client(base);
  const res = await c.post("/api/login", { code: who.code, birthday });
  return { c, res };
}

/** 同上，但多带几个请求头（模拟经 nginx 代理过来的形态） */
async function loginVia(base, who, headers, birthday = who.short) {
  const c = client(base);
  const res = await c.post("/api/login", { code: who.code, birthday }, { headers });
  return { c, res };
}

const sidOf = (res) => {
  const raw = res.setCookie.find((x) => x.startsWith("sid="));
  assert.ok(raw, "登录必须下发 sid cookie");
  return raw.split(";")[0].slice(4);
};

/* ------------------------------------------------------------------ *
 * 密码：4 位 / 8 位 / 错误 / 缺字段
 * ------------------------------------------------------------------ */

test("4 位月日可以进门", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const { res } = await login(s.base, DOOR, DOOR.short);
  assert.equal(res.status, 200, `${DOOR.short} 应当通过`);
  assert.deepEqual(res.body, { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: false });
});

test("8 位完整生日与带横线的写法同样可以进门", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  // 带横线的写法：非数字在比对前被剥掉，剥完要正好等于 full / short 两种形态之一。
  // （"0001-01-01" → "00010101" 是 full，"01-01" → "0101" 是 short）
  for (const typed of [DOOR.full, "0001-01-01", "01-01"]) {
    const { res } = await login(s.base, DOOR, typed);
    assert.equal(res.status, 200, `${typed} 应当通过`);
    assert.equal(res.body.id, "door");
  }
  for (const typed of [HERO.short, HERO.full]) {
    const { res } = await login(s.base, HERO, typed);
    assert.equal(res.status, 200, `${typed} 应当通过`);
    assert.equal(res.body.id, "hero");
  }
});

test("生日不对被拒，并给一句看得懂的提示", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const { res } = await login(s.base, DOOR, "1111");
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "bad_credentials");
  assert.match(res.body.hint, /生日/, "提示要说清密码是什么，不能只有「错误」");
  assert.equal(res.setCookie.length, 0, "密码不对不能发会话 cookie");
});

test("缺字段是 400，且不消耗爆破额度", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const c = client(s.base);

  for (const body of [{}, { code: DOOR.code }, { birthday: DOOR.short }, { code: "", birthday: DOOR.short }]) {
    const res = await c.post("/api/login", body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应当 400`);
    assert.equal(res.body.error, "bad_request");
  }

  // 格式错误不是密码猜错，不该把锁的额度烧掉
  const ok = await c.post("/api/login", { code: DOOR.code, birthday: DOOR.short });
  assert.equal(ok.status, 200, "四次 400 之后正确的密码仍然进得去");
});

test("数据库里只有加盐哈希，没有明文生日", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const rows = s.db.prepare("SELECT * FROM person ORDER BY id").all();
  const dump = JSON.stringify(rows);
  for (const secret of [DOOR.short, DOOR.full, HERO.short, HERO.full]) {
    assert.ok(!dump.includes(secret), `库里出现了明文生日 ${secret}`);
  }
  for (const row of rows) {
    const rec = { ...row };
    assert.match(rec.pw4, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/, "pw4 应是自描述的 scrypt 哈希");
    assert.match(rec.pw8, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/, "pw8 应是自描述的 scrypt 哈希");
    assert.notEqual(rec.pw4, rec.pw8, "两种形态各存一份，且盐不同");
  }
});

/* ------------------------------------------------------------------ *
 * 会话
 * ------------------------------------------------------------------ */

test("会话 cookie 是 httpOnly，token 够长", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const { res } = await login(s.base, DOOR);
  const raw = res.setCookie.find((x) => x.startsWith("sid="));
  assert.ok(raw);
  assert.match(raw, /HttpOnly/, "cookie 必须 HttpOnly");
  assert.match(raw, /SameSite=Lax/);
  assert.match(raw, /Path=\//);
  assert.equal(sidOf(res).length, 43, "32 字节随机的 base64url 是 43 个字符");
});

test("Secure 按连接协议走：HTTPS 加上，明文不加（CONSTRAINTS §3）", async (t) => {
  /* 两个方向都会坏人，而且都是 10-5 当天当场作废那种：
     - 明文页面加了 Secure → 浏览器**直接拒收**，两个人都登不进去
     - HTTPS 上不加 Secure → 凭据在第一次跳转时以明文发一次
     所以判据是「这一条连接是不是加密的」，两种形态各自都要对。 */
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const isSecure = (c) => /;\s*Secure/i.test(c);
  const noDomain = (c) => !/;\s*Domain=/i.test(c);

  // ---- 明文（本地调试、SSH 端口转发）----
  const plain = await login(s.base, DOOR);
  const rawPlain = plain.res.setCookie.find((x) => x.startsWith("sid="));
  assert.ok(rawPlain, "明文登录没有下发 cookie");
  assert.ok(!isSecure(rawPlain), "明文连接上加了 Secure —— 浏览器会直接拒收，登录不进去");
  assert.ok(noDomain(rawPlain), "cookie 不该带 Domain");

  // ---- HTTPS（走 nginx，X-Forwarded-Proto: https）----
  const viaProxy = await loginVia(s.base, DOOR, { "X-Forwarded-Proto": "https" });
  const rawHttps = viaProxy.res.setCookie.find((x) => x.startsWith("sid="));
  assert.ok(rawHttps, "经代理的登录没有下发 cookie");
  assert.ok(isSecure(rawHttps), "HTTPS 连接上没加 Secure —— 凭据会在第一次跳转时明文发出去");
  assert.ok(noDomain(rawHttps), "cookie 不该带 Domain");

  // 头里可能有多个值（"https,http"），只看第一个
  const chained = await loginVia(s.base, DOOR, { "X-Forwarded-Proto": "https, http" });
  const rawChain = chained.res.setCookie.find((x) => x.startsWith("sid="));
  assert.ok(isSecure(rawChain), "X-Forwarded-Proto 有多个值时判错了 —— 浏览器依然在 HTTPS 上");

  // 反向：伪造成 http 就必须**不加**，否则等于给自己开了个降级口子
  const forged = await loginVia(s.base, DOOR, { "X-Forwarded-Proto": "http" });
  const rawForged = forged.res.setCookie.find((x) => x.startsWith("sid="));
  assert.ok(!isSecure(rawForged), "X-Forwarded-Proto: http 时不该加 Secure");

  // 登出也走同一套：明文登出不带 Secure，HTTPS 登出带。
  // 代理头是**每个请求**带的，client 不会记住上一次登录时用的头，所以这里要再带一次。
  const outPlain = await plain.c.post("/api/logout");
  const outPlainRaw = (outPlain.setCookie || []).find((x) => x.startsWith("sid="));
  assert.ok(outPlainRaw && !isSecure(outPlainRaw), "明文登出的 cookie 不该带 Secure");
  const outHttps = await viaProxy.c.post("/api/logout", undefined, { headers: { "X-Forwarded-Proto": "https" } });
  const outHttpsRaw = (outHttps.setCookie || []).find((x) => x.startsWith("sid="));
  assert.ok(outHttpsRaw && isSecure(outHttpsRaw), "HTTPS 登出的 cookie 该带 Secure");
  t.diagnostic("明文不带 Secure / HTTPS 带 Secure，两个方向都验过");
});

test("/api/me 报身份与进度，未登录是 401", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const anon = client(s.base);
  const r0 = await anon.get("/api/me");
  assert.equal(r0.status, 401);
  assert.equal(r0.body.error, "no_session");

  const { c } = await login(s.base, DOOR);
  await c.post("/api/entry", { kind: "text", body: "第一条" });
  const me = await c.get("/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: false, count: 1 });
});

test("退出后拿同一个 token 再来，必须 401", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const { c, res } = await login(s.base, DOOR);
  const token = sidOf(res);
  assert.equal((await c.get("/api/me")).status, 200);

  const out = await c.post("/api/logout");
  assert.equal(out.status, 204);
  assert.match(
    out.setCookie.find((x) => x.startsWith("sid=")) || "",
    /Max-Age=0/,
    "登出要清 cookie",
  );

  // 把原 token 原样塞回去重放：证明是服务端作废了，不只是前端把 cookie 删了
  c.setCookie("sid=" + token);
  const replay = await c.get("/api/me");
  assert.equal(replay.status, 401, "同一个 token 登出后必须失效");
  assert.equal(replay.body.error, "no_session");
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM session WHERE token = ?").get(token).n,
    0,
    "库里不该还留着这条会话",
  );
});

/* ------------------------------------------------------------------ *
 * 登录爆破锁定
 * ------------------------------------------------------------------ */

test("同一 IP 连错 5 次锁 10 分钟，再对的密码也不放行", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const c = client(s.base);

  for (let i = 1; i <= 4; i++) {
    const r = await c.post("/api/login", { code: DOOR.code, birthday: "1111" });
    assert.equal(r.status, 401, `第 ${i} 次错应当是 401`);
  }
  const fifth = await c.post("/api/login", { code: DOOR.code, birthday: "1111" });
  assert.equal(fifth.status, 429, "第 5 次错就锁上");
  assert.equal(fifth.body.error, "locked");
  assert.ok(fifth.body.retryAfter > 0 && fifth.body.retryAfter <= 600, "retryAfter 应是 10 分钟内的秒数");

  const right = await c.post("/api/login", { code: DOOR.code, birthday: DOOR.short });
  assert.equal(right.status, 429, "锁着的时候密码再对也不放行");
  assert.equal(right.setCookie.length, 0, "锁着的时候不能发 cookie");

  const row = s.db.prepare("SELECT fails, locked_until FROM login_fail").get();
  assert.equal(row.fails, 5);
  assert.equal(row.locked_until - JUST_BEFORE, 10 * 60 * 1000, "锁窗是 10 分钟");
});

/* ------------------------------------------------------------------ *
 * 限流的作用域：必须是「真实客户端」，不是「直连方」
 * ------------------------------------------------------------------ *
 * 部署形态是 nginx 在前面反代，应用绑回环。不设 trust proxy 的话 Express 的
 * req.ip 是直连方地址 127.0.0.1 —— 限流就退化成**全局**的：任何人在网上连错
 * 5 次，两个人一起被锁在外面 10 分钟。这条断言就是钉住这件事。
 *
 * nginx 的 $proxy_add_x_forwarded_for 会把真实客户端地址**追加到最右边**，
 * 客户端自己塞的伪造项留在左边。trust proxy=1 只认最右边那一项。
 */
test("限流按真实客户端算：伪造 X-Forwarded-For 绕不过，也连累不到别人", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const spoofed = "203.0.113.5"; // 客户端自己塞的，应被忽略
  const realA = "198.51.100.7"; // A 的真实地址（最右）
  const realB = "192.0.2.9"; // B 的真实地址（最右）

  const ca = client(s.base);
  for (let i = 1; i <= 5; i++) {
    const r = await ca.post(
      "/api/login",
      { code: DOOR.code, birthday: "1111" },
      { headers: { "x-forwarded-for": `${spoofed}, ${realA}` } },
    );
    assert.equal(r.status, i === 5 ? 429 : 401, `A 第 ${i} 次错应当是 ${i === 5 ? 429 : 401}`);
  }

  const rows = s.db.prepare("SELECT ip, fails FROM login_fail").all();
  assert.equal(rows.length, 1, `只该记 A 一个客户端，实际记了 ${rows.length} 个`);
  assert.equal(rows[0].ip, realA, "锁定键必须是最右边的真实客户端，不能是客户端伪造的那一项");
  assert.equal(rows[0].fails, 5);

  // A 锁死**不许**牵连 B。修 trust proxy 之前这里会是 429（两者共用 127.0.0.1 这个键）。
  const cb = client(s.base);
  const rB = await cb.post(
    "/api/login",
    { code: DOOR.code, birthday: "1111" },
    { headers: { "x-forwarded-for": `${spoofed}, ${realB}` } },
  );
  assert.equal(rB.status, 401, "A 被锁不该牵连 B —— 没设 trust proxy 时这里会是 429");

  // 只带伪造项、不带真实项时，锁的仍是直连方（测试里就是 127.0.0.1），不是伪造值。
  const cc = client(s.base);
  const rC = await cc.post(
    "/api/login",
    { code: DOOR.code, birthday: "1111" },
    { headers: { "x-forwarded-for": spoofed } },
  );
  assert.equal(rC.status, 401, "C 第一次错应当是 401");
  // 按 ip 精确取行：`WHERE fails = 1` 会同时命中 B（B 也恰好错了一次），
  // 条件不唯一的查询取到谁全看插入顺序 —— 那是在测数据库的返回顺序，不是在测限流。
  const cRow = s.db.prepare("SELECT fails FROM login_fail WHERE ip = ?").get(spoofed);
  assert.equal(cRow?.fails, 1, "单跳时最右项就是唯一项，锁定键取它才对");
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM login_fail").get().n,
    3,
    "A / B / C 三个客户端各记一行，不该被合并",
  );
});

/* ------------------------------------------------------------------ *
 * 非回环绑定时，X-Forwarded-For 一个字都不能信
 * ------------------------------------------------------------------ *
 * 独立复审实测过的后果：把绑定改成 0.0.0.0，再带伪造的 XFF 登录，
 * 8 次全部 401，限流**完全归零**；对照组不带该头，第 5 次照锁。
 *
 * 根因：XFF 只有在「唯一能连到进程的人就是本机 nginx」时才可信。
 * 进程一旦对外暴露，那个头就是客户端自己填的 —— 于是「每换一个假 IP 就多试一次」，
 * 4 位生日的爆破面从「每 10 分钟 5 次」变成「不限次」。
 *
 * 所以 trust proxy 必须由**实际绑定**决定，而不是人记得配。
 * 绑回环 → 采信 1 跳；绑非回环 → 一个 XFF 都不采信，限流退回按直连方算（不可伪造）。
 */
test("绑非回环时伪造 X-Forwarded-For 绕不过限流", async (t) => {
  const s = await startTestServer({ bindHost: "0.0.0.0" });
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const c = client(s.base);

  // 每次换一个伪造 IP。若 XFF 被采信，等于每次都用新身份重置计数，永远锁不上。
  const codes = [];
  for (let i = 1; i <= 8; i++) {
    const r = await c.post(
      "/api/login",
      { code: DOOR.code, birthday: "1111" },
      { headers: { "x-forwarded-for": `198.51.100.${i}` } },
    );
    codes.push(r.status);
  }
  assert.deepEqual(
    codes,
    [401, 401, 401, 401, 429, 429, 429, 429],
    `前 4 次 401、第 5 次起一直锁着。若 XFF 被采信，序列会是 8 个 401 —— ` +
      `换着假 IP 就能无限试`,
  );

  // 锁定键必须是直连方，不是任何一个伪造值
  const rows = s.db.prepare("SELECT ip, fails FROM login_fail").all();
  assert.equal(rows.length, 1, `伪造 8 个 IP 不该记成 8 行，实际 ${rows.length} 行`);
  assert.match(rows[0].ip, /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/, `锁定键应是直连方，实际 ${rows[0].ip}`);
  assert.equal(
    rows[0].fails,
    5,
    "只记了前 5 次：锁上之后请求在 lockState 就早返回，不再累加（所以不是 8）",
  );
});

test("绑回环时仍采信一跳（生产形态不能被上一条带跑）", async (t) => {
  const s = await startTestServer();          // 默认 127.0.0.1
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const c = client(s.base);

  const r = await c.post(
    "/api/login",
    { code: DOOR.code, birthday: "1111" },
    { headers: { "x-forwarded-for": "203.0.113.5, 198.51.100.7" } },
  );
  assert.equal(r.status, 401, "第一次错应当是 401");
  const row = s.db.prepare("SELECT ip FROM login_fail").get();
  assert.equal(row.ip, "198.51.100.7", `绑回环时锁定键应是最右的真实客户端，实际 ${row.ip}`);
});

/* ------------------------------------------------------------------ *
 * 留言：只作用自己的
 * ------------------------------------------------------------------ */

test("留言只能改自己的：动别人的条目一律 404", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const { c: door } = await login(s.base, DOOR);
  const created = await door.post("/api/entry", { kind: "text", body: "【改这里：doorCode】写的话" });
  assert.equal(created.status, 201);
  const id = created.body.entry.id;
  assert.equal(created.body.entry.kind, "text");
  assert.equal(created.body.entry.ord, 1);
  assert.equal(created.body.entry.created, JUST_BEFORE, "created 必须用注入的时钟，不是 Date.now()");
  assert.equal(created.body.entry.photo, null);

  const { c: hero } = await login(s.base, HERO);
  const stolen = await hero.patch("/api/entry/" + id, { body: "改别人的" });
  assert.equal(stolen.status, 404, "改别人的条目 404");
  const killed = await hero.del("/api/entry/" + id);
  assert.equal(killed.status, 404, "删别人的条目 404");
  assert.equal(
    s.db.prepare("SELECT body FROM entry WHERE id = ?").get(id).body,
    "【改这里：doorCode】写的话",
    "别人的操作不能改到数据",
  );

  const own = await door.patch("/api/entry/" + id, { body: "【改这里：doorCode】改过的话" });
  assert.equal(own.status, 200);
  assert.equal(own.body.entry.body, "【改这里：doorCode】改过的话");

  const dropped = await door.del("/api/entry/" + id);
  assert.equal(dropped.status, 204);
  const after = await door.get("/api/entry");
  assert.deepEqual(after.body.mine, [], "撤回后列表里没有了");
  /* 硬删（2026-10-03 起）：行本身查不到，不是「留一行、deleted 非空」。
     `deleted` 那一列从此恒为 NULL，db.js 里只当遗留列留着，这里也不再 SELECT 它。 */
  assert.equal(
    s.db.prepare("SELECT id FROM entry WHERE id = ?").get(id),
    undefined,
    "硬删：数据库里这一行必须查不到",
  );
  assert.equal((await door.get("/api/me")).body.count, 0);
});

test("留言校验：非 text 的 kind 与空正文都是 400", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const { c } = await login(s.base, DOOR);

  for (const body of [{ kind: "text" }, { kind: "text", body: "   " }, { kind: "photo", body: "x" }, {}]) {
    const r = await c.post("/api/entry", body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} 应当 400`);
  }
  assert.equal((await c.get("/api/entry")).body.mine.length, 0, "400 的请求不该写进库");
});

test("未登录读不到、也写不了留言", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const c = client(s.base);

  for (const r of [await c.get("/api/entry"), await c.post("/api/entry", { kind: "text", body: "x" })]) {
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "no_session");
  }
});

/* ------------------------------------------------------------------ *
 * 时间锁：读侧主闸门
 * ------------------------------------------------------------------ */

/** 往库里直塞一条对方的留言（缝二：数据确实写进去了） */
function plantTheirs(s) {
  s.db
    .prepare("INSERT INTO entry(id, owner, kind, body, ord, created, deleted) VALUES(?,?,?,?,?,?,NULL)")
    .run("e_theirs_secret", "hero", "text", "他提前写好的那句话", 1, JUST_BEFORE);
}

test("未解锁时只读得到自己的留言，对方的 id 与 body 都不在响应体里", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const { c } = await login(s.base, DOOR);
  await c.post("/api/entry", { kind: "text", body: "【改这里：doorCode】写的话" });
  plantTheirs(s);

  const res = await c.get("/api/entry");
  assert.equal(res.status, 200);
  assert.equal(res.body.mine.length, 1);
  assert.equal(res.body.mine[0].body, "【改这里：doorCode】写的话");
  assert.deepEqual(res.body.theirs, [], "未解锁时 theirs 恒为空");
  assert.ok(!res.text.includes("e_theirs_secret"), "响应体里不能出现对方的 id");
  assert.ok(!res.text.includes("他提前写好的那句话"), "响应体里不能出现对方的 body");
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM entry WHERE owner = 'hero'").get().n,
    1,
    "对方那行确实在库里——是门挡住了，不是数据没写进去",
  );
});

test("读侧的时间锁可被证伪：开门后 theirs 真的有对方的东西", async (t) => {
  // 上一条只断言了「未解锁 → 空」，那样把开门判断整个删掉测试照样绿。
  // 这里补上开门那一侧：同一个库、同一份数据，开门后必须读得到。
  const s = await startTestServer();
  t.after(() => s.close());
  const { c } = await login(s.base, DOOR);
  plantTheirs(s);

  s.setNow(AT_UNLOCK);
  const res = await c.get("/api/entry");
  assert.equal(res.status, 200);
  assert.equal(res.body.theirs.length, 1, "开门后对方的留言必须读得到");
  assert.equal(res.body.theirs[0].id, "e_theirs_secret");
  assert.equal(res.body.theirs[0].body, "他提前写好的那句话");
});

test("门禁可被证伪：未解锁 /api/shared 404，开门后 200", async (t) => {
  // 两侧都断言。只测前者的话，把 LOCKED_PREFIXES 清空你一样绿。
  const s = await startTestServer();
  t.after(() => s.close());
  const anon = client(s.base);

  s.setNow(AT_UNLOCK - 1);
  for (const p of ["/api/shared", "/api/wish"]) {
    assert.equal((await anon.get(p)).status, 404, `${p} 在未解锁时不该存在`);
  }

  // 匿名在开门后仍必须 401：未鉴权就 200 等于把共同层公开（工单 04 复审 HIGH-1）
  s.setNow(AT_UNLOCK);
  for (const p of ["/api/shared", "/api/wish"]) {
    assert.equal((await anon.get(p)).status, 401, `${p} 开门后仍必须鉴权，匿名不许读到`);
  }

  // 登录后开门才可达——两侧都断言，缺一不可
  const { c } = await login(s.base, DOOR);
  for (const p of ["/api/shared", "/api/wish"]) {
    assert.equal((await c.get(p)).status, 200, `${p} 开门后必须可达，否则上面的 404 证明不了闸门`);
  }
});

test("时钟边界：差 1 毫秒仍锁，整点就开", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const { c } = await login(s.base, DOOR);
  plantTheirs(s);

  s.setNow(AT_UNLOCK - 1);
  assert.equal((await c.get("/api/status")).body.unlocked, false, "开门前一毫秒仍然锁着");
  assert.equal((await c.get("/api/me")).body.unlocked, false);
  assert.deepEqual((await c.get("/api/entry")).body.theirs, []);
  assert.equal((await c.get("/api/shared")).status, 404);

  s.setNow(AT_UNLOCK);
  assert.equal((await c.get("/api/status")).body.unlocked, true, "整点就开门，不多等一毫秒");
  assert.equal((await c.get("/api/me")).body.unlocked, true);
  assert.equal((await c.get("/api/entry")).body.theirs.length, 1);
  assert.equal((await c.get("/api/shared")).status, 200);
  assert.equal(AT_UNLOCK, UNLOCK_AT, "取样点就是开门那一刻本身");
});

test("同一组断言在别的时区机器上给出同样结果", async (t) => {
  // 在子进程里真的起一套服务跑，而不是在本进程换个 TZ 重跑一遍断言。
  const helpersUrl = new URL("./helpers.js", import.meta.url).href;
  const code = "\u623f\u95f4\u95e8"; // 【改这里：doorCode】
  const script = `
    import(${JSON.stringify(helpersUrl)}).then(async (h) => {
      const s = await h.startTestServer();
      const c = h.client(s.base);
      const out = [];
      for (const t of [h.JUST_BEFORE, h.AT_UNLOCK]) {
        s.setNow(t);
        const st = await c.get("/api/status");
        const sh = await c.get("/api/shared");
        const lg = await c.post("/api/login", { code: ${JSON.stringify(code)}, birthday: ${JSON.stringify(DOOR.short)} });
        const me = await c.get("/api/me");
        out.push([st.body.unlocked, sh.status, lg.status, me.body.unlocked, me.body.count].join(":"));
      }
      process.stdout.write(out.join("|"));
      await s.close();
    });`;
  const expected = "false:404:200:false:0|true:200:200:true:0";
  for (const tz of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    });
    assert.equal(r.status, 0, `TZ=${tz} 跑不起来: ${r.stderr}`);
    assert.equal(r.stdout, expected, `TZ=${tz} 的结论与其他时区不一致`);
  }
});

/* ====================================================================== *
 * 内容的方向：【改这里：heroCode】封存的，【改这里：doorCode】开门后看到；反之同理
 *
 * 2026-10-02 用户点名要确认的一条。方向一旦反了，10-5 她打开会看到
 * **自己写给自己的东西**——惊喜当场变成尴尬，而且不报任何错。
 *
 * 之前只有一个方向有测试（【改这里：doorCode】写 → 【改这里：heroCode】读 theirs，见 03 的配文用例），
 * 另一个方向靠 `otherId()` 的对称性默认成立——「靠对称性」不是护栏。
 * 改成**两个方向都点名**。
 * ====================================================================== */

test("内容方向：【改这里：heroCode】封存的【改这里：doorCode】看得到，【改这里：doorCode】封存的【改这里：heroCode】看得到", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const MARK = {
    door: "【【改这里：doorCode】封存】这句话应当出现在【改这里：heroCode】的阅读流里",
    hero: "【【改这里：heroCode】封存】这句话应当出现在【改这里：heroCode】自己看不见的那一半",
  };

  // 锁住时各自写一条——写完即封存，谁都还看不见对方的
  const { c: door } = await login(s.base, DOOR);
  const wDoor = await door.post("/api/entry", { kind: "text", body: MARK.door });
  assert.equal(wDoor.status, 201, "【改这里：doorCode】写入失败");
  const { c: hero } = await login(s.base, HERO);
  const wHero = await hero.post("/api/entry", { kind: "text", body: MARK.hero });
  assert.equal(wHero.status, 201, "【改这里：heroCode】写入失败");

  // 门还没开：各自只看得见自己写的，对方那一半是空的
  assert.deepEqual((await door.get("/api/entry")).body.theirs, [], "未解锁时【改这里：doorCode】读不到【改这里：heroCode】写的");
  assert.deepEqual((await hero.get("/api/entry")).body.theirs, [], "未解锁时【改这里：heroCode】读不到【改这里：doorCode】写的");

  // 开门
  s.setNow(AT_UNLOCK);
  const seenByDoor = await door.get("/api/entry");
  const seenByHero = await hero.get("/api/entry");

  const bodies = (r, k) => r.body[k].map((e) => e.body);
  assert.deepEqual(
    bodies(seenByDoor, "theirs"),
    [MARK.hero],
    "开门后【改这里：doorCode】在「对方的」里应当只看到【改这里：heroCode】封存的那一条",
  );
  assert.deepEqual(
    bodies(seenByHero, "theirs"),
    [MARK.door],
    "开门后【改这里：heroCode】在「对方的」里应当只看到【改这里：doorCode】封存的那一条",
  );

  // 反向断言：**自己写的不会出现在「对方的」里**。
  // 只断言「对方能看到」的话，一个把两个列表都填成全部的坏实现也能过。
  assert.ok(
    !bodies(seenByDoor, "theirs").includes(MARK.door),
    "【改这里：doorCode】把自己写的看成了对方写的——方向反了",
  );
  assert.ok(
    !bodies(seenByHero, "theirs").includes(MARK.hero),
    "【改这里：heroCode】把自己写的看成了对方写的——方向反了",
  );
  // 并且「我的」里只有自己那一条
  assert.deepEqual(bodies(seenByDoor, "mine"), [MARK.door], "【改这里：doorCode】的「我的」应当只有自己写的那条");
  assert.deepEqual(bodies(seenByHero, "mine"), [MARK.hero], "【改这里：heroCode】的「我的」应当只有自己写的那条");
});