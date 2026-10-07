/**
 * L3 真浏览器 E2E —— 两个**独立 profile** 的真 Chrome。
 *
 * 这一层专门验 jsdom 与 HTTP 层都验不到的东西：
 *   1. **同一浏览器里两个人的 session cookie 会互相覆盖。** jsdom 每个用例一个独立
 *      实例，永远撞不上这个；同源的第二个 tab 也共享 cookie，所以必须是两个进程、
 *      两个 --user-data-dir。
 *   2. **真实图片解码**。jsdom 没有解码器，<img> 永不 load —— 现有测试是显式派发
 *      error 事件模拟的。这里是真的把图解出来、量 naturalWidth/Height。
 *   3. **真实渲染**：阅读流到底出不出得来、照片是不是占位块。
 *
 * 判定仍然用**唯一标记法**：从服务端响应取标记，再在**真实 DOM 的 textContent**
 * 里点名。不看「界面上有某句话」——那种断言在任何内容下都恒真。
 *
 *   node scripts/e2e/browser.mjs --dir <种子目录>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app.js";
import { openDb } from "../../src/db.js";
import { UNLOCK_AT } from "../../src/clock.js";
import { TEST_SECRET, useTestSecrets } from "../../test/helpers.js";
import { launch, Page, sleep } from "../cdp-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const DIR = path.resolve(argOf("--dir", ""));
if (!DIR) { console.error("必须给 --dir <种子目录>"); process.exit(2); }

const M = JSON.parse(fs.readFileSync(path.join(DIR, "markers.json"), "utf8"));
/** 与下面 createApp 前注入的是同一批值 —— 两边不同源的话，红的是 401，离原因很远 */
const LOGIN = { door: TEST_SECRET.DOOR_PASSWORD, hero: TEST_SECRET.HERO_PASSWORD };
const OTHER = { door: "hero", hero: "door" };

const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass: !!pass, detail }); return !!pass; };

/* ── 一个角色 = 一个独立 Chrome 进程 ─────────────────────────── */
async function openRole(who, base, tmpRoot) {
  const userDataDir = path.join(tmpRoot, `profile-${who}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  const { proc, wsPath } = await launch({ userDataDir, windowSize: "390,844" });
  const page = await Page.attach(wsPath);
  await page.viewport({ width: 390, height: 844, mobile: true });
  await page.goto(base);
  // #app 要等 boot() 里那串 fetch 回来才画出来；goto 返回 ≠ 界面好了
  await page.waitFor(`document.querySelector('#app') && document.querySelector('#app').children.length > 0`,
                     { label: "首屏渲染" });
  return { who, proc, page, userDataDir };
}

const closeRole = async (r) => { try { r.page.close(); } catch {} try { r.proc.kill("SIGKILL"); } catch {} };

/* ── 走完一个角色的流程：选身份 → 输生日 → 进去 ────────────────────
   ⚠️ 登录成功之后落在哪一屏，**取决于开门状态**，别写死：
   开门后同一个入口直接变成阅读流（design.md / CONSTRAINTS §1），
   没开门才是布置台。早先这里只等 `.addbar`，结果开门态下**永远等不到**，
   而登录其实早就成功了 —— 失败信息只有一句「等不到 door 进布置台」，
   差点被当成密码错了。 */
async function walkIn(page, who) {
  await page.waitFor(`!!document.querySelector('[data-go="who"]')`, { label: `${who} 看到入口` });
  await page.eval(`document.querySelector('[data-go="who"]').click()`);
  await page.waitFor(`!!document.querySelector('[data-who="${who}"]')`, { label: `${who} 身份卡` });
  await page.eval(`document.querySelector('[data-who="${who}"]').click()`);
  await page.waitFor(`!!document.querySelector('#pin')`, { label: `${who} 密码页` });

  // 真敲键盘，不走后门。顺便量一下：输入框的 autocomplete 要是又变回 off 就报出来。
  const pin = LOGIN[who];
  const ac = await page.eval(`document.querySelector('#pin').getAttribute('autocomplete')`);
  ok(`浏览器 · ${who} 密码框 autocomplete=${ac}`, ac === "one-time-code", `实际 ${ac}`);
  await page.eval(`(() => { const el = document.querySelector('#pin'); el.value = ${JSON.stringify(pin)};
    el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
  await page.eval(`document.querySelector('[data-go="desk"]').click()`);

  try {
    await page.waitFor(`!!document.querySelector('.addbar') || !!document.querySelector('.rd-hero')`,
                       { label: `${who} 进门` });
  } catch (e) {
    const diag = await page.eval(`JSON.stringify({
      screen: document.querySelector('#app > .screen') ? document.querySelector('#app > .screen').className : null,
      pmsg: (document.querySelector('#pmsg')||{}).textContent || null,
      body: document.body.textContent.slice(0, 160)
    })`).catch((x) => `诊断本身失败：${x.message}`);
    throw new Error(`${e.message}\n    现场：${diag}`);
  }
  return await page.eval(`!!document.querySelector('.rd-hero')`);   // true = 直接进了阅读流
}

/* ── 观察者旁路 ──────────────────────────────────────────────────
   这一段专门补 jsdom 补不了的洞：jsdom 没有解码器，<img> 永远不 load，
   所以「照片真的显示出来了」在那一层只能验到 HTML 上有个 <img>。
   这里是**真把图解出来**，量 naturalWidth/Height —— 也就是这个旁路
   存在的唯一理由。判据是「解码出来的张数 = 双方 + 共同层的总数」，
   不是「有图就行」：少一张和全都没有，在只看 imgs.length 时长得一样。 */
async function runObserver(base, tmpRoot) {
  const OBSERVER_PIN = argOf("--observer-pin", TEST_SECRET.OBSERVER_PASSWORD);
  const userDataDir = path.join(tmpRoot, "profile-observer");
  fs.mkdirSync(userDataDir, { recursive: true });
  const { proc, wsPath } = await launch({ userDataDir, windowSize: "390,844" });
  const page = await Page.attach(wsPath);
  await page.viewport({ width: 390, height: 844, mobile: true });

  const url = `${base}/#observe`;
  await page.goto(url);
  await page.waitFor(`!!document.querySelector('#ob-pin')`, { label: "观察者凭据框出现" });
  ok("浏览器 · 观察者门出现（#observe 直接到凭据页，不经过选身份）",
     await page.eval(`!!document.querySelector('#ob-pin')`), "");

  // 错 PIN：要有话说，且**不能**因此放行
  await page.eval(`(() => { const el = document.querySelector('#ob-pin'); el.value = '0000';
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.eval(`document.querySelector('[data-ob="enter"]').click()`);
  await page.waitFor(`(document.querySelector('#ob-msg')||{}).textContent.trim().length > 0`,
                     { label: "错 PIN 有提示" });
  const msg = await page.eval(`(document.querySelector('#ob-msg')||{}).textContent || ''`);
  ok("浏览器 · 观察者错 PIN 显示服务端的话", msg.trim().length > 0, msg.slice(0, 40));
  ok("浏览器 · 错 PIN 之后**没有**进全貌",
     await page.eval(`!document.querySelector('.ob-side')`), "");

  // 对的 PIN
  await page.eval(`(() => { const el = document.querySelector('#ob-pin'); el.value = ${JSON.stringify(OBSERVER_PIN)};
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.eval(`document.querySelector('[data-ob="enter"]').click()`);
  await page.waitFor(`!!document.querySelector('.ob-side[data-side="door"]') && !!document.querySelector('.ob-side[data-side="hero"]')`,
                     { label: "观察者进得来且两边都在" });

  const otext = await page.eval(`document.body.textContent`);
  for (const who of ["door", "hero"]) {
    for (const k of ["letterMark", "tailMark", "capMark"]) {
      ok(`浏览器 · 观察者视图里有 ${who} 的 ${k}`, otext.includes(M[who][k]), M[who][k]);
    }
  }
  ok("浏览器 · 观察者视图里有共同层祝福语", otext.includes(M.shared.blessing), "");

  // 分侧归属：door 那栏不许出现 hero 的标记
  for (const [who, other] of Object.entries(OTHER)) {
    const side = await page.eval(`(document.querySelector('.ob-side[data-side="${who}"]')||{}).textContent || ''`);
    ok(`浏览器 · 观察者 ${who} 侧只含自己的标记`,
       side.includes(M[who].letterMark) && !side.includes(M[other].letterMark), "");
  }

  // --- 真解码：滚一遍，等全部 complete ---
  await page.eval(`(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 250));
  })()`);
  await page.waitFor(`Array.from(document.querySelectorAll('.ob-side .pframe img, .ob-shared .grid3 img'))
      .every(im => im.complete)`, { timeout: 25_000, label: "观察者视图图片全部加载完" });

  const oimgs = await page.eval(`(() => Array.from(document.querySelectorAll('.ob-side .pframe img, .ob-shared .grid3 img'))
    .map(im => ({ src: im.getAttribute('src'), nw: im.naturalWidth, nh: im.naturalHeight })))()`);
  const broken = oimgs.filter((i) => !i.nw || !i.nh);
  ok(`浏览器 · 观察者的照片全部真解码出来了（${oimgs.length} 张）`,
     oimgs.length > 0 && broken.length === 0,
     `未解码 ${broken.length} 张：${broken.map((b) => b.src).join(",")}`);

  // 张数对账：双方各 N 张 + 共同层 N 张，一张都不许少。
  // ⚠️ 下面那条 `> 0 && broken === 0` 只能分辨「**全都没传**」（0 张 → 红）。
  //    「传了 6 张、应该 7 张」它一律放行 —— 少一张和一张不少，在它眼里长得一样。
  //    真正拦住「少传」的是紧接着的 `=== wantCount`。
  //    （独立复审指出过：早先这里写的是「少传一张和全都没传长得一模一样」，前半句对、后半句错。）
  const wantCount = M.door.photoIds.length + M.hero.photoIds.length + M.shared.photoIds.length;
  ok(`浏览器 · 观察者看到双方 + 共同层共 ${wantCount} 张`,
     oimgs.length === wantCount, `实到 ${oimgs.length}`);

  const oids = oimgs.map((i) => (i.src || "").split("/").pop());
  const gotShared = oids.filter((id) => String(id).length).length;
  ok("浏览器 · 观察者看到的是**双方**的照片（不是只有一方）",
     M.door.photoIds.some((id) => oids.includes(id)) && M.hero.photoIds.some((id) => oids.includes(id)),
     `door=${M.door.photoIds.filter((id) => oids.includes(id)).length} hero=${M.hero.photoIds.filter((id) => oids.includes(id)).length} got=${gotShared}`);

  // 截图要在**出门之前**拍。早先放在最后，拍到的是「出门之后回到的普通入口」，
  // 一张自证观察者视图的图都没有 —— 而这一层恰恰是 jsdom 拍不了的。
  try { await page.shot(path.join(DIR, "browser-observer.png")); } catch {}
  console.error(`[e2e-browser] 观察者截图：${path.join(DIR, "browser-observer.png")}`);

  // 出门
  await page.eval(`document.querySelector('[data-ob="leave"]').click()`);
  await sleep(400);
  ok("浏览器 · 观察者出门后回到正常入口",
     await page.eval(`!document.querySelector('.ob-side') && !!document.querySelector('[data-go="who"]')`), "");
  ok("浏览器 · 出门后地址栏不再有 #observe",
     !(await page.eval(`location.hash`)).includes("observe"), await page.eval(`location.hash`));

  try { page.close(); } catch {}
  try { proc.kill("SIGKILL"); } catch {}
}

/* ── 主流程 ───────────────────────────────────────────────────── */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "two-years-chrome-"));
let server = null, db = null, roles = [];

/**
 * --base：指向一个**已经在跑**的实例，而不是自己起一个。
 *
 * 「本地跑通」与「线上跑通」要验的不是同一件事：本地过只说明代码逻辑对，
 * 线上还要过 sharp 的 Linux 原生模块、systemd 的写权限收紧、真实文件系统的
 * 700 目录、以及那份数据在另一台机器上被读出来的样子。浏览器层不接 --base
 * 的话，这一层在线上一次都跑不到。
 *
 * 注意：给了 --base 就不再 openDb —— 远端实例持有自己的库连接，
 * 本地再开一个会与之抢锁，而且那份库根本不是我们要验的那一份。
 */
const BASE = argOf("--base", null);
/**
 * 这一层要跑哪一段，由**实例真实的开门状态**决定，不由命令行开关决定。
 *
 * 早先只写了解封后那一段，于是把线上那个「锁着的」实例喂进来时，
 * 登录后两人落在布置台，接下来 20 条断言逐条红 —— 每一条都在说
 * 「这里该有对方的信却没有」，而真正的原因是**跑错了状态**。
 * 20 条红字会把人引到「线上数据没灌对」上去查，而那是对的。
 *
 * 现在：开门就跑阅读流那 29 条；锁着就跑布置台那几条（她必须能提前布置，
 * 10-5 当天才不用手忙脚乱 —— 这本身就是要验的东西）；观察者那一段两种状态都跑。
 */
let remoteUnlocked = null;
try {
  let base;
  if (BASE) {
    base = BASE.replace(/\/+$/, "");
    const probe = await fetch(`${base}/api/status`);
    if (!probe.ok) throw new Error(`${base}/api/status 返 ${probe.status}`);
    const st = await probe.json();
    remoteUnlocked = !!st.unlocked;
    console.error(`[e2e-browser] 两个独立 Chrome，指向既有实例 ${base}（unlocked=${st.unlocked}）`);
  } else {
    // 口令必须在 createApp 之前注入：src/auth.js 与 src/observer-auth.js 没有缺省值了。
    useTestSecrets();
    db = openDb(M.db);
    const app = createApp({ db, now: () => UNLOCK_AT + 60_000, dataDir: path.dirname(M.db) });   // 已开门
    server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    console.error(`[e2e-browser] 两个独立 Chrome，服务在 ${base}`);
  }

  const canRead = remoteUnlocked === null ? true : remoteUnlocked === true;

  if (canRead) {
  // 两个人**同时**在场：不是串行退出再换人
  for (const who of ["door", "hero"]) roles.push(await openRole(who, base, tmpRoot));
  ok("两个独立 profile 的 Chrome 都起来了", roles.length === 2, `n=${roles.length}`);

  // 两人**同时**在场：不是串行退出再换人
  const landed = [];
  for (const r of roles) landed.push(await walkIn(r.page, r.who));
  ok("两人登录后都直接进了阅读流（开门后同一个入口就是阅读流）", landed.every(Boolean), JSON.stringify(landed));

  const seen = {};
  for (const r of roles) {
    const { who, page } = r;
    const other = OTHER[who];

    // 真 DOM 的 textContent，不是接口返回
    const rtext = await page.eval(`document.body.textContent`);

    // --- 对方的东西必须在 ---
    for (const k of ["letterMark", "tailMark", "capMark"]) {
      ok(`浏览器 · ${who} 阅读流里有对方的 ${k}`, rtext.includes(M[other][k]), M[other][k]);
    }

    // --- 自己的东西必须不在「TA留给你的」里 ---
    // 判据只取那一段的 textContent：整页里出现自己的**约定**是对的
    // （约定区本来就并排显示两条），所以不能拿整页当判据。
    const giftText = await page.eval(`(() => {
      const h = Array.from(document.querySelectorAll('.kicker, h1'))
        .find(x => x.textContent.includes('给') && x.textContent.includes('你'));
      if (!h) return '';
      const sec = h.closest('.rd-hero') || h.parentElement;
      const rest = h.parentElement.parentElement;
      return (rest ? rest.textContent : sec.textContent);
    })()`);
    ok(`浏览器 · ${who} 取到了「TA留给你的」那一段（判据非空）`, giftText.length > 0, `len=${giftText.length}`);
    for (const k of ["letterMark", "tailMark", "capMark"]) {
      ok(`浏览器 · ${who}「TA留给你的」里没有自己的 ${k}`, !giftText.includes(M[who][k]), M[who][k]);
    }

    // 共同层
    ok(`浏览器 · ${who} 阅读流里有共同层祝福语`, rtext.includes(M.shared.blessing), "");

    // 约定：两条都在
    ok(`浏览器 · ${who} 阅读流里有自己的约定`, rtext.includes(M[who].wishMark), M[who].wishMark);
    ok(`浏览器 · ${who} 阅读流里有对方的约定`, rtext.includes(M[other].wishMark), M[other].wishMark);

    // --- 真实图片解码：不能是占位块 ---
    // ⚠️ 必须**先滚一遍**。照片是 loading="lazy"，不滚到它就压根不发请求，
    // naturalWidth 恒为 0 —— 于是「未解码」会被误当成「图坏了」。
    // 真实用户会滚，测试也得滚。
    await page.eval(`(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 200));
    })()`);
    await page.waitFor(`Array.from(document.querySelectorAll('.wall .pframe img, .grid3 img'))
        .every(im => im.complete)`, { timeout: 25_000, label: `${who} 图片全部加载完` });

    const imgs = await page.eval(`(() => Array.from(document.querySelectorAll('.wall .pframe img, .grid3 img'))
      .map(im => ({ src: im.getAttribute('src'), nw: im.naturalWidth, nh: im.naturalHeight })))()`);
    const broken = imgs.filter((i) => !i.nw || !i.nh);
    ok(`浏览器 · ${who} 的照片全部真解码出来了（${imgs.length} 张）`, imgs.length > 0 && broken.length === 0,
       `共 ${imgs.length} 张，未解码 ${broken.length} 张：${broken.map((b) => b.src).join(",")}`);

    // 取到的必须正是**对方**那几张，一张自己的都不许混进来
    const want = new Set(M[other].photoIds);
    const gotIds = imgs.map((i) => (i.src || "").split("/").pop());
    const ownLeak = gotIds.filter((id) => M[who].photoIds.includes(id));
    ok(`浏览器 · ${who} 读到的照片里没有自己那几张`, ownLeak.length === 0, `混入自己的：${ownLeak.join(",")}`);
    const gotWant = gotIds.filter((id) => want.has(id));
    ok(`浏览器 · ${who} 读到了对方的 ${want.size} 张照片`, gotWant.length === want.size, `实到 ${gotWant.length}`);

    seen[who] = { imgs: imgs.length, giftLen: giftText.length };
  }

  // 两个页面**同时**在场时，各自的会话没被对方顶掉
  const stillDesk = await Promise.all(roles.map(async (r) => {
    const t = await r.page.eval(`!!document.querySelector('.rd-hero')`);
    return r.who === "door" ? t : t;
  }));
  ok("两个会话互不干扰（cookie 没有互相顶掉）", stillDesk.every(Boolean), JSON.stringify(stillDesk));

  } else {
    /* ---- 解封前：布置台。她必须能提前把东西折好，10-5 当天才不用手忙脚乱。 ----
       判据与阅读流那段方向相反：这里**该**只看得到自己的。
       早先这一段根本不存在，于是锁着跑时只会得到 20 条「应该有对方的信却没有」，
       而那句话在解封前是对的 —— 用错方向的断言量一个正确的行为。 */
    for (const who of ["door", "hero"]) roles.push(await openRole(who, base, tmpRoot));
    ok("解封前 · 两个独立 profile 的 Chrome 都起来了", roles.length === 2, `n=${roles.length}`);

    const landed = [];
    for (const r of roles) landed.push(await walkIn(r.page, r.who));
    ok("解封前 · 两人登录后都落在布置台（不是阅读流）", landed.every((x) => x === false), JSON.stringify(landed));

    for (const r of roles) {
      const { who, page } = r;
      const other = OTHER[who];
      await page.waitFor(`!!document.querySelector('.addbar')`, { label: `${who} 看到布置台` });
      const t = await page.eval(`document.body.textContent`);

      // 自己的必须在
      for (const k of ["letterMark", "tailMark", "capMark"]) {
        ok(`解封前 · ${who} 布置台上有自己的 ${k}`, t.includes(M[who][k]), M[who][k]);
      }
      // 对方的一条都不许出现 —— 这是解封前最要紧的那条
      for (const k of ["letterMark", "tailMark", "capMark"]) {
        ok(`解封前 · ${who} 布置台上**没有**对方的 ${k}`, !t.includes(M[other][k]), M[other][k]);
      }

      // 自己的照片能真解码（她得看见自己折好了什么）
      await page.eval(`(async () => {
        const step = window.innerHeight;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120));
        }
        window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 250));
      })()`);
      await page.waitFor(`Array.from(document.querySelectorAll('.wall .pframe img')).every(im => im.complete)`,
                         { timeout: 25_000, label: `${who} 布置台图片加载完` });
      const imgs = await page.eval(`(() => Array.from(document.querySelectorAll('.wall .pframe img'))
        .map(im => ({ src: im.getAttribute('src'), nw: im.naturalWidth })))()`);
      const broken = imgs.filter((i) => !i.nw);
      ok(`解封前 · ${who} 自己的照片全部真解码（${imgs.length} 张）`,
         imgs.length > 0 && broken.length === 0, `未解码 ${broken.length} 张`);
      const ids = imgs.map((i) => (i.src || "").split("/").pop());
      ok(`解封前 · ${who} 布置台上**没有**对方的照片`,
         M[other].photoIds.every((id) => !ids.includes(id)), "");
    }
  }

  // ── 观察者旁路：第三个独立 profile 的真 Chrome ──────────────────
  // 单开一个 profile，而不是复用上面两个之一：那一层验的正是
  // 「同源 cookie 会不会互相顶掉」，拿它顺手验旁路会把两件事搅在一起。
  // 它也**不受开门状态影响** —— 旁路绕的就是时间锁，这正是它的用途。
  await runObserver(base, tmpRoot);

  // 截图留证（不进 git）
  for (const r of roles) {
    const f = path.join(DIR, `browser-${r.who}.png`);
    try { await r.page.shot(f); } catch {}
  }
  console.error(`[e2e-browser] 截图：${path.join(DIR, "browser-door.png")} / browser-hero.png`);
} finally {
  for (const r of roles) await closeRole(r);
  if (server) await new Promise((res) => server.close(res));
  if (db) db.close();
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
fs.writeFileSync(path.join(DIR, "report-browser.json"), JSON.stringify({ total: results.length, pass, fail, results }, null, 2), "utf8");
for (const r of results) if (!r.pass) console.log(`✖ ${r.name}  ${r.detail}`);
console.log(`\n真浏览器 E2E：${pass}/${results.length} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
