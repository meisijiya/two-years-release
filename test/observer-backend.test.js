/**
 * 观察者入口（CONSTRAINTS §2 的一次显式降级，见 CONSTRAINTS.md §2b）。
 *
 * 这组用例守三件事，一件比一件容易被「看起来能用」骗过去：
 *
 *   1. **它真的能看**。未解锁时也能一次拿到双方条目 —— 这是它存在的理由。
 *   2. **它真的只能看**。同 IP 限流、凭据可验伪、撤回的条目不给看、
 *      7 张表一张不多。旁路一旦同时能写，风险就高一个量级。
 *   3. **它没有顺手拆掉别的东西**。时间锁的两道闸门原样有效、
 *      全站取图仍然只有 /api/photo/:id 一条路。
 *
 * 写死的东西：`AT_UNLOCK` 来自 helpers.js（绝对 epoch），不从 UNLOCK_AT 推导。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { startTestServer, client, JUST_BEFORE, AT_UNLOCK, TEST_SECRET } from "./helpers.js";
import { openDb } from "../src/db.js";
import { createApp, ROOT } from "../src/app.js";
import { createObserverAuth } from "../src/observer-auth.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const DOOR = { code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD };
const HERO = { code: "【改这里：heroCode】", birthday: TEST_SECRET.HERO_PASSWORD };
/**
 * 观察者 PIN。**它是 OBSERVER_PASSWORD，不是任何一方的生日。**
 * 以前它与【改这里：heroCode】的口令同值，口令抽离之后三者已经不同了 ——
 * deploy.sh 现在也硬性要求三个凭据两两不同。这里取错值的话，这条用例
 * 验的就不再是「观察者进得去」，而是「观察者碰巧与某人同口令」。
 */
const PIN = TEST_SECRET.OBSERVER_PASSWORD;

/** 一张真 JPEG —— 走一遍真的压缩管线，不拿假字节糊弄「图片能显示」这条 */
const SMALL = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#3366aa" } })
  .jpeg()
  .toBuffer();

/* ------------------------------ 小工具 ------------------------------ */

async function login(base, who) {
  const c = client(base);
  const res = await c.post("/api/login", { code: who.code, birthday: who.birthday });
  assert.equal(res.status, 200, `${who.code} 应当进得门：${res.text}`);
  return c;
}

async function observer(base, pin = PIN) {
  const c = client(base);
  const res = await c.post("/api/observe", { pin });
  assert.equal(res.status, 200, `观察者应当进得来：${res.text}`);
  return c;
}

function multipart(data, field = "photo") {
  const boundary = "----obs" + randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="p.jpg"\r\n` +
      "Content-Type: image/jpeg\r\n\r\n",
    "utf8",
  );
  return {
    body: Buffer.concat([head, Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * 传一张照片，返回落库后的条目。
 *
 * `/api/upload` 的响应是 `{ entry: { …, photo: {id, mime, w, h} } }` —— 照片 id 嵌在
 * entry 里，不是顶层字段（这里曾经按顶层 `photoId` 取过，全红）。
 * 取不到就当场抛，而不是让后面某条断言报一个与本条无关的错。
 */
async function upload(c, data) {
  const { body, contentType } = multipart(data);
  const r = await c.raw("/api/upload", { method: "POST", body, headers: { "content-type": contentType } });
  assert.equal(r.status, 201, `上传应当成功，实际 ${r.status} ${r.text}`);
  return r.body.entry;
}

/** 取二进制：client() 只留 text，图片断言要字节 */
async function bytes(base, cookie, p) {
  const res = await fetch(base + p, { headers: { cookie } });
  return { status: res.status, type: res.headers.get("content-type"), body: Buffer.from(await res.arrayBuffer()) };
}

/** 直查磁盘上的库：绕开进程内句柄 */
function direct(dbFile, sql, ...args) {
  const d = new DatabaseSync(dbFile);
  try {
    return d.prepare(sql).get(...args);
  } finally {
    d.close();
  }
}

/**
 * 把 Express 的路由表摊平。
 * 用它证明「取图仍然只有一条路」「观察者只注册了三个路由」这类**结构性**断言 ——
 * 用 HTTP 探测只能证明「这些具体路径能用」，证明不了「没有别的路径」。
 */
function routesOf(app) {
  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };
  walk(app._router?.stack ?? app.router?.stack, "");
  return out;
}

/* ====================================================================== *
 * 1. 凭据：进得来、认得出、出得去
 * ====================================================================== */

test("观察者：错 PIN 401 并给出提示，对的 PIN 换到凭据 cookie", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const bad = client(s.base);
  const r1 = await bad.post("/api/observe", { pin: "9999" });
  assert.equal(r1.status, 401);
  assert.equal(r1.body.error, "bad_credentials");
  assert.ok(r1.body.hint && r1.body.hint.length > 0, "应当给一句提示，而不是冷冰冰一个错误");
  assert.equal(r1.setCookie.length, 0, "错 PIN 绝不能发凭据");

  const c = client(s.base);
  const r2 = await c.post("/api/observe", { pin: PIN });
  assert.equal(r2.status, 200);
  const cookie = r2.setCookie.find((x) => x.startsWith("obs="));
  assert.ok(cookie, `应当发 obs cookie，实际是 ${JSON.stringify(r2.setCookie)}`);
  assert.match(cookie, /HttpOnly/, "凭据 cookie 必须 HttpOnly");
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.ok(!/Secure/.test(cookie), "这次是明文 HTTP，加 Secure 浏览器会直接拒收");
});

test("观察者：没有凭据读不到东西，凭据是唯一的钥匙", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const anon = client(s.base);
  const r = await anon.get("/api/observe");
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "no_observer_session");
});

test("观察者：凭据被改一位就作废，删字段也作废", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const c = await observer(s.base);
  assert.equal((await c.get("/api/observe")).status, 200, "对照组：原凭据应当能用");

  const raw = c.cookie; // "obs=v1.<expiry>.<mac>"
  const token = raw.slice(raw.indexOf("=") + 1);
  const parts = token.split(".");

  const tampered = client(s.base);
  tampered.setCookie("obs=" + parts[0] + "." + parts[1] + "." + flipLast(parts[2]));
  const r1 = await tampered.get("/api/observe");
  assert.equal(r1.status, 401, "改一位签名必须立刻作废");

  const shortened = client(s.base);
  shortened.setCookie("obs=" + parts[0] + "." + parts[1]);
  const r2 = await shortened.get("/api/observe");
  assert.equal(r2.status, 401, "少一段必须作废（不能因为前缀对就放行）");

  const swapped = client(s.base);
  swapped.setCookie("obs=" + parts[0] + "." + (Number(parts[1]) + 1) + "." + parts[2]);
  const r3 = await swapped.get("/api/observe");
  assert.equal(r3.status, 401, "改过期时间也必须作废（签名覆盖了它）");
});

/** 改 token 最后一个字符，且保证改完与原值不同 */
function flipLast(s) {
  const last = s.slice(-1);
  return s.slice(0, -1) + (last === "A" ? "B" : "A");
}

test("观察者：过期即失效", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const c = await observer(s.base);
  // TTL 是 12 小时；把时钟推到 13 小时后
  s.setNow(JUST_BEFORE + 13 * 3600 * 1000);
  const r = await c.get("/api/observe");
  assert.equal(r.status, 401, `凭据必须自己会过期：${r.text}`);
});

test("观察者：登出之后读不到（cookie 被清掉）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const c = await observer(s.base);
  assert.equal((await c.get("/api/observe")).status, 200);
  const out = await c.post("/api/observe/logout", {});
  assert.equal(out.status, 204);
  const cleared = out.setCookie.find((x) => x.startsWith("obs="));
  assert.match(cleared, /Max-Age=0/, "登出必须把浏览器那份收回去");
  assert.equal((await c.get("/api/observe")).status, 401, "登出后必须立刻读不到");
});

/* ====================================================================== *
 * 2. 它真的能看：未解锁时一次拿到双方 + 共同层 + 约定
 * ====================================================================== */

test("观察者：未解锁时一次读到双方条目、共同层与约定", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  // 双方各落一条文字 + 一张照片
  const a = await login(s.base, DOOR);
  await a.post("/api/entry", { kind: "text", body: "她写的一句" });
  const shotA = await upload(a, SMALL);

  const b = await login(s.base, HERO);
  await b.post("/api/entry", { kind: "text", body: "他写的一句" });
  const shotB = await upload(b, SMALL);

  // 共同层：合照 + 约定。约定在未解锁时**读侧被闸门挡着**，所以只能直接写库。
  // 哨兵 entry 的 id 与 owner 都必须是 SHARED_OWNER（见 shared.js）——
  // 共同层的合照查询是拿 photo.entry_id 与它等值 JOIN 的，填错就查不出来。
  s.db.prepare("INSERT INTO wish(person_id, text) VALUES('door','她的约定')").run();
  s.db.prepare("INSERT INTO wish(person_id, text) VALUES('hero','他的约定')").run();
  s.db
    .prepare(
      "INSERT INTO entry(id, owner, kind, body, ord, created, deleted) VALUES('@shared-layer','@shared-layer','photo',NULL,0,1,NULL)",
    )
    .run();
  s.db
    .prepare("INSERT INTO photo(id, entry_id, mime, bytes, w, h) VALUES('ph-sh','@shared-layer','image/jpeg',1,40,30)")
    .run();
  s.db.prepare("INSERT INTO shared(id, kind, body, ord) VALUES('sh1','together_photo','ph-sh',0)").run();

  const c = await observer(s.base);
  const r = await c.get("/api/observe");
  assert.equal(r.status, 200, r.text);

  assert.deepEqual(Object.keys(r.body.sides).sort(), ["door", "hero"], "必须是双方，不多不少");
  assert.equal(r.body.sides.door.code, "【改这里：doorCode】");
  assert.equal(r.body.sides.hero.code, "【改这里：heroCode】");
  assert.equal(r.body.sides.door.role, "【改这里：girlfriend】");
  assert.equal(r.body.sides.hero.role, "【改这里：boyfriend】");

  assert.equal(r.body.sides.door.entries.length, 2, "她自己的两条都要在");
  assert.equal(r.body.sides.hero.entries.length, 2, "他自己的两条都要在");

  // 未解锁时，两个人的常规接口**都**只看得到自己 —— 观察者看到的是两边都有
  const mineA = await a.get("/api/entry");
  assert.equal(mineA.body.theirs.length, 0, "对照组：未解锁时她的接口里没有对方的东西");
  assert.equal(mineA.body.mine.length, 2);
  const mineB = await b.get("/api/entry");
  assert.equal(mineB.body.theirs.length, 0, "对照组：未解锁时他的接口里也没有对方的东西");

  assert.equal(r.body.shared.photos.length, 1, "共同层合照要在");
  assert.equal(r.body.shared.photos[0].photoId, "ph-sh");
  assert.equal(r.body.shared.days, 731);
  assert.ok(r.body.range.from && r.body.range.to);
  assert.equal(r.body.wishes.length, 2, "双方约定都要在");

  // 条目形状与 /api/entry 的 mine 逐字同构 —— 前端那套 card() 才能原样复用
  assert.deepEqual(
    Object.keys(r.body.sides.door.entries[0]).sort(),
    Object.keys(mineA.body.mine[0]).sort(),
    "观察者的条目形状必须与 /api/entry 完全一致，否则前端要另写一套渲染",
  );
  assert.ok(shotA.photo.id, "对照组：她的照片确实传上去了");
  assert.ok(shotB.photo.id, "对照组：他的照片确实传上去了");
});

test("观察者：拿到的是对方的照片元数据，且能顺着 id 真的取到字节", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const b = await login(s.base, HERO);
  await b.post("/api/entry", { kind: "text", body: "他的" });
  const photoId = (await upload(b, SMALL)).photo.id;

  const c = await observer(s.base);
  const r = await c.get("/api/observe");
  const hisEntry = r.body.sides.hero.entries.find((e) => e.photo);
  assert.ok(hisEntry, "他的照片条目必须在");
  assert.equal(hisEntry.photo.id, photoId, "照片 id 必须对得上，否则前端拼出来的地址是错的");
  assert.ok(hisEntry.photo.w > 0 && hisEntry.photo.h > 0, "宽高要在，九宫格要靠它算位置");

  // 核心：走前端的取图地址（/api/photo/:id），观察者的 cookie 就能拿到字节
  const got = await bytes(s.base, "obs=" + c.cookie.slice(4), `/api/photo/${photoId}`);
  assert.equal(got.status, 200, `观察者必须能取到图片字节：${got.status}`);
  assert.equal(got.type, "image/jpeg");
  assert.ok(got.body.length > 100, `字节数不对：${got.body.length}`);
});

/* ====================================================================== *
 * 3. 它真的只能看
 * ====================================================================== */

test("观察者：凭据不能写 —— 留言 / 改 / 撤 / 传图 / 约定 / 约定读全被拒", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  await a.post("/api/entry", { kind: "text", body: "她写的" });
  const shot = await upload(a, SMALL);
  const entry = (await a.get("/api/entry")).body.mine[0];

  const c = await observer(s.base);

  // 写侧全都要 401：obs 不是会话，personByToken 认不出来
  const writes = [
    ["POST", "/api/entry", { kind: "text", body: "观察者写的" }],
    ["PATCH", `/api/entry/${entry.id}`, { body: "观察者改的" }],
    ["DELETE", `/api/entry/${entry.id}`, undefined],
    ["POST", "/api/wish", { text: "观察者的约定" }],
  ];
  for (const [method, p, body] of writes) {
    const r = await c.req(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(r.status, 401, `${method} ${p} 必须 401，实际 ${r.status} ${r.text}`);
  }
  const { body: upBody, contentType } = multipart(SMALL);
  const up = await c.raw("/api/upload", { method: "POST", body: upBody, headers: { "content-type": contentType } });
  assert.equal(up.status, 401, "观察者不能传图");

  // 读侧也只有 /api/observe 一条
  for (const p of ["/api/entry", "/api/me"]) {
    const r = await c.get(p);
    assert.equal(r.status, 401, `${p} 必须 401，实际 ${r.status}`);
  }

  // 什么也没写进去
  const counts = direct(s.dbFile, "SELECT COUNT(*) AS n FROM entry").n;
  assert.equal(counts, 2, "观察者一次都没能写进库（对：她传照片自带一条）");
  assert.equal(direct(s.dbFile, "SELECT COUNT(*) AS n FROM photo").n, 1, "只有她传的那一张");
  assert.equal(direct(s.dbFile, "SELECT COUNT(*) AS n FROM wish").n, 0, "约定表不该被动过");
  assert.ok(shot.photo.id, "对照组：她那张确实在");
});

test("观察者：已撤回的条目不给了 —— 它是调试旁路，不是全知视角", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  await a.post("/api/entry", { kind: "text", body: "留着的" });
  // 被撤的那条**自带一张照片** —— 这样「撤条目」和「撤照片字节」是同一件事，
  // 不用在库里手工改 entry_id 才能观察（手工改出来的场景证明不了真链路）。
  const drop = await upload(a, SMALL);
  const photoId = drop.photo.id;

  const obs = client(s.base);
  await obs.post("/api/observe", { pin: PIN });
  const before = await bytes(s.base, obs.cookie, `/api/photo/${photoId}`);
  assert.equal(before.status, 200, "对照组：撤之前观察者看得到这张照片");

  const del = await a.del(`/api/entry/${drop.id}`);
  assert.equal(del.status, 204);

  const r = await obs.get("/api/observe");
  assert.equal(r.body.sides.door.entries.length, 1, "只剩那条文字");
  assert.ok(r.body.sides.door.entries.every((e) => e.id !== drop.id), "撤回的条目不该出现在观察者视图里");

  const gone = await bytes(s.base, obs.cookie, `/api/photo/${photoId}`);
  assert.equal(gone.status, 404, `撤回的照片不该还能取到：${gone.status}`);
});

test("观察者：限流与登录共用一套（同 IP 5 次锁 10 分钟）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const c = client(s.base);
  for (let i = 0; i < 4; i++) {
    const r = await c.post("/api/observe", { pin: "0000" });
    assert.equal(r.status, 401, `第 ${i + 1} 次应当是 401`);
  }
  const fifth = await c.post("/api/observe", { pin: "0000" });
  assert.equal(fifth.status, 429, "第 5 次当场锁");
  assert.ok(fifth.body.retryAfter > 0, "要告诉客户端还要等多久");

  // 锁着的时候连**对的** PIN 也不给进 —— 锁的是这条路，不是这个 PIN
  const right = await c.post("/api/observe", { pin: PIN });
  assert.equal(right.status, 429, "锁窗内正确的 PIN 也不放行");

  // 锁窗过了自动解锁
  s.setNow(JUST_BEFORE + 11 * 60 * 1000);
  const after = await c.post("/api/observe", { pin: PIN });
  assert.equal(after.status, 200, `锁窗过后应当能进：${after.text}`);
});

test("观察者：锁窗与两个生日共用 login_fail —— 不会给旁路单开一扇没锁的门", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const c = client(s.base);
  // 观察者那边错 4 次
  for (let i = 0; i < 4; i++) await c.post("/api/observe", { pin: "0000" });
  // 同一个 IP 再从生日那边错 1 次 —— 应当当场把**两边**一起锁上
  const login = await c.post("/api/login", { code: DOOR.code, birthday: "9999" });
  assert.equal(login.status, 429, `共用一张表就该共用一把锁，实际 ${login.status}`);
  assert.equal(direct(s.dbFile, "SELECT COUNT(*) AS n FROM login_fail").n, 1, "只有一行，不是两套");
});

/* ====================================================================== *
 * 4. 它没有顺手拆掉别的东西
 * ====================================================================== */

test("观察者：时间锁的两道闸门原样有效，obs 也不能从 /api/shared、/api/wish 走进去", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  s.db.prepare("INSERT INTO wish(person_id, text) VALUES('door','她的约定')").run();

  const c = await observer(s.base);
  for (const p of ["/api/shared", "/api/wish"]) {
    const r = await c.get(p);
    assert.equal(r.status, 404, `${p} 未解锁时必须 404，obs 也不例外（实际 ${r.status}）`);
  }
  // 闸门里的约定，观察者走自己的接口照样能读到
  assert.equal((await c.get("/api/observe")).body.wishes.length, 1);

  // 开门之后闸门才放行，且两个人走的老路一个字没改
  s.setNow(AT_UNLOCK);
  const a = await login(s.base, DOOR);
  await a.post("/api/entry", { kind: "text", body: "他的" });
  const opened = await a.get("/api/wish");
  assert.equal(opened.status, 200, "开门后约定照常可读");
});

test("观察者：10-5 之前，**本人**的常规接口一条没松（旁路不外溢）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  await a.post("/api/entry", { kind: "text", body: "她写的" });
  const b = await login(s.base, HERO);
  await b.post("/api/entry", { kind: "text", body: "他写的" });
  const photoId = (await upload(b, SMALL)).photo.id;

  // 观察者存在这件事，不该让他在未解锁时读到她的东西
  const c = await observer(s.base);
  assert.equal((await c.get("/api/observe")).status, 200);

  const viewA = await a.get("/api/entry");
  assert.equal(viewA.body.mine.length, 1, "只看得到自己写的");
  assert.equal(viewA.body.theirs.length, 0, "看不到对方写的 —— 观察者在场也不改变这一点");

  // 她的 cookie 读不到他的照片
  const herPhoto = await bytes(s.base, a.cookie, `/api/photo/${photoId}`);
  assert.equal(herPhoto.status, 404, `未解锁时她读不到他的照片：${herPhoto.status}`);
});

test("观察者：全站取图仍然只有 /api/photo/:id 一条路", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  // 用这套被测应用**自己**的路由表，不另起一个 createApp：
  // 另起的那个会多开一个库句柄，Windows 上清理临时目录时直接 EPERM。
  const routes = routesOf(s.app);

  const photoRoutes = routes.filter((r) => /photo|image|bytes|raw|download/i.test(r));
  assert.deepEqual(
    photoRoutes.sort(),
    ["GET /api/photo/:id"],
    `除它以外不得再有出字节的路径，实际：${JSON.stringify(photoRoutes)}`,
  );

  // 观察者自己只该有这三个路由，一条不多
  const observeRoutes = routes.filter((r) => r.includes("/api/observe"));
  assert.deepEqual(
    observeRoutes.sort(),
    ["GET /api/observe", "POST /api/observe", "POST /api/observe/logout"],
    `观察者路由应当只有这三个，实际：${JSON.stringify(observeRoutes)}`,
  );
});

test("观察者：不建表、不加行 —— 表还是 7 张，person 还是 2 行", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  await (await login(s.base, DOOR)).post("/api/entry", { kind: "text", body: "x" });
  const c = await observer(s.base);
  await c.get("/api/observe");

  const tables = direct(
    s.dbFile,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const names = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  assert.equal(names.length, 7, `表应当还是 7 张，实际 ${names.length}：${names.join(",")}`);
  assert.equal(direct(s.dbFile, "SELECT COUNT(*) AS n FROM person").n, 2, "person 不该多出第三个人");
  assert.equal(direct(s.dbFile, "SELECT COUNT(*) AS n FROM session").n, 1, "无状态凭据不占 session 表");
});

test("观察者：签名密钥落在数据目录里且重启不变（否则每次部署都被登出）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const c = await observer(s.base);
  const token = c.cookie.slice(4);

  const dir = mkdtempSync(path.join(tmpdir(), "two-years-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(path.join(dir, "k.db"));

  // 用同一个 dataDir 起第二个应用实例（模拟进程重启）
  const app2 = createApp({ db, now: () => JUST_BEFORE, dataDir: s.dir });
  const c2 = client(s.base);
  c2.setCookie("obs=" + token);
  assert.equal((await c2.get("/api/observe")).status, 200, "换进程后凭据必须还有效");
  db.close();
});

/* ====================================================================== *
 * 5. 密钥文件读不到时：必须当场炸，而且**绝不能**换一把新密钥
 * ====================================================================== */

test("观察者：密钥文件内容损坏时报错，而不是默默重建", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-badkey-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, ".observer-key");
  fs.writeFileSync(file, Buffer.from("太短了"));   // 3 字节 < 32
  const before = fs.readFileSync(file);

  assert.throws(
    () => createObserverAuth({ dataDir: dir, now: () => JUST_BEFORE }),
    /已损坏/,
    "内容不对就该明确报错",
  );
  assert.deepEqual(fs.readFileSync(file), before, "报错之后**不能**把它换掉——换掉等于作废所有已发出的凭据");
});

test("观察者：密钥文件读不到时（权限不对）报错，且不换密钥", async (t) => {
  // chmod 在 Windows 上没有权限语义，这条只在 POSIX 上跑。
  // 本机（Windows）跑不到，但它正是**线上**炸掉的那一种，所以必须留着，
  // 并在服务器上由 `npm run verify` 真正跑到 —— 那里才是它会发作的地方。
  if (process.platform === "win32") {
    t.diagnostic("Windows 上没有 POSIX 权限语义，这条用例在服务器上才会真正执行");
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-nokey-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, ".observer-key");
  const first = createObserverAuth({ dataDir: dir, now: () => JUST_BEFORE });
  const key = fs.readFileSync(file);
  assert.ok(key.length >= 32, "先有一把正常的钥匙");

  fs.chmodSync(file, 0o000);
  t.after(() => { try { fs.chmodSync(file, 0o600); } catch {} });
  if (process.getuid && process.getuid() === 0) {
    // root 无视权限位，这条在服务器上以 root 跑门禁时同样跑不到。
    // 留着的价值是：换成非 root 的部署机上它会真正生效。
    t.diagnostic("当前是 root，权限位无效，这条只在非 root 环境执行");
    return;
  }

  assert.throws(
    () => createObserverAuth({ dataDir: dir, now: () => JUST_BEFORE }),
    /dataDir|读不到|chown/,
    "读不到必须原样炸出来",
  );
  fs.chmodSync(file, 0o600);
  assert.deepEqual(fs.readFileSync(file), key, "**钥匙必须原封不动**——重建等于轮换密钥");

  // 恢复权限后，凭据仍然有效
  const again = createObserverAuth({ dataDir: dir, now: () => JUST_BEFORE });
  assert.equal(again.issue(), first.issue(), "同一把钥匙、同一个时刻，签出来的东西必须一样");
});

test("观察者：createApp 漏传 dataDir 当场拒绝启动", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-nodir-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(path.join(dir, "n.db"));

  // 真实事故：这里原本有默认值 path.join(ROOT, "data")，于是签名密钥被写进了
  // 生产数据目录（服务器上 ROOT 就是 /opt/two-years），以 root 跑一次门禁就
  // 把服务弄到起不来。默认值让「忘了传」与「故意传错」长得一模一样。
  //
  // 判据是「**这次调用没碰它**」，不是「那个路径上没有密钥」——
  // 服务器上 ROOT/data 就是生产数据目录，那里本来就该有一把钥匙。
  // 早先写成「文件不存在」，于是在服务器上必然红，而红的原因与要验的东西无关。
  const stray = path.join(ROOT, "data", ".observer-key");
  const existedBefore = fs.existsSync(stray);
  const contentBefore = existedBefore ? fs.readFileSync(stray) : null;
  const mtimeBefore = existedBefore ? fs.statSync(stray).mtimeMs : 0;

  assert.throws(
    () => createApp({ db, now: () => JUST_BEFORE }),
    /dataDir/,
    "漏传必须当场炸出来，不能默默用默认目录",
  );

  assert.equal(fs.existsSync(stray), existedBefore, "漏传这一次不许在默认目录里新建密钥");
  if (existedBefore) {
    assert.deepEqual(fs.readFileSync(stray), contentBefore, "更不许把已存在的那把换掉（等于轮换密钥）");
    assert.equal(fs.statSync(stray).mtimeMs, mtimeBefore, "连碰都不该碰它");
  }
  db.close();
});

test("观察者：PIN 由 OBSERVER_PASSWORD 决定，部署时可与生日不同", async (t) => {  const prev = process.env.OBSERVER_PASSWORD;
  process.env.OBSERVER_PASSWORD = "7788";
  t.after(() => {
    if (prev === undefined) delete process.env.OBSERVER_PASSWORD;
    else process.env.OBSERVER_PASSWORD = prev;
  });

  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const c = client(s.base);
  assert.equal((await c.post("/api/observe", { pin: PIN })).status, 401, "换掉之后缺省值就不该再能进");
  const ok = await c.post("/api/observe", { pin: "7788" });
  assert.equal(ok.status, 200, ok.text);
});

test("观察者：登录后不读任何正文（Cache-Control 不许缓存）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const c = await observer(s.base);
  const r = await c.get("/api/observe");
  assert.match(r.headers.get("cache-control") || "", /no-store/, "双方内容绝不能被中间层缓存");
});
