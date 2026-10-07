/**
 * 观察者旁路（测试专用）· 前端契约测试
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假网络（fetch 被打桩），
 * 装置照抄 test/ticket-02-frontend.test.js。断言落在界面上看得见的文本、
 * 渲染出来的元素集合与「我们向浏览器要了什么 URL」上，不碰内部实现。
 *
 * 这一份要挡住的是四件具体的事：
 *   1. **不回归**：hash 不在时，正常那条路一个字的都没变。
 *   2. **不露馅**：界面上没有半个字、没有一个链接指向这条旁路 ——
 *      两个人不该知道自己还有一个入口。
 *   3. **真的是同一份渲染**：双方的内容走阅读流那个 card(e, i, "read")，
 *      照片落在同一条取图路径上（/api/photo/:id），不是另画一套。
 *   4. **真的是只读**：进门之后界面上一个可写控件都不剩。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { cp } from "../src/copy-get.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_FILE = path.join(ROOT, "public", "index.html");
const APP_FILE = path.join(ROOT, "public", "app.js");

/* ── 假数据 ──────────────────────────────────────────────────────────
   正文用 ASCII：这些是「用户内容」，不是文案（与 ticket-08 那条同理）。 */
const D_TEXT = { id: "d-text", kind: "text", body: "DOOR-SIDE-BODY", ord: 2, created: 2, photo: null };
const D_PHOTO = { id: "d-photo", kind: "photo", body: "DOOR-CAPTION", ord: 1, created: 1,
  photo: { id: "photo-door", mime: "image/jpeg", w: 100, h: 125 } };
const H_TEXT = { id: "h-text", kind: "text", body: "HERO-SIDE-BODY", ord: 2, created: 2, photo: null };
const H_PHOTO = { id: "h-photo", kind: "photo", body: "", ord: 1, created: 1,
  photo: { id: "photo-hero", mime: "image/jpeg", w: 200, h: 150 } };

const OB_VIEW = {
  sides: {
    door: { code: "【改这里：doorCode】", role: "【改这里：girlfriend】", entries: [D_TEXT, D_PHOTO] },
    hero: { code: "【改这里：heroCode】", role: "【改这里：boyfriend】", entries: [H_TEXT, H_PHOTO] },
  },
  shared: {
    photos: [{ id: "sh1", photoId: "shared-photo-1", w: 10, h: 10 }],
    blessing: "BLESSING-BODY",
    from: "2024-10-05", to: "2026-10-05", days: 731,
  },
  wishes: [
    { id: "door", code: "【改这里：doorCode】", text: "WISH-DOOR" },
    { id: "hero", code: "【改这里：heroCode】", text: "WISH-HERO" },
  ],
  range: { from: "2024-10-05", to: "2026-10-05", days: 731 },
};

const LOCKED_STATUS = { status: 200, body: { unlocked: false, unlockAt: 1791129600000, unlockLabel: "2026-10-05T00:00:00+08:00", now: 1791129599000 } };
const UNLOCKED_STATUS = { ...LOCKED_STATUS, body: { ...LOCKED_STATUS.body, unlocked: true } };
const ME = { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: false, count: 2 };
const THEIRS = { id: "x-theirs", kind: "text", body: "THEIRS-BODY", ord: 1, created: 3, photo: null };

const ANON_ROUTES = {
  "GET /api/status": LOCKED_STATUS,
  "GET /api/me": { status: 401, body: { error: "no_session" } },
};
const DESK_ROUTES = {
  "GET /api/status": LOCKED_STATUS,
  "GET /api/me": { status: 200, body: ME },
  "GET /api/entry": { status: 200, body: { mine: [D_TEXT], theirs: [THEIRS] } },
  "POST /api/logout": { status: 204 },
};
/** 开门后的阅读流：走一遍确认那一屏也没漏出旁路的字样 */
const READING_ROUTES = {
  "GET /api/status": UNLOCKED_STATUS,
  "GET /api/me": { status: 200, body: { ...ME, unlocked: true } },
  "GET /api/entry": { status: 200, body: { mine: [D_TEXT], theirs: [THEIRS] } },
  "GET /api/shared": { status: 200, body: OB_VIEW.shared },
  "GET /api/wish": { status: 200, body: { wishes: OB_VIEW.wishes } },
};
const OK_ROUTES = {
  "POST /api/observe": { status: 200, body: { ok: true } },
  "GET /api/observe": { status: 200, body: OB_VIEW },
};

/* 旁路界面上真的会出现的字（从数据源里取，不手抄）。
   「不许露馅」那条断言用的是这张表，而下面「进门后」那条会证明它们真的会出现 ——
   两边合起来才是鉴别力：表里的串如果是编的，露馅那条就恒真。 */
const OB_ONLY_TEXT = [
  "observe.title", "observe.hint", "observe.pin", "observe.enter", "observe.leave",
  "observe.shared", "observe.side", "observe.wishes",
].map((k) => cp(k));

async function mount(routes, { hash = "" } = {}) {
  const seen = [];
  const timers = { interval: 0 };
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      // hash 要在**脚本跑起来之前**就在：真实打开就是带着 #observe 加载的，
      // 那条路走的是 boot() 里的分支，不是后来改 hash 的 hashchange。
      if (hash) w.location.hash = hash;
      const real = w.setInterval.bind(w);
      w.setInterval = (...a) => { timers.interval += 1; return real(...a); };
      w.fetch = async (url, init = {}) => {
        const key = `${(init.method || "GET").toUpperCase()} ${url}`;
        seen.push(key);
        const r = routes[key];
        const status = r ? r.status : 404;
        const body = r && status !== 204 ? r.body : { error: "not_found" };
        return new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      };
    },
  });
  return { dom, seen, timers };
}

async function boot(t, routes, opts = {}) {
  const { dom, seen, timers } = await mount(routes, opts);
  t.after(() => dom.window.close());
  for (let i = 0; i < 200 && !dom.window.__t02; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t02, "public/index.html 没有跑起 public/app.js");
  await dom.window.__t02.ready;
  const doc = dom.window.document;
  return {
    win: dom.window, doc, seen, timers,
    text: () => doc.body.textContent,
    html: () => doc.querySelector("#app").innerHTML,
    click(sel) {
      const el = doc.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      return el;
    },
    fill(sel, value) {
      const el = doc.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      el.value = value;
      return el;
    },
    submit(sel) {
      const el = doc.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      el.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    },
  };
}

async function until(pred, msg) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.fail(msg);
}

/** 走完口令：填 → 提交 → 等它把门画出来。
 *  纯 jsdom，接口是打桩的，这里要的是**一串非空凭据**而不是真的口令；
 *  取的是观察者测试口令（00030303），与两边口令不同 —— 免得读代码的人
 * 以为观察者 PIN 就是【改这里：heroCode】的生日。 */
async function enterAs(ui, pin = "00030303") {
  ui.fill("#ob-pin", pin);
  ui.submit('form[data-form="observe"]');
}

/* ══════════ 1. 不回归：hash 不在时，那条路一个字都没变 ══════════ */

test("不带 #observe 时：正常入口一字未变，一条 /api/observe 都没打过", async (t) => {
  const ui = await boot(t, DESK_ROUTES);

  assert.equal(ui.win.__t07.OB.on, false, "没带 hash 却进了旁路");
  assert.equal(ui.doc.querySelector("#observe"), null, "封印页里不该长出旁路的根节点");
  assert.ok(ui.text().includes("两年了"), "封印页没出来");
  assert.equal(ui.timers.interval, 1, "全站只应有一个 setInterval");

  const asked = ui.seen.filter((k) => k.includes("/api/observe"));
  assert.deepEqual(asked, [], `没带 hash 却打了旁路接口：${JSON.stringify(asked)}`);

  // 有会话时封印页的入口是「进 去 看」，点它进布置台
  ui.click('[data-go="desk"]');
  assert.ok(ui.text().includes(D_TEXT.body), "布置台没出来");
  assert.ok(!ui.text().includes(OB_VIEW.shared.blessing), "未解锁时出现了共同层的祝福语");

  // 布置台上没有身份页那种 data-go，所以走退出回封印页，确认那条路没被改
  ui.click("[data-logout]");
  await until(() => ui.text().includes("我先去布置"), "退出后没有回到封印页");
  assert.equal(ui.doc.querySelector("#observe"), null, "来回走了一趟之后长出了旁路的根节点");
  t.diagnostic(`普通入口：封印→布置台→退出→封印 都在；旁路接口 0 次`);
});

/* ══════════ 2. 不露馅：界面上没有半个字指向它 ══════════ */

test("印章页 / 布置台 / 阅读流 / 页脚的可见文本里没有 observe 相关字样", async (t) => {
  const screens = [];

  const anon = await boot(t, ANON_ROUTES);                 // 封印页
  screens.push(["封印页", anon.text()]);
  anon.click('[data-go="who"]');  screens.push(["身份页", anon.text()]);
  anon.click('[data-who="door"]'); screens.push(["密码页", anon.text()]);

  const desk = await boot(t, DESK_ROUTES);                // 布置台
  desk.click('[data-go="desk"]'); screens.push(["布置台", desk.text()]);

  const rd = await boot(t, READING_ROUTES);               // 阅读流（开门后）
  deskClick(rd);
  screens.push(["阅读流", rd.text()]);

  for (const [where, text] of screens) {
    for (const w of OB_ONLY_TEXT) {
      assert.ok(!text.includes(w), `${where} 出现了只有旁路才该有的文案「${w}」`);
    }
    assert.ok(!text.includes("观 察 者"), `${where}出现了「观 察 者」`);
    assert.ok(!text.includes("observe"), `${where}的可见文本里出现了 observe`);
    assert.ok(!text.includes("#observe"), `${where}的可见文本里出现了 #observe`);
  }
  t.diagnostic(`扫了 ${screens.length} 屏：${screens.map(([w]) => w).join(" / ")}，可见文本里 0 处 observe`);

  const sealText = screens[0][1];
  // 页脚单独点一次名：seal.foot 是常驻那一行。它只在封印页上有，所以读的是**当时**的快照
  assert.ok(sealText.includes(cp("seal.foot")), "封印页的页脚没出来——下面那句断言是空转");
  assert.ok(!sealText.includes(cp("observe.leave")), "页脚被塞进了旁路的按钮文案");

  // 界面上没有任何一个元素链到它（hash 入口不许有 <a>）
  for (const [, ui] of [[0, anon], [0, desk], [0, rd]]) {
    for (const a of ui.doc.querySelectorAll("a[href]")) {
      assert.ok(!a.getAttribute("href").includes("observe"), `界面上有个链接指向旁路：${a.getAttribute("href")}`);
    }
  }
});

/** 开门后同一个入口就是阅读流（与 app.js 的 desk 路由分流同一条路） */
function deskClick(ui) {
  ui.click('[data-go="desk"]');
  return ui;
}

test("入口本身也不在页面里：index.html / app.js 源码里没有任何导航链到它", () => {
  const html = fs.readFileSync(HTML_FILE, "utf8");
  assert.ok(!/observe/i.test(html), "public/index.html 里出现了 observe —— 应急页/静态页会把它带出去");

  const src = fs.readFileSync(APP_FILE, "utf8");
  // 代码里只允许两种出现：接口路径常量，与 #observe 这个 hash 常量。
  // 任何一个 <a href="#observe"> 或 data-* 导航项都会在这里被抓到。
  assert.ok(!/<a\b[^>]*observe/i.test(src), "app.js 里有个 <a> 指向旁路");
  assert.ok(!/href\s*=\s*["'][^"']*observe/i.test(src), "app.js 里有个 href 指向旁路");
  assert.ok(!/data-(go|who|add|pick)\s*=\s*["']?observe/i.test(src), "app.js 把旁路挂进了正常那几屏的导航属性");
});

/* ══════════ 3. 口令：错显服务端的 hint，被锁显秒数 ══════════ */

test("口令错：显示服务端给的 hint，不是前端自己编的那句", async (t) => {
  const HINT = "SERVICE-HINT-EXACTLY";
  const ui = await boot(t, { "POST /api/observe": { status: 401, body: { error: "bad_credentials", hint: HINT } } }, { hash: "#observe" });

  assert.ok(ui.doc.querySelector("#ob-pin"), "带 hash 进来该是口令门");
  enterAs(ui, "9999");
  await until(() => ui.doc.querySelector("#ob-msg").textContent.length > 0, "口令错了却没有任何提示");

  const msg = ui.doc.querySelector("#ob-msg").textContent;
  assert.equal(msg, HINT, `401 的提示不是服务端那句：${msg}`);
  assert.ok(!msg.includes("凭据没了"), "401 落到了前端兜底那句上——服务端 hint 没被原样显示");
  assert.ok(ui.seen.includes("POST /api/observe"), "没有真的打 POST /api/observe");
  t.diagnostic(`401 → #ob-msg = 「${msg}」`);
});

test("被锁（429）：显示 retryAfter 秒数，用 err.locked 那条文案", async (t) => {
  const ui = await boot(t, { "POST /api/observe": { status: 429, body: { error: "locked", retryAfter: 600 } } }, { hash: "#observe" });

  enterAs(ui, "00030303");
  await until(() => ui.doc.querySelector("#ob-msg").textContent.length > 0, "429 没有任何提示");

  const msg = ui.doc.querySelector("#ob-msg").textContent;
  assert.match(msg, /600/, `429 的提示里没有秒数：${msg}`);
  assert.equal(msg, cp("err.locked", { n: 600 }), `429 没有用 err.locked 那条文案：${msg}`);
  assert.ok(!msg.includes("凭据没了"), "被锁时显示成「凭据没了」——她会以为自己又输错了，接着试");
  t.diagnostic(`429 → #ob-msg = 「${msg}」`);
});

/* ══════════ 4. 进门后：双方内容 + 共同层，照片真的显示 ══════════ */

test("进门后：双方的内容都渲染出来了，照片 src 走 /api/photo/<photo.id>", async (t) => {
  const ui = await boot(t, OK_ROUTES, { hash: "#observe" });
  enterAs(ui);
  await until(() => !!ui.doc.querySelector("#observe .ob-sides"), "进门后没有画出旁路那一屏");

  const text = ui.text();
  // 正向：旁路那些词**确实**出现了（上面「不露馅」那条断言的鉴别力来源）
  for (const w of [cp("observe.title"), cp("observe.shared"), cp("observe.side"), cp("observe.wishes")]) {
    assert.ok(text.includes(w), `旁路视图里看不到「${w}」——「不露馅」那条的词表可能是编出来的`);
  }
  // 双方各自的代号与内容
  for (const w of [OB_VIEW.sides.door.code, OB_VIEW.sides.hero.code, D_TEXT.body, H_TEXT.body, D_PHOTO.body]) {
    assert.ok(text.includes(w), `观察者视图里缺了「${w}」`);
  }
  // 共同层
  assert.ok(text.includes(OB_VIEW.shared.blessing), "共同层的祝福语没出来");
  assert.ok(text.includes("731"), "共同层的 731 天没出来");
  assert.ok(text.includes("2024 年 10 月 5 日") && text.includes("2026 年 10 月 5 日"), "共同层的日期区间没出来");
  // 双方约定
  assert.ok(text.includes("WISH-DOOR") && text.includes("WISH-HERO"), "双方的约定没出来");

  // ── 照片：这块是这一整条旁路存在的理由（「东西传上去之后真的能看到」）
  //
  // ⚠️ 诚实的边界（写在这里，别被下面这些绿断言骗了）：这一段问的是
  // **应用渲染出了什么**（observeView() 吐出的那段 HTML），不是「浏览器最后显示了什么」。
  // jsdom 不会真的去取 /api/photo/*，那张图会立刻触发 error 并被工单 06 那个兜底
  // 换成占位块 —— 那是既有行为，不是旁路的毛病。像素那一层留给真浏览器（e2e）。
  const markup = ui.win.__t07.observeView();
  for (const e of [D_PHOTO, H_PHOTO]) {
    assert.ok(
      markup.includes(`<img class="ph" src="/api/photo/${e.photo.id}"`),
      `渲染产物里没有 ${e.photo.id} 那张图；实际产物：${markup}`,
    );
  }
  // 共同层合照走的是同一条取图路，只是字段名是 photoId
  assert.ok(
    markup.includes('<img class="gimg" src="/api/photo/shared-photo-1"'),
    "九宫格那一格没渲染出共同层合照",
  );
  // 真的画成了 <img>，而不是一块占位块：兜底那一路会在原地塞进 .ph.img-fb
  assert.ok(!/img-fb/.test(markup), "渲染产物里出现了破图兜底的占位块 —— 照片没被画出来");
  // 照片落在阅读流同款的照片框里，说明用的是同一个渲染器
  assert.equal((markup.match(/<div class="pframe">/g) || []).length, 2, "两侧的照片卡没落在 .pframe 里");
  t.diagnostic(`渲染产物里两张照片卡 + 一格合照，src 全走 /api/photo/：${
    (markup.match(/\/api\/photo\/[a-z0-9-]+/gi) || []).join(" / ")}`);
});

test("进门后：双方都用 card(..., \"read\")——没有撤回角标 / 操作行 / 输入框", async (t) => {
  const ui = await boot(t, OK_ROUTES, { hash: "#observe" });
  enterAs(ui);
  await until(() => !!ui.doc.querySelector("#observe .ob-sides"), "进门后没有画出旁路那一屏");

  // 两侧都渲染了内容（空集合的话上面那些空集合断言会全部空转）
  assert.equal(ui.doc.querySelectorAll('[data-side="door"] .letter').length, 2, "【改这里：doorCode】那一侧没渲染出两条");
  assert.equal(ui.doc.querySelectorAll('[data-side="hero"] .letter').length, 2, "【改这里：heroCode】那一侧没渲染出两条");

  // read 态：撤回角标 / 操作行 / 配文输入框一个都不渲染
  assert.deepEqual(Array.from(ui.doc.querySelectorAll("#observe .ops")).map((n) => n.className), [], "read 态渲染了操作行");
  assert.deepEqual(Array.from(ui.doc.querySelectorAll("#observe [data-del]")).map((n) => n.tagName), [], "read 态渲染了撤回入口");
  assert.deepEqual(Array.from(ui.doc.querySelectorAll("#observe [data-edit], #observe [data-cap]")).map((n) => n.tagName), [], "read 态渲染了改写入口");
  assert.ok(ui.text().includes("已 送 达"), "信卡的封条应当是 read 态的「已送达」");

  // 反向断言：edit 态确实产出这些 —— 否则上面那组空集合可能只是「什么都不产出」
  const edit = ui.doc.createElement("div");
  edit.innerHTML = ui.win.__t04.card(D_PHOTO, 0, "edit");
  assert.ok(edit.querySelector(".ops"), "edit 态应当有操作行——上面那组空集合没有鉴别力");
  assert.ok(edit.querySelector("[data-del]"), "edit 态应当有撤回入口");
});

/* ══════════ 5. 只读：进门之后一个可写控件都不剩 ══════════ */

test("观察者视图里不存在任何可写控件", async (t) => {
  const ui = await boot(t, OK_ROUTES, { hash: "#observe" });
  enterAs(ui);
  await until(() => !!ui.doc.querySelector("#observe .ob-sides"), "进门后没有画出旁路那一屏");

  const writable = "#observe input, #observe textarea, #observe select, #observe [contenteditable]";
  assert.deepEqual(
    Array.from(ui.doc.querySelectorAll(writable)).map((n) => n.tagName),
    [],
    "观察者视图里出现了可写控件",
  );
  // 写操作的入口也一个都没有
  for (const sel of ["[data-del]", "[data-edit]", "[data-cap]", "[data-add]", "[data-pick]", "#pick-photo"]) {
    assert.equal(ui.doc.querySelector(`#observe ${sel}`), null, `观察者视图里出现了写操作入口 ${sel}`);
  }
  // 反向：门（还没进门时）是允许有口令框的，所以上面那条对进门之后才成立
  const gate = await boot(t, OK_ROUTES, { hash: "#observe" });
  assert.ok(gate.doc.querySelector("#ob-pin"), "口令门该有那个输入框——上面那条就变成恒真式了");
  t.diagnostic("进门后 input/textarea/select/contenteditable = 0；门上有 1 个口令框（反例在同一条里）");
});

/* ══════════ 6. 出门：回到普通入口 ══════════ */

test("「出去」：打一次 logout，回到普通入口，旁路读到的东西一件不留在正常那条路上", async (t) => {
  const ui = await boot(t, { ...OK_ROUTES, ...ANON_ROUTES, "POST /api/observe/logout": { status: 204 } }, { hash: "#observe" });
  enterAs(ui);
  await until(() => !!ui.doc.querySelector("#observe .ob-sides"), "进门后没有画出旁路那一屏");

  ui.click("[data-ob='leave']");
  await until(() => ui.text().includes("我先去布置"), "出去之后没有回到封印页");

  assert.ok(ui.seen.includes("POST /api/observe/logout"), "没有真的打 POST /api/observe/logout");
  assert.notEqual(ui.win.location.hash, "#observe", "hash 没清掉，刷新一下又进旁路");
  assert.equal(ui.win.__t07.OB.on, false, "还在旁路那一屏");
  assert.equal(ui.win.__t07.OB.data, null, "旁路读到的内容还留在内存里");
  assert.equal(ui.win.__t07.S.shared, null, "共同层还留在正常那条路的状态里——出门没清干净");
  assert.ok(!ui.text().includes(OB_VIEW.shared.blessing), "出门后共同层的祝福语还留在界面上");
});

test("运行中把 hash 改成 #observe：口令门自己出来", async (t) => {
  const ui = await boot(t, ANON_ROUTES);
  assert.equal(ui.doc.querySelector("#observe"), null, "一开始就长出了旁路的根节点");

  ui.win.location.hash = "#observe";
  await until(() => !!ui.doc.querySelector("#ob-pin"), "改了 hash 之后口令门没出来");
  assert.equal(ui.win.__t07.OB.on, true, "hashchange 那条路没把 OB.on 置上");
  t.diagnostic("hashchange → 口令门（这条是运行中切换，不是带着 hash 加载）");
});

/* ══════════ 7. 取图路径仍然只有一条（CONSTRAINTS §3）══════════ */

test("没有第二条取图路径：旁路不给照片单开接口", () => {
  // 全站「只有一条」那条断言由 ticket-03 守着；这里只补**旁路特有**的那一面。
  // 只数代码：注释里复述这条契约不算一条路径（app.js 里就有好几处）。
  const code = fs.readFileSync(APP_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
  const hits = code.match(/\/api\/photo\//g) || [];
  assert.equal(hits.length, 1, `app.js 的代码里出现了 ${hits.length} 处 /api/photo/ 取图路径 —— 只能有一条`);
  assert.ok(
    !/\/api\/observe\/photo/.test(code),
    "旁路给照片单开了一条取图接口——取图鉴权散在两处，早晚对「谁能看哪张」得出不同答案",
  );
});

test("旁路只有一个 setInterval：换 hash、进门、重画都不新建", async (t) => {
  const ui = await boot(t, { ...OK_ROUTES, ...ANON_ROUTES, "POST /api/observe/logout": { status: 204 } }, { hash: "#observe" });
  assert.equal(ui.timers.interval, 1, "带 hash 启动就不该多于一个 setInterval");

  enterAs(ui);
  await until(() => !!ui.doc.querySelector("#observe .ob-sides"), "进门后没有画出旁路那一屏");
  for (let i = 0; i < 5; i++) ui.win.__t07.renderObserve();
  assert.equal(ui.timers.interval, 1, "renderObserve() 里建了 setInterval");

  ui.click("[data-ob='leave']");
  await until(() => ui.text().includes("我先去布置"), "出去之后没有回到封印页");
  assert.equal(ui.timers.interval, 1, "换回正常入口时又建了 setInterval");
});
