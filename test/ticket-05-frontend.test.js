/**
 * 工单 05 · 共同动作·约定 —— 前端契约测试
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假网络（fetch 被打桩）。
 * 断言只落在界面上看得见的文本与元素集合上，以及真实的 fetch 序列，不碰内部实现。
 *
 * 重点是三条容易做砸的：
 *   1. 收尾不能开天窗 —— 约定接口 500 时，自己已经存的那一条仍然看得见；
 *   2. 只显示代号 —— 响应里就算多带了 role / 姓名，一个字都不许上屏；
 *   3. 约定区是阅读流的收尾，不是新页面；切过去不许新建定时器。
 *
 * ⚠️ jsdom 没有 canvas、没有排版引擎，也没有可用的 localStorage（file:// 是不透明源，
 * 取值那一下就抛 SecurityError）。所以「两栏并排」只断言**结构 + CSS 声明**，
 * 像素级的排版、以及换设备/重开页面时靠本地镜像兜底那条路，都验不了——如实记在交付报告里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_FILE = path.join(ROOT, "public", "index.html");
const CSS_FILE = path.join(ROOT, "public", "style.css");

/* 契约里的预填选项：逐字写在这里，不从实现里读（读实现就变成自证）。
   ⚠️ 2026-10-03 整份替换：本人逐条给定（【改这里：place】 / 搬到一起住 / 学会做那道菜 / 海边日出 /
   玩游戏 / 按摩），替掉原先抄 prototype/ui-v4.html 的那六条。**这份字面量就是契约本身**，
   所以改文案时要在这里跟着改一遍 —— 它守的正是「界面上出现的就是这六条」这件事。
   ⚠️ 别为了图省事改成从 src/copy.js import：那样这个测试会恒真，改坏文案也照样绿。 */
const WISHES = [
  "去【改这里：place】游【改这里：place】",
  "搬到一起住",
  "学会做对方最爱吃的那道菜",
  "一起去海边看一次日出",
  "一起玩一款新游戏",
  "一起解锁新按摩",
];

/* 只有开门后才可能出现的内容：锁定态的断言拿它们当探针，出现一个字就是破的。
   ⚠️ 两条约定**刻意都不在预填选项里**——否则「界面上出现了对方那一条」这条断言
   会被布置台上的选项按钮撞响，变成恒真。 */
const MINE_WISH = "一起把阳台收拾出来";
const THEIR_WISH = "去看她一直想看的那场演唱会";
/* 假姓名探针：服务端哪天多带了 name/role，到界面上一个字都不许剩 */
const FAKE_NAME = "张三李四王五";

const MINE = [{ id: "e1", kind: "text", body: "我自己的留言。", ord: 1, created: 1759000000000, photo: null }];
const THEIRS = [{ id: "x1", kind: "text", body: "一封信。", ord: 1, created: 1759000000000, photo: null }];
const ME = { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: false, count: 1 };

const sharedOf = () => ({
  photos: [],
  blessing: "从第一天起，每一天我都记着。",
  from: "2024-10-05",
  to: "2026-10-05",
  days: 731,
});

const statusOf = (unlocked) => ({
  status: 200,
  body: { unlocked, unlockAt: 1791129600000, unlockLabel: "2026-10-05T00:00:00+08:00", now: 1791129599000 },
});

/** 约定接口的回包形状（对应 test/ticket-05-backend.test.js 钉住的那份） */
const wishOf = (extra = {}) => ({
  status: 200,
  body: {
    wishes: [
      { id: "door", code: "【改这里：doorCode】", text: MINE_WISH, ...extra },
      { id: "hero", code: "【改这里：heroCode】", text: THEIR_WISH, ...extra },
    ],
  },
});

/**
 * 路由表。
 * ⚠️ 锁定态**照样**给约定接口塞一份内容：门在前端也必须自己守一道，
 * 靠「服务端不返回」是不够的。
 * POST 是函数：把提交上来的原文原样回给页面（真实实现就是这样回显的）。
 */
const routesFor = (unlocked, wishRoute = wishOf()) => ({
  "GET /api/status": statusOf(unlocked),
  "GET /api/me": { status: 200, body: { ...ME, unlocked } },
  "GET /api/entry": { status: 200, body: { mine: MINE, theirs: THEIRS } },
  "GET /api/shared": { status: 200, body: sharedOf() },
  "GET /api/wish": wishRoute,
  "POST /api/wish": (sent) => ({
    status: 200,
    body: { wish: { id: "door", code: "【改这里：doorCode】", text: sent?.text ?? "" } },
  }),
});

/** 打桩 fetch：记录调用（GET 记 key，POST 连提交内容一起记），返回真 Response。 */
async function mount(routes) {
  const seen = [];
  const sent = [];
  const timers = { interval: 0 };
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      const real = w.setInterval.bind(w);
      w.setInterval = (...a) => { timers.interval += 1; return real(...a); };
      w.fetch = async (url, init = {}) => {
        const key = `${(init.method || "GET").toUpperCase()} ${url}`;
        seen.push(key);
        const r = routes[key];
        if (!r) {
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404, headers: { "content-type": "application/json" },
          });
        }
        const isSend = key.startsWith("POST ");
        let body = null;
        if (isSend && typeof init.body === "string") {
          try { body = JSON.parse(init.body); } catch { body = null; }
        }
        if (isSend) sent.push(body);
        const out = typeof r === "function" ? r(body) : r;
        return new Response(out.status === 204 ? null : JSON.stringify(out.body), {
          status: out.status,
          headers: { "content-type": "application/json" },
        });
      };
    },
  });
  return { dom, seen, sent, timers };
}

async function boot(t, routes) {
  const { dom, seen, sent, timers } = await mount(routes);
  t.after(() => dom.window.close());          // 关窗会清掉那个 setInterval，否则进程不退出
  for (let i = 0; i < 200 && !dom.window.__t05; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t05, "public/index.html 没有跑起 public/app.js（脚本没加载，或加载后没挂 __t05）");
  await dom.window.__t05.ready;
  const doc = dom.window.document;
  return {
    win: dom.window,
    doc,
    seen,
    sent,
    timers,
    text: () => doc.body.textContent,
    all: (sel) => Array.from(doc.querySelectorAll(sel)),
    el(sel) {
      const el = doc.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      return el;
    },
    click(sel) {
      this.el(sel).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      return this.el(sel);
    },
    type(sel, value) {
      const el = this.el(sel);
      el.value = value;
      return el;
    },
    submit(sel) {
      this.el(sel).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    },
    async settle() {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10));
    },
    intoDesk() {
      const b = doc.querySelector('[data-go="desk"]');
      assert.ok(b, "封印页没有入口按钮");
      b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    },
  };
}

/* ── CSS 契约：只验声明存在，验不了像素 ───────────────────────────── */
const css = () => fs.readFileSync(CSS_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 把一段 CSS 拆成 [{sel, sels, body}]；选择器空白归一并按逗号拆开 */
function rules(text) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const sels = m[1].trim().replace(/\s+/g, " ").split(",").map((s) => s.trim());
    out.push({ sel: sels[0], sels, body: m[2] });
  }
  return out;
}
const rule = (text, sel) => {
  const hit = rules(text).find((r) => r.sels.includes(sel));
  assert.ok(hit, `style.css 里没有 ${sel} 这条规则`);
  return hit.body;
};

/* ══════════════════════════════════════════════════════════════════ */

test("布置台：预填选项点一下就折好（未解锁也能提前折）", async (t) => {
  const ui = await boot(t, routesFor(false));
  ui.intoDesk();
  await ui.settle();

  // 六个选项都在，点得动
  const buttons = ui.all(".pick [data-pick]");
  assert.equal(buttons.length, WISHES.length, "预填选项一个不少");
  for (const w of WISHES) {
    assert.ok(ui.text().includes(w), `界面上看不到预填选项「${w}」`);
  }

  // 点第 3 个：真发 POST，提交的就是被点的那一条
  ui.click('.pick [data-pick="' + WISHES[2] + '"]');
  await ui.settle();
  assert.ok(ui.seen.includes("POST /api/wish"), `点选没有真的写进去。请求：${ui.seen.join(" / ")}`);
  assert.equal(ui.sent.at(-1)?.text, WISHES[2], "提交的必须是**被点的**那一条，不是别的");
  assert.ok(ui.text().includes(`已经折好：${WISHES[2]}`), "折好之后界面上要看得见自己那一条");
  t.diagnostic(`未解锁时点选：POST /api/wish 提交「${WISHES[2]}」`);
});

test("布置台：也能自己写一条不在选项里的（选项不框住人）", async (t) => {
  const ui = await boot(t, routesFor(false));
  ui.intoDesk();
  await ui.settle();

  assert.ok(ui.el('form[data-form="wish"] [data-body]'), "选项下面必须有一个自己写的输入框");
  const mine = "去看一次她一直想看的海（不在任何选项里）";
  assert.ok(!WISHES.includes(mine));
  ui.type('form[data-form="wish"] [data-body]', mine);
  ui.submit('form[data-form="wish"]');
  await ui.settle();

  assert.ok(ui.seen.includes("POST /api/wish"), "自己写的那条也得发出去");
  assert.equal(ui.sent.at(-1)?.text, mine, "提交的必须是自己写的原文");
  assert.ok(ui.text().includes(mine), "自己写的那条要在界面上看得见");
  t.diagnostic(`自己写的一条已折好：「${mine}」`);
});

test("开门后：两个人的答案并排出现，各自带代号", async (t) => {
  const ui = await boot(t, routesFor(true));
  ui.intoDesk();
  await ui.settle();

  assert.ok(ui.seen.includes("GET /api/wish"), `开门后没有真的拉约定。请求：${ui.seen.join(" / ")}`);
  const sides = ui.all(".both .side");
  assert.equal(sides.length, 2, "并排两栏：一个人的约定不会只有一栏");
  assert.ok(sides[0].textContent.includes("【改这里：doorCode】"), "第一栏只显示代号「【改这里：doorCode】」");
  assert.ok(sides[0].textContent.includes(MINE_WISH), "第一栏要是自己那一条");
  assert.ok(sides[1].textContent.includes("【改这里：heroCode】"), "第二栏只显示代号「【改这里：heroCode】」");
  assert.ok(sides[1].textContent.includes(THEIR_WISH), "第二栏要是对方那一条——比的就是这个");
  // 两栏在同一个容器里：一栏缺了就不是「并排」
  assert.equal(ui.all(".both").length, 1, "两栏必须在同一个并排容器里");

  // 「并排」这件事在 CSS 上兑现：两栏是可换行的弹性列，不是上下两段文字
  const text = css();
  assert.match(rule(text, ".both"), /display:\s*flex/, ".both 必须是弹性布局才能并排");
  assert.match(rule(text, ".both .side"), /flex:\s*1 1/, ".both .side 必须有弹性基准，窄屏才落回上下两格");
  t.diagnostic("两栏并排：【改这里：doorCode】 / 【改这里：heroCode】，各带自己那一条");
});

test("约定区是阅读流的收尾，不是新页面：它在最后一段话之后", async (t) => {
  const ui = await boot(t, routesFor(true));
  ui.intoDesk();
  await ui.settle();
  const text = ui.text();
  const atWish = text.indexOf(MINE_WISH);
  assert.ok(atWish > 0, "开门后的阅读流里看不到约定");
  assert.ok(text.indexOf("最 后") < atWish, "约定区必须排在最后一段话之后");
  assert.ok(atWish < text.indexOf("折好的每一件"), "约定区排在收尾那句话之前就错了");
  t.diagnostic("约定区在「最后」之后、收尾语之前");
});

test("收尾不开天窗：约定接口 500 时，自己已存的那一条仍然显示", async (t) => {
  const routes = routesFor(true);
  const ui = await boot(t, routes);
  ui.intoDesk();
  await ui.settle();

  // 前提：这一次拉取成功，自己那一条已经存下来了（也进了本地镜像）
  assert.ok(ui.text().includes(MINE_WISH), "前提：自己那一条已经拉到了并显示着");

  // 约定接口开始挂：500
  routes["GET /api/wish"] = { status: 500, body: { error: "server_error" } };
  await ui.win.__t05.loadWish();
  ui.win.__t05.render();
  await ui.settle();

  const text = ui.text();
  assert.ok(text.includes(MINE_WISH), "拉取失败时收尾把自己那一条也弄没了——这就是开天窗");
  assert.equal(ui.win.__t05.S.wishes.length, 0, "拉取失败时不该拿空的回包冒充有内容");
  const sides = ui.all(".both .side");
  assert.equal(sides.length, 2, "两栏的位置仍然要留着，塌成一片就看不出对比了");
  assert.ok(sides[0].textContent.includes(MINE_WISH), "自己那一栏不许退化成「还没选」");
  assert.ok(text.includes("没 读 到 TA 的 约 定"), "读不到对方的约定要说清楚，不能装作有");
  assert.ok(!text.includes(THEIR_WISH), "拉取失败时凭空多出一条对方的内容才是真的破");
  // 不遮蔽：正文里的其它段落在
  assert.ok(text.includes("一 封 信"), "约定区一挂，整条阅读流被遮住了");
  t.diagnostic("500 之后：自己那一条仍在、两栏仍在、对方的格子说「还没读到」");
});

test("约定只显示代号：回包里多带的 role / 姓名一个字都不许上屏", async (t) => {
  const ui = await boot(t, routesFor(true, wishOf({ role: "【改这里：girlfriend】", name: FAKE_NAME })));
  ui.intoDesk();
  await ui.settle();

  const text = ui.text();
  assert.ok(text.includes("【改这里：doorCode】") && text.includes("【改这里：heroCode】"), "代号要在");
  for (const leak of [FAKE_NAME, "【改这里：girlfriend】", "【改这里：boyfriend】"]) {
    assert.ok(!text.includes(leak), `界面上出现了不该出现的东西：${leak}`);
  }
  // 全站只用代号这条更早就成立了，这里只是不许因为约定又破一次
  t.diagnostic("回包多带 role / name，界面照样只有代号");
});

test("切到约定区不新建定时器：全站仍然只有一个 setInterval", async (t) => {
  // 阅读流收尾那两栏：切过去 + 反复重绘
  const ui = await boot(t, routesFor(true));
  assert.equal(ui.timers.interval, 1, "全站只应有一个 setInterval");
  ui.intoDesk();                                     // 开门后同一个入口 = 阅读流
  await ui.settle();
  for (let i = 0; i < 5; i++) ui.win.__t05.render();
  assert.equal(ui.timers.interval, 1, "render() 又建了 setInterval —— 每次重绘泄漏一个");

  // 布置台上折约定（含一次真的 POST 与重绘）同样不许新建
  const desk = await boot(t, routesFor(false));
  desk.intoDesk();
  await desk.settle();
  desk.click('.pick [data-pick="' + WISHES[1] + '"]');
  await desk.settle();
  assert.equal(desk.timers.interval, 1, "布置台上折约定时又建了 setInterval");
  t.diagnostic("阅读流收尾与布置台折约定，全站始终 1 个 setInterval");
});

test("未解锁：约定区里只有我自己的，界面上没有对方那一条", async (t) => {
  const ui = await boot(t, routesFor(false));
  ui.intoDesk();
  await ui.settle();

  // 门在前端自己也要守一道：服务端回了内容也不能画
  assert.ok(!ui.text().includes(THEIR_WISH), "未解锁时布置台出现了对方的约定");
  assert.ok(!ui.all(".both").length, "未解锁时不该出现并排那两栏（那是阅读流的收尾）");
  assert.ok(!ui.seen.includes("GET /api/wish"), `未解锁时前端仍然去请求了约定接口：${ui.seen.join(" / ")}`);
  // 自己的那一条照样能折：她必须能提前写
  ui.click('.pick [data-pick="' + WISHES[4] + '"]');
  await ui.settle();
  assert.equal(ui.sent.at(-1)?.text, WISHES[4], "未解锁时也必须能提前折好约定");
  t.diagnostic("未解锁：只请求不 GET 约定，界面无对方内容，自己能提前折");
});
