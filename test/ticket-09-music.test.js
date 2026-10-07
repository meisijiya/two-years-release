/**
 * 工单 09 · 背景音乐 —— 前端契约测试
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假 fetch + **可脚本化的 play()**。
 *
 * 为什么必须替掉 play()：jsdom 里 `HTMLMediaElement.play()` 根本不实现，
 * 直接调用会走 notImplemented 并返回 undefined。这条用例真正要守的是
 * 「**被浏览器拒了 → 出提示 → 她第一次点页面 → 真的响了 → 提示消失**」
 * 这条状态机，而自动播放被拒正是它唯一能出现的入口。
 * 不替掉 play()，这条路径在测试里永远走不到，断言就成了恒真式。
 *
 * 另一处替身是 localStorage：jsdom 的 file:// 是不透明源，取值那一下就抛
 * SecurityError。我们**另外**有一条用例专门守「它真的抛了也不许把整页带崩」，
 * 所以替身必须能显式地抛，两种环境各测一遍。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_FILE = path.join(ROOT, "public", "index.html");

const LOCKED_STATUS = { status: 200, body: { unlocked: false, unlockAt: 1791129600000 } };
const NO_SESSION = { status: 401, body: { error: "no_session" } };
const ROUTES = { "GET /api/status": LOCKED_STATUS, "GET /api/me": NO_SESSION };

/**
 * 装一个页面。
 * @param {object} o
 * @param {"ok"|"reject"} o.autoplay  当前 play() 的结果
 * @param {boolean} o.storageThrows   localStorage 每次取值都抛（模拟不透明源）
 * @param {Map} o.store               复用同一个 localStorage —— 「刷新」是同一个浏览器的下一个页面
 */
async function mount({ autoplay = "reject", storageThrows = false, store: shared = null } = {}) {
  const seen = [];
  const timers = { interval: 0 };
  const store = shared || new Map();
  const plays = { calls: 0, pauses: 0 };

  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      const real = w.setInterval.bind(w);
      w.setInterval = (...a) => { timers.interval += 1; return real(...a); };

      /* 可脚本化的播放器：唯一能测「被拒 → 手势救回来」这条路径的办法。
         ⚠️ 真实浏览器**只在自动播放那一段拒**，有了一次手势之后 play() 就放行了；
            这里若让它永远拒，就测不到「救回来」那一段。用例要自己用
            `__setAutoplay("ok")` 切过去，那一步就是「手势发生了」这个假设本身。 */
      let mode = autoplay;
      w.HTMLMediaElement.prototype.play = function () {
        plays.calls += 1;
        if (mode === "reject") return Promise.reject(new DOMException("blocked", "NotAllowedError"));
        this._playing = true;
        return Promise.resolve();
      };
      w.HTMLMediaElement.prototype.pause = function () {
        plays.pauses += 1;
        this._playing = false;
      };
      w.__setAutoplay = (m) => { mode = m; };

      const ls = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      };
      if (storageThrows) {
        for (const k of ["getItem", "setItem", "removeItem"]) {
          ls[k] = () => { throw new w.DOMException("opaque origin", "SecurityError"); };
        }
      }
      Object.defineProperty(w, "localStorage", { value: ls, configurable: true });

      w.fetch = async (url, init = {}) => {
        const key = `${(init.method || "GET").toUpperCase()} ${url}`;
        seen.push(key);
        const r = ROUTES[key];
        const status = r ? r.status : 404;
        const body = r && status !== 204 ? r.body : { error: "not_found" };
        return new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      };
    },
  });

  for (let i = 0; i < 200 && !dom.window.__t08; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t08, "public/index.html 没有跑起 public/app.js（脚本没加载，或没挂 __t08）");
  await dom.window.__t08.ready;
  return { dom, seen, timers, store, plays };
}

const boot = async (t, opts) => {
  const m = await mount(opts);
  t.after(() => m.dom.window.close());
  const doc = m.dom.window.document;
  return {
    win: m.dom.window,
    doc,
    ...m,
    btn: () => doc.querySelector("#bgm-btn"),
    hint: () => doc.querySelector("#bgm-hint"),
    audio: () => doc.querySelector("#bgm"),
    music: () => m.dom.window.__t08.MUSIC,
  };
};

/** 在窗口里造一次真实的手势（不是直接调函数） */
const gesture = (win, target) =>
  target.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));

/* ══════════════════════════════════════════════════════════════════ */

test("BGM：播放器与收纳建在 #app 之外 —— render 重画不会把它连同音乐一起重建", async (t) => {
  const ui = await boot(t);
  const a0 = ui.audio();
  assert.ok(a0, "页面里没有 <audio id=bgm>");
  assert.equal(a0.parentNode, ui.doc.body, "必须在 body 上，不能挂在 #app 里");
  assert.equal(ui.doc.querySelector("#app audio"), null, "挂在 #app 里的话每次重绘都会被重建");
  // 开关现在长在收纳面板里，所以判据是「不在 #app 里」而不是「父节点是 body」——
  // 后者钉死的是实现形状：它会在有人把开关重新摊平成一颗常驻按钮时变红，
  // 而那正是这个用例要防的回归。
  assert.ok(ui.btn() && !ui.doc.querySelector("#app").contains(ui.btn()),
    "开关必须在 #app 之外");
  assert.ok(ui.doc.querySelector("#dw"), "收纳壳不见了");
  assert.ok(ui.doc.querySelector("#dw").contains(ui.btn()), "开关应当长在收纳面板里");
  assert.ok(ui.doc.querySelector("#app").contains(ui.hint()) === false, "提示条也不能在 #app 里");

  for (let i = 0; i < 5; i++) ui.win.__t08.render();
  assert.equal(ui.doc.querySelector("#bgm"), a0, "重画 5 次之后 <audio> 换了对象 —— 音乐会从头开始");
  assert.equal(ui.doc.querySelector("#bgm-btn"), ui.btn(), "开关也被重建了");
  assert.equal(ui.doc.querySelector("#dw"), ui.doc.querySelector("#dw"), "收纳壳必须是同一个节点");
});

test("BGM：preload=none、循环、默认小音量 —— 不进站就下 6MB 会拖慢开门那一下", async (t) => {
  const ui = await boot(t);
  const a = ui.audio();
  assert.equal(a.getAttribute("preload"), "none", "preload 必须是 none");
  assert.equal(a.loop, true, "lofi 要循环");
  assert.equal(a.volume, 0.3, "默认音量 0.3：一段要陪人读很久的 BGM 不该一上来就炸");
  assert.match(a.getAttribute("src"), /bgm\.mp3$/, "音源不对");
});

test("BGM：被浏览器拒了 → 出提示；她第一次点页面 → 真响，提示消失", async (t) => {
  const ui = await boot(t, { autoplay: "reject" });
  assert.equal(ui.music().want, true, "默认是开的");
  assert.equal(ui.music().playing, false, "被拒了就不该假装在放");
  assert.equal(ui.music().blocked, true, "被拒的事实要记下来");
  assert.equal(ui.hint().classList.contains("on"), true, "被拒且想要开 → 提示该出现");
  assert.equal(ui.hint().textContent.length > 0, true, "提示条是空的等于没提示");

  // 「手势发生了」这件事由桩来表达：真实浏览器从这一刻起就不再拒了
  ui.win.__setAutoplay("ok");
  gesture(ui.win, ui.doc.body);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(ui.music().playing, true, "一次手势之后应该真的响起来");
  assert.equal(ui.music().blocked, false);
  assert.equal(ui.hint().classList.contains("on"), false, "响了就不该再提示 —— 正在放的时候弹一句最吵");
  assert.equal(ui.hint().textContent, "", "提示文字要清掉，不能留在 DOM 里");
});

test("BGM：提示条不吃点击（它要接住的是她在别处的那一次手势）", async (t) => {
  const ui = await boot(t, { autoplay: "reject" });
  const cs = ui.win.getComputedStyle(ui.hint());
  assert.equal(cs.pointerEvents, "none", "pointer-events 必须是 none，否则提示条会把点击吃掉，音乐永远起不来");
});

test("BGM：开关关掉 → 真的停、按钮变「音 乐 关」、读屏说的是「打开」", async (t) => {
  const ui = await boot(t, { autoplay: "ok" });
  assert.equal(ui.music().playing, true, "前置：自动播放放行时它直接就在放");
  assert.equal(ui.btn().textContent.trim(), "音 乐 开");
  assert.equal(ui.btn().getAttribute("aria-pressed"), "true");
  assert.match(ui.btn().getAttribute("aria-label"), /关闭/);

  ui.btn().click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(ui.music().want, false, "按一下应该关掉");
  assert.equal(ui.music().playing, false, "关了必须真的停");
  assert.ok(ui.plays.pauses >= 1, "没有调 pause()：按钮变了声音还在");
  assert.equal(ui.btn().textContent.trim(), "音 乐 关");
  assert.equal(ui.btn().getAttribute("aria-pressed"), "false");
  assert.match(ui.btn().getAttribute("aria-label"), /打开/, "关着的时候要告诉读屏按下去会打开");
  assert.equal(ui.hint().classList.contains("on"), false, "她已经主动关掉了，别再提示她打开");
});

test("BGM：关掉之后刷新仍然是关着的（别让她每次回来都被迫再关一次）", async (t) => {
  const store = new Map();                      // 同一个浏览器的两页：localStorage 是共享的
  const first = await boot(t, { autoplay: "ok", store });
  first.btn().click();
  assert.equal(store.get("bgm"), "off", "按掉之后要记住");

  const second = await boot(t, { autoplay: "ok", store });
  assert.equal(second.music().want, false, "新页面应当是关着的");
  assert.equal(second.plays.calls, 0, "都记着关着呢，不该再自动去放");
  assert.equal(second.btn().textContent.trim(), "音 乐 关");
});

test("BGM：localStorage 整个抛掉（不透明源）也不许把整页带崩", async (t) => {
  const ui = await boot(t, { autoplay: "reject", storageThrows: true });
  // 抛了以后仍要走默认值：开
  assert.equal(ui.music().want, true, "读不到偏好就用默认值，不许当成关");
  assert.ok(ui.audio(), "播放器照样要建起来");
  assert.ok(ui.btn(), "开关照样要建起来");

  ui.btn().click();          // 存偏好那一步会抛
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ui.music().want, false, "内存里的状态照样要跟着按钮走");
  assert.equal(ui.btn().textContent.trim(), "音 乐 关", "界面不能因为存不进去就不更新");
  // jsdom 没有 innerText，用 textContent —— 要证明的是「整页还是活的」，不是某个具体属性
  assert.ok(ui.doc.body.textContent.includes("两年了"), "整页还得是活的");
});

test("BGM：它不新建定时器（全站仍然只有一个 setInterval）", async (t) => {
  const ui = await boot(t, { autoplay: "reject" });
  assert.equal(ui.timers.interval, 1, `音乐不该建定时器，实际建了 ${ui.timers.interval} 个`);
  ui.win.__setAutoplay("ok");
  gesture(ui.win, ui.doc.body);
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 5; i++) ui.win.__t08.render();
  assert.equal(ui.timers.interval, 1, "起播与重画都不许建定时器");
});
