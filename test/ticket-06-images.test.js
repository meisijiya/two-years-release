/**
 * 工单 06 · 可靠性与部署脚本 —— 前端：破图不许塌，触控目标不许小
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假网络。
 *
 * 两条边界必须说在前面：
 *   1. jsdom **没有排版引擎**：scrollWidth/clientWidth、getBoundingClientRect 全是 0。
 *      所以这里不写"框没塌"这种假断言 —— 尺寸相关的证据留给真实浏览器
 *      （工单 06 的浏览器取证）。这里能真断言的是**结构**：
 *      占位块换上去之后仍在原来的比例容器里、且带着原图那个尺寸属性。
 *   2. jsdom 也没有图片解码器：<img> 永远不会 load，也永远不会自己触发 error。
 *      浏览器在读不出来时做的事就是往 img 上派发一个 error 事件，所以这里
 *      显式派发同一个事件 —— 被测的是我们收到事件之后的行为，这部分是纯 DOM 的。
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

const AT_UNLOCK = 1791129600000;
const ME = { id: "hero", code: "【改这里：heroCode】", role: "【改这里：boyfriend】", unlocked: true, count: 2 };

const PHOTO = { id: "p1", mime: "image/jpeg", bytes: 10, w: 1200, h: 1600 };
const MINE = [
  { id: "e1", kind: "photo", body: "第一张，配文。", ord: 1, created: 1759000000000, photo: PHOTO },
  { id: "e2", kind: "text", body: "墙上的一句留言。", ord: 2, created: 1759000000000, photo: null },
];
const THEIRS = [
  { id: "x1", kind: "photo", body: "她留的那张。", ord: 1, created: 1759000000000, photo: { ...PHOTO, id: "p9" } },
  { id: "x2", kind: "text", body: "一封信。", ord: 2, created: 1759000000000, photo: null },
];

/** 开门后的回包：布置台上 1 张自己的照片，阅读流里 1 张她的 + 九宫格 2 张合照 */
const routes = {
  "GET /api/status": { status: 200, body: { unlocked: true, unlockAt: AT_UNLOCK, now: AT_UNLOCK + 1000 } },
  "GET /api/me": { status: 200, body: { ...ME, unlocked: true } },
  "GET /api/entry": { status: 200, body: { mine: MINE, theirs: THEIRS } },
  "GET /api/shared": {
    status: 200,
    body: {
      photos: [{ id: "sh1", photoId: "s1" }, { id: "sh2", photoId: "s2" }],
      blessing: "从第一天起。", from: "2024-10-05", to: "2026-10-05", days: 731,
    },
  },
  "GET /api/wish": {
    status: 200,
    body: { wishes: [{ id: "door", code: "【改这里：doorCode】", text: "一起看一次日出。" }, { id: "hero", code: "【改这里：heroCode】", text: "学会做那道菜。" }] },
  },
};

async function mount({ unlocked = true, anon = false } = {}) {
  const timers = { interval: 0 };
  const table = {
    ...routes,
    "GET /api/status": { status: 200, body: { unlocked, unlockAt: AT_UNLOCK, now: unlocked ? AT_UNLOCK + 1000 : AT_UNLOCK - 1000 } },
    "GET /api/me": anon
      ? { status: 401, body: { error: "no_session" } }
      : { status: 200, body: { ...ME, unlocked } },
    // 未解锁时服务端不会给 theirs：门在前端自己也有一道，这里照样照发
    "GET /api/entry": { status: 200, body: { mine: MINE, theirs: unlocked ? THEIRS : [] } },
    "GET /api/wish": unlocked
      ? routes["GET /api/wish"]
      : { status: 404, body: { error: "not_found" } },
    "GET /api/shared": unlocked ? routes["GET /api/shared"] : { status: 404, body: { error: "not_found" } },
  };
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      const real = w.setInterval.bind(w);
      w.setInterval = (...a) => { timers.interval += 1; return real(...a); };
      w.fetch = async (url, init = {}) => {
        const r = table[`${(init.method || "GET").toUpperCase()} ${url}`];
        if (!r) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), {
          status: r.status, headers: { "content-type": "application/json" },
        });
      };
    },
  });
  return { dom, timers };
}

async function boot(t, opts) {
  const { dom, timers } = await mount(opts);
  t.after(() => dom.window.close());
  for (let i = 0; i < 200 && !dom.window.__t06; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t06, "public/index.html 没有跑起 public/app.js");
  await dom.window.__t06.ready;
  const doc = dom.window.document;
  return {
    win: dom.window,
    doc,
    timers,
    text: () => doc.body.textContent,
    all: (sel) => Array.from(doc.querySelectorAll(sel)),
    el(sel) {
      const el = doc.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      return el;
    },
    click(sel) {
      const el = this.el(sel);
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    },
    settle: async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); },
  };
}

/** 浏览器在图读不出来时做的事：往那个 <img> 上派发一个 error 事件（不冒泡）。 */
function breakImage(img) {
  img.dispatchEvent(new img.ownerDocument.defaultView.Event("error"));
}

/* ── CSS 契约：只验声明，验不了像素（jsdom 没有排版引擎）───────────── */
const css = () => fs.readFileSync(CSS_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

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
/** 同一条选择器可能出现在分组选择器里（.st-seal-l, .st-seal-r, …）也可能另起一条，
 *  所以把命中的所有声明并起来 —— 只看第一条会漏掉分组里那半条。 */
const rule = (text, sel) => {
  const hit = rules(text).filter((r) => r.sels.includes(sel));
  assert.ok(hit.length, `style.css 里没有 ${sel} 这条规则`);
  return hit.map((r) => r.body).join("; ");
};

/* ══════════════════════════════════════════════════════════════════ */

test("照片读不出来：换成有设计感的占位块，配文与正文都还在原位", async (t) => {
  // 未解锁 → 同一个入口走布置台（开门后同一个入口就变成阅读流了，那边看不到自己的卡）
  const ui = await boot(t, { unlocked: false });
  ui.click('[data-go="desk"]');
  await ui.settle();

  const imgs = ui.all(".pframe img");
  assert.equal(imgs.length, 1, "前提：布置台上正好有一张照片");
  assert.ok(ui.text().includes("第一张，配文。"), "前提：照片配文在界面上");

  breakImage(imgs[0]);

  const frame = ui.el(".pframe");
  assert.equal(frame.querySelectorAll("img").length, 0, "破图之后那个 <img> 还在原地");
  const fb = frame.querySelector(".img-fb");
  assert.ok(fb, "破图之后照片框里没有占位块 —— 变成了一个空洞");
  assert.ok(fb.textContent.includes("照 片"), `占位块没说明这里本来有张照片：${fb.textContent}`);
  // 有设计感的判据：它带着五色占位块的那套类，且那一套在 CSS 里是有底色 + 虚线边框的
  assert.match(fb.className, /\bp[0-4]\b/, `占位块没落进五色轮转：${fb.className}`);
  const tone = fb.className.match(/\b(p[0-4])\b/)[1];
  const toneRule = rule(css(), `.${tone}`);
  assert.match(toneRule, /background:\s*var\(--/, `占位块 ${tone} 没有底色，就是一个灰块`);

  // 布局不塌陷的结构依据：占位块仍在比例容器里，容器自己声明着 aspect-ratio
  assert.match(rule(css(), ".pframe"), /aspect-ratio:\s*4\s*\/\s*5/, "照片框丢了 4:5，比例一换布局就变了");
  assert.match(rule(css(), ".ph"), /width:\s*100%/, "占位块没有撑满容器");
  assert.match(rule(css(), ".ph"), /height:\s*100%/, "占位块没有撑满容器");
  // 内容不许跟着图一起消失
  assert.ok(ui.text().includes("第一张，配文。"), "破图把配文也带走了");
  assert.ok(ui.text().includes("墙上的一句留言。"), "破图把整面墙都带走了");
  t.diagnostic(`照片破图 → 占位块「${fb.textContent.trim()}」（${tone}），配文与留言仍在`);
});

test("形象图破图：占位块带着原来的尺寸，不会缩成一个点", async (t) => {
  // 匿名（/api/me → 401）→ 封印页上是「我先去布置」，才够得着身份页上的形象图
  const ui = await boot(t, { anon: true });
  ui.click('[data-go="who"]');
  await ui.settle();
  const bub = ui.el(".idcard img");
  const w = bub.getAttribute("width");
  const h = bub.getAttribute("height");
  assert.ok(w && h, "前提：形象图带 width/height 属性");

  breakImage(bub);

  const fb = ui.el(".idcard .img-fb");
  assert.equal(fb.style.width, `${w}px`, "形象图的占位块没继承原图的宽度 —— 盒子会缩成一点");
  assert.equal(fb.style.height, `${h}px`, "形象图的占位块没继承原图的高度");
  assert.ok(fb.textContent.includes("图"), `占位块没有标注：${fb.textContent}`);
  t.diagnostic(`形象图破图 → 占位块 ${fb.style.width} × ${fb.style.height}，与原图同尺寸`);
});

test("九宫格与放大层里的图破图：格子数不变，占位块顶上", async (t) => {
  const ui = await boot(t);
  ui.click('[data-go="desk"]');
  await ui.settle();                                   // 开门后同一个入口 = 阅读流

  const cells = ui.all(".grid3 .g");
  assert.equal(cells.length, 9, "前提：九宫格恒 9 格");
  // ⚠️ 九宫格那几张**先重试再占位**（2026-10-03 加的：占位块不可逆，一次抖动
  // 就等于那张照片在整场阅读里永久缺席；公网实测同一批九张图首载有 3 张没出来）。
  // 所以这里要把重试用完，断的仍然是「占位块顶上、格子数不变」那两件事 ——
  // 变的只是「失败几次之后才占位」，不是「占不占位」。
  const gridImgs = ui.all(".grid3 img");
  for (let round = 0; round < 3; round++) {
    for (const im of gridImgs) if (im.isConnected) breakImage(im);
    await ui.settle();
    await new Promise((r) => setTimeout(r, 700));       // 等 600ms 的重试间隔过掉
  }
  assert.equal(ui.all(".grid3 .g").length, 9, "破图之后九宫格塌了 —— 格子数必须恒为 9");
  const fbs = ui.all(".grid3 .img-fb");
  assert.equal(fbs.length, 2, `两张合照重试用完之后应有两块占位，实际 ${fbs.length}`);
  for (const f of fbs) assert.ok(f.textContent.includes("合 照"), `合照占位块没标注：${f.textContent}`);
  assert.match(rule(css(), ".grid3 .g"), /aspect-ratio:\s*1/, "九宫格格子不是 1:1，比例一换布局就变了");

  // 放大层：同一个委托必须也管到这里。**放大层那张不重试**（它的行为一直是一次
  // 失败就占位，这次刻意不顺手改），所以这里仍然一发就断。
  ui.click(".grid3 .g[data-lb-open]");
  await ui.settle();
  const lbImg = ui.el(".lb-frame img");
  breakImage(lbImg);
  assert.ok(ui.el(".lb-frame .img-fb"), "放大层里的图破图后没有占位块");
  assert.ok(ui.el(".lb-cnt").textContent.length > 0, "破图把放大层的计数也带走了");
  t.diagnostic("九宫格 2 张（三次失败才占位）+ 放大层 1 张（一发就占位）：格子恒 9、计数仍在、占位块顶上");
});

test("取图路径仍然只有 photoSrc() 一条：破图处理没有偷偷加第二条", async (t) => {
  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  // 界面上出现的照片地址必须都由 photoSrc() 拼出来（唯一一条读图路径）
  const imgs = await (async () => {
    const ui = await boot(t, { unlocked: false });
    ui.click('[data-go="desk"]');
    await ui.settle();
    return ui.all("img").map((i) => i.getAttribute("src"));
  })();
  for (const s of imgs) {
    assert.ok(s, "有 <img> 没有 src");
    assert.ok(/^\/?(yier-bubu\/|api\/photo\/)/.test(s), `出现了第二条取图路径：${s}`);
  }
  assert.match(src, /const photoSrc = \(p\) => `\/api\/photo\/\${encodeURIComponent\(p\.id\)}`;/,
    "取图入口 photoSrc 不在原地了");
  assert.ok(!/["'`]\/photos\/|\/uploads\/|\/yier-bubu\/.*api/.test(src), "源码里出现了照片目录的直连路径");
  t.diagnostic(`界面上 ${imgs.length} 张图：形象图走 yier-bubu/，照片一律 api/photo/`);
});

test("触控目标：可点元素的点按区都 ≥ 48px（声明层取证，像素由浏览器取证）", async (t) => {
  const text = css();
  const need48 = [
    ".go", ".back", ".idcard", ".pin", ".linkish", ".letter .ops button",
    ".add", ".pick button", ".composer-ops button", ".lbnav", ".lbclose",
    ".netbar .nb-retry", ".x",
  ];
  for (const sel of need48) {
    const body = rule(text, sel);
    const has = /min-height:\s*var\(--tap\)/.test(body) || /min-height:\s*48px/.test(body)
      || /height:\s*var\(--tap\)/.test(body) || /height:\s*48px/.test(body)
      || (/padding:\s*1[5-9]px/.test(body) && !/min-height/.test(body));   // 大内边距的按钮
    assert.ok(has, `${sel} 没有 ≥48px 的点按区（工单 06 的硬要求）`);
  }
  // 撤回角标：视觉 32px，点按区 48px —— 拆成两条声明，靠 ::before 画那块 32px
  const x = rule(text, ".x");
  assert.match(x, /width:\s*var\(--tap\)/, ".x 的点按区不是 48px");
  assert.match(x, /height:\s*var\(--tap\)/, ".x 的点按区不是 48px");
  assert.match(rule(text, ".x::before"), /width:\s*32px/, "角标的视觉还是 32px（design.md §四）");
  assert.match(rule(text, ":root"), /--tap:\s*48px/, ":root 里 --tap 必须是 48px");
  t.diagnostic(`${need48.length} 类可点元素 + .x 命中区都 ≥48px（.x 视觉仍 32px）`);
});

test("安全区与视口单位：固定元素避开手势条，角落装饰避开刘海，高度用 100dvh", async (t) => {
  const text = css();
  const root = rule(text, ":root");
  assert.match(root, /--safe-t:\s*env\(safe-area-inset-top/, "顶部安全区变量没定义");
  assert.match(root, /--safe-b:\s*env\(safe-area-inset-bottom/, "底部安全区变量没定义");
  // 底部固定元素：添加栏必须留出手势条
  assert.match(rule(text, ".addbar"), /padding:[^;]*var\(--safe-b\)/, "底部添加栏没有避开手势条");
  // 顶部固定元素与角落装饰
  for (const sel of [".back", ".netbar", ".lbclose", ".st-seal-l", ".st-seal-r", ".st-two-r", ".desk .decor"]) {
    assert.match(rule(text, sel), /var\(--safe-t\)/, `${sel} 没有避开顶部安全区（会被状态栏压住）`);
  }
  // 100vh 一处都不许再有：移动浏览器地址栏会把它顶掉
  assert.ok(!/[^d]100vh/.test(text), "CSS 里出现了 100vh");
  assert.match(rule(text, ".screen"), /min-height:\s*100dvh/, "整屏高度没有用 100dvh");
  assert.match(rule(text, ".rd-hero"), /min-height:\s*100dvh/, "阅读流首屏没有用 100dvh");
  t.diagnostic("安全区：--safe-t/--safe-b 到位；高度：100vh 0 处，全是 100dvh");
});
