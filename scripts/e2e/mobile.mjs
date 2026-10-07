/**
 * L3 手机尺寸专项 —— 390×844 + 触摸（scripts/e2e/mobile.mjs）
 *
 * browser.mjs 已经在 390×844 / mobile:true 下跑，但它验的是**内容**：
 * 谁的字、谁的图、开门落在哪一屏。这一层验的是**手机适配本身**——
 * 那些只有在真排版引擎里才存在、jsdom 与 HTTP 层根本没有的东西：
 *
 *   1. **横向溢出**：屏幕上出现左右拖不动的空白，手机上等于「进不去」。
 *   2. **触控目标**：手指点不准。判据分两级——24px 是 WCAG 2.2 AA 的硬下限
 *      （不过就红），44px 是手指舒服的尺寸（只报不拦，因为文字链接天然达不到）。
 *   3. **固定元素压住可点内容**：收纳把手是 fixed，它挡的东西**点不到**。
 *      硬判据是「把手不盖住任何可点元素的中心点」，面积只报不拦。
 *   4. **本轮新加的交互**：收纳展开/收起、音乐开关、退出、布置台引导、
 *      撤回=真删（含**盘上文件真的没了**）、九宫格破图重试。
 *      这六项在 browser.mjs 里一条断言都没有 —— 它们只在 jsdom 里被验过。
 *   5. **console 干净**：真机页面上的 error/warning 一个都不该有。
 *
 * 为什么要独立一层而不是塞进 browser.mjs：browser.mjs 的判定法是
 * 「唯一标记法」（种一个只有这一轮才有的标记，再在 DOM 里点名），
 * 那套方法验不了「这个元素有没有被压住」「这个目标够不够大」——
 * 后者要的是几何，不是内容。
 *
 *   node scripts/e2e/mobile.mjs --dir <种子目录> [--base <既有实例>] [--observer-pin 00030303]
 *
 * 开门状态**由被测实例决定**（/api/status），不由命令行开关决定：
 * 开着就跑阅读流那一段，锁着就跑布置台那一段。给 --base 时不碰本地库。
 * 自建实例时同一个进程里翻时钟（now 是每请求求值的），两段都能跑到。
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

const DIR = path.resolve(argOf("--dir", ""));
if (!DIR) { console.error("必须给 --dir <种子目录>"); process.exit(2); }
const M = JSON.parse(fs.readFileSync(path.join(DIR, "markers.json"), "utf8"));
/** 与下面 createApp 前注入的是同一批值 —— 两边不同源的话，红的是 401，离原因很远 */
const LOGIN = { door: TEST_SECRET.DOOR_PASSWORD, hero: TEST_SECRET.HERO_PASSWORD };
const OBSERVER_PIN = argOf("--observer-pin", TEST_SECRET.OBSERVER_PASSWORD);

/** 手机基准视口。与 browser.mjs 同值，别各写一个。 */
const VW = 390, VH = 844;
/** WCAG 2.2 AA Target Size (Minimum)：24×24 CSS px。低于这个数就是红。 */
const TAP_FLOOR = 24;
/** 手指舒服的下限（Apple 44 / Material 48）。只报不拦。 */
const TAP_COMFY = 44;

const results = [];
const findings = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass: !!pass, detail }); return !!pass; };
const note = (scope, text) => { findings.push({ scope, text }); console.log(`  · ${scope} · ${text}`); };

/* ══ 页面里跑的函数：一律 fn.toString() 注入 ═══════════════════════
   不拼字符串 —— 拼接出来的表达式里每多一个引号、一次转义，
   就是一个「锚点找不到 / 页面里报错」等着你，而那种报错不看源码猜不出来。 */

const AUDIT = () => {
  const de = document.documentElement;
  const vw = window.innerWidth;
  const name = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const sel = "button, a, input, [role=button], [data-go], [data-who], [data-add], [data-del], " +
              "[data-cap], [data-edit], [data-cancel], [data-logout], [data-pick], [data-ob], [data-net-retry]";
  const overshoot = [], small = [], taps = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      // 装饰出血不算缺陷：贴纸熊、拍立得本来就故意挂到边外（bub/polaroid 都写 alt=""），
      // 真正要拦的是**带文字或能点**的东西越界 —— 那种会被切掉或永远点不到。
      const deco = el.tagName === "IMG" && el.getAttribute("alt") === "" &&
                   (el.textContent || "").trim() === "";
      const clickable = el.matches("button, a, input, [role=button]") ||
                        !!el.closest("button, a, [role=button]");
      const carries = (el.textContent || "").trim().length > 0;
      overshoot.push({
        el: name(el), left: Math.round(r.left), right: Math.round(r.right),
        hard: !deco && (clickable || carries),
      });
    }
  }
  overshoot.sort((a, b) => (b.hard ? 1 : 0) - (a.hard ? 1 : 0));
  for (const el of document.querySelectorAll(sel)) {
    if (el.disabled) continue;
    if (el.tagName === "INPUT" && el.type === "hidden") continue;   // 文件选择框本体不可见
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;      // hidden / display:none
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;
    const rec = {
      el: name(el), w: Math.round(r.width), h: Math.round(r.height),
      cx: r.left + r.width / 2, cy: r.top + r.height / 2, min: Math.min(r.width, r.height),
    };
    taps.push(rec);
    if (rec.min < TAP_FLOOR_FLOOR) small.push(rec);
  }
  return {
    vw, vh: window.innerHeight, dpr: window.devicePixelRatio,
    docScrollW: de.scrollWidth, bodyScrollW: document.body.scrollWidth,
    scrollH: de.scrollHeight,
    viewportMeta: (document.querySelector('meta[name="viewport"]') || {}).content || null,
    overshoot: overshoot.slice(0, 12),
    overshootN: overshoot.length,
    overshootHardN: overshoot.filter((o) => o.hard).length,
    small, taps,
  };
};

const OVERLAP = () => {
  const tab = document.querySelector("#dw-tab");
  if (!tab) return { hasTab: false, items: [] };
  const t = tab.getBoundingClientRect();
  const name = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const da = el.dataset || {};
    const data = da.go ? `[data-go=${da.go}]` : da.add ? `[data-add=${da.add}]`
             : da.del ? `[data-del]` : da.logout ? "[data-logout]" : "";
    return el.tagName.toLowerCase() + id + cls + data;
  };
  const sel = "button, a, input[type=file], [role=button], [data-add], [data-del], [data-go], " +
              "[data-who], [data-logout], [data-pick], [data-ob], [data-net-retry]";
  const items = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest("#dw")) continue;                    // 收纳自己的面板不算被自己挡
    if (el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // fixed 要**连祖先一起查**：添加栏那个按钮自己是 static，fixed 的是它的父 .addbar。
    // 只看元素本身会把它当成「随滚动移动」，于是算出一个滚动档位上的假重叠 ——
    // 而它固定在视口底部（y≈730~844），跟把手那条带（585~681）压根不碰。
    let fixedLike = false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).position === "fixed") { fixedLike = true; break; }
    }
    items.push({
      el: name(el),
      left: r.left, right: r.right, w: r.width, h: r.height,
      // 文档坐标：滚动时随之移动的元素要换算成 docY 才能算「滚到哪一档会撞上」
      docTop: r.top + window.scrollY,
      fixed: fixedLike,
    });
  }
  return {
    hasTab: true,
    band: { top: t.top, bottom: t.bottom, left: t.left, right: t.right,
            w: t.width, h: t.height },
    scrollMax: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    items,
  };
};

/**
 * 收纳把手压到了谁 —— **解析式，不采样**。
 *
 * 早先在六个滚动位置采样，得出「只有首屏有 217px²，其余全 0」。
 * 那是**采样漏掉了元素从把手带里经过的那几帧**，不是真的没有：把手是 fixed、
 * 内容在滚，任何全宽元素滚过去都会从它底下过一遍。采样点再密也只是逼近。
 *
 * 这里直接算：把手带在视口 y∈[top,bottom] 固定不动，元素在文档 y∈[docTop, docTop+h]
 * 随滚动平移，于是「滚到 s 时竖向相交」等价于
 *   s ∈ [docTop - bandBottom, docTop + h - bandTop]
 * 与 [0, scrollMax] 有交集时，**最坏竖向重叠 = min(bandH, h)**（能把它整个罩进带里就罩全）。
 * fixed 元素不随滚动走，直接按当前视口位置算。
 * 这个式子对每个元素给出的是**上确界**，不是抽样。
 */
function analyzeOverlap(raw, scope) {
  if (!raw.hasTab) { ok(`${scope} · 收纳把手在场`, false, "页面上没有 #dw-tab"); return null; }
  const { band, scrollMax, items } = raw;
  const hitW = (it) => Math.max(0, Math.min(band.right, it.right) - Math.max(band.left, it.left));
  const rows = [];
  for (const it of items) {
    const w = hitW(it);
    if (w <= 0) continue;
    const cx = (it.left + it.right) / 2;
    const centerCovered = cx >= band.left && cx <= band.right;
    if (it.fixed) {
      // 不随滚动移动：只在它当下真的落在带里时才算
      const inBand = Math.max(0, Math.min(band.bottom, it.docTop + it.h) - Math.max(band.top, it.docTop));
      if (inBand <= 0) continue;
      rows.push({ el: it.el, area: Math.round(w * inBand), centerCovered, at: "fixed", h: Math.round(inBand) });
    } else {
      const sMin = Math.max(0, it.docTop - band.bottom);
      const sMax = Math.min(scrollMax, it.docTop + it.h - band.top);
      if (sMin > sMax) continue;                        // 滚遍全程都碰不到那条带
      const h = Math.min(band.h, it.h);
      rows.push({ el: it.el, area: Math.round(w * h), centerCovered,
                  at: `滚到 ${Math.round(sMin)}~${Math.round(sMax)}px 时`, h: Math.round(h) });
    }
  }
  const covered = rows.filter((r) => r.centerCovered);
  ok(`${scope} · 整个滚动范围内，收纳把手都没盖住任何可点元素的正中心`, covered.length === 0,
     covered.map((c) => `${c.el}（${c.at}）`).join("；"));

  // ⚠️ 2026-10-04：**零重叠不再作为硬门禁。**
  // 当初零重叠是硬门禁，靠的是 style.css 里那条窄屏 @media（.col 让开 --tap）——
  // 它存在的理由正是「九宫格每格右侧被压掉 28px，点那一块打开的是把手而不是照片」。
  // 用户随后明确改了主意：**正文保持居中，不为了给收纳腾位置把整列左移**
  // （收纳盖住一点内容可以接受，内容本来就能上下滑动查看）。那条 @media 因此删掉了。
  //
  // 所以现在只保证**正中心**不被盖（上面那条仍是硬门禁）：点的位置还是内容自己。
  // 丢掉的是最右一列右边缘那条约 28px —— 那里点下去开的是收纳。
  // 这条仍然量、仍然报，只是从「必须为 0」降级成「记录事实」。
  const worst = rows.reduce((a, b) => (b.area > (a?.area ?? 0) ? b : a), null);
  if (worst) {
    note(scope, `滚动全程最坏重叠 ${worst.area}px²：${worst.el}（${worst.at}，竖向压 ${worst.h}px）` +
      (rows.length > 1 ? `；另有 ${rows.length - 1} 个可点元素也会经过` : ""));
  } else {
    note(scope, "滚动全程零重叠（把手带内没有任何可点元素）");
  }
  return { band, scrollMax, rows, worst };
}


/* ══ 工具 ══════════════════════════════════════════════════════════ */

function attachConsole(page) {
  const bucket = { errors: [], warnings: [] };
  const short = (a) => (a.map ? a.map((x) => x.value ?? x.description ?? x.type).join(" ") : "");
  page.on("Runtime.consoleAPICalled", (p) => {
    const line = short(p.args).slice(0, 160);
    if (p.type === "error") bucket.errors.push(`console.error: ${line}`);
    else if (p.type === "warning") bucket.warnings.push(`console.warn: ${line}`);
  });
  page.on("Runtime.exceptionThrown", (p) => {
    const d = p.exceptionDetails;
    bucket.errors.push(`未捕获异常: ${d.exception?.description || d.text}`.slice(0, 200));
  });
  return bucket;
}

/** 真手指：CDP 的 touch 事件，不是 el.click()。
 *  el.click() 绕过了 touch 事件链，验不出「手机上点不动」这类问题。 */
async function tap(page, selector, { nth = 0, label = selector, needBox = false } = {}) {
  const found = await page.eval(`(() => {
    const l = document.querySelectorAll(${JSON.stringify(selector)});
    const el = l[${nth}];
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    return { n: l.length };
  })()`).catch(() => null);
  if (!found) return { tapped: false, why: `页面上没有 ${label}` };
  await sleep(140);                                        // 等滚动落定，否则取到的是旧坐标
  const box = await page.eval(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`).catch(() => null);
  if (!box) return { tapped: false, why: `${label} 取不到坐标` };
  if (box.w === 0 || box.h === 0) return { tapped: false, why: `${label} 尺寸 0×0（不可见）` };
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y, id: 1 }] });
  await sleep(50);
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(180);
  if (needBox) return { tapped: true, box };
  return { tapped: true, box };
}

async function launchAttach(userDataDir, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    let proc = null;
    try {
      const l = await launch({ userDataDir, windowSize: `${VW},${VH}` });
      proc = l.proc;
      const page = await Page.attach(l.wsPath);
      return { proc, page };
    } catch (e) {
      last = e;
      try { proc?.kill("SIGKILL"); } catch {}
      // 一轮要连开六七个 Chrome，前一个还没退干净下一个就起不来（Windows 上尤其明显）：
      // 报出来的是「连不上 ws://…/devtools/browser/…」，看着像页面挂了，其实是浏览器没活着。
      await sleep(1200 + i * 1200);
    }
  }
  throw new Error(`起 Chrome 试了 ${tries} 次都不行：${last?.message || last}`);
}

async function openRole(who, base, tmpRoot, { blockedUrls = [] } = {}) {
  const userDataDir = path.join(tmpRoot, `mprofile-${who}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  const { proc, page } = await launchAttach(userDataDir);
  const con = attachConsole(page);
  await page.viewport({ width: VW, height: VH, mobile: true });
  if (blockedUrls.length) {
    await page.send("Network.enable");
    await page.send("Network.setBlockedURLs", { urls: blockedUrls });
  }
  await page.goto(base);
  await page.waitFor(`document.querySelector('#app') && document.querySelector('#app').children.length > 0`,
                     { label: "首屏渲染" });
  return { who, proc, page, con, userDataDir };
}
const closeRole = async (r) => { try { r.page.close(); } catch {} try { r.proc.kill("SIGKILL"); } catch {} };

/**
 * 重载当前页。**不能用 goto 同一个 URL 代替**：
 * 地址完全一样时 Chrome 不发 Page.loadEventFired，goto() 就在 once() 上
 * 死等 20 秒然后抛「等不到事件」—— 表现得像页面挂了，其实是根本没导航。
 */
async function reload(page) {
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.reload", { ignoreCache: false });
  await loaded;
}

/**
 * 逐个滚动位置量收纳把手压到了谁。
 *
 * 为什么不能只量 scroll=0：把手是 **fixed**，内容是滚动的 —— 滚下去之后，
 * 任何全宽元素都会从它底下经过。只量首屏会得出「阅读流零重叠、布置台 217px²」
 * 这种**看起来没事**的结论，而那句话只对首屏成立。
 * 早先手动测过一次，滚到九宫格段与约定收尾段分别压了 1129px² 与 1957px² ——
 * 同一屏，scroll=0 是零。判据必须跟着内容走，不能跟着「打开时的样子」走。
 *
 * 判据分两级：把手**不盖住任何可点元素的正中心**是硬门禁；
 * 面积与被压元素清单只报不拦（边缘压住几像素是取舍，不是缺陷）。
 */
async function sweepOverlap(page, scope) {
  return analyzeOverlap(await page.eval(`(${OVERLAP.toString()})()`), scope);
}

async function guard(scope, fn) {
  try { return await fn(); }
  catch (e) { ok(`${scope} · 这一段跑完了`, false, String(e.message).split("\n")[0].slice(0, 220)); return null; }
}

async function walkIn(page, who) {
  await page.waitFor(`!!document.querySelector('[data-go="who"]')`, { label: `${who} 看到入口` });
  await tap(page, '[data-go="who"]', { label: "入口按钮" });
  await page.waitFor(`!!document.querySelector('[data-who="${who}"]')`, { label: `${who} 身份卡` });
  await tap(page, `[data-who="${who}"]`, { label: `${who} 身份卡` });
  await page.waitFor(`!!document.querySelector('#pin')`, { label: `${who} 密码页` });
  await page.eval(`(() => { const el = document.querySelector('#pin'); el.value = ${JSON.stringify(LOGIN[who])};
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await tap(page, '[data-go="desk"]', { label: "进门按钮" });
  await page.waitFor(`!!document.querySelector('.addbar') || !!document.querySelector('.rd-hero')`,
                     { label: `${who} 进门` });
}

async function auditScreen(page, scope) {
  // 页面里那个函数用不了模块常量：TAP_FLOOR 得按名字喂进去，不能指望闭包带过去
  const raw = await page.eval(`(() => {
    const TAP_FLOOR_FLOOR = ${TAP_FLOOR};
    return (${AUDIT.toString()})();
  })()`);
  const hScroll = raw.docScrollW > raw.vw + 1 || raw.bodyScrollW > raw.vw + 1;
  ok(`${scope} · 没有横向滚动（scrollWidth ${raw.docScrollW} ≤ ${raw.vw}）`, !hScroll,
     hScroll ? `documentElement=${raw.docScrollW} body=${raw.bodyScrollW} 视口=${raw.vw}` : "");
  ok(`${scope} · 没有带文字/可点的东西越出右缘`, raw.overshootHardN === 0,
     raw.overshoot.filter((o) => o.hard).map((o) => `${o.el}[${o.left},${o.right}]`).join(" "));
  const deco = raw.overshoot.filter((o) => !o.hard);
  if (deco.length) note(scope, `${deco.length} 个装饰件故意挂到边外（alt="" 的贴纸/熊，不算缺陷）：` +
    deco.slice(0, 4).map((o) => o.el).join("、"));
  ok(`${scope} · viewport meta 是 width=device-width`,
     /width\s*=\s*device-width/.test(raw.viewportMeta || ""), String(raw.viewportMeta));
  ok(`${scope} · 视口真的是 ${VW}×${VH}（emulate 生效）`,
     raw.vw === VW && raw.vh === VH, `实到 ${raw.vw}×${raw.vh} dpr=${raw.dpr}`);
  ok(`${scope} · 触控目标没有一个低于 ${TAP_FLOOR}px`, raw.small.length === 0,
     raw.small.map((s) => `${s.el} ${s.w}×${s.h}`).join(" "));
  const comfy = raw.taps.filter((t) => t.min < TAP_COMFY);
  if (comfy.length) {
    note(scope, `有 ${comfy.length} 个可点目标小于 ${TAP_COMFY}px（只报不拦，WCAG 下限 ${TAP_FLOOR} 已过）：` +
      comfy.slice(0, 10).map((c) => `${c.el} ${c.w}×${c.h}`).join("、"));
  }
  return raw;
}

/* ══ 各段 ══════════════════════════════════════════════════════════ */

async function sectionGate(page) {
  // 未登录的凭据页：手机适配里最容易出问题的一屏（长文案 + 倒计时 + 装饰）
  const a = await auditScreen(page, "凭据页");
  await sweepOverlap(page, "凭据页");
  // 封印页是**设计成正好一屏放得下**的，所以判据不是「能滚」而是「不溢出、也不被压扁」：
  // 写成 scrollH > VH 的话，这一屏永远红，而它红不代表手机上坏。
  const card = await page.eval(`(() => {
    const el = document.querySelector('.seal, .screen, .card, #app > *');
    const r = el ? el.getBoundingClientRect() : null;
    return r ? { h: Math.round(r.height), top: Math.round(r.top) } : null;
  })()`);
  ok("凭据页 · 内容不超出视口（封印页本来就该一屏放下）", a.scrollH <= VH + 8, `scrollHeight=${a.scrollH}`);
  ok("凭据页 · 主体卡片占住了大半屏（没被压扁）",
     !!card && card.h >= VH * 0.6, card ? `卡片高 ${card.h} / 视口 ${VH}` : "找不到主体卡片");
}

async function sectionDesk(page, who) {
  const scope = `布置台·${who}`;
  const a = await auditScreen(page, scope);
  await sweepOverlap(page, scope);

  // 引导
  const g = await page.eval(`(() => {
    const el = document.querySelector('.guide');
    if (!el) return null;
    const items = Array.from(el.querySelectorAll('li')).map(li => li.textContent.trim());
    const bar = document.querySelector('.addbar');
    return { n: items.length, items,
             beforeAddbar: !!(bar && (el.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING)),
             rect: el.getBoundingClientRect().height };
  })()`);
  ok(`${scope} · 引导可见`, !!g, "页面上没有 .guide");
  if (g) {
    ok(`${scope} · 引导 5 条（4 条怎么折 + 1 条封存）`, g.n === 5, `实到 ${g.n} 条`);
    ok(`${scope} · 引导排在添加栏之前（先看说明再动手）`, g.beforeAddbar, "");
    ok(`${scope} · 引导里的封存那条填了开门那天`, g.items.some((t) => /\d{4}\s*年|\d+\s*月/.test(t)), g.items[4] || "");
  }

  // 收纳：位置 → 展开 → 收起（两种收法）
  const tabBox = await page.eval(`(() => {
    const t = document.querySelector('#dw-tab'); if (!t) return null;
    const r = t.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height,
             text: t.textContent.trim(), expanded: t.getAttribute('aria-expanded') };
  })()`);
  ok(`${scope} · 收纳把手在场`, !!tabBox, "");
  if (tabBox) {
    ok(`${scope} · 把手贴住右缘`, Math.abs(tabBox.right - VW) <= 2, `right=${Math.round(tabBox.right)} 视口=${VW}`);
    const mid = (tabBox.top + tabBox.bottom) / 2;
    ok(`${scope} · 把手在四分之三高（中心 ${Math.round(mid)} ≈ ${Math.round(VH * 0.75)}）`,
       Math.abs(mid - VH * 0.75) <= 24, `中心 ${Math.round(mid)}`);
    ok(`${scope} · 把手默认收起`, tabBox.expanded === "false", `aria-expanded=${tabBox.expanded}`);
  }

  const t1 = await tap(page, "#dw-tab", { label: "收纳把手" });
  ok(`${scope} · 手指点得动收纳把手`, t1.tapped, t1.why || "");
  const open = await page.eval(`(() => {
    const p = document.querySelector('#dw-panel');
    const t = document.querySelector('#dw-tab');
    return { hidden: p ? p.hidden : null, expanded: t ? t.getAttribute('aria-expanded') : null,
             hasMusic: !!document.querySelector('#bgm-btn'),
             outHidden: (document.querySelector('#dw-out')||{}).hidden,
             hintInPanel: (() => { const h = document.querySelector('#bgm-hint');
               return !!(h && document.querySelector('#dw-panel').contains(h)); })() };
  })()`);
  ok(`${scope} · 点把手展开收纳`, open.hidden === false, `panel.hidden=${open.hidden}`);
  ok(`${scope} · 面板里有音乐开关`, open.hasMusic, "");
  ok(`${scope} · 登录后面板里有退出`, open.outHidden === false, `#dw-out.hidden=${open.outHidden}`);
  ok(`${scope} · 音量提示长在面板里（不是浮在页面上压内容）`, open.hintInPanel, "");

  // 音乐
  const mus = await page.eval(`(() => {
    const a = document.querySelector('#bgm'); if (!a) return null;
    const b = document.querySelector('#bgm-btn');
    return { loop: a.loop, preload: a.preload, vol: a.volume, src: a.getAttribute('src'),
             pressed: b ? b.getAttribute('aria-pressed') : null, label: b ? b.textContent.trim() : null,
             tabBlocked: document.querySelector('#dw-tab').classList.contains('blocked') };
  })()`);
  ok(`${scope} · <audio id="bgm"> 在场`, !!mus, "");
  if (mus) {
    ok(`${scope} · 背景音乐循环播放`, mus.loop === true, `loop=${mus.loop}`);
    ok(`${scope} · 背景音乐 preload=none（不抢首屏的 6MB）`, mus.preload === "none", `preload=${mus.preload}`);
    ok(`${scope} · 默认音量 0.3`, Math.abs(mus.vol - 0.3) < 1e-6, `volume=${mus.vol}`);
    ok(`${scope} · 曲子是 /bgm.mp3`, /bgm\.mp3$/.test(mus.src || ""), String(mus.src));
  }
  const m1 = await tap(page, "#bgm-btn", { label: "音乐开关" });
  const m2 = await page.eval(`(() => { const b = document.querySelector('#bgm-btn');
    return { pressed: b.getAttribute('aria-pressed'), label: b.textContent.trim() }; })()`);
  ok(`${scope} · 手指点得动音乐开关`, m1.tapped, m1.why || "");
  ok(`${scope} · 点音乐开关后状态翻转`, m2.pressed !== mus?.pressed, `${mus?.pressed} → ${m2.pressed}`);
  ok(`${scope} · 音乐开关的文案跟着状态走`, m2.label !== mus?.label, `${mus?.label} → ${m2.label}`);

  // 点外面收起。**点在真元素上，不点在 document 上**：
  // 真实点击的 target 永远是元素，dispatch 到 document 是我自己造出来的场景 ——
  // 那种场景确实会把委托打挂（e.target.closest 不存在），但它不是用户能碰到的那条路，
  // 拿它当断言等于在测一个不存在的行为。真的那条路的脆弱性单列为发现，不混进这里。
  await page.eval(`(() => {
    const el = document.querySelector('.desk-top h1') || document.querySelector('#app');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(200);
  const afterOutside = await page.eval(`(document.querySelector('#dw-panel')||{}).hidden`);
  ok(`${scope} · 点收纳外面会收起`, afterOutside === true, `panel.hidden=${afterOutside}`);

  // 重新展开再按 Esc
  await tap(page, "#dw-tab", { label: "收纳把手（二次）" });
  const reopened = await page.eval(`(document.querySelector('#dw-panel')||{}).hidden`);
  ok(`${scope} · 收起后还能再展开`, reopened === false, `panel.hidden=${reopened}`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(200);
  const afterEsc = await page.eval(`(document.querySelector('#dw-panel')||{}).hidden`);
  ok(`${scope} · Esc 收起收纳`, afterEsc === true, `panel.hidden=${afterEsc}`);

  return a;
}

async function sectionWithdraw(page, who) {
  const scope = `撤回·${who}`;
  const other = who === "door" ? "hero" : "door";
  const mark = `MK-临时撤回-${who}-${Date.now()}`;

  // 走 UI 新建一条留言（不是撤种子数据 —— 撤种子会把后面阅读流要验的东西也撤掉）
  await tap(page, '[data-add="text"]', { label: "添加留言" });
  await page.waitFor(`!!document.querySelector('[data-form="new"]') || !!document.querySelector('.composer')`,
                     { label: "留言输入框" });
  await page.eval(`(() => {
    const f = document.querySelector('[data-form="new"]') || document.querySelector('.composer');
    const ta = f.querySelector('textarea'); if (!ta) return 'no-textarea';
    ta.value = ${JSON.stringify(mark)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`).then((r) => { if (r !== "ok") ok(`${scope} · 找到留言输入框`, false, r); });
  await tap(page, '[data-form="new"] button[type="submit"], [data-form="new"] .send, .composer button[type="submit"]',
            { label: "留言发送按钮" });
  await sleep(500);
  const created = await page.eval(`(() => {
    const t = document.body.textContent;
    const btn = Array.from(document.querySelectorAll('button[data-del]'))
      .find(b => (b.closest('.letter,.card,[data-id]')||document.body).textContent.includes(${JSON.stringify(mark)}));
    return { onScreen: t.includes(${JSON.stringify(mark)}), delId: btn ? btn.getAttribute('data-del') : null };
  })()`);
  ok(`${scope} · 留言写上去了`, created.onScreen, `标记 ${mark}`);
  ok(`${scope} · 留言卡上确实有撤回按钮`, !!created.delId, `data-del=${created.delId}`);

  // 撤回
  const delIdx = await page.eval(`(() => {
    const btns = Array.from(document.querySelectorAll('button[data-del]'));
    return btns.findIndex(b => b.closest('.letter')?.textContent.includes(${JSON.stringify(mark)}));
  })()`);
  ok(`${scope} · 定位到那条的撤回按钮`, delIdx >= 0, `idx=${delIdx}`);
  if (delIdx >= 0) {
    await tap(page, "button[data-del]", { nth: delIdx, label: "撤回按钮" });
    await sleep(600);
    const after = await page.eval(`document.body.textContent.includes(${JSON.stringify(mark)})`);
    ok(`${scope} · 撤回后界面上立刻没有了`, after === false, `标记仍在=${after}`);

    // 硬删的判据在库里，不在界面上：界面上消失只能证明「前端拿走了」
    const api = await page.eval(`(async () => {
      const r = await fetch('/api/entry', { credentials: 'same-origin' });
      const j = await r.json();
      const all = Array.isArray(j) ? j : (j.mine || []);
      return { n: all.length, stillThere: all.some(e => (e.body||'').includes(${JSON.stringify(mark)})) };
    })()`);
    ok(`${scope} · 数据库里也确实没有了（不只是前端拿走）`, api.stillThere === false,
       `mine=${api.n} 仍含该条=${api.stillThere}`);
  }
  return mark;
}

async function sectionPhotoWithdraw(page, who) {
  // 传一张真图再撤回：验的是「盘上文件也删了」，判据是那个 URL 直接 404。
  const scope = `撤图·${who}`;
  const src = path.join(ROOT, "photos", "together", "01.jpg");
  if (!fs.existsSync(src)) { ok(`${scope} · 找到要上传的图`, false, src); return; }

  // 先记下上传前已有的那些图：**靠「新出现的那张」定位，而不是靠「最后一张卡」**。
  // 桌面上照片排前面、留言排后面（app.js 的 wall 序），所以「最后一张卡」通常是留言 ——
  // 早先就那么写的，结果选中一张没有 <img> 的留言卡，src 取到 null，
  // 后面三条断言整块被 if 跳过，一条都没记，而套件照样报全绿。
  const beforeSrcs = await page.eval(`Array.from(document.querySelectorAll('.wall .pframe img, .letter img'))
    .map(i => i.getAttribute('src'))`);
  const before = beforeSrcs.length;

  await page.setFileInput("#pick-photo", src);
  await sleep(2500);

  const target = await page.eval(`(() => {
    const before = ${JSON.stringify(beforeSrcs)};
    const cards = Array.from(document.querySelectorAll('.letter'));
    const delAll = Array.from(document.querySelectorAll('.letter button[data-del]'));
    for (const c of cards) {
      const img = c.querySelector('img');
      if (!img) continue;
      const s = img.getAttribute('src');
      if (!s || before.includes(s)) continue;              // 只认**新出现**的那张
      const del = c.querySelector('button[data-del]');
      if (!del) continue;
      return { src: s, delIdx: delAll.indexOf(del) };
    }
    return null;
  })()`);
  // 判据把 src 一起押上：取不到新图就不是「跳过」，而是红。
  ok(`${scope} · 新传的那张图有撤回按钮（且定位到的是照片卡不是留言卡）`,
     !!target && target.delIdx >= 0 && !!target.src, JSON.stringify(target));
  ok(`${scope} · 手机上真传得上去一张图`,
     (await page.eval(`document.querySelectorAll('.wall .pframe img, .letter img').length`)) > before,
     `${before} → 传完`);

  if (!target || !target.src) return;
  const urlFetch = await page.eval(`(async () => (await fetch(${JSON.stringify(target.src)})).status)()`);
  ok(`${scope} · 撤回前那张图取得到`, urlFetch === 200, `status=${urlFetch}`);

  await tap(page, ".letter button[data-del]", { nth: target.delIdx, label: "照片撤回按钮" });
  await sleep(800);
  const after = await page.eval(`(async () => {
    const r = await fetch(${JSON.stringify(target.src)});
    return { status: r.status, stillThere: document.body.textContent.includes(${JSON.stringify(target.src)}) };
  })()`);
  ok(`${scope} · 撤回后那个地址直接 404（盘上文件真删了，不是软删）`, after.status === 404,
     `status=${after.status}`);
  ok(`${scope} · 撤回后界面上也没有这张了`, after.stillThere === false, `src 仍在=${after.stillThere}`);
}

async function sectionReading(page, who) {
  const scope = `阅读流·${who}`;
  const a = await auditScreen(page, scope);
  await sweepOverlap(page, scope);
  ok(`${scope} · 内容可以往下滚`, a.scrollH > VH * 1.5, `scrollHeight=${a.scrollH}`);
  ok(`${scope} · 九宫格在`, await page.eval(`!!document.querySelector('.grid3')`), "");
  const grid = await page.eval(`(() => {
    const imgs = Array.from(document.querySelectorAll('.grid3 img'));
    return { n: imgs.length, withRetry: imgs.filter(i => i.hasAttribute('data-img-retry')).length,
             cells: document.querySelectorAll('.grid3 > *').length };
  })()`);
  ok(`${scope} · 九宫格里确实有图`, grid.n > 0, JSON.stringify(grid));
  ok(`${scope} · 九宫格每一张都带重试标记（只有它带）`, grid.n === grid.withRetry,
     `${grid.withRetry}/${grid.n} 带标记，格子 ${grid.cells} 个`);

  // 退出必须从收纳走通：这是 10-5 当天唯一的出路
  await tap(page, "#dw-tab", { label: "收纳把手" });
  const outVisible = await page.eval(`(() => {
    const row = document.querySelector('#dw-out');
    return { hidden: row ? row.hidden : null, panelOpen: !(document.querySelector('#dw-panel')||{}).hidden };
  })()`);
  ok(`${scope} · 收纳展开后看得见退出`, outVisible.panelOpen === true && outVisible.hidden === false,
     JSON.stringify(outVisible));
  await tap(page, "#dw-out .dw-out", { label: "退出按钮" });
  // 等条件成立，不等固定时长。退出会重画整屏，而重画前那次 fetch 要过一次 nginx 往返；
  // 线上比本地慢，`sleep(900)` 这种写法就是抖动的来源 —— 它测的是「900ms 内有没有回���」，
  // 不是「退不退出得去」。真退不掉的话 12s 也等不到，一样红。
  const back = await page.waitFor(`!!document.querySelector('[data-go="who"]') || !!document.querySelector('#pin')`,
                                  { timeout: 12_000, label: "退出后回到凭据页" })
    .then(() => true).catch(() => false);
  if (!back) {
    const diag = await page.eval(`JSON.stringify({
      screen: (document.querySelector('#app > *') || {}).className || null,
      panelOpen: !!(document.querySelector('#dw-panel') && !document.querySelector('#dw-panel').hidden),
      outHidden: (document.querySelector('#dw-out') || {}).hidden,
      body: document.body.textContent.slice(0, 120)
    })`).catch((e) => `诊断本身失败：${e.message}`);
    ok(`${scope} · 退出后回到凭据页（出得来）`, false, `等了 12s 没回凭据页；现场 ${diag}`);
    return;
  }
  ok(`${scope} · 退出后回到凭据页（出得来）`, true, "");
}

async function sectionLogoutDesk(page, who) {
  const scope = `退出·${who}`;
  await tap(page, "#dw-tab", { label: "收纳把手" });
  await tap(page, "#dw-out .dw-out", { label: "收纳里的退出" });
  const back = await page.waitFor(`!!document.querySelector('[data-go="who"]') || !!document.querySelector('#pin')`,
                                  { timeout: 12_000, label: "布置台退出" }).then(() => true).catch(() => false);
  ok(`${scope} · 布置台从收纳退得出去`, back === true, back ? "" : "等了 12s 没回凭据页");
}

/* 九宫格破图重试：用**真网络失败**驱动（CDP 把某个 URL 拉黑），
   不用 eval 改 src —— 改 src 测的是「我手动制造的那个错」，
   不是「浏览器真的取不到」时那段代码怎么走。
   两条互为对照：拦一下就放（重试救得回来）／一直拦（重试用完才占位）。
   只测后一条的话，「第一次失败就占位」和「重试两次再占位」长得一模一样。 */
async function observeIn(page, base) {
  await page.goto(`${base}/#observe`);
  await page.waitFor(`!!document.querySelector('#ob-pin')`, { label: "观察者凭据框" });
  await page.eval(`(() => { const el = document.querySelector('#ob-pin'); el.value = ${JSON.stringify(OBSERVER_PIN)};
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.eval(`document.querySelector('[data-ob="enter"]').click()`);
  await page.waitFor(`!!document.querySelector('.ob-shared .grid3 img')`, { label: "共同层九宫格出现" });
}

async function sectionRetry(base, tmpRoot) {
  const scope = "九宫格重试";
  const pick = `(() => { const im = document.querySelector('.ob-shared .grid3 img');
    const s = im.getAttribute('src'); return s && s.includes('/api/photo/') ? s : null; })()`;

  // ── A：拦一下就放 → 重试救回来
  {
    const { proc, page } = await launchAttach(path.join(tmpRoot, "mA"));
    try {
      await page.viewport({ width: VW, height: VH, mobile: true });
      await observeIn(page, base);
      const src = await page.eval(pick);
      if (!src) { ok(`${scope} · 取得到一张共同层图当靶子`, false, "观察者视图里没有 grid3 的图"); return; }
      const victim = src.split("/").pop();
      await page.send("Network.enable");
      await page.send("Network.setBlockedURLs", { urls: [`*${victim}`] });
      await reload(page);                            // 重载：拦截要在第一帧就生效
      await page.waitFor(`!!document.querySelector('#ob-pin')`, { label: "A 重载后凭据框" });
      await page.eval(`(() => { const el = document.querySelector('#ob-pin'); el.value = ${JSON.stringify(OBSERVER_PIN)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await page.eval(`document.querySelector('[data-ob="enter"]').click()`);
      await page.waitFor(`!!document.querySelector('.ob-shared .grid3 img[data-img-retry="1"]')`,
                         { timeout: 15_000, label: "第一次取图失败、重试计数 2→1" })
        .catch(() => {});
      const sawDrop = await page.eval(`!!document.querySelector('.ob-shared .grid3 img[data-img-retry="1"]')`);
      await page.send("Network.setBlockedURLs", { urls: [] });          // 放行，让第二次拿到
      await page.waitFor(`(() => { const im = Array.from(document.querySelectorAll('.ob-shared .grid3 img'))
          .find(i => (i.getAttribute('src')||'').endsWith(${JSON.stringify(victim)}));
        return im && im.complete && im.naturalWidth > 0; })()`,
        { timeout: 15_000, label: "放行后重试拿到图" }).catch(() => {});
      const st = await page.eval(`(() => {
        const im = Array.from(document.querySelectorAll('.ob-shared .grid3 img'))
          .find(i => (i.getAttribute('src')||'').endsWith(${JSON.stringify(victim)}));
        return im ? { nw: im.naturalWidth, fb: im.classList.contains('img-fb') || !!im.closest('.ph'),
                      retry: im.getAttribute('data-img-retry') } : null; })()`);
      ok(`${scope} · 拉黑后确实重试了（data-img-retry 2→1）`, sawDrop, "没看到重试计数递减");
      ok(`${scope} · 放行后重试把图拿回来了`, !!st && st.nw > 0, JSON.stringify(st));
      ok(`${scope} · 救回来的图没有变成占位块`, !!st && !st.fb, JSON.stringify(st));
    } finally { try { page.close(); } catch {} try { proc.kill("SIGKILL"); } catch {} }
  }

  // ── B：一直拦 → 重试用完才占位（不是第一次失败就占位）
  {
    const { proc, page } = await launchAttach(path.join(tmpRoot, "mB"));
    try {
      await page.viewport({ width: VW, height: VH, mobile: true });
      await observeIn(page, base);
      const src = await page.eval(pick);
      const victim = src ? src.split("/").pop() : null;
      await page.send("Network.enable");
      await page.send("Network.setBlockedURLs", { urls: [`*${victim}`] });
      await reload(page);
      await page.waitFor(`!!document.querySelector('#ob-pin')`, { label: "B 重载后凭据框" });
      await page.eval(`(() => { const el = document.querySelector('#ob-pin'); el.value = ${JSON.stringify(OBSERVER_PIN)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await page.eval(`document.querySelector('[data-ob="enter"]').click()`);
      await page.waitFor(`!!document.querySelector('.ob-shared .grid3 img[data-img-retry="1"]')`,
                         { timeout: 15_000, label: "B 第一次失败" }).catch(() => {});
      const sawRetry = await page.eval(`!!document.querySelector('.ob-shared .grid3 img[data-img-retry="1"]')
        || !!document.querySelector('.ob-shared .grid3 img[data-img-retry="0"]')`);
      await page.waitFor(`(() => { const cell = Array.from(document.querySelectorAll('.ob-shared .grid3 > *'))
          .find(el => el.classList.contains('ph') || (el.querySelector && el.querySelector('.ph')));
        return !!cell; })()`, { timeout: 25_000, label: "重试用完后才出占位块" }).catch(() => {});
      const st = await page.eval(`(() => ({
        ph: Array.from(document.querySelectorAll('.ob-shared .grid3 > *'))
          .filter(el => el.classList.contains('ph') || (el.querySelector && el.querySelector('.ph'))).length,
        retryLeft: document.querySelectorAll('.ob-shared .grid3 img[data-img-retry]').length
      }))()`);
      ok(`${scope} · 取不到的时候是重试过才占位，不是第一次就占位`, sawRetry, JSON.stringify(st));
      ok(`${scope} · 重试耗尽后确实出了占位块`, st.ph > 0, JSON.stringify(st));
      const others = await page.eval(`document.querySelectorAll('.ob-side .pframe img[data-img-retry]').length`);
      ok(`${scope} · 别的图没有跟着一起重试（重试只给九宫格）`, others === 0, `侧栏带标记 ${others} 张`);
    } finally { try { page.close(); } catch {} try { proc.kill("SIGKILL"); } catch {} }
  }
}

/* ══ 主流程 ════════════════════════════════════════════════════════ */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "two-years-mobile-"));
let server = null, db = null;
const roles = [];
/** 自建实例时翻时钟用。给了 --base 就不碰——远端实例自己握着库连接。 */
const NOW = { v: UNLOCK_AT - 3_600_000 };

try {
  let base;
  let remoteUnlocked = null;
  if (argOf("--base", null)) {
    base = argOf("--base").replace(/\/+$/, "");
    const probe = await fetch(`${base}/api/status`);
    if (!probe.ok) throw new Error(`${base}/api/status 返 ${probe.status}`);
    const st = await probe.json();
    remoteUnlocked = !!st.unlocked;
    console.error(`[e2e-mobile] 指向既有实例 ${base}（unlocked=${st.unlocked}）`);
  } else {
    // 口令必须在 createApp 之前注入：src/auth.js 与 src/observer-auth.js 没有缺省值了。
    useTestSecrets();
    db = openDb(M.db);
    const app = createApp({ db, now: () => NOW.v, dataDir: path.dirname(M.db) });
    server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    console.error(`[e2e-mobile] 服务在 ${base}（先锁着，两段都跑）`);
  }

  // ── 1. 凭据页（未登录）
  await guard("凭据页", async () => {
    const r = await openRole("gate", base, tmpRoot);
    await sectionGate(r.page);
    ok("凭据页 · console 没有 error", r.con.errors.length === 0, r.con.errors.slice(0, 3).join(" | "));
    await closeRole(r);
  });

  /** 哪几段能跑，取决于**被测实例此刻的开门状态**，不取决于命令行开关。
   *  本地实例从锁着起步，跑完布置台再把注入时钟翻到开门那一刻跑阅读流 ——
   *  两段一次进程内跑完，不用起第二个服务也不用换一套种子。 */
  const runDesk = remoteUnlocked !== true;
  const runRead = remoteUnlocked !== false;
  if (remoteUnlocked === null) NOW.v = UNLOCK_AT - 3_600_000;   // 本地第一段：锁着

  // ── 2. 布置台
  if (runDesk) {
    for (const who of ["door", "hero"]) {
      await guard(`布置台·${who}`, async () => {
        const r = await openRole(who, base, tmpRoot);
        try {
          await walkIn(r.page, who);
          ok(`布置台·${who} · 落在布置台`, await r.page.eval(`!!document.querySelector('.addbar')`), "");
          await sectionDesk(r.page, who);
          if (who === "hero") {
            // 撤回测的是「自己新建的东西删掉」，不是撤种子 ——
            // 撤种子会把后面阅读流要验的那几条也一起撤掉
            await sectionWithdraw(r.page, who);
            await sectionPhotoWithdraw(r.page, who);
            await sectionLogoutDesk(r.page, who);
          }
          ok(`布置台·${who} · console 没有 error`, r.con.errors.length === 0, r.con.errors.slice(0, 3).join(" | "));
          if (r.con.warnings.length) note(`布置台·${who}`, `console 有 ${r.con.warnings.length} 条 warning：` +
            r.con.warnings.slice(0, 3).join(" | "));
        } finally { await closeRole(r); }
      });
    }
  }

  // ── 3. 九宫格重试（观察者绕的就是时间锁，两种开门状态都跑）
  await guard("九宫格重试", () => sectionRetry(base, tmpRoot));

  // ── 4. 阅读流（只有开门后才有）
  if (remoteUnlocked === null) NOW.v = UNLOCK_AT + 60_000;      // 本地第二段：翻到开门后
  if (runRead) {
    for (const who of ["door", "hero"]) {
      await guard(`阅读流·${who}`, async () => {
        const r = await openRole(who, base, tmpRoot);
        try {
          await walkIn(r.page, who);
          ok(`阅读流·${who} · 开门后直接进阅读流`, await r.page.eval(`!!document.querySelector('.rd-hero')`), "");
          await sectionReading(r.page, who);
          ok(`阅读流·${who} · console 没有 error`, r.con.errors.length === 0, r.con.errors.slice(0, 3).join(" | "));
        } finally { await closeRole(r); }
      });
    }
  }

  // 截图留证（不进 git）
  await guard("截图", async () => {
    const r = await openRole("shot", base, tmpRoot);
    try {
      await walkIn(r.page, "door");
      await tap(r.page, "#dw-tab", { label: "收纳把手" });
      await r.page.shot(path.join(DIR, "mobile-dweller.png"));
    } finally { await closeRole(r); }
  });
} finally {
  for (const r of roles) await closeRole(r);
  if (server) await new Promise((res) => server.close(res));
  if (db) db.close();
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
fs.writeFileSync(path.join(DIR, "report-mobile.json"),
  JSON.stringify({ total: results.length, pass, fail, viewport: `${VW}x${VH}`, results, findings }, null, 2), "utf8");
for (const r of results) if (!r.pass) console.log(`✖ ${r.name}  ${r.detail}`);
console.log(`\n手机尺寸 E2E（${VW}×${VH} + 触摸）：${pass}/${results.length} 通过，${fail} 失败`);
console.log(`报告：${path.join(DIR, "report-mobile.json")}`);
process.exit(fail === 0 ? 0 : 1);
