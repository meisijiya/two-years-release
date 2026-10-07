/**
 * document 级 click 委托：target 不保证是 Element
 *
 * 缺陷：两条 document.addEventListener("click", …) 直接写 `e.target.closest(...)`，
 * 没先问一句 e.target 是不是 Element。按 DOM 规范，click 的 target **可以不是** Element：
 * 在 document 上派一个 click，target 就是 document 这个 Document 节点，它没有 .closest，
 * 处理函数当场 TypeError —— 排在同一条链后面的监听器也一起被带走。
 *
 * 判据不止「没抛」。把整条处理函数删掉，或者在守卫里写 `if (!e.target.closest) return;`
 * 一笔带过（= 遇到不认识的目标就什么都不做），同样不抛；但放大层从此再也不
 * 「点画框外空白处关闭」。所以每条用例都同时断一个**看得见的行为**，
 * 并且正例（正常元素点击照旧走同一条委托）也钉住，免得守卫把整条路关掉。
 *
 * 取证通道：监听函数里抛的异常**不会**顺着 dispatchEvent 冒回调用方
 * （实测 dispatchEvent 返回 true，照样是 TypeError），jsdom 把它报给
 * virtualConsole 的 jsdomError。所以"没抛"只能从那儿读 —— 而这条通道本身
 * 也得先被验过（第一条用例），否则一个失灵的通道会让下面两条永远绿着。
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

const ROUTES = {
  "GET /api/me": ME_IN,
  "GET /api/entry": LIST,
  "GET /api/shared": { ...SHARED, body: { ...SHARED.body, photos: SHOTS } },
  "GET /api/wish": WISH,
};

/** 装一个页面，**顺手接住 jsdom 里冒出来的异常**（这批用例的全部取证都靠它）。 */
async function mount({ unlocked = false } = {}) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errs.push(e));
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: vc,
    beforeParse(w) {
      w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      w.HTMLMediaElement.prototype.pause = function () {};
      const ls = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
      Object.defineProperty(w, "localStorage", { value: ls, configurable: true });
      w.fetch = async (url, init = {}) => {
        const key = `${(init.method || "GET").toUpperCase()} ${url}`;
        const r = key === "GET /api/status" ? STATUS(unlocked) : ROUTES[key];
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
  return { dom, doc: dom.window.document, win: dom.window, errs };
}

const boot = async (t, opts) => {
  const m = await mount(opts);
  t.after(() => m.dom.window.close());
  return { ...m, api: () => m.win.__t08, lb: () => m.win.__t04.LB };
};

/** 只认「监听函数里冒出来的异常」这一类。
    取图失败之类会报同一类事件，与这条缺陷无关，不该算进账里。 */
const unhandled = (errs) => errs.filter((e) => e.type === "unhandled-exception" || /^Uncaught \[/.test(String(e.message)));

/** 把话摊开写进断言消息：光一个数字看不出是哪一行崩的。 */
const say = (errs) => unhandled(errs).map((e) => String(e.message || e)).join(" ‖ ") || "（一条也没有）";

/** 在 document 上派一个 click：它的 target 就是 document —— **Document 不是 Element**。
    正经浏览器里手指点不到它，但一次合成事件（扩展开一条、另一个脚本派一条）就够。 */
const clickOnDocument = (win) => win.document.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

/** 派一次非 Element 目标的 click，只对**这一次**负责：启动期自己的噪音不算账。 */
const strayClick = async (ui) => {
  ui.errs.length = 0;
  clickOnDocument(ui.win);
  await new Promise((r) => setTimeout(r, 0));
  return ui.errs;
};

/* ══════════════════════════════════════════════════════════════════ */

test("取证通道自检：一个必抛的监听器，用例必须看得见它", async (t) => {
  const ui = await boot(t);
  ui.doc.addEventListener("click", () => { throw new TypeError("PROBE-CANARY closest is not a function"); });
  ui.errs.length = 0;
  clickOnDocument(ui.win);
  await new Promise((r) => setTimeout(r, 0));
  // 下面两条用例的判据是「一个都没冒出来」。这条钉住的是另一头：
  // 通道要是坏了，它们会**恒绿** —— 所以这里必须真看得见这只金丝雀。
  const canaries = unhandled(ui.errs).filter((e) => /PROBE-CANARY/.test(String(e.message)));
  assert.equal(canaries.length, 1,
    `装了一个必抛的监听器，却只收到 ${canaries.length} 只金丝雀：${say(ui.errs)}\n` +
    `这条用例是下面两条的地基：通道失灵会让「一个都没冒出来」永远成立。`);
  assert.match(String(canaries[0].message), /^Uncaught \[/,
    `金丝雀走的不是 unhandled-exception 那条通道：${say(ui.errs)}`);
});

test("screen 委托：target 不是 Element 的 click 不许把处理函数打崩", async (t) => {
  const ui = await boot(t);
  const S = ui.api().S;
  assert.equal(S.screen, "seal", "开机应当落在封印页 —— 这条用例的前置条件没造出来");

  const errs = await strayClick(ui);
  assert.equal(unhandled(errs).length, 0,
    `在 document 上派一个 click 就崩了：${say(errs)}\n` +
    `委托的 target 不保证是 Element（document 自己就没有 .closest），` +
    `这里得先问一句，而不是直接 e.target.closest(...)`);
  // 看得见的行为：认不出目标就该跟"没点到任何东西"一样，画面一步都不许动
  assert.equal(S.screen, "seal", `这一下把界面带到了 ${S.screen} —— 认不出目标时该当没发生`);
});

test("正例：守卫不是把委托关掉 —— 挨过那一下之后，正常元素点击照旧走同一条路", async (t) => {
  const ui = await boot(t);
  const S = ui.api().S;
  const go = ui.doc.querySelector("[data-go]");
  assert.ok(go, "封印页上应当有 [data-go] 那颗按钮 —— 这条用例的前置条件没造出来");
  assert.equal(S.screen, "seal", "这条用例是从封印页上起手的");

  const errs = await strayClick(ui);
  assert.equal(unhandled(errs).length, 0, `非 Element 的目标不该崩：${say(errs)}`);

  go.dispatchEvent(new ui.win.MouseEvent("click", { bubbles: true }));
  assert.equal(S.screen, "desk",
    `挨过那一下之后，正常点击反而不走了（停在了 ${S.screen}）—— 守卫把委托关掉了`);
});

test("放大层委托：认不出 target 时不许崩，且仍要「点画框外空白处关闭」", async (t) => {
  // 共同层只在开门后才拉（load() 里 `S.shared = open() ? … : null`），
  // 没照片就没有放大层可开 —— 这条用例得从开门那份数据起手
  const ui = await boot(t, { unlocked: true });
  await ui.win.__t06.load();                    // 拉一次共同层，九张进来（load 只在 __t06 上）
  ui.win.__t04.openLB(0);
  assert.equal(ui.lb().on, true, "放大层没打开 —— 这条用例的前置条件没造出来");

  const errs = await strayClick(ui);
  assert.equal(unhandled(errs).length, 0,
    `在 document 上派一个 click 就崩了：${say(errs)}\n` +
    `放大层那条委托同样先得问一句 e.target 是不是 Element。`);
  // 看得见的行为：document 显然不在 .lb-frame 里，所以这一下**该关掉**放大层。
  // 写成「认不出 target 就直接 return」的懒守卫会让它一直开着 —— 这条断的就是那个。
  assert.equal(ui.lb().on, false, "认不出 target 就直接 return 了 —— 点画框外空白处关不掉了");
  assert.equal(ui.doc.querySelector("#lb").classList.contains("on"), false, "放大层还开着");
});
