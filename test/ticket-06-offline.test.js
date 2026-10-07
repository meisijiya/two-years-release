/**
 * 工单 06 · 可靠性与部署脚本 —— 前端：断网不许白屏
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假网络（fetch 全部 reject）。
 * 只断言界面上看得见的东西，不碰内部实现。
 *
 * 四条容易做砸的：
 *   1. 请求发不出去**不能抛**。抛出去，一次断网就把整屏带走。
 *   2. 断网时**不清空**已经读出来的内容 —— 墙上折好的东西要还在。
 *   3. 断网**不许**退回设备时钟开门：设备时钟过了开门时刻、问不到服务端 = 按没开。
 *   4. 断网提示不新建定时器：全站仍然只有一个 setInterval。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_FILE = path.join(ROOT, "public", "index.html");

const AT_UNLOCK = 1791129600000;      // 2026-10-05T00:00:00+08:00
const MY_ENTRY = "我折好的一句话，地铁里也要看得见。";

const MINE = [{ id: "e1", kind: "text", body: MY_ENTRY, ord: 1, created: 1759000000000, photo: null }];
const ME = { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: false, count: 1 };

const routesFor = (unlocked) => ({
  "GET /api/status": { status: 200, body: { unlocked, unlockAt: AT_UNLOCK, now: AT_UNLOCK - 1000 } },
  "GET /api/me": { status: 200, body: { ...ME, unlocked } },
  "GET /api/entry": { status: 200, body: { mine: MINE, theirs: [] } },
});

/**
 * 起一个真页面。`net.down` 为 true 时**所有** fetch 都 reject —— 真断网就是这个样子：
 * 浏览器抛 TypeError，压根没有 status、没有回包。
 */
async function mount({ net }) {
  const seen = [];
  const timers = { interval: 0 };
  const state = { down: net === "down" };
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
        if (state.down) throw new TypeError("Failed to fetch");    // 真断网长这样
        const r = routesFor(false)[key];
        if (!r) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), {
          status: r.status, headers: { "content-type": "application/json" },
        });
      };
    },
  });
  return { dom, seen, timers, state };
}

async function boot(t, opts) {
  const m = await mount(opts);
  t.after(() => m.dom.window.close());          // 关窗清掉那个 setInterval，否则进程不退出
  for (let i = 0; i < 200 && !m.dom.window.__t06; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(m.dom.window.__t06, "public/index.html 没有跑起 public/app.js（脚本没加载，或加载后没挂 __t06）");
  await m.dom.window.__t06.ready;
  const doc = m.dom.window.document;
  return {
    win: m.dom.window,
    doc,
    seen: m.seen,
    timers: m.timers,
    state: m.state,
    text: () => doc.body.textContent,
    all: (sel) => Array.from(doc.querySelectorAll(sel)),
    el(sel) {
      const el = doc.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      return el;
    },
    click(sel) {
      const el = this.el(sel);
      el.dispatchEvent(new m.dom.window.MouseEvent("click", { bubbles: true }));
      return el;
    },
    settle: async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); },
    intoDesk() {
      const b = doc.querySelector('[data-go="desk"]');
      assert.ok(b, "封印页没有入口按钮");
      b.dispatchEvent(new m.dom.window.MouseEvent("click", { bubbles: true }));
    },
  };
}

/* ══════════════════════════════════════════════════════════════════ */

test("一上来就断网：界面照样出得来，不是一屏空白", async (t) => {
  const ui = await boot(t, { net: "down" });

  assert.ok(ui.text().includes("两年了"), "断网时封印页没渲染出来 —— 这就是白屏");
  assert.ok(ui.el("#app").children.length > 0, "断网时 #app 是空的");
  // 断网后 load() 应当就地停下：问过 status 与 me 就该结束，不该继续往下列表接口打
  assert.deepEqual(ui.seen, ["GET /api/status", "GET /api/me"],
    `断网时不该继续往下列表接口打。实际请求：${ui.seen.join(" / ")}`);
  t.diagnostic(`断网首屏：${ui.text().trim().slice(0, 40)}…，#app 渲染出 ${ui.el("#app").children.length} 个子节点`);
});

test("断网时给出提示：说的是「连不上、还能看」，不是「内容为空」", async (t) => {
  const ui = await boot(t, { net: "down" });

  const bar = ui.el("#netbar");
  assert.ok(bar.classList.contains("on"), "断网了提示条却没有出现");
  assert.equal(bar.getAttribute("aria-hidden"), "false", "提示条出现了却对读屏软件说它是隐藏的");
  const tx = ui.el("#netbar .nb-tx").textContent;
  assert.ok(tx.includes("连不上"), `提示没有说清是连不上：${tx}`);
  assert.ok(tx.includes("已经读出来的内容"), `提示没有说清已有内容还能看：${tx}`);
  assert.ok(ui.el("#netbar .nb-retry"), "提示条上没有重试入口");
  t.diagnostic(`提示文案：${tx}`);
});

test("网络是好的：提示条不出现（不许一直挂着吓人）", async (t) => {
  const ui = await boot(t, { net: "up" });
  const bar = ui.el("#netbar");
  assert.ok(!bar.classList.contains("on"), "网络正常时提示条不该显示");
  assert.equal(bar.getAttribute("aria-hidden"), "true", "隐藏的提示条要对读屏软件声明隐藏");
});

test("断网：墙上已经折好的东西一件都不许消失", async (t) => {
  const ui = await boot(t, { net: "up" });

  // 前提：内容真的读到了并且在界面上
  ui.intoDesk();
  await ui.settle();
  assert.ok(ui.text().includes(MY_ENTRY), "前提：自己那条留言在界面上");

  // 地铁进隧道
  ui.state.down = true;
  await ui.win.__t06.retry();
  await ui.settle();

  assert.ok(ui.text().includes(MY_ENTRY), "断网时墙上折好的东西被清空了 —— 这就是白屏的另一种写法");
  assert.ok(ui.el("#netbar").classList.contains("on"), "断网重试之后提示条没有出现");
  assert.equal(ui.win.__t06.S.me, "door", "断网不该把身份也一起丢掉");
  t.diagnostic(`断网后：身份 ${ui.win.__t06.S.me}、自己那条仍在、提示条在`);
});

test("断网：读失败不许退回设备时钟开门（fail closed）", async (t) => {
  const ui = await boot(t, { net: "up" });
  // 把**页面里的设备时钟**拨到开门之后：这一条必须在门开着的那一侧被证伪
  const RealDate = ui.win.Date;
  const before = RealDate.now();
  ui.win.Date.now = () => AT_UNLOCK + 60_000;
  t.after(() => { ui.win.Date.now = RealDate.now.bind(RealDate); });

  ui.state.down = true;
  await ui.win.__t06.retry();
  await ui.settle();

  assert.equal(ui.win.__t06.open(), false, "问不到服务端却按设备时钟判成开门了 —— 时间锁在这一刻作废");
  assert.equal(ui.win.__t06.S.unlocked, false, "S.unlocked 在问不到服务端时必须是 false");
  const text = ui.text();
  assert.ok(!text.includes("我 们 的 两 年"), "断网时把共同层的标题画出来了");
  assert.ok(!text.includes("已 开"), "断网时出现了「已开」字样");
  t.diagnostic(`设备时钟已拨到开门之后 60 秒，open() 仍为 ${ui.win.__t06.open()}（问不到 = 按没开）`);
});

test("会话真的没了（401）仍然要退出：断网的宽容不许顺带把鉴权也放宽", async (t) => {
  const ui = await boot(t, { net: "up" });
  ui.intoDesk();
  await ui.settle();
  assert.ok(ui.text().includes(MY_ENTRY), "前提：自己那条在界面上");

  // 服务端真的回话了，只是说会话没了 —— 与「压根没发出去」是两件事
  ui.win.fetch = async () => new Response(JSON.stringify({ error: "no_session" }), {
    status: 401, headers: { "content-type": "application/json" },
  });
  await ui.win.__t06.retry();
  await ui.settle();

  assert.equal(ui.win.__t06.S.profile, null, "会话没了却没有退出登录");
  assert.ok(!ui.text().includes(MY_ENTRY), "会话没了之后还在显示对方的布置台内容");
  t.diagnostic("401 → 退出会话；status 0 → 保留界面。两者没有混成一条路");
});

test("断网处理全程不新建定时器：全站仍然只有一个 setInterval", async (t) => {
  const ui = await boot(t, { net: "up" });
  assert.equal(ui.timers.interval, 1, "全站只应有一个 setInterval");
  ui.intoDesk();
  await ui.settle();
  ui.state.down = true;
  await ui.win.__t06.retry();
  for (let i = 0; i < 5; i++) ui.win.__t06.render();
  ui.win.dispatchEvent(new ui.win.Event("offline"));          // 断网事件
  await ui.settle();
  assert.equal(ui.timers.interval, 1, "断网提示或事件处理里又建了 setInterval");
});

test("浏览器报告断网：提示条立刻出现，不用等下一次请求失败", async (t) => {
  const ui = await boot(t, { net: "up" });
  assert.ok(!ui.el("#netbar").classList.contains("on"), "前提：此刻网络是好的");

  ui.win.dispatchEvent(new ui.win.Event("offline"));
  assert.ok(ui.el("#netbar").classList.contains("on"), "浏览器报了 offline，提示条却没有出现");
  t.diagnostic("offline 事件 → 提示条立刻出现");
});

test("提示条上的「重 试」：网络回来之后自己收起来", async (t) => {
  const ui = await boot(t, { net: "down" });
  assert.ok(ui.el("#netbar").classList.contains("on"), "前提：断网中，提示条在");

  ui.state.down = false;
  ui.click("#netbar .nb-retry");
  await ui.settle();

  assert.ok(!ui.el("#netbar").classList.contains("on"), "网络已经恢复，提示条还挂着");
  t.diagnostic("点「重 试」→ 重新读到内容 → 提示条收起来");
});
