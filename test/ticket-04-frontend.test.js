/**
 * 工单 04 · 阅读流与共同层 —— 前端契约测试
 *
 * 这条把时间锁从「服务端保证」延伸成「阅读流保证」（CONSTRAINTS.md §1）：
 * 开门后同一个入口换成阅读流，里面同时有共同层的内容、对方的信、对方的照片。
 * 门没开时，这些一个字都不许出现在界面上。
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假网络（fetch 被打桩）。
 * 断言只落在界面上看得见的文本与元素集合上，不碰内部实现。
 *
 * ⚠️ jsdom 没有 canvas、没有排版引擎：4:5 / 1:1 的**真实渲染比例**、
 * transform 旋转的视觉结果、390×844 / 1280×900 下的 scrollWidth-clientWidth
 * 都验不了。这里只断言 CSS 契约（声明存在），像素级的留给工单 06 真实浏览器。
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

/* 假数据：全部是「只有开门后才可能出现」的内容。
   锁定态的断言就拿它们当探针 —— 出现一个字就是破的。 */
const BLESSING = "从第一天起，每一天我都记着。";
const LETTER = "给你写这封信的时候，窗外一直在下雨。";
const TAIL = "以后也一起吧，慢慢来。";
const GIFTP = { id: "p-gift-1", mime: "image/jpeg", w: 1200, h: 1600 };
const GIFTP2 = { id: "p-gift-2", mime: "image/jpeg", w: 1200, h: 1600 };
/* 对方的三件：信（有正文）、一张没写配文的照片、一段最后的话 */
const THEIRS = [
  { id: "x-letter", kind: "text", body: LETTER, ord: 1, created: 1759000000000, photo: null },
  { id: "x-photo", kind: "photo", body: null, ord: 2, created: 1759000000001, photo: GIFTP },
  { id: "x-tail", kind: "text", body: TAIL, ord: 3, created: 1759000000002, photo: null },
];
const MINE = [{ id: "e1", kind: "text", body: "我自己的留言，锁定态下该看得见。", ord: 1, created: 1759000000000, photo: null }];
const ME = { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: false, count: 1 };

/** 共同层：3 张合照（不足 9，用来验占位块）+ 祝福语 + 准确的日期区间 */
const sharedOf = (n) => ({
  photos: Array.from({ length: n }, (_, i) => ({ id: `sh${i + 1}`, photoId: `p-shared-${i + 1}`, w: 1200, h: 1600 })),
  blessing: BLESSING,
  from: "2024-10-05",
  to: "2026-10-05",
  days: 731,
});

const LOCKED_STATUS = {
  status: 200,
  body: { unlocked: false, unlockAt: 1791129600000, unlockLabel: "2026-10-05T00:00:00+08:00", now: 1791129599000 },
};
const UNLOCKED_STATUS = { ...LOCKED_STATUS, body: { ...LOCKED_STATUS.body, unlocked: true } };

/* 路由表含 /api/status、/api/me、/api/entry、/api/shared。
   ⚠️ 锁定态**照样**给 /api/shared 塞一份内容：门在前端也必须自己守一道，
   靠「服务端不返回」是不够的。 */
const routesFor = (unlocked, shared = sharedOf(3)) => ({
  "GET /api/status": unlocked ? UNLOCKED_STATUS : LOCKED_STATUS,
  "GET /api/me": { status: 200, body: { ...ME, unlocked } },
  "GET /api/entry": { status: 200, body: { mine: MINE, theirs: THEIRS } },
  "GET /api/shared": { status: 200, body: shared },
});

/** 开门后阅读流里**确实会出现**的串。对照测试与锁定态断言共用这一张表。
 *  ⚠️ 「TA 留给你的」不在表里：封印页的信封上一直写着「里面是 TA 留给你的」（工单 02 起就有），
 *  那是封条文案，不泄露任何内容，也不是「已解锁」字样。改用只属于阅读流的转场 kicker。
 *
 *  ⚠️ 2026-10-03 移除了「这 731 个日夜」：祝福语那块的小标题换成了「说点正经的」，
 *  那个串上屏了但它守的**不是文案、是天数**，而天数在下面一行「一共 731 天」上还有一个证人。
 *  换句话说这个串从来不是独立的守门人，去掉它不减少天数上的覆盖。
 *  若日后要把天数也从小标题里拿干净，先确认 range 那行仍然在表里。 */
const READING_TEXT = [
  BLESSING, LETTER, TAIL,                       // 共同层祝福语 + 信 + 最后一段话
  "我 们 的 两 年", "【改这里：heroCode】 给 你 的", "一 封 信", "TA 留 给 你 的 照 片",
  "一共 731 天",                                 // 日期跨度用后端给的 days（含首尾，731）
  "2024 年 10 月 5 日", "2026 年 10 月 5 日",     // 日期区间用后端给的 from/to
  "已 送 达",                                   // 同一个 card() 的只读语气
];

/** 打桩 fetch：记录调用，返回真 Response。setInterval 计数用来抓「重绘时建定时器」。 */
async function mount(routes, { deviceNowMs } = {}) {
  const seen = [];
  const timers = { interval: 0 };
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      const real = w.setInterval.bind(w);
      w.setInterval = (...a) => { timers.interval += 1; return real(...a); };
      // 假装这台设备的时间已经过了开门时刻。open() 一旦退回设备时钟就会露馅。
      if (deviceNowMs !== undefined) {
        const RealDate = w.Date;
        const shifted = new RealDate(deviceNowMs);
        class FakeDate extends RealDate {
          constructor(...a) {
            if (a.length === 0) super(shifted.getTime());
            else super(...a);
          }
          static now() {
            return shifted.getTime();
          }
        }
        w.Date = FakeDate;
      }
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

async function boot(t, routes, opts) {
  const { dom, seen, timers } = await mount(routes, opts);
  t.after(() => dom.window.close());          // 关窗会清掉那个 setInterval，否则进程不退出
  for (let i = 0; i < 200 && !dom.window.__t04; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t04, "public/index.html 没有跑起 public/app.js（脚本没加载，或加载后没挂 __t04）");
  await dom.window.__t04.ready;
  const doc = dom.window.document;
  return {
    win: dom.window,
    doc,
    seen,
    timers,
    text: () => doc.body.textContent,
    all: (sel) => Array.from(doc.querySelectorAll(sel)),
    click(sel) {
      const el = doc.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      return el;
    },
    key(k) {
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
    },
    intoReading() {
      const b = doc.querySelector('[data-go="desk"]');
      assert.ok(b, "封印页没有入口按钮");
      b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    },
  };
}

/* ── CSS 契约：只验声明存在，验不了像素 ───────────────────────────── */
const css = () => fs.readFileSync(CSS_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出 @media 查询的大括号内容（正则会被嵌套花括号骗，所以手工配平） */
function mediaInner(text, query) {
  const i = text.indexOf(query);
  assert.ok(i >= 0, `style.css 里没有 ${query} 这条媒体查询`);
  const open = text.indexOf("{", i);
  let depth = 0, j = open;
  for (; j < text.length; j++) {
    if (text[j] === "{") depth += 1;
    else if (text[j] === "}") { depth -= 1; if (!depth) break; }
  }
  return text.slice(open + 1, j);
}

/** 把一段 CSS 拆成 [{sel, sels, body}]；选择器空白归一并按逗号拆开，
    这样 `.ph.p0, .ph.p1` 这种成组写法和单独写 `.ph.p0` 一样查得到 */
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

test("对照：开门后共同层文案、信、照片、日期区间确实出现——没有这一条下面就是恒真式", async (t) => {
  const ui = await boot(t, routesFor(true));
  ui.intoReading();
  for (const w of READING_TEXT) {
    assert.ok(ui.text().includes(w), `开门后的阅读流里看不到「${w}」——禁用词表里的串是编出来的`);
  }
  // 日期区间与天数来自 /api/shared，不是写死在界面上的
  assert.ok(ui.seen.includes("GET /api/shared"), "阅读流没有真的打 GET /api/shared");
  assert.ok(ui.doc.querySelector('.grid3 img[src="/api/photo/p-shared-1"]'), "共同层合照没走鉴权取图路径");
  // 对方的条目也取到了：信与最后一段话都上了屏
  assert.ok(ui.text().includes(LETTER) && ui.text().includes(TAIL), "对方的信/最后一段话没上屏");
  t.diagnostic(`开门后可见文本长度 ${ui.text().length}`);
});

test("共同层没给日期时，兜底常量推出的是同一段日子与 731 天", async (t) => {
  /* 前端有一套「服务端没给 from/to/days 就用常量推」的兜底。
     早先没有任何测试走过这条路 —— 每一条用例的 /api/shared 都把日期给全了。
     于是 public/app.js 里那个 `START_DAY` 是**完全没被验过**的：
     把它改成减 DAYS（731），起点会变成 2024-10-04，测试照样全绿。
     这条专门走那条缝。 */
  const bare = { photos: sharedOf(3).photos, blessing: BLESSING };   // 故意不给 from/to/days
  const ui = await boot(t, routesFor(true, bare));
  ui.intoReading();

  const text = ui.text();
  assert.ok(text.includes("2024 年 10 月 5 日"), `兜底起点不对，界面上看不到 2024 年 10 月 5 日：${text.slice(0, 200)}`);
  assert.ok(!text.includes("2024 年 10 月 4 日"), "兜底起点算成了 10 月 4 日 —— 减的应该是 SPAN 不是 DAYS");
  // 天数只由这一行守。原来还并列断言过「这 731 个日夜」——那是祝福语小标题的文案，
  // 2026-10-03 那句换成「说点正经的」之后就没了，range 这行接手（同一个 r.days）。
  assert.ok(text.includes("一共 731 天"), "兜底天数不是 731");
  t.diagnostic("服务端不给日期时，兜底推出来的是 2024-10-05 → 2026-10-05 · 731 天");
});

test("阅读流顺序固定：首屏 → 我们的两年 → TA留给你的 → 信 → 照片 → 最后一段话", async (t) => {
  const ui = await boot(t, routesFor(true));
  ui.intoReading();
  const text = ui.text();
  const order = ["两年了", "我 们 的 两 年", "【改这里：heroCode】 给 你 的", "一 封 信", "TA 留 给 你 的 照 片", TAIL];
  let at = -1;
  for (const mark of order) {
    const i = text.indexOf(mark);
    assert.ok(i > at, `阅读流顺序不对：「${mark}」出现在前面一个区段之前或根本没出现`);
    at = i;
  }
  // 首屏与转场各占一整屏（薄荷绿 / 天蓝），中间那段是奶油白
  assert.ok(ui.doc.querySelector(".rd-mint") && ui.doc.querySelector(".rd-sky") && ui.doc.querySelector(".rd-warm"),
    "阅读流少了一段底色");
  t.diagnostic("6 个区段按序出现；薄荷绿首屏 / 天蓝转场 / 奶油白正文三段底色齐全");
});

test("未解锁：封印页与布置台都不出现共同层、对方内容与开门字样", async (t) => {
  const ui = await boot(t, routesFor(false));
  for (const w of READING_TEXT) {
    assert.ok(!ui.text().includes(w), `封印页出现了只有开门后才该有的「${w}」`);
  }
  assert.ok(!ui.text().includes("p-shared-1"), "封印页把共同层照片的文件 id 画出来了");
  assert.ok(!ui.text().includes("x-letter"), "封印页把对方的条目 id 画出来了");
  // 自己的留言还在：否则上面那组断言是空转
  assert.ok(ui.text().includes("两年了"), "封印页该有主标题");

  ui.intoReading();   // 同一个入口：没开门时它仍然是布置台
  // 泄漏断言放在控制断言**前面**：开门判定一旦失效，先红的是「内容漏出来了」，
  // 而不是后面那条「布置台该有自己的留言」——那才是这条测试想防的失效模式。
  for (const w of READING_TEXT) {
    assert.ok(!ui.text().includes(w), `布置台出现了只有开门后才该有的「${w}」`);
  }
  assert.ok(!ui.seen.includes("GET /api/shared"), "未解锁时前端仍然去请求了 /api/shared");
  // 自己的留言还在：否则上面那组断言是空转
  assert.ok(ui.text().includes(MINE[0].body), "布置台该显示自己的留言");
  t.diagnostic(`未解锁 可见文本长度 ${ui.text().length}，请求：${ui.seen.join(" / ")}`);
});

test("切到阅读流与放大层都不新建定时器：全站仍然只有一个 setInterval", async (t) => {
  const ui = await boot(t, routesFor(true));
  assert.equal(ui.timers.interval, 1, "全站只应有一个 setInterval");

  ui.intoReading();
  ui.click("[data-lb-open]");
  ui.click('[data-lb="next"]');
  ui.click('[data-lb="prev"]');
  ui.key("ArrowRight");
  ui.click('[data-lb="close"]');
  assert.equal(ui.timers.interval, 1, "切进阅读流或开放大层时又建了 setInterval");

  for (let i = 0; i < 5; i++) ui.win.__t04.render();
  assert.equal(ui.timers.interval, 1, "render() 又建了 setInterval —— 每次重绘泄漏一个");
});

test("放大层：环形翻页 / 计数在画框外 / 三种关闭 / 打开时锁背景滚动", async (t) => {
  const ui = await boot(t, routesFor(true, sharedOf(3)));
  ui.intoReading();
  const doc = ui.doc;
  const cnt = () => doc.querySelector("#lb .lb-cnt").textContent.trim();

  /* 计数在画框外面：原型第一版压在照片上，浅色占位图上几乎读不出来 */
  assert.deepEqual(Array.from(doc.querySelectorAll("#lb .lb-frame .lb-cnt")), [], "计数被画进画框里了");
  assert.ok(!doc.querySelector("#lb .lb-frame").textContent.includes("1 / 3"), "画框里出现了计数文本");
  const mid = doc.querySelector("#lb .lb-mid");
  assert.ok(mid && mid.querySelector(":scope > .lb-cnt") && mid.querySelector(":scope > .lb-frame"),
    "计数与画框必须是画框外的一对兄弟节点");

  /* 打开：锁背景滚动 */
  ui.click("[data-lb-open]");
  assert.ok(doc.querySelector("#lb").classList.contains("on"), "放大层没打开");
  assert.equal(doc.body.style.overflow, "hidden", "放大层打开时没有锁背景滚动");
  assert.equal(cnt(), "1 / 3", "计数不对");

  /* 环形：第 3 张 next 回到第 1 张 */
  ui.click('[data-lb-open="2"]');
  assert.equal(cnt(), "3 / 3", "没跳到第 3 张");
  ui.click('[data-lb="next"]');
  assert.equal(cnt(), "1 / 3", "最后一张 next 没有环形回到第 1 张");
  ui.click('[data-lb="prev"]');
  assert.equal(cnt(), "3 / 3", "第 1 张 prev 没有环形回到最后一张");

  /* 方向键（桌面端）：← → */
  ui.key("ArrowLeft");
  assert.equal(cnt(), "2 / 3", "← 翻页不对");
  ui.key("ArrowRight");
  assert.equal(cnt(), "3 / 3", "→ 翻页不对");

  /* 点画框内不关闭，点画框外空白关闭 */
  ui.click("#lb .lb-frame");
  assert.ok(doc.querySelector("#lb").classList.contains("on"), "点画框内就关了");
  ui.click("#lb");
  assert.ok(!doc.querySelector("#lb").classList.contains("on"), "点画框外空白没有关闭");
  assert.equal(doc.body.style.overflow, "", "关闭后没有解锁背景滚动");

  /* 关闭方式二：右上 × */
  ui.click("[data-lb-open]");
  ui.click('[data-lb="close"]');
  assert.ok(!doc.querySelector("#lb").classList.contains("on"), "右上角 × 没有关闭");
  assert.equal(doc.body.style.overflow, "", "× 关闭后背景滚动仍被锁着");

  /* 关闭方式三：Esc */
  ui.click("[data-lb-open]");
  ui.key("Escape");
  assert.ok(!doc.querySelector("#lb").classList.contains("on"), "Esc 没有关闭");
  assert.equal(doc.body.style.overflow, "", "Esc 关闭后背景滚动仍被锁着");
  t.diagnostic("环形翻页 ✓ 计数在画框外 ✓ ×/空白/Esc 三种关闭 ✓ 滚动锁 ✓");
});

test("阅读端照片卡：走的是同一个 card(mode=read)，撤回角标/操作行/没配文的配文区集合恰好为空", async (t) => {
  const ui = await boot(t, routesFor(true));
  ui.intoReading();
  const doc = ui.doc;
  const cards = Array.from(doc.querySelectorAll(".wall.ro .letter"));
  assert.equal(cards.length, 1, `阅读端应只有 1 张对方照片卡，实际 ${cards.length}`);
  assert.ok(doc.querySelector(".wall.ro .pframe"), "阅读端照片卡没有照片框");

  // 集合相等，不是「某元素不存在」：空集合必须真的空
  assert.deepEqual(Array.from(doc.querySelectorAll(".wall.ro .x")), [], "read 态渲染了撤回角标");
  assert.deepEqual(Array.from(doc.querySelectorAll(".wall.ro .ops")), [], "read 态渲染了操作行");
  assert.deepEqual(Array.from(doc.querySelectorAll(".wall.ro .cap")), [], "read 态没配文却渲染了配文区");
  assert.deepEqual(Array.from(doc.querySelectorAll(".wall.ro [data-del]")), [], "read 态渲染了撤回入口");
  assert.deepEqual(Array.from(doc.querySelectorAll(".wall.ro [data-cap]")), [], "read 态渲染了写一句入口");
  assert.deepEqual(Array.from(doc.querySelectorAll(".wall.ro textarea")), [], "read 态渲染了输入框");
  assert.deepEqual(Array.from(doc.querySelectorAll(".wall.ro button")), [], "read 态不该有任何按钮");
  assert.ok(cards[0].textContent.includes("已 送 达"), "read 态的封条应是「已送达」");
  // AC：照片信卡要显示「一共几张」
  assert.ok(ui.text().includes("一 共 1 张"), `照片信卡没有显示一共几张（实际可见「${doc.querySelector(".rd-count")?.textContent ?? "无"}」）`);

  /* 反向鉴别力：换成写了配文的照片，同一个渲染器必须给出一块实线配文。
     没有这一条，上面那组空集合可能只是「渲染器什么都不产出」。 */
  const withCap = { ...THEIRS[1], id: "x-photo-cap", body: "这张是偷偷拍的" };
  const box = doc.createElement("div");
  box.innerHTML = ui.win.__t04.card(withCap, 0, "read");
  const caps = Array.from(box.querySelectorAll(".cap"));
  assert.equal(caps.length, 1, "写了配文的照片在 read 态应有一块配文区");
  assert.ok(caps[0].className.includes("cap-real"), "read 态的配文应是实线浅底（内容，不是输入框）");
  // 同一个渲染器，edit 态就有撤回角标和操作行了
  const ed = doc.createElement("div");
  ed.innerHTML = ui.win.__t04.card(withCap, 0, "edit");
  assert.equal(ed.querySelectorAll(".x").length, 1, "edit 态应有撤回角标");
  assert.equal(ed.querySelectorAll(".ops").length, 1, "edit 态应有操作行");
  t.diagnostic("read 的 .x/.ops/.cap/[data-del]/[data-cap]/textarea/button 全为空集合；edit 态对照非空");
});

test("合照不足 9 张：缺的格子走占位块，格子数恒为 9", async (t) => {
  for (const n of [0, 1, 4, 9]) {
    const ui = await boot(t, routesFor(true, sharedOf(n)));
    ui.intoReading();
    const doc = ui.doc;
    const cells = Array.from(doc.querySelectorAll(".grid3 > .g"));
    assert.equal(cells.length, 9, `${n} 张合照时格子数应为 9，实际 ${cells.length}`);
    assert.equal(doc.querySelectorAll(".grid3 .g-ph").length, 9 - n, `${n} 张合照时占位块数不对`);
    assert.equal(doc.querySelectorAll(".grid3 [data-lb-open]").length, n, `${n} 张合照时可放大的格子数不对`);
    // 每格都有内容且带一个自带高度的占位块（布局不塌陷的前一半：格子里不是空的）
    for (const c of cells) {
      assert.equal(c.children.length, 1, `${n} 张合照时有一格没有内容`);
      if (c.classList.contains("g-ph")) {
        assert.ok(/^p[0-4]$/.test([...c.firstElementChild.classList].find((x) => /^p[0-4]$/.test(x))),
          `${n} 张合照时占位块缺五色轮转类`);
      }
    }
    t.diagnostic(`${n} 张合照：格子 ${cells.length}、占位块 ${doc.querySelectorAll(".grid3 .g-ph").length}`);
  }
  t.diagnostic("0 / 1 / 4 / 9 张：格子恒 9，占位块恒等于 9 − 实际张数");
});

test("CSS 契约：≥760px 内容列 480px 居中；九宫格 1:1；照片信卡 4:5；放大层 3:4", (t) => {
  const text = css();
  const col = rule(text, ".col");
  assert.match(col, /margin:\s*0\s+auto/, "内容列没有居中");

  const wide = mediaInner(text, "@media (min-width: 760px)");
  assert.match(rule(wide, ".col"), /max-width:\s*480px/, "≥760px 时内容列不是 480px");

  assert.match(rule(text, ".grid3"), /grid-template-columns:\s*repeat\(3,\s*1fr\)/, "九宫格不是 3 列");
  assert.match(rule(text, ".grid3 .g"), /aspect-ratio:\s*1/, "九宫格格子不是 1:1 方格");
  assert.match(rule(text, ".pframe"), /aspect-ratio:\s*4\s*\/\s*5/, "照片信卡不是 4:5 竖幅");
  assert.match(rule(text, ".letter.ro .pframe .ph"), /object-fit:\s*contain/, "阅读端照片没有改成不裁边的 contain");
  assert.match(rule(text, ".lb-frame"), /aspect-ratio:\s*3\s*\/\s*4/, "放大层画框不是 3:4 竖幅");
  assert.match(rule(text, ".lb-cnt"), /color:/, "计数没有配色");

  // 占位块：五色轮转，五个不同的底色，且带虚线感边框
  const colors = [0, 1, 2, 3, 4].map((i) => (rule(text, `.p${i}`).match(/background:\s*([^;]+);/) || [])[1]);
  assert.equal(colors.filter(Boolean).length, 5, "占位块的五色没有齐");
  assert.equal(new Set(colors).size, 5, "占位块五个底色有重复，看起来就是同一种方块");
  assert.match(rule(text, ".ph.p0"), /border:\s*2px dashed/, "占位块没有虚线感边框");
  // 单文件：不引 CDN、不引外部字体
  const html = fs.readFileSync(HTML_FILE, "utf8");
  assert.ok(!/https?:\/\//.test(html) && !/https?:\/\//.test(text), "引了外部地址");
  assert.ok(!/@import|url\(/.test(text), "style.css 里有外部资源引用");
  t.diagnostic(`占位块五色：${colors.join(" / ")}`);
});

/* ====================================================================== *
 * fail closed：问不到服务端就是「没开」
 *
 * 复审 HIGH-2：open() 曾经退回设备时钟，于是「status 失败 + 手机时间已过开门
 * 时刻」会让整条阅读流骨架渲染出来——服务端全 404，但界面上已经全是开门文案。
 * 上一条「未解锁无共同层」把 status 钉死成 200 + unlocked:false，这一支零覆盖。
 * ====================================================================== */
test("fail closed：问不到 /api/status 时按没开处理，设备时钟过点也不渲染阅读流", async (t) => {
  const AT_UNLOCK = 1791129600000;
  const broken = {
    "GET /api/status": { status: 500, body: { error: "server_error" } },
    "GET /api/me": { status: 200, body: ME },
    "GET /api/entry": { status: 200, body: { mine: MINE, theirs: [THEIRS] } },
    "GET /api/shared": { status: 404, body: { error: "not_found" } },
  };
  const ui = await boot(t, broken, { deviceNowMs: AT_UNLOCK + 86400000 });

  const text = ui.text();
  for (const w of ["我 们 的 两 年", "一 封 信", "TAIL"]) {
    assert.ok(!text.includes(w), `问不到服务端却渲染出了「${w}」——open() 退回设备时钟了`);
  }
  // 也不该把共同层接口打出去
  assert.ok(
    !ui.seen.includes("GET /api/shared"),
    "status 都没问到就去请求 /api/shared，请求本身就会把共同层的存在暴露出去",
  );
  t.diagnostic(`fail closed 可见文本长度 ${text.length}，抽样：${text.trim().slice(0, 60)}…`);
});