/**
 * 工单 05 · 共同动作·约定 —— 后端线。
 *
 * 全部从外部可观察：HTTP 状态码、响应体、磁盘上那个 SQLite 文件里的真实行。
 * 不断言内部结构，不碰 public/（前端线独占）。
 *
 * 这票最容易重犯的错是**开门后漏鉴权**：`/api/shared` 曾经无鉴权直接 200，
 * 祝福语和 9 个照片 id 公开给任何人。所以这里把「开门后匿名 → 401」单独钉一条。
 *
 * 时间戳取样点用 helpers.js 写死的绝对 epoch，不从 UNLOCK_AT 推导——
 * 推导出来的取样点会让断言自指（见 helpers.js 的注释）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { startTestServer, client, JUST_BEFORE, AT_UNLOCK, TEST_SECRET } from "./helpers.js";

/** SPEC §一：【改这里：doorCode】用【改这里：heroCode】的生日进门，【改这里：heroCode】用【改这里：doorCode】的生日进门 */
const DOOR = { code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD };
const HERO = { code: "【改这里：heroCode】", birthday: TEST_SECRET.HERO_PASSWORD };

/* ------------------------------ 小工具 ------------------------------ */

async function login(base, who) {
  const c = client(base);
  const res = await c.post("/api/login", { code: who.code, birthday: who.birthday });
  assert.equal(res.status, 200, `${who.code} 应当进得门：${res.text}`);
  return c;
}

/** 另开一个连接直查同一个 SQLite 文件：看到的就是磁盘上的库，绕开进程内句柄 */
function withDirect(dbFile, fn) {
  const direct = new DatabaseSync(dbFile);
  try {
    return fn(direct);
  } finally {
    direct.close();
  }
}
const one = (dbFile, sql, ...a) => withDirect(dbFile, (d) => d.prepare(sql).get(...a));
const all = (dbFile, sql, ...a) => withDirect(dbFile, (d) => d.prepare(sql).all(...a));

/* ====================================================================== *
 * 1. 未解锁：读 404（闸门在关），写允许（她要能提前折好）
 * ====================================================================== */

test("未解锁：约定读不到 404，但约定写得进去（她要能提前折）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  // 匿名：连路由都不该走到
  assert.equal((await client(s.base).get("/api/wish")).status, 404, "未解锁时匿名必须 404");
  // 登录了也一样 404：约定属于「那天的内容」，不是「我的内容」
  const a = await login(s.base, DOOR);
  assert.equal((await a.get("/api/wish")).status, 404, "未解锁时已登录必须 404");
  assert.equal((await a.get("/API/WISH")).status, 404, "大小写绕不过闸门");

  // 但写是允许的：POST /api/wish 未解锁也能成功
  const put = await a.post("/api/wish", { text: "一起去海边看一次日出" });
  assert.equal(put.status, 200, `未解锁时写约定必须成功：${put.text}`);
  assert.equal(put.body.wish.code, DOOR.code, "回包只带代号");
  assert.equal(put.body.wish.text, "一起去海边看一次日出");
  t.diagnostic(`未解锁 POST /api/wish = ${put.status}；同一时刻 GET = 404`);
});

/* ====================================================================== *
 * 2. 开门后：登录才读得到，双方各一条并排，带代号
 * ====================================================================== */

test("开门后：登录才读得到，双方各一条、各带代号，顺序固定", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(AT_UNLOCK);

  // 一个约定都没写：两栏的位置仍然要在（否则界面排不出「并排」）
  const a = await login(s.base, DOOR);
  const empty = await a.get("/api/wish");
  assert.equal(empty.status, 200, `开门后必须 200：${empty.text}`);
  assert.ok(Array.isArray(empty.body.wishes), "wishes 必须是数组");
  assert.equal(empty.body.wishes.length, 2, "双方各一栏");
  assert.deepEqual(
    empty.body.wishes.map((w) => w.code),
    [DOOR.code, HERO.code],
    "两栏的顺序固定为 【改这里：doorCode】 / 【改这里：heroCode】，不随谁登录换位置",
  );
  for (const w of empty.body.wishes) {
    assert.equal(w.text, "", "还没写的一方给空串，不给 null");
    // 只带代号与正文：role、姓名、真名一个字都不许进响应体
    assert.deepEqual(Object.keys(w).sort(), ["code", "id", "text"], "元素只带这三个键");
  }

  // 双方各写一条
  const b = await login(s.base, HERO);
  assert.equal((await a.post("/api/wish", { text: "搬到一起住" })).status, 200);
  assert.equal((await b.post("/api/wish", { text: "学会做对方最爱吃的那道菜" })).status, 200);

  const r = await a.get("/api/wish");
  assert.equal(r.status, 200, `开门后必须 200：${r.text}`);
  const byId = Object.fromEntries(r.body.wishes.map((w) => [w.id, w]));
  assert.equal(byId.door.text, "搬到一起住", "自己的那一条要看得见");
  assert.equal(byId.hero.text, "学会做对方最爱吃的那道菜", "对方那一条也要看得见——并排比的就是这个");
  assert.equal(byId.door.code, DOOR.code, "只显示代号");
  assert.equal(byId.hero.code, HERO.code, "只显示代号");
  // 全站只用代号：响应里不许出现角色或任何真名
  const raw = JSON.stringify(r.body);
  for (const leak of ["【改这里：girlfriend】", "【改这里：boyfriend】", "name", "role", "birthday"]) {
    assert.ok(!raw.includes(leak), `响应体里出现了不该出现的东西：${leak}`);
  }
  t.diagnostic(`开门后 GET /api/wish = 200，双方各一条：${raw}`);
});

/* ====================================================================== *
 * 3. 鉴权：开门后匿名一律 401；未登录写也 401
 * ====================================================================== */

test("开门后匿名读约定 → 401；未登录写约定 → 401（公网 IP + 裸 HTTP）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(AT_UNLOCK);

  // 这条是本票最容易重犯的错：/api/shared 曾经无鉴权直接 200。
  const anon = await client(s.base).get("/api/wish");
  assert.equal(anon.status, 401, `开门后匿名必须 401，实际 ${anon.status}：${anon.text}`);
  assert.equal(anon.body?.error, "no_session");

  // 写也不能匿名：约定是双方的私密内容
  const anonPut = await client(s.base).post("/api/wish", { text: "偷偷写一条" });
  assert.equal(anonPut.status, 401, "未登录写约定必须 401");

  // 拿一个登出后的 token 再来一次：旧会话不算
  const a = await login(s.base, DOOR);
  assert.equal((await a.get("/api/wish")).status, 200, "登录后能读——上面那个 401 不是因为路由坏了");
  assert.equal((await a.post("/api/logout")).status, 204);
  assert.equal((await a.get("/api/wish")).status, 401, "退出后旧 cookie 立即失效");
  t.diagnostic("登录 200 / 匿名 401 / 退出后 401");
});

/* ====================================================================== *
 * 4. 缝二：直查同一个库——行确实在，而未解锁时 HTTP 读不到
 * ====================================================================== */

test("缝二：约定行确实在库里，而同一时刻未解锁的 HTTP 读不到", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  await a.post("/api/wish", { text: "一起去海边看一次日出" });

  // ---- 直查同一个 SQLite 文件 ----
  // 只测「读不到」区分不了「数据没写进去」和「数据写进去了但被门挡住」。
  // 这几行是那个区分本身的证据。
  const row = one(s.dbFile, "SELECT person_id, text FROM wish WHERE person_id = ?", "door");
  assert.ok(row, "wish 行必须真的在库里——否则下面那个 404 说明不了任何事");
  assert.equal(row.text, "一起去海边看一次日出", "库里存的就是我刚写的那一条");
  assert.equal(all(s.dbFile, "SELECT * FROM wish").length, 1);

  // ---- 同一时刻，HTTP 读不到 ----
  const locked = await a.get("/api/wish");
  assert.equal(locked.status, 404, "未解锁时 HTTP 必须读不到");
  assert.ok(!locked.text.includes("海边"), "未解锁时响应体里一个字都不许出现约定正文");

  // ---- 开门后同一个约定读得到，证明上面那个 404 是门挡的，不是路由坏了 ----
  s.setNow(AT_UNLOCK);
  const opened = await a.get("/api/wish");
  assert.equal(opened.status, 200, `开门后必须读得到：${opened.text}`);
  assert.equal(
    opened.body.wishes.find((w) => w.id === "door").text,
    "一起去海边看一次日出",
    "开门后读到的是库里那一条",
  );
  t.diagnostic("库里 1 行；未解锁 HTTP 404；开门后 HTTP 200 且是同一条");
});

/* ====================================================================== *
 * 5. 覆盖不是追加 + 形状边界 + 没有后门路径
 * ====================================================================== */

test("一方写两次是覆盖不是追加", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(AT_UNLOCK);

  const a = await login(s.base, DOOR);
  const b = await login(s.base, HERO);
  await a.post("/api/wish", { text: "第一次想做的" });
  await a.post("/api/wish", { text: "改主意了" });

  const rows = all(s.dbFile, "SELECT person_id, text FROM wish ORDER BY person_id");
  assert.equal(rows.length, 1, "同一方永远只有一行——追加会让阅读端出现两份同一个人的答案");
  assert.equal(rows[0].text, "改主意了", "第二次写覆盖第一条");

  await b.post("/api/wish", { text: "对方的一条" });
  const r = await b.get("/api/wish");
  assert.equal(r.body.wishes.length, 2, "两个人两栏，不是四条");
  assert.equal(r.body.wishes.filter((w) => w.text === "改主意了").length, 1, "只有一栏是我那一条");
  t.diagnostic("两次写入后 wish 表 1 行，GET 回两栏");
});

test("约定正文的形状边界：空、超长、非字符串一律 400", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(AT_UNLOCK);
  const a = await login(s.base, DOOR);

  for (const body of [{ text: "" }, { text: "   " }, { text: "x".repeat(201) }, { text: 42 }, {}]) {
    const r = await a.post("/api/wish", body);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 40)} 必须 400，实际 ${r.status}`);
  }
  // 200 字整条收下（前后端上限同值：200）
  assert.equal((await a.post("/api/wish", { text: "字".repeat(200) })).status, 200);
  assert.equal(all(s.dbFile, "SELECT * FROM wish").length, 1, "被拒的那些一次都没写进库");
  t.diagnostic("5 种坏输入全 400，200 字收下");
});

test("没有「查看对方内容」的后门路径：只认 POST /api/wish 一条写、一个 GET 读", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(AT_UNLOCK);
  const a = await login(s.base, DOOR);
  await a.post("/api/wish", { text: "搬到一起住" });

  // 逐人取约定的路径不存在（那是最容易被后来人顺手加出来的后门）
  for (const p of ["/api/wish/door", "/api/wish/hero", "/api/wish/1", "/api/wishes"]) {
    assert.equal((await a.get(p)).status, 404, `${p} 不该存在`);
    assert.equal((await a.post(p, { text: "x" })).status, 404, `${p} 不该可写`);
  }
  // 改与删都不在契约里
  assert.equal((await a.patch("/api/wish", { text: "改" })).status, 404);
  assert.equal((await a.del("/api/wish")).status, 404);
  t.diagnostic("逐人路径 / 改 / 删一律 404");
});
