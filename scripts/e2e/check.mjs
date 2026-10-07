/**
 * E2E 双向视角校验 —— 证明「解封后各自看到的是**对方**的东西，不是自己的」。
 *
 * 判定方式：**唯一标记法**。种子脚本给每一方的每一条内容塞了只可能来自那一方的串
 * （MK-door-xxxx / MK-hero-xxxx）。这里从**服务端真实响应**里取标记，
 * 再逐条点名，不靠「界面上有某句话」——那种断言在任何内容下都恒真。
 *
 * 两种模式：
 *   node scripts/e2e/check.mjs --dir <种子目录>              起本地实例（注入假时钟，测解封后）
 *   node scripts/e2e/check.mjs --dir <目录> --base http://…  打已有服务（线上冒烟用）
 *   node scripts/e2e/check.mjs --dir <目录> --locked         测解封前（不注入时钟）
 *   node scripts/e2e/check.mjs --dir <目录> --observer-pin 7788   线上换过 PIN 时用
 *
 * 每个模式都跑两套断言：两个人的双向视角（看得到对方、看不到自己），
 * 以及观察者旁路（一个人一次看全两边 + 照片字节真的取得到）。
 *
 * 产出 <目录>/report.json。
 */
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../../src/app.js";
import { openDb } from "../../src/db.js";
import { UNLOCK_AT } from "../../src/clock.js";
import { TEST_SECRET, useTestSecrets } from "../../test/helpers.js";

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const DIR = path.resolve(argOf("--dir", ""));
const BASE = argOf("--base", null);
const LOCKED = has("--locked");
/** 观察者 PIN。线上那套部署会用 OBSERVER_PASSWORD 换掉缺省值，所以留个口子。 */
const OBSERVER_PIN = argOf("--observer-pin", TEST_SECRET.OBSERVER_PASSWORD);
if (!DIR) { console.error("必须给 --dir <种子目录>"); process.exit(2); }

const M = JSON.parse(fs.readFileSync(path.join(DIR, "markers.json"), "utf8"));
/** 与下面 createApp 前注入的是同一批值 —— 两边不同源的话，红的是 401，离原因很远 */
const LOGIN = {
  door: { code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD },
  hero: { code: "【改这里：heroCode】", birthday: TEST_SECRET.HERO_PASSWORD },
};
const OTHER = { door: "hero", hero: "door" };

/* ── 结果收集 ───────────────────────────────────────────── */
const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass: !!pass, detail }); return !!pass; };

/* ── HTTP 客户端（自带 cookie jar）───────────────────────── */
function client(base, jar) {
  return async (method, url, body, headers = {}) => {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload = body;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isForm && !h["content-type"]) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(`${base}${url}`, { method, headers: h, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(";"); const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === "") jar.delete(k); else jar.set(k, v);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch { /* 非 JSON */ }
    return { status: res.status, buf, json, ctype: res.headers.get("content-type") || "" };
  };
}

/* ── 跑一遍（对某个 base 跑两次，两个角色各一次）──────────── */
async function runSuite(base, label) {
  const perRole = {};
  for (const who of ["door", "hero"]) {
    const other = OTHER[who];
    const jar = new Map();
    const call = client(base, jar);

    const login = await call("POST", "/api/login", LOGIN[who]);
    ok(`${label} · ${who} 能登录`, login.status === 200, `status=${login.status}`);

    const entries = await call("GET", "/api/entry");
    const mine = entries.json?.mine ?? [];
    const theirs = entries.json?.theirs ?? [];

    // 自己的：必须有，且含自己的标记
    const mineText = JSON.stringify(mine);
    ok(`${label} · ${who} 读得到自己的 ${mine.length} 条`, mine.length >= 4, `mine=${mine.length}`);
    for (const k of ["letterMark", "tailMark"]) {
      ok(`${label} · ${who} 的 mine 含自己的 ${k}`, mineText.includes(M[who][k]), M[who][k]);
    }

    if (LOCKED) {
      // 解封前：对方内容一条都不许给
      ok(`${label} · ${who} 解封前 theirs 恒为空`, theirs.length === 0, `theirs=${theirs.length}`);
      const shared = await call("GET", "/api/shared");
      ok(`${label} · ${who} 解封前 /api/shared 是 404`, shared.status === 404, `status=${shared.status}`);
    } else {
      // 解封后：theirs 必须**只**含对方的标记，一个自己的都不许有
      const theirsText = JSON.stringify(theirs);
      ok(`${label} · ${who} 读得到对方的 ${theirs.length} 条`, theirs.length >= 4, `theirs=${theirs.length}`);
      for (const k of ["letterMark", "tailMark"]) {
        ok(`${label} · ${who} 的 theirs 含对方的 ${k}`, theirsText.includes(M[other][k]), M[other][k]);
      }
      for (const k of ["letterMark", "tailMark", "wishMark", "capMark"]) {
        ok(`${label} · ${who} 的 theirs **不含自己的** ${k}`, !theirsText.includes(M[who][k]), M[who][k]);
      }

      // 照片：取的是对方的文件，且字节与库里的行对得上
      for (const pid of M[other].photoIds) {
        const r = await call("GET", `/api/photo/${pid}`);
        ok(`${label} · ${who} 能取到对方的照片 ${pid.slice(0, 10)}…`, r.status === 200 && r.buf.length > 0,
           `status=${r.status} bytes=${r.buf.length}`);
        ok(`${label} · ${who} 取到的是 JPEG`, (r.ctype || "").includes("jpeg"), r.ctype);
      }
      // 自己那份**也**能取（布置台要能看见自己的）——但它绝不能出现在 theirs 的集合里
      const theirsPhotoIds = new Set(theirs.filter((e) => e.photo?.id).map((e) => e.photo.id));
      const leak = M[who].photoIds.filter((id) => theirsPhotoIds.has(id));
      ok(`${label} · ${who} 的 theirs 里没有自己的照片`, leak.length === 0, `leak=${leak.join(",")}`);

      // 共同层：双方都读得到
      const shared = await call("GET", "/api/shared");
      ok(`${label} · ${who} 解封后能读共同层`, shared.status === 200, `status=${shared.status}`);
      ok(`${label} · ${who} 的共同层含祝福语`, JSON.stringify(shared.json || {}).includes(M.shared.blessing), "");
      ok(`${label} · ${who} 的共同层照片数=${M.shared.photoIds.length}`,
         (shared.json?.photos || []).length === M.shared.photoIds.length,
         `got=${(shared.json?.photos || []).length}`);

      // 约定：两条都在，且**自己那条 + 对方那条**
      const wish = await call("GET", "/api/wish");
      const wtext = JSON.stringify(wish.json || {});
      ok(`${label} · ${who} 读到两条约定`, (wish.json?.wishes || []).length === 2, `n=${(wish.json?.wishes || []).length}`);
      ok(`${label} · ${who} 的约定含自己那条`, wtext.includes(M[who].wishMark), M[who].wishMark);
      ok(`${label} · ${who} 的约定含对方那条`, wtext.includes(M[other].wishMark), M[other].wishMark);
    }

    perRole[who] = { mine: mine.length, theirs: theirs.length };
  }

  /* 匿名：期望**按状态分**，不是一律 401。
     闸门（src/app.js 的 LOCKED_PREFIXES）只挡 /api/shared 与 /api/wish 的**读**方法，
     而且它跑在会话检查**之前** —— 所以未解锁时匿名打这两个拿到的是 404（闸门），
     不是 401（会话）。开门之后闸门放行，才轮到会话检查给出 401。
     写成「一律 401」会把正确的行为判成失败；写成「一律 404」又会漏掉开会话检查。 */
  const anon = client(base, new Map());
  const ANON_EXPECT = LOCKED
    ? { "/api/entry": 401, "/api/me": 401, "/api/shared": 404, "/api/wish": 404 }
    : { "/api/entry": 401, "/api/me": 401, "/api/shared": 401, "/api/wish": 401 };
  for (const [u, want] of Object.entries(ANON_EXPECT)) {
    const r = await anon("GET", u);
    ok(`${label} · 匿名 ${u} 是 ${want}`, r.status === want, `status=${r.status} want=${want}`);
  }
  /* ── 观察者旁路 ───────────────────────────────────────────
     单开一个套件，因为它验的是**另一件事**：
     上面验的是「各自只看得到对方」，这里验的是「一个人一次看全两边」。
     两件事的方向相反，共用一套断言会互相掩盖。

     关键是**照片字节**那条：标记出现在 JSON 里不等于图片能显示，
     而这个旁路存在的唯一理由就是确认图片显示得出来。 */
  const obs = client(base, new Map());

  const noObs = await obs("GET", "/api/observe");
  ok(`${label} · 观察者无凭据是 401`, noObs.status === 401, `status=${noObs.status}`);

  const enter = await obs("POST", "/api/observe", { pin: OBSERVER_PIN });
  ok(`${label} · 观察者用 PIN 进得来`, enter.status === 200, `status=${enter.status} ${enter.buf.toString("utf8").slice(0, 120)}`);

  if (enter.status === 200) {
    const view = await obs("GET", "/api/observe");
    ok(`${label} · 观察者读得到全貌`, view.status === 200, `status=${view.status}`);
    const sides = view.json?.sides ?? {};
    const dtext = JSON.stringify(sides.door ?? {});
    const htext = JSON.stringify(sides.hero ?? {});
    const all = JSON.stringify(sides);

    // 两边都在同一个响应里 —— 这正是观察者与两个人各自视角的**唯一**区别
    ok(`${label} · 观察者一次读到双方的标记`,
       all.includes(M.door.letterMark) && all.includes(M.hero.letterMark),
       `door=${all.includes(M.door.letterMark)} hero=${all.includes(M.hero.letterMark)}`);

    // 分侧归属：不能串。door 那块只该有 door 的，hero 那块只该有 hero 的
    ok(`${label} · door 侧含 door 的标记`, dtext.includes(M.door.letterMark), "");
    ok(`${label} · door 侧不含 hero 的标记`, !dtext.includes(M.hero.letterMark), M.hero.letterMark);
    ok(`${label} · hero 侧含 hero 的标记`, htext.includes(M.hero.letterMark), "");
    ok(`${label} · hero 侧不含 door 的标记`, !htext.includes(M.door.letterMark), M.door.letterMark);

    // 共同层与约定
    const sharedPhotos = view.json?.shared?.photos || [];
    ok(`${label} · 观察者的共同层照片数=${M.shared.photoIds.length}`,
       sharedPhotos.length === M.shared.photoIds.length,
       `got=${sharedPhotos.length}`);

    // 照片字节：双方 + 共同层，一张一张真取。这是「图片能显示」的机器判据。
    //
    // ⚠️ 共同层的 id **不能**从 markers 里取：`markers.shared.photoIds` 装的是
    // 素材**文件名**（seed 写盘时推的），而 /api/photo/:id 收的是 photo 表的 id。
    // 早先直接拼 markers，3 张合照全部 404 —— 看着像「观察者看不到公共照片」，
    // 其实是断言取了错的键。正确的来源是**服务端响应**。
    const allPhotoIds = [
      ...M.door.photoIds,
      ...M.hero.photoIds,
      ...sharedPhotos.map((p) => p.photoId),
    ];
    let gotOk = 0;
    for (const pid of allPhotoIds) {
      const r = await obs("GET", `/api/photo/${pid}`);
      if (r.status === 200 && r.buf.length > 0 && (r.ctype || "").includes("jpeg")) gotOk++;
      else ok(`${label} · 观察者取不到照片 ${String(pid).slice(0, 14)}…`, false, `status=${r.status} bytes=${r.buf.length} ctype=${r.ctype}`);
    }
    ok(`${label} · 观察者能取到全部 ${allPhotoIds.length} 张照片`, gotOk === allPhotoIds.length, `ok=${gotOk}/${allPhotoIds.length}`);

    const wtext = JSON.stringify(view.json?.wishes || []);
    ok(`${label} · 观察者读到两条约定`, (view.json?.wishes || []).length === 2, `n=${(view.json?.wishes || []).length}`);
    ok(`${label} · 观察者的约定含双方标记`, wtext.includes(M.door.wishMark) && wtext.includes(M.hero.wishMark), "");
    ok(`${label} · 观察者看得到 731 天`, view.json?.range?.days === 731, `days=${view.json?.range?.days}`);

    // 只读：obs 换成 sid 一样什么都干不了
    const ro = await obs("POST", "/api/entry", { kind: "text", body: "MK-observer-should-not-write" });
    ok(`${label} · 观察者写不了留言`, ro.status === 401, `status=${ro.status}`);
    const rd = await obs("GET", "/api/entry");
    ok(`${label} · 观察者读不到 /api/entry`, rd.status === 401, `status=${rd.status}`);

    // 时间锁两道闸门没被拆：obs 也走不通
    for (const u of ["/api/shared", "/api/wish"]) {
      const r = await obs("GET", u);
      const want = LOCKED ? 404 : 401;
      ok(`${label} · 观察者走 ${u} 是 ${want}（闸门没被拆）`, r.status === want, `status=${r.status}`);
    }
  }

  return perRole;
}

/* ── 主流程 ─────────────────────────────────────────────── */
let server = null, db = null, base = BASE;
const label = LOCKED ? "解封前" : "解封后";
try {
  if (!base) {
    // 口令必须在 createApp 之前注入：src/auth.js 与 src/observer-auth.js 没有缺省值了。
    useTestSecrets();
    db = openDb(M.db);
    // 解封前：不注入时钟（真实 now）。解封后：注入到开门之后 1 分钟。
    // dataDir 必须跟着库走：观察者的签名密钥落在里面，不传就掉进仓库的 data/。
    const app = createApp({
      db,
      now: LOCKED ? Date.now : () => UNLOCK_AT + 60_000,
      dataDir: path.dirname(M.db),
    });
    server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const label = LOCKED ? "解封前" : "解封后";
  console.error(`[e2e-check] ${label} · base=${base}`);
  await runSuite(base, label);
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (db) db.close();
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
const report = { dir: DIR, base, locked: LOCKED, total: results.length, pass, fail, results };
fs.writeFileSync(path.join(DIR, `report${LOCKED ? "-locked" : ""}.json`), JSON.stringify(report, null, 2), "utf8");

for (const r of results) if (!r.pass) console.log(`✖ ${r.name}  ${r.detail}`);
console.log(`\n${label}：${pass}/${results.length} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
