/**
 * 收纳组件 + 布置台引导 + 九宫格破图重试 —— 前端契约测试
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假 fetch，与 ticket-09 同一套。
 *
 * 这批用例要守住的是用户真的提出来的事，外加一件实测撞见的：
 *   1. 音乐开关**不许再压住顶部**。早先它是一颗常驻右上角的胶囊，正好盖在
 *      布置台顶部右上那只装饰熊与倒计时条上。判据不是「看起来对」——
 *      jsdom 没有布局，所以只能断**几何声明**：收纳本体垂直居中、
 *      开关不再是 fixed 覆盖物。这一条能区分「挪走了」与「换个颜色又摆回顶部」。
 *   2. 布置台**和**解封后的阅读流都要有退出。早先布置台有一个行内退出，
 *      阅读流一个都没有 —— 从那条路进去出不来。收纳是常驻的（#app 之外），
 *      所以不必渲染两遍就能验，但**必须真的在两种屏上都验一遍**：
 *      把收纳搬进 #app 的话，reading() 里就没有它了。
 *   3. 布置台的每个操作都要有引导，尤其「撤回」——它已经是**真删**，
 *      按钮上只写两个字不足以让人按下它。
 *   4. 九宫格破图要**先重试再占位**：占位块不可逆，一次抖动就等于那张照片
 *      在整场阅读里永久缺席。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_FILE = path.join(ROOT, "public", "index.html");

const STATUS = (unlocked) => ({ status: 200, body: { unlocked, unlockAt: 1791129600000 } });
const ME_IN = { status: 200, body: { id: "door", code: "【改这里：doorCode】", count: 3 } };
const ME_OUT = { status: 401, body: { error: "no_session" } };
const LIST = { status: 200, body: { mine: [], theirs: [] } };
const SHARED = {
  status: 200,
  body: { photos: [], blessing: "BLESSING-TEXT", from: "2024-10-05", to: "2026-10-05", days: 731 },
};
/** 九张**假**合照：只带 photoId；jsdom 里不会真去取图。 */
const SHOTS = Array.from({ length: 9 }, (_, i) => ({
  photoId: `p${String(i).padStart(24, "0")}`,
  ord: i + 1,
}));
const WISH = { status: 200, body: [{ id: "door", text: "WISH-DOOR" }, { id: "hero", text: "WISH-HERO" }] };

const ROUTES_FOR = (unlocked, authed, withShots = false) => ({
  "GET /api/status": STATUS(unlocked),
  "GET /api/me": authed ? ME_IN : ME_OUT,
  "GET /api/entry": LIST,
  "GET /api/shared": withShots ? { ...SHARED, body: { ...SHARED.body, photos: SHOTS } } : SHARED,
  "GET /api/wish": WISH,
});

/** 装一个页面。play() 必须替掉：jsdom 的 HTMLMediaElement.play() 不实现。 */
async function mount({ unlocked = false, authed = true, routes = null, withShots = false } = {}) {
  const ROUTES = routes || ROUTES_FOR(unlocked, authed, withShots);
  const seen = [];
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      w.HTMLMediaElement.prototype.pause = function () {};
      const ls = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
      Object.defineProperty(w, "localStorage", { value: ls, configurable: true });
      w.fetch = async (url, init = {}) => {
        const key = `${(init.method || "GET").toUpperCase()} ${url}`;
        seen.push(key);
        const r = ROUTES[key];
        const status = r ? r.status : 404;
        const body = r && status !== 204 ? r.body : { error: "not_found" };
        return new Response(status === 204 ? null : JSON.stringify(body), {
          status, headers: { "content-type": "application/json" },
        });
      };
    },
  });
  for (let i = 0; i < 200 && !dom.window.__t08; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t08, "public/index.html 没有跑起 public/app.js");
  await dom.window.__t08.ready;
  return { dom, seen, doc: dom.window.document, win: dom.window };
}

const boot = async (t, opts) => {
  const m = await mount(opts);
  t.after(() => m.dom.window.close());
  return {
    ...m,
    dw: () => m.doc.querySelector("#dw"),
    tab: () => m.doc.querySelector("#dw-tab"),
    panel: () => m.doc.querySelector("#dw-panel"),
    out: () => m.doc.querySelector("#dw-out"),
    outBtn: () => m.doc.querySelector("#dw-out [data-logout]"),
    bgmBtn: () => m.doc.querySelector("#bgm-btn"),
    guide: () => m.doc.querySelector("#app .guide"),
    app: () => m.doc.querySelector("#app"),
    api: () => m.dom.window.__t08,
  };
};

const click = (win, el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

/** 落到某一屏。**必须真的把屏切过去再断言** ——
    开机时人在封印页，在那儿断「布置台有没有引导」是恒真的：
    它在封印页当然没有，早先那条「阅读流里不该有引导」就是这么绿的。 */
const toScreen = (ui, screen, unlocked) => {
  const S = ui.api().S;
  S.unlocked = !!unlocked;
  S.screen = screen;
  ui.api().render();
};

/* ══════════════════════════════════════════════════════════════════ */

test("提示条长在面板里，不浮在页面上 —— 浮着的那一版被挤成一列单字还压住引导", async (t) => {
  const ui = await boot(t);
  const hint = ui.doc.querySelector("#bgm-hint");
  assert.ok(hint, "没有 #bgm-hint");
  assert.equal(hint.parentElement, ui.panel(), "提示条不在面板里 —— 它会变成浮在页面上的一层");
  // 兜住另一条实现路径：留在面板里但仍然是 fixed/absolute，一样会脱离面板去盖内容
  const cs = ui.win.getComputedStyle(hint);
  assert.equal(cs.position, "static", `#bgm-hint 是 position:${cs.position}，它仍然会浮在页面上`);
});

test("九宫格破图**先重试再占位** —— 占位块不可逆，一次抖动不该等于永久缺席", async (t) => {
  const ui = await boot(t, { unlocked: true, authed: true, withShots: true });
  await ui.win.__t06.load();                     // 拉一次共同层，九张进来（load 只在 __t06 上）
  toScreen(ui, "desk", true);
  const grid = ui.app().querySelector(".grid3");
  assert.ok(grid, "没落在阅读流");
  const imgs = [...grid.querySelectorAll("img")];
  assert.equal(imgs.length, 9, `九张合照没都画出来：${imgs.length}`);
  assert.equal(grid.querySelectorAll(".ph").length, 0, "一上来就是占位块");

  const im = imgs[0];
  const src = im.getAttribute("src");
  assert.match(src, /^\/api\/photo\//, "取图路径不对");

  // 第一次失败：不许立刻占位
  im.dispatchEvent(new ui.win.Event("error"));
  assert.ok(grid.querySelector("img"), "第一次失败就被换成占位块了 —— 没有重试");
  assert.equal(grid.querySelectorAll(".img-fb").length, 0);
  assert.equal(im.getAttribute("data-img-retry"), "1", "重试次数没有递减");
  assert.equal(im.getAttribute("src"), null, "重试前应当先摘掉 src，否则不会重新发起加载");

  // 600ms 之后 src 要被挂回去（= 真的又去取了一次）
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(im.getAttribute("src"), src, "重试之后 src 没有挂回去 —— 那一次重取没发生");

  // 第二次失败：还剩一次
  im.dispatchEvent(new ui.win.Event("error"));
  assert.ok(grid.querySelector("img"), "第二次失败也被立刻占位了");
  assert.equal(im.getAttribute("data-img-retry"), "0");
  await new Promise((r) => setTimeout(r, 700));

  // 第三次失败：重试用完，这 才 落到占位块
  im.dispatchEvent(new ui.win.Event("error"));
  assert.equal(grid.querySelectorAll(".img-fb").length, 1, "重试用完之后仍然没有占位块");
  assert.equal(grid.querySelectorAll("img").length, 8, "占位块应当顶掉那一张，其余八张不动");
  t.diagnostic("九张里第一张失败 3 次：前两次重试、第三次才占位；其余 8 张不受影响");
});

test("别的图仍然一次失败就占位 —— 不顺手改有测试钉着的既有行为", async (t) => {
  const ui = await boot(t, { unlocked: true, authed: true, withShots: true });
  await ui.win.__t06.load();
  toScreen(ui, "desk", true);
  ui.win.__t04.openLB(0);            // 放大层里的图要打开才有（__t04 那一缝）
  const lbImg = ui.doc.querySelector(".lb-frame img");
  assert.ok(lbImg, "放大层里没有图");
  assert.equal(lbImg.getAttribute("data-img-retry"), null, "放大层那张被挂了重试次数");
  lbImg.dispatchEvent(new ui.win.Event("error"));
  assert.equal(ui.doc.querySelectorAll(".lb-frame .img-fb").length, 1,
    "放大层那张也重试了 —— 它的行为有 ticket-06 钉着，不该跟着改");
});

test("收纳：收起态是右边缘一条把手，展开后是音乐开关 + 退出", async (t) => {
  const ui = await boot(t);
  const tab = ui.tab();
  assert.ok(tab, "没有 #dw-tab");
  assert.ok(ui.dw(), "没有 #dw");
  assert.equal(ui.panel().hidden, true, "默认必须收着 —— 不收着就是它当初挡住顶部的那个形状");
  assert.equal(tab.getAttribute("aria-expanded"), "false");
  assert.ok(ui.bgmBtn(), "面板里没有音乐开关");
  assert.ok(ui.outBtn(), "面板里没有退出");

  click(ui.win, tab);
  assert.equal(ui.panel().hidden, false, "点一下把手应当展开");
  assert.equal(tab.getAttribute("aria-expanded"), "true");
  assert.equal(tab.getAttribute("aria-label"), ui.api().cp("dweller.a11yClose"), "展开后读屏要念「收起」");

  click(ui.win, tab);
  assert.equal(ui.panel().hidden, true, "再点一下应当收回去");
});

test("收纳：点外面收起来、Esc 也收起来 —— 它是常驻的，不收会一直挡着右半边", async (t) => {
  const ui = await boot(t);
  click(ui.win, ui.tab());
  assert.equal(ui.panel().hidden, false);

  click(ui.win, ui.app());                       // 点内容区
  assert.equal(ui.panel().hidden, true, "点外面没收起来");

  click(ui.win, ui.tab());
  ui.doc.dispatchEvent(new ui.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(ui.panel().hidden, true, "Esc 没收起");
});

test("布局：收纳贴在右边缘**四分之三高**处（位置固定，不漂回顶部/中间）", async (t) => {
  const ui = await boot(t);
  const cs = ui.win.getComputedStyle(ui.dw());
  // ⚠️ 标题里**不再**写「不挡任何一屏的内容」：jsdom 没有布局，这条从来就只断
  // 几何声明，证明不了遮挡；真遮挡是像素级事实，由 scripts/e2e/mobile.mjs 在
  // 390x844 的真 Chrome 上解析式量（那条量的是「正中心不被盖」，仍是硬门禁）。
  // 2026-10-04 起正文恢复居中、不再为把手让位，收纳盖住内容右边缘一条是**已接受的**取舍。
  // 归一化：jsdom 把 `right: 0` 报成 "0px"，`top: 75%` 原样保留。
  const zeroish = (v) => /^0(px)?$/.test(String(v).trim());
  assert.equal(cs.position, "fixed", "收纳应当常驻");
  assert.equal(String(cs.top).trim(), "75%", "收纳必须在四分之三高；回到 50% 或 top:calc(...) 就又压到东西了");
  assert.ok(zeroish(cs.right), `收纳应当贴在右边缘，实际 right=${cs.right}`);
  // 开关本身不再是一颗 fixed 覆盖物：它只在面板里，面板才是那层浮层
  const bs = ui.win.getComputedStyle(ui.bgmBtn());
  assert.notEqual(bs.position, "fixed", "音乐开关还是 position:fixed —— 它仍是一颗压在页面上的常驻按钮");
  t.diagnostic(`#dw: position=${cs.position} top=${cs.top} right=${cs.right}；#bgm-btn position=${bs.position}`);
});

test("退出：布置台和解封后的阅读流**都有**，而且是同一颗常驻的", async (t) => {
  const ui = await boot(t, { unlocked: false, authed: true });

  toScreen(ui, "desk", false);
  assert.ok(ui.app().querySelector(".desk"), "没落在布置台上");
  const dwLocked = ui.dw();
  assert.equal(ui.out().hidden, false, "布置台上收纳里没有退出");
  assert.ok(ui.app().querySelector(".desk [data-logout]"), "布置台的行内退出不见了");

  toScreen(ui, "desk", true);
  assert.ok(ui.app().querySelector(".rd-hero"), "开门后应当落在阅读流");
  assert.equal(ui.dw(), dwLocked, "换了屏收纳换了节点 —— 它被 render() 重建了，音乐与展开状态都会丢");
  assert.equal(ui.out().hidden, false, "解封后的阅读流里没有退出：进去之后出不来");
  t.diagnostic("布置台 / 阅读流两屏共用同一个 #dw，退出都在");
});

test("退出：没登录时收纳里**不出现**退出，登录后立刻出现", async (t) => {
  const anon = await boot(t, { unlocked: true, authed: false });
  toScreen(anon, "desk", true);
  assert.equal(anon.out().hidden, true, "没会话却摆着一个退出的按钮");

  const inS = await boot(t, { unlocked: true, authed: true });
  toScreen(inS, "desk", true);
  assert.equal(inS.out().hidden, false);

  // 退出会话之后它要立刻消失 —— 判据挂在 render() 里的 dwellerSync 上
  inS.api().S.profile = null; inS.api().render();
  assert.equal(inS.out().hidden, true, "会话没了，收纳里的退出还挂在那儿");
});

test("引导：布置台顶部有五条，且撤回那条说清是**真删**", async (t) => {
  const ui = await boot(t, { unlocked: false, authed: true });
  toScreen(ui, "desk", false);
  const g = ui.guide();
  assert.ok(g, `布置台上没有 .guide（.pad-b = ${ui.app().querySelector(".pad-b")?.innerHTML.slice(0, 120)}）`);
  const lis = [...g.querySelectorAll("li")];
  assert.equal(lis.length, 5, `引导应当是五条，实际 ${lis.length}：${lis.map((l) => l.textContent).join(" | ")}`);
  for (const li of lis) {
    const b = li.querySelector("b");
    assert.ok(b, `有一条没有关键词：${li.textContent}`);
    assert.ok(li.textContent.replace(b.textContent, "").trim().length > 8,
      `「${b.textContent}」那条只有标题没有说明`);
  }
  // 关键词要覆盖布置台上真实存在的四类操作
  const text = g.textContent;
  for (const k of ["写 几 句", "照 片", "约 定", "撤 回"]) {
    assert.ok(text.includes(k), `引导里没有「${k}」这一项`);
  }
  // 撤回已经是硬删：行、photo 行、盘上文件一起没。按钮上只写两个字，说不了这件事
  assert.ok(/真删|删掉/.test(text), "撤回那条没有说清是删");
  assert.ok(text.includes("找不回来"), "撤回那条没有说清不可恢复");
});

test("引导：{human} 真的被填成开门日期，不许把花括号留在屏幕上", async (t) => {
  const ui = await boot(t, { unlocked: false, authed: true });
  toScreen(ui, "desk", false);
  const g = ui.guide();
  assert.ok(g, "没落在布置台上");
  assert.ok(!g.textContent.includes("{human}"), "占位符原样显示在界面上了 —— cp() 没拿到 vars");
  assert.ok(g.textContent.includes(ui.api().cp("date.monthDay", { m: 10, d: 5 })),
    `引导里没有开门日期「10 月 5 日」：${g.textContent.slice(-60)}`);
});

test("引导：只在布置台出现 —— 解封后同一个入口已经是阅读流，那时候没东西可折", async (t) => {
  const ui = await boot(t, { unlocked: true, authed: true });
  toScreen(ui, "desk", false);
  assert.ok(ui.guide(), "反例没造出来：锁着的布置台上本来也该有引导");
  toScreen(ui, "desk", true);
  assert.ok(ui.app().querySelector(".rd-hero"), "没落在阅读流上（那这条又成了恒真）");
  assert.equal(ui.guide(), null, "阅读流里不该有布置台的引导");
});

test("引导：排在约定区**之前** —— 她第一眼要看见它，而不是先翻过整面墙", async (t) => {
  const ui = await boot(t, { unlocked: false, authed: true });
  toScreen(ui, "desk", false);
  const pad = ui.app().querySelector(".pad-b");
  assert.ok(pad, "没有 .pad-b");
  const kids = [...pad.children].map((n) => n.className);
  const gi = kids.findIndex((c) => c.includes("guide"));
  const wi = kids.findIndex((c) => c.includes("wish-box"));
  assert.ok(gi >= 0, `.pad-b 里没有引导：${kids.join(" / ")}`);
  assert.ok(wi >= 0, ".pad-b 里没有约定区");
  assert.ok(gi < wi, `引导排在约定区后面（.pad-b 子元素：${kids.join(" / ")}）`);
});
