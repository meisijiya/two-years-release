/**
 * 工单 03 · 文件层 · 前端契约测试
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假网络（fetch 被打桩），
 * 装置照抄 test/ticket-02-frontend.test.js。断言只落在界面上看得见的文本、
 * 渲染出来的元素集合、以及「我们向浏览器平台要了什么」上。
 *
 * ⚠️ 诚实的边界（写在最前面，别被下面的绿测试骗了）：
 *   jsdom 没有 canvas、也没有 createImageBitmap。这里给这两个**平台**打桩
 *   （和给 fetch 打桩同一类：补的是环境，不是给应用逻辑开后门），
 *   断言的是「画布被设成多大、setTransform 收到什么矩阵、toBlob 收到什么类型与质量」。
 *   **canvas 编码出来的 JPEG 字节本身无法验证** —— 那留给工单 06 的真实浏览器取证。
 *   任何「已上传的字节是对的」这类断言都不在这里，也别往这里加。
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
const APP_FILE = path.join(ROOT, "public", "app.js");

/* 我自己的条目。photo.id 走契约里的形状（03 工单：{id,mime,w,h}）。 */
const P1 = { id: "e7", kind: "photo", body: null, ord: 1, created: 1759000000000, photo: { id: "p3", mime: "image/jpeg", w: 1200, h: 1600 } };
const P2 = { id: "e8", kind: "photo", body: "这张洗了好多次", ord: 2, created: 1759000000001, photo: { id: "p4", mime: "image/jpeg", w: 1200, h: 1600 } };
const T1 = { id: "e1", kind: "text", body: "两年了，还是会因为一点小事开心很久。", ord: 3, created: 1759000000002, photo: null };
const ME = { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: false, count: 3 };
const LOCKED_STATUS = {
  status: 200,
  body: { unlocked: false, unlockAt: 1791129600000, unlockLabel: "2026-10-05T00:00:00+08:00", now: 1791129599000 },
};
const BASE = {
  "GET /api/status": LOCKED_STATUS,
  "GET /api/me": { status: 200, body: ME },
  "GET /api/entry": { status: 200, body: { mine: [P1, P2, T1], theirs: [] } },
};

/* ══════════ 装置 ══════════ */

/**
 * 打桩 fetch 与两个 canvas 平台能力，并记录一切我们向平台索取的参数。
 * 记下来的东西就是断言对象：不是「函数被调了几次」，而是
 * 「我们要求浏览器把图画成多大、按什么矩阵摆正、按什么质量编码」。
 */
async function mount(routes) {
  const seen = [];
  const timers = { interval: 0 };
  const canvas = { toBlob: [], transform: [], fill: [], draw: [], bitmapOpts: [] };
  const uploads = [];          // { fields: [名字…], contentType: 手写的那个头 }
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      const real = w.setInterval.bind(w);
      w.setInterval = (...a) => { timers.interval += 1; return real(...a); };

      // 平台能力补齐：真实浏览器里有，jsdom 里没有
      w.createImageBitmap = async (file, opts) => {
        canvas.bitmapOpts.push(opts);
        return { width: file.__w, height: file.__h, close() {} };
      };
      w.HTMLCanvasElement.prototype.getContext = function () {
        const self = this;
        return {
          set fillStyle(v) { /* 白底，只关心有没有铺 */ },
          get fillStyle() { return "#fff"; },
          fillRect(x, y, w, h) { canvas.fill.push({ w: self.width, h: self.height, x, y, w2: w, h2: h }); },
          setTransform(a, b, c, d, e, f) { canvas.transform.push([a, b, c, d, e, f]); },
          drawImage(src, x, y, w, h) { canvas.draw.push({ x, y, w, h, srcW: src.width, srcH: src.height }); },
        };
      };
      w.HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
        canvas.toBlob.push({ w: this.width, h: this.height, type, quality });
        cb(new w.Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: type || "image/jpeg" }));
      };

      w.fetch = async (url, init = {}) => {
        const key = `${(init.method || "GET").toUpperCase()} ${url}`;
        seen.push(key);
        if (init.body && typeof init.body.keys === "function") {
          uploads.push({ fields: [...init.body.keys()], contentType: (init.headers || {})["Content-Type"] || null });
        }
        const r = routes[key];
        const status = r ? r.status : 404;
        const body = r && status !== 204 ? r.body : { error: "not_found" };
        return new Response(status === 204 ? null : JSON.stringify(body), {
          status, headers: { "content-type": "application/json" },
        });
      };
    },
  });
  return { dom, seen, timers, canvas, uploads };
}

async function boot(t, routes) {
  const { dom, seen, timers, canvas, uploads } = await mount(routes);
  t.after(() => dom.window.close());          // 关窗会清掉那个 setInterval，否则进程不退出
  for (let i = 0; i < 200 && !dom.window.__t03; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t03, "public/index.html 没有跑起 public/app.js（脚本没加载，或加载后没挂 __t03）");
  await dom.window.__t03.ready;
  const doc = dom.window.document;
  return {
    win: dom.window, doc, seen, timers, canvas, uploads,
    text: () => doc.body.textContent,
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
    /** 选图：把假 File 塞进 input.files 再发 change —— 用户在系统相册里点一下就是这两步 */
    pick(file) {
      const el = doc.querySelector("#pick-photo");
      assert.ok(el, "界面上找不到 #pick-photo（上传入口没在常驻添加栏里）");
      Object.defineProperty(el, "files", { value: [file], configurable: true });
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
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

/** 把一段 card() 的输出挂到真实 DOM 上再查，断言落在元素集合而不是字符串匹配上 */
function renderCard(doc, card, e, i, mode) {
  const box = doc.createElement("div");
  box.innerHTML = card(e, i, mode);
  doc.body.appendChild(box);
  return box;
}
const all = (box, sel) => Array.from(box.querySelectorAll(sel));

/* ══════════ 1. EXIF 方向解析（纯函数，脱离 canvas） ══════════ */

/** 造一段最小 JPEG：SOI + APP1(Exif\0\0 + IFD0{Orientation}) + EOI。
 *  小端大端各来一份 —— 两种相机都有，只测一种等于没测。 */
function jpegWithOrientation(o, little = true) {
  const tiffLen = 8 + 2 + 12 + 4;                    // 头 + 条目数 + 1 条目 + 下一段指针
  const segLen = 2 + 6 + tiffLen;                    // 长度字段(2) + "Exif\0\0"(6) + TIFF
  const buf = new Uint8Array(2 + 2 + 2 + (segLen - 2) + 2);
  const dv = new DataView(buf.buffer);
  let p = 0;
  const u8 = (...v) => { for (const x of v) buf[p++] = x; };
  const u16 = (v) => { dv.setUint16(p, v, little); p += 2; };
  const u32 = (v) => { dv.setUint32(p, v, little); p += 4; };
  u8(0xff, 0xd8);                                   // SOI
  u8(0xff, 0xe1);                                   // APP1
  u16(segLen);
  u8(0x45, 0x78, 0x69, 0x66, 0x00, 0x00);           // "Exif\0\0"
  u8(little ? 0x49 : 0x4d, little ? 0x49 : 0x4d);   // II / MM
  u16(42);
  u32(8);                                           // IFD0 相对 TIFF 头的偏移
  u16(1);                                           // 条目数
  u16(0x0112);                                      // Orientation
  u16(3);                                           // SHORT
  u32(1);                                           // count
  u16(o); u16(0);                                   // 值存在值域前两字节
  u32(0);                                           // 下一段指针
  u8(0xff, 0xd9);                                   // EOI
  return buf;
}

test("EXIF 方向：合成字节里读出 orientation=1/3/6/8，小端大端都读得对", (t) => {
  const { exifOrientation } = pure();
  for (const little of [true, false]) {
    for (const o of [1, 3, 6, 8]) {
      assert.equal(exifOrientation(jpegWithOrientation(o, little)), o,
        `${little ? "小端 II" : "大端 MM"} 的 orientation=${o} 读错了 —— 竖拍照片会躺着显示`);
    }
  }
  t.diagnostic("合成 JPEG 38 字节，APP1 34 字节；4 方向 × 2 端序 = 8 例全中");
});

test("EXIF 方向：读不到就当 1，绝不猜", (t) => {
  const { exifOrientation } = pure();
  // 没有 EXIF 段：只留 SOI + EOI
  assert.equal(exifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), 1, "没有 EXIF 时应回落到 1");
  // 截断的 EXIF：读到一半就没字节了
  assert.equal(exifOrientation(jpegWithOrientation(6).slice(0, 25)), 1, "截断的 EXIF 不该被猜成 6");
  // 根本不是 JPEG
  assert.equal(exifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 1, "非 JPEG 应回落到 1");
  assert.equal(exifOrientation(new Uint8Array(0)), 1, "空字节应回落到 1");
  assert.equal(exifOrientation(null), 1, "null 应回落到 1");
  t.diagnostic("5 类坏输入全部回落 1：宁可当成没旋转，也不要歪 90°");
});

/* ══════════ 2. 摆正矩阵（纯函数） ══════════ */

test("EXIF 方向 → 仿射矩阵：四种方向的四个角都落在摆正后的画布里", (t) => {
  const { exifTransform, swapAxes } = pure();
  const sw = 4032, sh = 3024;                        // 手机竖拍存下来的横缓冲
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const corners = [[0, 0], [sw, 0], [sw, sh], [0, sh]];

  // 4/5/6/8 要转置，1/2/3/4 不转
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(swapAxes), [false, false, false, false, true, true, true, true],
    "5/6/7/8 必须转置，否则画布宽高与摆正后的长宽对不上");

  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const m = exifTransform(o, sw, sh, 1);
    assert.equal(m.length, 6, "矩阵必须是 setTransform 的六个参数");
    // 行列式绝对值 = k²：没有镜像以外的缩放/错切
    assert.ok(Math.abs(Math.abs(m[0] * m[3] - m[1] * m[2]) - 1) < 1e-9, `orientation=${o} 的矩阵带了不该有的缩放`);

    const dw = swapAxes(o) ? sh : sw, dh = swapAxes(o) ? sw : sh;
    for (const [x, y] of corners) {
      const [X, Y] = apply(m, x, y);
      assert.ok(X >= -1e-9 && X <= dw + 1e-9, `orientation=${o} 角(${x},${y}) 的 X=${X} 掉出画布 0..${dw}`);
      assert.ok(Y >= -1e-9 && Y <= dh + 1e-9, `orientation=${o} 角(${x},${y}) 的 Y=${Y} 掉出画布 0..${dh}`);
    }
  }

  // 关键一条：orientation=6（竖拍最常见）必须顺时针转 90°，长宽互换成竖幅
  const m6 = exifTransform(6, sw, sh, 1);
  assert.deepEqual(apply(m6, 0, 0).map(Math.round), [sh, 0], "orientation=6：左上角该转到右上角");
  assert.deepEqual(apply(m6, sw, 0).map(Math.round), [sh, sw], "orientation=6：右上角该转到右下角");
  assert.deepEqual(apply(m6, 0, sh).map(Math.round), [0, 0], "orientation=6：左下角该转到左上角");
  assert.equal(swapAxes(6), true, "orientation=6 是竖拍照片，长宽必须转置");
  t.diagnostic("8 个方向 × 4 角共 32 点全部落在摆正后画布内；o=6 角点映射 TL→TR→BR");
});

/* ══════════ 3. 压缩目标尺寸（纯函数） ══════════ */

test("压缩目标尺寸：长边封顶 1280、比例不变、绝不出现 0 或负数", (t) => {
  const { targetSize, MAX_EDGE } = pure();
  assert.equal(MAX_EDGE, 1280, "浏览器端长边上限写死 1280（服务端兜底 1600）");

  const cases = [
    [4032, 3024, 1280, 960],       // 手机横拍：长边压到上限
    [3024, 4032, 960, 1280],       // 竖着那张的像素：宽度变短边
    [1200, 900, 1200, 900],        // 已经够小：原样
    [1, 1, 1, 1],                  // 极端小图：不缩不放
    [1280, 1280, 1280, 1280],      // 正好等于上限
  ];
  for (const [w, h, ew, eh] of cases) {
    const r = targetSize(w, h, MAX_EDGE);
    assert.equal(r.w, ew, `${w}×${h} 的目标宽度算错`);
    assert.equal(r.h, eh, `${w}×${h} 的目标高度算错`);
  }

  // 退化输入：不能算出 0/负数/NaN —— 那会让 toBlob 编出一张全黑的图
  for (const [w, h] of [[0, 0], [-5, 100], [100, -5], [NaN, 500], [500, NaN], [undefined, undefined]]) {
    const r = targetSize(w, h, MAX_EDGE);
    assert.ok(Number.isInteger(r.w) && r.w > 0, `输入 ${w}×${h} 算出宽度 ${r.w}，必须是正整数`);
    assert.ok(Number.isInteger(r.h) && r.h > 0, `输入 ${w}×${h} 算出高度 ${r.h}，必须是正整数`);
    assert.ok(Math.max(r.w, r.h) <= MAX_EDGE, `输入 ${w}×${h} 的长边 ${Math.max(r.w, r.h)} 超过上限`);
  }

  // 比例：允许四舍五入的 1px 误差，不许变形；长边 = min(上限, 原长边) —— 只压不放
  for (const [w, h] of [[4032, 3024], [3024, 4032], [3000, 1700], [777, 1000], [4000, 4000], [640, 480]]) {
    const r = targetSize(w, h, MAX_EDGE);
    assert.ok(Math.abs(r.w * h - r.h * w) <= Math.max(r.w, r.h), `${w}×${h} → ${r.w}×${r.h} 比例被改坏了`);
    assert.equal(Math.max(r.w, r.h), Math.min(MAX_EDGE, Math.max(w, h)),
      `${w}×${h} 的长边应为 min(${MAX_EDGE}, ${Math.max(w, h)}) = ${Math.min(MAX_EDGE, Math.max(w, h))}，实际 ${Math.max(r.w, r.h)}`);
  }
  t.diagnostic("5 组确定值 + 6 组退化输入 + 6 组比例/封顶，全部通过；长边恒 ≤1280 且只压不放");
});

/* ══════════ 4. 配文可选项 ══════════ */

test("配文可选项：没写配文时 read 态的配文区集合为空（不是「有个空的」）", async (t) => {
  const ui = await boot(t, BASE);
  const { card } = ui.win.__t03;
  const noCap = renderCard(ui.doc, card, P1, 0, "read");
  assert.deepEqual(all(noCap, ".cap"), [], "read 态没写配文却渲染出了配文区");
  noCap.remove();

  // 反向：写了的照片，read 态必须有一块实线浅底的配文，否则这条是恒真式
  const withCap = renderCard(ui.doc, card, P2, 0, "read");
  assert.deepEqual(all(withCap, ".cap").length, 1, "写了配文的照片在 read 态应有且只有一块配文区");
  assert.equal(all(withCap, ".cap")[0].textContent.trim(), P2.body, "配文内容不对");
  assert.ok(all(withCap, ".cap")[0].className.includes("cap-real"), "read 态的配文应是实线浅底（内容，不是输入框）");
  withCap.remove();
  t.diagnostic("P1(body=null) → 0 块；P2(body 有字) → 1 块且是 cap-real");
});

/* ══════════ 5. 两端同源：edit 与 read 的差异集合 ══════════ */

test("同一个 card：照片的 edit/read 差异集合**恰好**符合 design.md §6.2", async (t) => {
  const ui = await boot(t, BASE);
  const { card } = ui.win.__t03;

  for (const entry of [P1, P2]) {
    const label = entry.id;
    const read = renderCard(ui.doc, card, entry, 0, "read");
    const edit = renderCard(ui.doc, card, entry, 0, "edit");

    // read 态：撤回角标 / 操作行 / 改写入口，一个都不许有
    assert.deepEqual(all(read, ".x"), [], `read 态渲染了撤回角标（${label}）`);
    assert.deepEqual(all(read, ".ops"), [], `read 态渲染了操作行（${label}）`);
    assert.deepEqual(all(read, "[data-del]"), [], `read 态渲染了撤回入口（${label}）`);
    assert.deepEqual(all(read, "[data-cap]"), [], `read 态渲染了写一句入口（${label}）`);
    assert.deepEqual(all(read, "textarea"), [], `read 态渲染了输入框（${label}）`);
    assert.ok(read.textContent.includes("已 送 达"), `read 态的封条应是「已送达」（${label}）`);

    // edit 态：三样都在
    assert.deepEqual(all(edit, ".x").length, 1, `edit 态应有 1 个撤回角标（${label}）`);
    assert.deepEqual(all(edit, ".ops").length, 1, `edit 态应有 1 条操作行（${label}）`);
    assert.deepEqual(all(edit, "[data-del]").length, 2, `edit 态应有角标+操作行两个撤回入口（${label}）`);
    assert.deepEqual(all(edit, "[data-cap]").length, 1, `edit 态应有「写一句」（${label}）`);
    assert.ok(edit.textContent.includes("封 存 中"), `edit 态的封条应是「封存中」（${label}）`);

    // 照片本体在两端都在，且是同一个渲染器出的
    assert.deepEqual(all(read, ".pframe").length, 1, `read 态应有照片框（${label}）`);
    assert.deepEqual(all(edit, ".pframe").length, 1, `edit 态应有照片框（${label}）`);
    read.remove(); edit.remove();
  }

  // 没写配文时，edit 态给输入提示占位，read 态整块不渲染 —— 同一张卡的两态对照
  const read = renderCard(ui.doc, card, P1, 0, "read");
  const edit = renderCard(ui.doc, card, P1, 0, "edit");
  assert.deepEqual(all(read, ".cap"), [], "read 态无配文 → 配文区集合为空");
  assert.deepEqual(all(edit, ".cap").length, 1, "edit 态无配文 → 应有输入提示占位");
  assert.equal(all(edit, ".cap")[0].textContent.trim(), "给这张照片写一句话（可不写）", "占位文案不对");
  read.remove(); edit.remove();
  t.diagnostic("2 张照片 × 2 态：read 的 .x/.ops/[data-del]/[data-cap]/textarea 全为空集合");
});

test("留言与照片走同一个 card：kind 只改文案与配文块，不改撤回/操作行", async (t) => {
  const ui = await boot(t, BASE);
  const { card } = ui.win.__t03;
  const txt = renderCard(ui.doc, card, T1, 0, "read");
  const pho = renderCard(ui.doc, card, P1, 0, "read");
  // 两种 kind 在 read 态的「可交互元素集合」必须完全一致：都是只读
  for (const sel of [".x", ".ops", "[data-del]", "[data-cap]", "[data-edit]", "textarea", "button"]) {
    assert.deepEqual(all(txt, sel), all(pho, sel).slice(0, all(txt, sel).length), `${sel} 在留言/照片两态不一致`);
  }
  assert.deepEqual(all(txt, "button"), [], "read 态的留言不该有任何按钮");
  // edit 态的留言仍然是「撤回 / 改一下」，不能被照片的「撤回 / 写一句」顶掉
  const te = renderCard(ui.doc, card, T1, 0, "edit");
  assert.ok(te.textContent.includes("改 一 下"), "留言的第二操作应仍是「改一下」，工单 02 的行为不能被顶掉");
  assert.equal(all(te, "[data-cap]").length, 0, "留言不该长出照片的「写一句」");
  txt.remove(); pho.remove(); te.remove();
  t.diagnostic("留言卡与照片卡的只读元素集合相同；edit 态第二按钮按 kind 分流");
});

/* ══════════ 6. 上传入口在常驻添加栏，不在墙底 ══════════ */

test("上传入口在 position:fixed 的常驻添加栏里，不是墙底", async (t) => {
  const ui = await boot(t, BASE);
  ui.click('[data-go="desk"]');

  const entry = ui.doc.querySelector('.addbar [data-add="photo"]');
  assert.ok(entry, "常驻添加栏里没有「照片」入口");
  assert.equal(ui.doc.querySelector('.wall [data-add="photo"]'), null, "上传入口出现在墙里了 —— 传第 11 张前要先滑 7 屏");
  assert.ok(ui.doc.querySelector('.addbar .add[data-add="text"]'), "常驻添加栏里「写几句」入口不见了");

  // 固定栏会遮内容，所以墙底必须留出 172px（design.md §6.3）
  const css = fs.readFileSync(CSS_FILE, "utf8");
  const addbar = css.match(/\.addbar\s*\{([^}]*)\}/);
  assert.ok(addbar && /position:\s*fixed/.test(addbar[1]), "添加栏不是 position:fixed —— 它会被滚走，等于没有入口");
  const padb = css.match(/\.pad-b\s*\{([^}]*)\}/);
  assert.ok(padb && /padding-bottom:\s*172px/.test(padb[1]), "墙底没留 172px，最后一张卡会被固定栏盖住");
  t.diagnostic("入口在 .addbar 内且 .addbar 是 fixed；.pad-b 留 172px");
});

/* ══════════ 7. 上传链路：压缩 → 摆正 → 编码 → 201 → 卡片 ══════════ */

test("上传：先按 EXIF 摆正再限长边，以 image/jpeg 0.72 编码，字段名 photo", async (t) => {
  const posted = { id: "e9", kind: "photo", body: null, ord: 4, created: 1759000000009, photo: { id: "p9", mime: "image/jpeg", w: 960, h: 1280 } };
  const ui = await boot(t, { ...BASE, "POST /api/upload": { status: 201, body: { entry: posted } } });
  ui.click('[data-go="desk"]');

  // 一张竖拍原图：4032×3024 的横缓冲 + orientation=6
  const file = fakeFile(jpegWithOrientation(6), 4032, 3024);
  ui.pick(file);
  await until(() => ui.doc.querySelector('.pframe img[src="/api/photo/p9"]'), "上传后卡没出现在墙上");

  assert.ok(ui.seen.includes("POST /api/upload"), "没有真的打 POST /api/upload");
  assert.deepEqual(ui.uploads.map((u) => u.fields), [["photo"]], "multipart 字段名必须是 photo");
  assert.deepEqual(ui.uploads.map((u) => u.contentType), [null],
    "手写 Content-Type 会把 boundary 顶掉，服务端拿不到分隔符");

  // 关键：必须显式要「原始方向」的像素，否则浏览器已经摆正一次，我们再转一次就歪了。
  // （opts 是 jsdom  realm 的对象，跨 realm 比原型会误判，所以只比字段。）
  assert.equal(ui.canvas.bitmapOpts.length, 1, "createImageBitmap 没有被调用");
  assert.equal(ui.canvas.bitmapOpts[0].imageOrientation, "none",
    "createImageBitmap 没传 imageOrientation:'none' —— 默认 'from-image' 会和我们的矩阵转两次");

  // 画布：orientation=6 转置后是 3024×4032 的竖幅，长边压到 1280 → 960×1280
  assert.equal(ui.canvas.toBlob.length, 1, "只该编码一次");
  assert.equal(ui.canvas.toBlob[0].type, "image/jpeg", "编码类型必须是 image/jpeg");
  assert.equal(ui.canvas.toBlob[0].quality, 0.72, "编码质量必须是 0.72");
  assert.deepEqual([ui.canvas.toBlob[0].w, ui.canvas.toBlob[0].h], [960, 1280], "画布尺寸不是 960×1280");

  // 矩阵：k = 960/3024，源 4032×3024 的 orientation=6
  const k = 960 / 3024;
  assert.deepEqual(ui.canvas.transform[0], [0, k, -k, 0, 3024 * k, 0], "摆正矩阵不对：orientation=6 应是顺时针 90°");
  assert.deepEqual(ui.canvas.draw[0], { x: 0, y: 0, w: 4032, h: 3024, srcW: 4032, srcH: 3024 },
    "drawImage 应按源的原始像素尺寸整张画");
  assert.deepEqual([ui.canvas.fill[0].w2, ui.canvas.fill[0].h2], [960, 1280], "JPEG 没有 alpha，编码前必须先铺白底");

  // 上传过程中不许新建定时器
  assert.equal(ui.timers.interval, 1, "上传过程中新建了 setInterval —— 全站只应有一个");

  // 成功后卡片上墙：4:5 竖幅框 + 唯一的取图路径
  assert.ok(ui.doc.querySelector('.pframe img[src="/api/photo/p9"]'), "上传成功的照片没渲染成卡片");
  // jsdom 没有排版引擎，4:5 只能断言「CSS 契约写死了」这一层；真实比例留给工单 06
  const css = fs.readFileSync(CSS_FILE, "utf8");
  const rule = css.match(/\.pframe\s*\{([^}]*)\}/);
  assert.ok(rule && /aspect-ratio:\s*4\s*\/\s*5/.test(rule[1]), "照片框必须是 4:5 竖幅");
  assert.ok(rule && /overflow:\s*hidden/.test(rule[1]), "照片框必须裁切（object-fit: cover）");
  t.diagnostic("EXIF=6 → 画布 960×1280；矩阵 [0,k,-k,0,3024k,0]；toBlob image/jpeg@0.72；字段 photo；定时器仍为 1");
});

test("取图地址只有 /api/photo/:id 一条路径", async (t) => {
  // 只数代码：注释里复述这条契约不算一条路径（app.js 里就有一处注释）
  const code = fs.readFileSync(APP_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const hits = code.match(/\/api\/photo\//g) || [];
  assert.equal(hits.length, 1, `app.js 的代码里出现了 ${hits.length} 处 /api/photo/ 取图路径 —— 只能有一条`);
  assert.ok(!/\/(uploads|photos|public)\//.test(code), "代码里出现了第二个可能的照片目录");

  const ui = await boot(t, BASE);
  const { card, photoSrc } = ui.win.__t03;
  assert.equal(photoSrc({ id: "p3" }), "/api/photo/p3", "取图地址形状不对");
  const box = renderCard(ui.doc, card, P1, 0, "read");
  const imgs = all(box, "img");
  assert.equal(imgs.length, 1, "一张照片卡只该有一张图");
  assert.ok(imgs[0].getAttribute("src").startsWith("/api/photo/"), "照片卡里的图不是走鉴权接口的");
  box.remove();
  t.diagnostic("app.js 中 /api/photo/ 出现 1 次；照片卡 img src = /api/photo/p3");
});

test("撤回照片：角标与操作行都打到 DELETE，撤回后从墙上消失", async (t) => {
  const ui = await boot(t, { ...BASE, "DELETE /api/entry/e7": { status: 204 } });
  ui.click('[data-go="desk"]');
  assert.ok(ui.doc.querySelector('.pframe img[src="/api/photo/p3"]'), "自己那张照片没上墙");

  ui.click('.letter .x[data-del="e7"]');
  await until(() => !ui.doc.querySelector('.pframe img[src="/api/photo/p3"]'), "撤回后照片还在墙上");
  assert.ok(ui.seen.includes("DELETE /api/entry/e7"), "没有真的打 DELETE /api/entry/e7");
  assert.ok(ui.doc.querySelector('.pframe img[src="/api/photo/p4"]'), "撤回应只撤这一张，另一张还在");
  t.diagnostic("角标撤回命中 e7，p4 不受影响");
});

test("给照片写一句：走 PATCH 同一个条目接口，不是新端点", async (t) => {
  const CAP = "在阳台上拍的，风很大";
  const ui = await boot(t, { ...BASE, "PATCH /api/entry/e7": { status: 200, body: { entry: { ...P1, body: CAP } } } });
  ui.click('[data-go="desk"]');
  ui.click('[data-cap="e7"]');
  ui.fill('form[data-form="edit"] [data-body]', CAP);
  ui.submit('form[data-form="edit"]');
  // 配文用一句墙上原本没有的，否则条件一开始就成立，会在重绘之前就往下走
  await until(() => ui.text().includes(CAP), "写完的配文没出现在卡上");
  assert.ok(ui.seen.includes("PATCH /api/entry/e7"), "配文没有走 PATCH /api/entry/:id");
  const caps = all(ui.doc.querySelector(".wall"), ".cap");
  assert.equal(caps.length, 2, `e7 写了配文后墙上应有两块配文（e7 与 e8），实际 ${caps.length}`);
  assert.ok(caps.some((c) => c.textContent.trim() === CAP), "新写的配文内容不对");
  t.diagnostic("写一句 → PATCH /api/entry/e7 → 墙上配文区从 1 块变 2 块");
});

test("非图片文件在浏览器端就被挡下，不打后端", async (t) => {
  const ui = await boot(t, { ...BASE, "POST /api/upload": { status: 201, body: { entry: P1 } } });
  ui.click('[data-go="desk"]');
  ui.pick({ name: "note.txt", type: "text/plain", size: 10, arrayBuffer: async () => new ArrayBuffer(0) });
  await until(() => ui.text().includes("只收图片"), "非图片文件没有给出提示");
  assert.ok(!ui.seen.includes("POST /api/upload"), "非图片也打给了后端 —— 白白浪费一次上传");
  t.diagnostic("text/plain 被前端拦下，POST /api/upload 未发出");
});

/* ══════════ 8. 结构性回归：定时器只有一个 / 没有第二条取图路径 ══════════ */

test("上传 + 换屏反复 render：全站仍然只有一个 setInterval", async (t) => {
  const ui = await boot(t, { ...BASE, "POST /api/upload": { status: 201, body: { entry: P1 } } });
  assert.equal(ui.timers.interval, 1, "启动就不该多于一个 setInterval");
  ui.click('[data-go="desk"]');
  ui.pick(fakeFile(jpegWithOrientation(8), 3024, 4032));
  await until(() => ui.canvas.toBlob.length === 1, "上传没有走完");
  for (let i = 0; i < 5; i++) ui.win.__t03.render();
  assert.equal(ui.timers.interval, 1, "render() 里建了 setInterval —— 原型踩过，每次重绘泄漏一个");

  // orientation=8：源 3024×4032 竖缓冲转成 4032×3024 横幅 → 画布 1280×960
  await until(() => ui.canvas.toBlob.length === 1, "编码还没落");
  assert.deepEqual([ui.canvas.toBlob[0].w, ui.canvas.toBlob[0].h], [1280, 960], "orientation=8 的画布尺寸不对");
  assert.equal(ui.timers.interval, 1, "换屏与上传过程中又建了 setInterval");
  t.diagnostic("上传(orientation=8) → 画布 1280×960；5 次 render 后定时器仍为 1");
});

/* ── 纯函数直接从真脚本里取：不经 jsdom 也能跑，所以它不能依赖 window ──
   只把「启动」那一行与导出缝摘掉，剩下的顶层代码原样执行
   （document / setInterval 给打桩，顶层只调 document.addEventListener）。 */
function pure() {
  const src = fs.readFileSync(APP_FILE, "utf8");
  const body = src
    .replace(/^const ready = boot\(\);?$/m, "const ready = null;")
    .replace(/^window\.__t0[23] = [\s\S]*?^};?$/m, "");
  const noop = () => {};
  const out = {};
  new Function("out", "document", "setInterval", "window", `${body}
    out.exifOrientation = exifOrientation;
    out.exifTransform = exifTransform;
    out.targetSize = targetSize;
    out.swapAxes = swapAxes;
    out.photoSrc = photoSrc;
    out.MAX_EDGE = MAX_EDGE;
    out.QUALITY = QUALITY;
  // window 也要给 addEventListener：pageshow 只在 window 上派发
  // （见 app.js 的 bfcache 兜底），传空对象会直接 TypeError。
  `)(out, { addEventListener: noop, querySelector: () => null }, noop, { addEventListener: noop });
  return out;
}

/** 造一个假 File：jsdom 的 file input 不接受真 File 注入，但应用只用到这四样 */
function fakeFile(bytes, w, h, type = "image/jpeg") {
  return { name: "IMG_0001.jpg", type, size: bytes.length, __w: w, __h: h, arrayBuffer: async () => bytes.buffer };
}
