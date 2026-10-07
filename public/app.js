/**
 * 工单 04 · 阅读流与共同层 —— 前端（在工单 02/03 的四屏之上开门后的一整条阅读流）
 *
 * ── 工单 06 追加：可靠性 ──
 *   1. call() 把「请求没发出去」变成 status 0 而不是异常：一次断网不再把整屏带走。
 *   2. load() 在 status 0 时**就地返回**：已经读出来的内容一件都不清空（不白屏）。
 *      服务端真给了回包才照它说的改 —— 401 照样退出会话，时间锁照样 fail closed。
 *   3. 断网提示条 #netbar 建在 #app 之外，只插一次，不需要定时器；可点「重 试」。
 *   4. 图片 error 用捕获阶段的 document 委托统一收，原地换成占位块并把尺寸带过去，
 *      框还在、比例还在、布局不塌陷（不是灰色方块）。
 *   5. 断网 / 恢复网络各一条事件（事件不是定时器：全站仍然只有一个 setInterval）。
 *
 * 四屏：封印 seal → 身份 who → 密码 pass → 布置台 desk（留言 + 照片）。
 * 开门后**同一个入口**变成阅读流 reading（原型 ui-v4.html：desk 路由按 open() 分流）：
 * 首屏薄荷绿 → 我们的两年（九宫格 + 那段话 + 准确日期区间）→「TA留给你的」天蓝转场
 * → 一封信 → 照片信卡 → 最后一段话。
 *
 * 阅读端的照片卡**没有第二个渲染器**：走的是工单 03 的 card(e, i, "read")（CONSTRAINTS.md §4）。
 *
 * 三条硬约束（design.md §八 / CONSTRAINTS.md §1）：
 *   1. 开门时刻硬编码东八区，不读设备时区（见下面 UNLOCK_AT 的三种写法注释）。
 *   2. 全站只有一个 setInterval，且建在模块顶层而不是 render() 里。
 *      原型踩过这个坑：定时器建在 render() 内，每次重绘泄漏一个，每秒一个。
 *      放大层同样不许建：它是事件驱动的，切进切出阅读流不新建任何定时器。
 *   3. 未解锁时界面上不得出现共同层内容、对方内容、任何「已解锁」字样。
 *      未解锁时 load() 连 /api/shared 都不请求，theirs 也**不取**：
 *      即使服务端哪天破了那道门，前端也没有一条把对方/共同层画出来的代码路径。
 *
 * 接口契约以 `docs/contracts/02-时间锁·文字层.md` 与
 * `04-阅读流与共同层.md` 为准，且只在这一个地方（API + call）定义。
 */
"use strict";

/* ── 取文案 ──────────────────────────────────────────────────────────
   全部用户可见的字符串都在 src/copy.js（数据源）里，经 public/copy.js
   挂到 window.COPY。这里是**唯一**一个从 COPY 取值的地方，形状刻意做成
   `cp("a.b.c")` 的字面量键 —— scripts/check-copy.mjs 静态扫的就是这个形状，
   少一个键它就退出非 0。

   **缺键不抛**：分工在 src/copy.js 顶部写死了——键缺失由构建期的门禁挡住，
   运行时再抛就只剩「把某一处少几个字」升级成「整页白屏」这一个作用。
   10-5 当天宁可少几个字，也不要白屏。

   它与 src/copy-get.js 里的同名函数是同一套语义（键路径 + {name} 填值 +
   缺键返回空串）；test/ticket-08-copy.test.js 逐条对过两个实现的结果一致。
   为什么这里手写而不用 import：app.js 是不带 module 的传统脚本，
   而这张页面不允许有任何构建期依赖。 */
const cp = (key, vars) => {
  const v = String(key).split(".").reduce((o, k) => (o == null ? o : o[k]), window.COPY);
  if (v == null) return "";
  if (typeof v === "object") return v;                       // wish.options 那种数组原样返回
  if (vars === undefined) return v;
  // 没给值的占位符填空串，而不是把花括号留在屏幕上
  return String(v).replace(/\{(\w+)\}/g, (_m, n) => (vars[n] == null ? "" : String(vars[n])));
};

/* ── 开门时刻 ────────────────────────────────────────────────────────
   ✅ 唯一允许的形态。❌ new Date("2026-10-05") 按 UTC 解析，会提前 8 小时开门；
   ❌ getFullYear() / getMonth() / toLocaleString() 随设备时区漂移。
   与服务端 src/clock.js 用同一个常量，两边结论必须一致。 */
const UNLOCK_AT = Date.UTC(2026, 9, 5, 0, 0, 0) - 8 * 3600 * 1000;

/* 全站只用代号，不出现真名。code 是登录时提交给后端的值（"【改这里：doorCode】" / "【改这里：heroCode】"）——
   它是 person 表里的身份数据，**不是文案**，所以留在这里。
   身份卡上那个小标签（【改这里：girlfriend】 / 【改这里：boyfriend】）是措辞，在 COPY.identity.roles 里。 */
const CODES = {
  door: { code: "【改这里：doorCode】" },
  hero: { code: "【改这里：heroCode】" },
};

/* 身份代号 → 身份卡上的那个角色称谓。
   `who` 的含义有坑，见 pass() 里的注释：要报的是**对方**的角色。
   两处都是字面量键，check-copy 才核得动。 */
const roleOf = (id) => (id === "hero" ? cp("identity.roles.hero") : cp("identity.roles.door"));
/** 对方是谁（TA）：与 roleOf 同一套映射，方向反过来。 */
const otherOf = (id) => (id === "door" ? "hero" : "door");

/* 约定的预填选项在 COPY.wish.options（src/copy.js）。
   **选项不是围栏**：下面始终跟着一个自己写的输入框（design.md §四 .pick）。 */

/* 单条约定的字数上限，与服务端 MAX_WISH 同值。两边不一样就会出现
   「前端数着没超、后端说超了」这种没法解释的 400。 */
const MAX_WISH = 200;

/* 形象素材（原型资产，逐张的构图分流见 design.md §3.1）。
   注意：文件本体在 prototype/yier-bubu/，需要由 public/ 提供同名目录才能被静态服务命中。 */

/* ⚠️ **身份形象：白熊 = 【改这里：doorCode】（【改这里：girlfriend】），褐熊 = 【改这里：heroCode】（【改这里：boyfriend】）。**
   2026-10-02 由用户定死。之前三处全挂反了（白挂【改这里：heroCode】、褐挂【改这里：doorCode】），
   identity 页、密码页、合照组无一例外——在密码页上尤其要命：
   选完身份、看到的却不是自己刚点的那个角色。

   **为什么起名带身份、不叫 tl/tr**：`tl`/`tr` 只是位置，
   位置名早晚会被后人「顺手对调」以为在调布局。名字里写着 door/hero，
   对调的那天 grep 一下就露馅。
   `design.md §3.1` 只按构图分流、**不定身份**，所以这个映射只写在这里与 design.md §3.1。 */
const WHO_IMG = {
  door: "yier-bubu/bb07.jpg",   // 白熊
  hero: "yier-bubu/bb08.jpg",   // 褐熊
};

const IMG = {
  /* 合照组：**左 = 【改这里：doorCode】（白）· 右 = 【改这里：heroCode】（褐）**，与 WHO_IMG 同一套映射。
     封印页与阅读首屏用它，它同时也是别人第一眼看到「我们俩」的地方。 */
  duoL: "yier-bubu/bb02.jpg",   // 白熊
  duoR: "yier-bubu/bb03.jpg",   // 褐熊
  foot: "yier-bubu/bb04.jpg",
  st1: "yier-bubu/bb09.png",   // 皇冠 + 爱心 + 小花 · 白底 → 照片卡
  st2: "yier-bubu/bb10.jpg",   // 棕熊头像 · 浅粉底 → 圆形
  st3: "yier-bubu/bb11.jpg",   // 举望远镜看两个白熊 · 薄荷绿底 → 圆形（阅读首屏左下）
  st4: "yier-bubu/bb12.jpg",   // 皮套装 + 粉心蓝星 · 白底 → 照片卡
  st5: "yier-bubu/bb13.jpg",   // 白熊抱小棕熊 · 白底 → 圆形（「我们的两年」标题行右侧）
};

/* ── 接口契约：只在这里定义一次 ──────────────────────────────────── */
const API = {
  me:     { method: "GET",    path: "/api/me" },
  status: { method: "GET",    path: "/api/status" },
  login:  { method: "POST",   path: "/api/login" },
  logout: { method: "POST",   path: "/api/logout" },
  list:   { method: "GET",    path: "/api/entry" },
  create: { method: "POST",   path: "/api/entry" },
  patch:  { method: "PATCH",  path: (id) => `/api/entry/${encodeURIComponent(id)}` },
  remove: { method: "DELETE", path: (id) => `/api/entry/${encodeURIComponent(id)}` },
  upload: { method: "POST",   path: "/api/upload" },
  /* 共同层：photos[9] / blessing / from / to / days（契约见 04 号工单）。
     未解锁时服务端 404；前端也**只在开门后**才请求它。 */
  shared: { method: "GET",    path: "/api/shared" },
  /* 约定（工单 05）：读双方各一条，未解锁 404；写允许提前做（她要能提前折好）。 */
  wish:    { method: "GET",    path: "/api/wish" },
  wishSet: { method: "POST",   path: "/api/wish" },
  /* 观察者旁路（测试专用，CONSTRAINTS §2b）：口令换凭据 → 一次读共同层 + 双方 + 约定。
     **不受时间锁约束**，也只有 GET / POST 进门与出门三条路 —— 没有写、没有改、没有撤。
     照片字节**不走这里**：取图仍然只有 /api/photo/:id 一条（服务端在那条路上多认一种凭据）。 */
  observeLogin:  { method: "POST", path: "/api/observe" },
  observeList:   { method: "GET",  path: "/api/observe" },
  observeLogout: { method: "POST", path: "/api/observe/logout" },
};

/* 网络状态：'unknown' 还没问过 · 'ok' 刚拿到过回包 · 'offline' 请求压根没发出去。
   单独记一份，是因为**问不到**和**服务端说了不要**必须分开处理：
   前者不许清空已经读出来的内容（10-5 当天在地铁里，一屏空白等于礼物坏了），
   后者必须照它说的改。 */
const NET = { state: "unknown" };

async function call(spec, id, body) {
  const init = { method: spec.method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    // multipart 的 boundary 只能由浏览器自己写。手写 Content-Type 会把它顶掉，
    // 服务端 multer 拿不到分隔符，表现为「文件字段丢失」而不是一个能读的报错。
    init.body = body;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(typeof spec.path === "function" ? spec.path(id) : spec.path, init);
  } catch {
    // 断网 / 超时 / DNS 不通：请求没发出去，**不往上抛**。
    // 抛出去的话，一次 fetch 失败会把已经画好的整屏一起带走 —— 那就是白屏。
    // status 0 是「网络层失败」的标记：与 401/404/500 这类「服务端说了什么」区分开。
    NET.state = "offline";
    return { ok: false, status: 0, data: null };
  }
  NET.state = "ok";                                              // 拿到回包 = 网络是通的（哪怕 500）
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { data = null; }     // 204/空体/坏字节不炸
  }
  return { ok: res.ok, status: res.status, data };
}

/* ── 状态 ────────────────────────────────────────────────────────── */
const S = {
  screen: "seal",        // seal | who | pass | desk
  me: null,              // "door" | "hero"，本机选定的身份
  profile: null,         // GET /api/me 的响应；非空即已登录
  entries: [],           // 只装 mine
  count: 0,              // 进度感（/api/me 的 count）
  editor: null,          // {id:null|条目id, text} 写/改留言的草稿
  err: "",               // 密码页与操作失败时的提示
  say: "",               // 布置台顶部的中性提示（上传成功、正在压小…）
  note: "",              // 封印页的临时提示
  unlocked: false,        // 服务端判定的开门状态。fail closed：问不到就是「没开」
  theirs: [],            // 对方的条目，**只在开门后**才从 /api/entry.theirs 取
  shared: null,          // GET /api/shared 的共同层；未解锁时恒为 null
  wishes: [],            // GET /api/wish 的双方约定，**只在开门后**才取；拉不到恒为 []
  myWish: "",            // 我自己那一条。拉取失败时收尾靠它，见 wishCache()
  busy: false,
};

const here = () => !!S.profile;

/* 开门日期从 UNLOCK_AT 推出来，不写死字面量——常量一改，文案不会对不上 */
const UNLOCK_PARTS = (() => {
  const t = new Date(UNLOCK_AT + 8 * 3600 * 1000); // 拨到东八区，再用 getUTC* 读（不读设备时区）
  const p = (n) => String(n).padStart(2, "0");
  return {
    md: `${p(t.getUTCMonth() + 1)} - ${p(t.getUTCDate())}`,
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    dotted: `${t.getUTCFullYear()} . ${t.getUTCMonth() + 1} . ${t.getUTCDate()}`,
  };
})();

/* 「10 月 5 日」这种写法。这里**刻意做成函数而不是模块顶层就拼好的字符串**：
   顶层读 window.COPY 会在「纯函数装置」（ticket-03 用打桩 window 重跑整份脚本）
   与脚本加载顺序上都变得脆，CONSTRAINTS §7 要求顶层只准碰 document.addEventListener。 */
const unlockHuman = () => cp("date.monthDay", { m: UNLOCK_PARTS.month, d: UNLOCK_PARTS.day });

/**
 * 开门状态**只**认服务端 `/api/status.unlocked`，且 fail closed。
 *
 * 曾经在这里退回过设备时钟（`S.unlocked === null ? Date.now() >= UNLOCK_AT : ...`），
 * 那是破的：status 请求失败 + 手机时钟已过开门时刻，整条阅读流骨架就会渲染出来。
 * CONSTRAINTS §1 原话是「服务端 404 了但前端还渲染占位文案，同样是破的」。
 * 问不到服务端 = 按没开处理，宁可少显示也不显示错的东西。
 */
const open = () => S.unlocked === true;

const q = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = (n) => String(n).padStart(2, "0");

const bub = (src, size, cls = "") =>
  `<img class="bub ${cls}" src="${esc(src)}" width="${size}" height="${size}" alt="" decoding="async">`;
const polaroid = (src, size, cls = "") =>
  `<span class="polaroid ${cls}"><img src="${esc(src)}" width="${size}" height="${size}" alt="" decoding="async"></span>`;

/* 倒计时：只算差值，不格式化日期，所以与运行机器的时区无关 */
function remain() {
  const d = Math.max(0, UNLOCK_AT - Date.now()) / 1000;
  return [Math.floor(d / 86400), Math.floor((d % 86400) / 3600), Math.floor((d % 3600) / 60), Math.floor(d % 60)];
}

/* 倒计时独立 tick：只改文本，不重建 DOM，所以不打断滚动与输入 */
function tick() {
  const r = remain();
  document.querySelectorAll("[data-cdu]").forEach((n) => { n.textContent = pad(r[+n.dataset.cdu]); });
  document.querySelectorAll("[data-cd]").forEach((n) => {
    // 倒计时那行是「N 天 HH:MM:SS」：天数后面那个单位词取自 units[0]，
    // 所以删掉「天」字要改的是 COPY，不是这里。
    n.textContent = open()
      ? cp("seal.countdown.opened")
      : `${r[0]} ${cp("seal.countdown.units")[0]} ${pad(r[1])}:${pad(r[2])}:${pad(r[3])}`;
  });
}

/* ── 照片：EXIF 方向 → 目标尺寸 → canvas 编码 ──────────────────────────
   契约在 docs/contracts/03-时间锁·文件层.md。
   下面 4 个函数是**纯函数**，不碰 DOM，可单独取证（test/ticket-03-frontend.test.js）。
   画布编码出来的字节 jsdom 验不了（没有 canvas），留给工单 06 真实浏览器。 */

/** 浏览器端先压到长边 1280（服务端兜底 1600），quality 固定 0.72 —— 两个值都写死，
 *  别让人以为能调：调了就会出现「同一张照片不同人上传大小差一截」。 */
const MAX_EDGE = 1280;
const QUALITY = 0.72;
const ERR_NO_CANVAS = "no_canvas";

/* 取图地址**只有这一条**：鉴权接口 /api/photo/:id。
   不写第二条 = 猜不到静态路径 = 时间锁没被绕过去（CONSTRAINTS.md §2）。 */
const photoSrc = (p) => `/api/photo/${encodeURIComponent(p.id)}`;

/* 5/6/7/8 要转置：摆正后的长宽与像素缓冲的长宽互为高低。
   手机竖拍存下来的是 4032×3024 的横缓冲 + orientation=6，不转就是躺着显示。 */
const swapAxes = (o) => o >= 5 && o <= 8;

/** EXIF 里的 IFD0 头（tag 0x0112）。返回 0 表示「这块字节里没读到方向」。 */
function tiffOrientation(b, t, end) {
  if (t + 8 > end) return 0;
  let le;
  if (b[t] === 0x49 && b[t + 1] === 0x49) le = true;         // "II" 小端
  else if (b[t] === 0x4d && b[t + 1] === 0x4d) le = false;    // "MM" 大端
  else return 0;
  const u16 = (i) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i) => (le
    ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
    : (((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0));
  if (u16(t + 2) !== 42) return 0;                            // TIFF magic
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return 0;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 0;                              // 截断：宁可当没有
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);                                  // SHORT 存在值域前两字节
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 0;
}

/** 从 JPEG 字节里读出 orientation（1..8）。读不到 / 不是 JPEG / 字节被截断，一律 1。
 *  宁可当成没旋转，也不要猜错方向——猜错等于把竖拍照片再歪 90°。 */
function exifOrientation(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 3 < b.length) {
    if (b[p] !== 0xff) { p += 1; continue; }
    const m = b[p + 1];
    if (m === 0xff) { p += 1; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (m === 0xda || m === 0xd9) break;                      // 到图像数据了，EXIF 不会再出现
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) break;
    const seg = p + 4, end = Math.min(seg + len - 2, b.length);
    if (m === 0xe1 && end - seg >= 14 &&
        b[seg] === 0x45 && b[seg + 1] === 0x78 && b[seg + 2] === 0x69 &&
        b[seg + 3] === 0x66 && b[seg + 4] === 0x00 && b[seg + 5] === 0x00) {
      const o = tiffOrientation(b, seg + 6, end);
      if (o) return o;
    }
    p = seg + len - 2;
  }
  return 1;
}

/** 源尺寸 → 画布尺寸。长边封顶，比例不变，两个边都至少 1px。
 *  不可用的输入退回上限而不是 0：0×0 的画布编出来是一张全黑的图，
 *  那比「多传一点字节」糟得多。 */
function targetSize(w, h, max = MAX_EDGE) {
  const lim = Math.max(1, Math.floor(max) || MAX_EDGE);
  let W = Math.round(Number(w)), H = Math.round(Number(h));
  if (!Number.isFinite(W) || W <= 0) W = lim;
  if (!Number.isFinite(H) || H <= 0) H = lim;
  const long = Math.max(W, H);
  const k = long <= lim ? 1 : lim / long;
  return { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)) };
}

/** 把源像素 (x,y) 摆正后映射到画布的仿射矩阵 [a,b,c,d,e,f]（即 setTransform 的六个参数）。
 *  X = a·x + c·y + e ；Y = b·x + d·y + f 。k 是统一缩放（= 画布长边 / 摆正后长边）。
 *  1 正立 · 2 左右翻 · 3 倒转 · 4 上下翻 · 5 转置 · 6 顺时针 90 · 7 反转置 · 8 逆时针 90 */
function exifTransform(o, sw, sh, k = 1) {
  const x = Math.max(1, sw) * k, y = Math.max(1, sh) * k;
  switch (o) {
    case 2:  return [-k, 0, 0, k, x, 0];
    case 3:  return [-k, 0, 0, -k, x, y];
    case 4:  return [k, 0, 0, -k, 0, y];
    case 5:  return [0, k, k, 0, 0, 0];
    case 6:  return [0, k, -k, 0, y, 0];
    case 7:  return [0, -k, -k, 0, y, x];
    case 8:  return [0, -k, k, 0, 0, x];
    default: return [k, 0, 0, k, 0, 0];      // 1 与读不到时都走正立
  }
}

/** 解码。createImageBitmap 必须显式 imageOrientation:"none"：
 *  它的默认值是 "from-image"，浏览器会**已经**把方向摆正，
 *  我们再转一次就是转两次 —— 竖拍照片会歪 90° 而不是被扶正。
 *  <img> 解码天生就是摆正后的，所以那条老路上方向按 1 算，不能再套矩阵。 */
async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "none" });
      return { src: bmp, w: bmp.width, h: bmp.height, exif: true };
    } catch { /* 退回 <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const el = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("decode_failed"));
      im.src = url;
    });
    return { src: el, w: el.naturalWidth || 1, h: el.naturalHeight || 1, exif: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 压成 JPEG Blob：先按 EXIF 摆正，再限长边，最后 toBlob 编码。
 *  顺带把画布的宽高回报出去（测试要断言「我们向画布要了多大一张」）。 */
async function encodePhoto(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const d = await decodeImage(file);
  const o = d.exif ? exifOrientation(bytes) : 1;

  const cv = document.createElement("canvas");
  const disp = swapAxes(o) ? { w: d.h, h: d.w } : { w: d.w, h: d.h };
  const t = targetSize(disp.w, disp.h, MAX_EDGE);
  cv.width = t.w; cv.height = t.h;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error(ERR_NO_CANVAS);
  ctx.fillStyle = "#ffffff";                                  // JPEG 没有 alpha，透明会变黑
  ctx.fillRect(0, 0, t.w, t.h);
  const k = t.w / disp.w;
  const m = exifTransform(o, d.w, d.h, k);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(d.src, 0, 0, d.w, d.h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", QUALITY));
  if (!blob) throw new Error(ERR_NO_CANVAS);
  return { blob, w: t.w, h: t.h, o, k };
}

/* ── 信卡：布置台与阅读端共用同一个渲染器 ────────────────────────────
   mode="edit" → 撤回角标 / 操作行（撤回·写一句·改一下）/ 配文是虚线输入框语气 /
                 封条「封存中」/ 没写配文时给输入提示占位
   mode="read" → 上面三者都不渲染 / 配文是实线浅底（是内容不是输入框）/
                 封条「已送达」/ 没写配文整块不渲染
   留言与照片走**同一个** card()：kind 决定头部文案与配文块，不决定要不要撤回角标。
   两端同源（CONSTRAINTS.md §4）：另写一个只给上传用的渲染器就是判 FAIL。 */
const ROTS = ["-.4deg", ".35deg", ".3deg", ".4deg", "-.3deg", "-.35deg"];

/* 封条：语气由 mode 决定，不看时间 —— 布置台「封存中」，阅读端「已送达」 */
const stamp = (edit) => `<span class="date">${edit ? cp("card.stamp.editing") : cp("card.stamp.reading")}</span>`;

const isPhoto = (e) => e.kind === "photo" && !!(e.photo && e.photo.id);

function card(e, i, mode) {
  const edit = mode === "edit";
  const kind = isPhoto(e)
    ? cp("card.kind.photo", { n: i + 1 })
    : cp("card.kind.text");
  // ro = 只读（阅读端）。同一个渲染器，只多一个语气类，样式分支由它接管
  return `<div class="letter${edit ? "" : " ro"}" style="--rot:${ROTS[i % ROTS.length]}">
    <div class="top"><span class="wax"></span>
      <span class="kind">${kind}</span>${stamp(edit)}</div>
    ${isPhoto(e) ? photoBlock(e, edit) : bodyBlock(e, edit)}
    ${ops(e, edit)}
  </div>`;
}

/* 照片块：4:5 竖幅照片框 + 撤回角标（只 edit）+ 配文。
   取图地址只走 photoSrc()，界面上不出现第二条路径。 */
function photoBlock(e, edit) {
  const body = (e.body || "").trim();
  const x = edit ? `<button class="x" data-del="${esc(e.id)}" aria-label="${cp("a11y.removeCard")}">×</button>` : "";
  let cap;
  if (edit && S.editor && S.editor.id === e.id) cap = editorForm(e.id, body);   // 正在写这一句
  else if (body) cap = `<div class="cap${edit ? "" : " cap-real"}">${esc(body)}</div>`;
  else if (edit) cap = `<div class="cap ph-cap">${cp("card.captionHint")}</div>`;
  else cap = "";                                                               // read 态没配文：整块不渲染
  return `<div class="pframe">
      <img class="ph" src="${esc(photoSrc(e.photo))}" alt="" loading="lazy" decoding="async">
      ${x}
    </div>${cap}`;
}

function ops(e, edit) {
  if (!edit) return "";
  const second = isPhoto(e) ? cp("card.ops.writeOne") : cp("card.ops.editOne");
  const attr = isPhoto(e) ? "cap" : "edit";
  return `<div class="ops"><button data-del="${esc(e.id)}">${cp("card.ops.withdraw")}</button>
    <button data-${attr}="${esc(e.id)}">${second}</button></div>`;
}

function bodyBlock(e, edit) {
  if (edit && S.editor && S.editor.id === e.id) return editorForm(e.id, e.body || "");
  return `<div class="body">${esc(e.body || "")}</div>`;
}

function editorForm(id, text) {
  return `<form class="composer" data-form="edit" data-id="${esc(id)}">
    <div class="h">${cp("composer.edit.title")}</div>
    <textarea data-body rows="3" maxlength="1000" aria-label="${cp("composer.a11y")}">${esc(text)}</textarea>
    <div class="composer-ops">
      <button type="button" data-cancel="1">${cp("composer.cancel")}</button>
      <button type="submit" class="btn-solid">${cp("composer.edit.submit")}</button>
    </div>
  </form>`;
}

function newForm() {
  if (!S.editor || S.editor.id) return "";
  return `<form class="composer" data-form="new">
    <div class="h">${cp("composer.new.title")}</div>
    <textarea id="new-body" data-body rows="3" maxlength="1000"
      placeholder="${cp("composer.new.placeholder")}" aria-label="${cp("composer.new.placeholder")}"></textarea>
    <div class="composer-ops">
      <button type="button" data-cancel="1">${cp("composer.cancel")}</button>
      <button type="submit" class="btn-solid">${cp("composer.new.submit")}</button>
    </div>
  </form>`;
}

/* ══════════ 封印页 ══════════ */
function seal() {
  const isOpen = open();
  return `<div class="screen seal">
    <div class="seal-body">
      ${polaroid(IMG.st1, 54, "st-seal-l")}
      ${bub(IMG.st2, 64, "st-seal-r")}
      <div class="duo">
        <span class="l">${bub(IMG.duoL, 104)}</span>
        <span class="r">${bub(IMG.duoR, 104)}</span>
      </div>
      <h1>${cp("hero.title")}</h1>
      <div class="sub">${cp("seal.dates")}</div>
      <div class="sealbox" id="box">
        <div class="in">${cp("seal.envelope")}</div>
        <div class="tape">${isOpen
          ? cp("seal.tape.unlocked")
          : cp("seal.tape.locked", { md: UNLOCK_PARTS.md })}</div>
      </div>
      <div class="nudge" id="nudge">${esc(S.note || (isOpen ? cp("seal.note.unlocked") : cp("seal.note.locked")))}</div>
      ${isOpen
        ? `<div class="kicker" style="opacity:.7">${cp("seal.kickerUnlocked", { dotted: UNLOCK_PARTS.dotted })}</div>`
        : `<div class="cd">${cp("seal.countdown.units").map((l, i) =>
            `<div class="u"><div class="n" data-cdu="${i}">--</div><div class="l">${l}</div></div>`).join("")}</div>`}
      ${here()
        ? `<button class="go" data-go="desk">${cp("seal.cta.authed")}</button>`
        : `<button class="go" data-go="who">${cp("seal.cta.anonymous")} <span class="arw">→</span></button>`}
    </div>
    <div class="seal-foot">${cp("seal.foot")}</div>
  </div>`;
}

/* ══════════ 身份页 ══════════ */
function who() {
  const cardOf = (k, img) => {
    const c = CODES[k];
    return `<button class="idcard" data-who="${k}">${bub(img, 54)}
      <span><span class="code">${c.code}</span><span class="role">${roleOf(k)}</span></span></button>`;
  };
  return `<div class="screen gate">
    <button class="back" data-go="seal">${cp("nav.back")}</button>
    <div class="col gate-body">
      <h2>${cp("identity.title")}</h2>
      <p class="hint">${cp("identity.hint")}</p>
      ${cardOf("door", WHO_IMG.door)}${cardOf("hero", WHO_IMG.hero)}
    </div>
  </div>`;
}

/* ══════════ 密码页 ══════════ */
function pass() {
  const c = CODES[S.me];
  // 要报的是**对方**的角色，不是自己的。早先这里写的是 `${c.who}`，于是
  // 【改这里：doorCode】那一屏显示「说出 【改这里：girlfriend】 的生日」——那是你自己的生日，照着输进不去。
  // 同一屏的 aria-label 与失败提示都写着「对方的生日」，三处自相矛盾。
  const other = CODES[S.me === "door" ? "hero" : "door"];
  return `<div class="screen gate">
    <button class="back" data-go="who">${cp("nav.back")}</button>
    <div class="col gate-body">
      <!-- 头像用**身份卡上那一只**，不是另挑一张：刚点完【改这里：doorCode】、下一屏
           看到的必须是同一个角色，否则两屏之间就得靠脑内对调一次。 -->
      <div style="text-align:center;margin-bottom:20px">${bub(WHO_IMG[S.me], 92)}</div>
      <h2>${c.code}</h2>
      <p class="hint">${cp("pass.hint", { who: roleOf(otherOf(S.me)) })}</p>
      <!-- ⚠️ autocomplete="one-time-code"，**不是** "off"。
           Chrome / Safari 在登录场景下不认 autocomplete="off"：照样弹「保存密码」、
           照样回填，于是她下次点一下就进去了，「每次都要选身份、验证自己」这条就没了。
           one-time-code 是规范里唯一明说「这不是凭据字段」的值，两个引擎都会跳过
           密码管理器的保存与回填。配合三件事才真正成立（缺一件就漏）：
             1. 唯一输入框**没有 name** —— 密码管理器凑不出「用户名 + 密码」这一对；
             2. 它**不在 form 里** —— 整站没有 form 包着它，提交/回填都无入口；
             3. type="tel" 而不是 password —— 数字键盘还在，但不进密码库。
           后果是她每次进来都得自己敲。**别把它「优化」回 autocomplete="off"。**
           （这段注释在模板字符串里：里面**不能出现反引号**，会当场截断字面量。） -->
      <input class="pin ${S.err ? "err" : ""}" id="pin" type="tel" inputmode="numeric" maxlength="12"
             placeholder="${cp("pass.placeholder")}" autocomplete="one-time-code" aria-label="${cp("pass.a11y")}">
      <div class="pmsg ${S.err ? "err" : ""}" id="pmsg">${esc(S.err)}</div>
      <button class="go" data-go="desk" style="width:100%;margin-top:22px">${cp("pass.submit")}</button>
    </div>
  </div>`;
}

/* ══════════ 布置台 · 信封墙 ══════════ */
function chip() {
  return open()
    ? `<span class="chip">${cp("desk.chip.unlocked", { code: CODES[S.me] ? CODES[S.me].code : "" })}</span>`
    : `<span class="chip">${cp("desk.chip.locked")} <b data-cd>--</b></span>`;
}

/* 布置台顶部的操作引导。
   位置在 .pad-b 的**最上面**：她进来第一眼就滑到它，而不是要先翻过整面墙。
   只在布置台出现 —— 开门后同一个入口已经是阅读流，那时候没有东西可折了。 */
function guide() {
  const items = cp("desk.guide.items")
    .map((it) => `<li><b>${esc(it.k)}</b>${esc(it.v)}</li>`).join("");
  return `<div class="guide">
    <div class="h">${esc(cp("desk.guide.title"))}</div>
    <ul>${items}<li><b>${esc(cp("desk.guide.seal.k"))}</b>${
      esc(cp("desk.guide.seal.v", { human: unlockHuman() }))}</li></ul>
  </div>`;
}

function desk() {
  // 照片排在留言前面（原型 ui-v4.html 的墙序）：墙是一个整体序列，i 同时当倾斜角与「第几张」用
  const wall = [...S.entries.filter(isPhoto), ...S.entries.filter((e) => !isPhoto(e))];
  const msg = S.err
    ? `<div class="pmsg err" id="desk-msg">${esc(S.err)}</div>`
    : S.say
      ? `<div class="pmsg" id="desk-msg">${esc(S.say)}</div>`
      : "";
  return `<div class="screen desk">
    <div class="col">
      <div class="desk-top">
        ${bub(WHO_IMG.door, 56, "decor decor-tl")}${bub(WHO_IMG.hero, 56, "decor decor-tr")}
        ${chip()}
        <h1>${cp("desk.title")}</h1>
        <p class="lead">${cp("desk.lead.top")}<br>${open()
          ? cp("desk.lead.unlocked")
          : cp("desk.lead.locked", { human: unlockHuman() })}</p>
        <p class="meta">${cp("desk.countLead")} <b>${S.count}</b> ${cp("desk.countTail")} <button class="linkish" data-logout="1">${cp("desk.logout")}</button></p>
      </div>
      <div class="pad-b">
        ${guide()}
        ${msg}
        ${wishForm()}
        ${newForm()}
        <div class="wall">
          ${wall.map((e, i) => card(e, i, "edit")).join("")}
          ${!S.entries.length ? `<div class="empty">${cp("desk.empty")}</div>` : ""}
          <div class="foot-bear">${bub(IMG.foot, 84)}${polaroid(IMG.st4, 48, "st-foot")}</div>
        </div>
      </div>
    </div>
    <div class="addbar"><div class="in">
      <button class="add" data-add="photo" type="button">
        <div class="p">${cp("addbar.plus")}</div><div class="t">${cp("addbar.photo.title")}</div>
        <div class="d">${cp("addbar.photo.desc")}</div></button>
      <button class="add" data-add="text" type="button">
        <div class="p">${cp("addbar.plus")}</div><div class="t">${cp("addbar.text.title")}</div>
        <div class="d">${cp("addbar.text.desc")}</div></button>
      <input id="pick-photo" type="file" accept="image/*" hidden>
    </div></div>
  </div>`;
}

/* ══════════ 阅读流 · 共同层（工单 04）══════════
   开门后同一个入口从布置台换成这一整条。顺序是契约：
   首屏薄荷绿 → 我们的两年（九宫格 + 那段话 + 准确日期区间）→ 「TA留给你的」天蓝转场
   → 一封信 → 照片信卡 → 最后一段话。 */

/* 九宫格固定 9 格（design.md §四 .grid3/.g）；素材不足时缺的格子走占位块 */
const SHOTS = 9;
/* 纪念日天数：与 /api/shared 的 days 同值，只在服务端没给时兜底。
   **731** —— 2024-10-05 记作第 1 天，2026-10-05 是第 731 天（**含首尾**）。
   这个数是**显示**用的，所以是 731；推起点要减的是下面的 SPAN，不是它。
   兜底也从常量推，不写死日期字面量。 */
const DAYS = 731;
/* 两个日期之间**相隔**多少天（不含首尾）= 730。与 src/shared.js 的 SPAN_DAYS 同值。
   ⚠️ 拿 DAYS 去减，起点会变成 2024-10-04 —— 界面显示一切正常，起点却错了一天。 */
const SPAN = DAYS - 1;

/** 开门那一天的年月日（东八区）。从常量推，不读设备时钟。 */
const unlockDay = (ms) => {
  const t = new Date(ms + 8 * 3600 * 1000);      // 拨到东八区，再用 getUTC* 读
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const UNLOCK_DAY = unlockDay(UNLOCK_AT);
const START_DAY = unlockDay(UNLOCK_AT - SPAN * 86400 * 1000);

/** "2024-10-05" → {y,m,d}。手拆字符串，不交给 new Date()：
    裸日期串按 UTC 解析，在东八区会显示成前一天 —— 与开门时刻同一个坑。 */
const dateParts = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
};
const dayLabel = (p) => (p ? cp("date.full", { y: p.y, m: p.m, d: p.d }) : "");

/** 日期区间以**服务端给的**为准；共同层还没就位时退回常量推出来的同一段日子。 */
function sharedRange() {
  const s = S.shared || {};
  return {
    from: dayLabel(dateParts(s.from) || START_DAY),
    to: dayLabel(dateParts(s.to) || UNLOCK_DAY),
    days: Number(s.days) > 0 ? Number(s.days) : DAYS,
  };
}

const shots = () => (S.shared && Array.isArray(S.shared.photos) ? S.shared.photos : []);

/* 共同层合照的取图：契约里 photos[] 元素的 id 是 shared 行 id（"sh1"），
   而 /api/photo/:id 收的是**文件 id**（photoId）。这里只搬字段，
   取图仍然只有 photoSrc() 这一条路 —— 不新增第二条取图路径。 */
const shotSrc = (p) => photoSrc({ id: p && (p.photoId || p.id) });

/* 占位块：五色轮转 + 虚线感边框 + 「待替换」标签，不是灰色方块（design.md §四） */
const ph = (i, label) => `<div class="ph p${((i % 5) + 5) % 5}"><span>${esc(label || cp("placeholder.pending"))}</span></div>`;

/* 九宫格：3×3 固定 9 格、1:1 方格。够不着素材的格子放占位块，布局不塌陷。 */
function grid3() {
  return `<div class="grid3">${Array.from({ length: SHOTS }, (_, i) => {
    const p = shots()[i];
    return p
      ? `<button class="g" data-lb-open="${i}" aria-label="${cp("a11y.zoomShot", { n: i + 1 })}">` +
          `<img class="gimg" src="${esc(shotSrc(p))}" alt="" loading="lazy" decoding="async" ` +
          `${GRID_RETRY_ATTR}="${GRID_RETRY}"></button>`
      : `<div class="g g-ph">${ph(i, cp("placeholder.shot"))}</div>`;
  }).join("")}</div>`;
}

/* ── 放大层（design.md §6.1）──────────────────────────────────────────
   环形翻页 / 三种关闭 / 桌面端 ← → / 打开时锁背景滚动。
   元素建在 #app 之外（render() 只重画 #app），且**只建一次**：
   它不进 render()，所以这里没有任何定时器。 */
const LB = { on: false, i: 0, list: [] };

function ensureLB() {
  if (q("#lb")) return;
  const el = document.createElement("div");
  el.className = "lb";
  el.id = "lb";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", cp("a11y.lightbox"));
  el.innerHTML = `<button class="lbnav" data-lb="prev" aria-label="${cp("a11y.prev")}">‹</button>
    <div class="lb-mid"><div class="lb-frame"></div><div class="lb-cnt"></div></div>
    <button class="lbnav" data-lb="next" aria-label="${cp("a11y.next")}">›</button>
    <button class="lbclose" data-lb="close" aria-label="${cp("a11y.close")}">×</button>`;
  document.body.appendChild(el);
}

function paintLB() {
  const el = q("#lb");
  if (!el) return;
  el.classList.toggle("on", LB.on);
  document.body.style.overflow = LB.on ? "hidden" : "";   // 打开时锁滚动，否则背景跟着动
  if (!LB.on) return;
  el.querySelector(".lb-cnt").textContent = `${LB.i + 1} / ${LB.list.length}`;
  const p = LB.list[LB.i];
  el.querySelector(".lb-frame").innerHTML = p
    ? `<img class="lb-img" src="${esc(shotSrc(p))}" alt="" decoding="async">`
    : ph(LB.i, cp("placeholder.shot"));
}

/** 环形：第 n 张再点 next 回到第 1 张，prev 同理。 */
function stepLB(d) {
  const n = LB.list.length;
  if (!n) return;
  LB.i = (LB.i + d + n) % n;
  return paintLB();
}
function openLB(i) {
  LB.list = shots();
  if (!LB.list.length) return;
  LB.on = true; LB.i = i;
  return paintLB();
}
function closeLB() { LB.on = false; return paintLB(); }

/* ── 阅读流 ───────────────────────────────────────────────────────── */
function reading() {
  const me = CODES[S.me] || CODES.door;
  const o = S.me === "door" ? "hero" : "door";          // TA 是谁
  const gifts = S.theirs.filter(isPhoto);               // 他留给她的照片
  const texts = S.theirs.filter((e) => e.kind === "text");
  const letter = (texts[0] || {}).body || "";            // 第一条留言 = 一封信
  const tail = texts.length > 1 ? (texts[texts.length - 1].body || "") : "";
  const r = sharedRange();
  const blessing = ((S.shared && S.shared.blessing) || "").trim();
  return `<div class="screen">
    <div class="rd-hero rd-mint">
      ${bub(IMG.st3, 86, "st-hero-l")}
      <div class="duo">
        <span class="l">${bub(IMG.duoL, 100)}</span>
        <span class="r">${bub(IMG.duoR, 100)}</span>
      </div>
      <div class="kicker">${cp("hero.kicker")}</div>
      <h1>${cp("hero.title")}</h1>
      <div class="s">${r.from} &nbsp;—&nbsp; ${r.to}<br>${cp("reading.anniversary")}</div>
      <div class="cue">${cp("reading.cue")}</div>
    </div>

    <div class="rd-warm">
      ${bub(IMG.st5, 56, "st-two-r")}
      <div class="col">
        <div class="sec-h"><div class="kicker">${cp("reading.twoYearsTitle")}</div></div>
        ${grid3()}
        ${shots().length ? `<div class="grid-tip">${cp("reading.zoomHint")}</div>` : ""}
        <div class="letter-big" style="margin-top:24px">
          <div class="in">
            ${blessing
              ? `<p class="rd-blessing">${esc(blessing)}</p>`
              : `<p class="rd-none">${cp("reading.blessing.empty")}</p>`}
          </div>
        </div>
        <div class="rd-range">${r.from} &nbsp;—&nbsp; ${r.to} &nbsp;·&nbsp; ${cp("reading.range", { days: r.days })}</div>
      </div>
    </div>

    <div class="rd-hero rd-sky rd-turn">
      <div class="kicker">${esc(CODES[o].code)} ${cp("reading.turn.kicker")}</div>
      <h1>${cp("reading.turn.title")}</h1>
      <div class="s">${cp("reading.turn.hint")}</div>
    </div>

    <div class="rd-warm rd-sec">
      <div class="col"><div class="letter-big"><div class="in">
        <div class="h">${cp("reading.letter.title")}</div>
        ${letter ? `<p>${esc(letter)}</p>` : `<p class="rd-none">${cp("reading.letter.empty")}</p>`}
      </div></div></div>
    </div>

    <div class="rd-warm rd-sec">
      <div class="col">
        <div class="rd-sub">${cp("reading.photos.title")}</div>
        ${gifts.length ? `<div class="rd-count">${cp("reading.photos.count", { n: gifts.length })}</div>` : ""}
        <div class="wall ro">${gifts.map((e, i) => card(e, i, "read")).join("")}</div>
        ${gifts.length ? "" : `<div class="empty">${cp("reading.photos.empty")}</div>`}
      </div>
    </div>

    ${tail ? `<div class="rd-warm rd-sec">
      <div class="col"><div class="letter-big"><div class="in">
        <div class="h">${cp("reading.tailTitle")}</div><p>${esc(tail)}</p>
      </div></div></div>
    </div>` : ""}

    ${wishSection()}

    <div class="rd-warm rd-foot-wrap">
      <div class="col">
        <div class="rd-foot">${esc(me.code)} ${cp("reading.foot")}</div>
      </div>
    </div>
  </div>`;
}

/* ══════════ 约定（工单 05）══════════
   阅读流的**收尾**，不是新页面：最后一段话之后就是它，两个人各一条并排出现。
   布置台上是「折」——预填选项点一下就存，也可以自己写一条不在选项里的；
   阅读端是「看」——两栏并排，只显示代号。 */

/** 一栏：代号 + 那一条正文。
 *  拉取失败时 S.wishes 是空的：我自己那一条**仍然要看得见**（收尾不能开天窗），
 *  对方的格子留白并说「还没选」。宁可少显示，也不显示没有的东西。 */
function wishSide(id) {
  const c = CODES[id] || { code: "" };
  const w = S.wishes.find((x) => x.id === id);
  const t = (w && typeof w.text === "string" && w.text) || (id === S.me ? S.myWish : "");
  return `<div class="side"><div class="who">${esc(c.code)}</div>
    <div class="v">${t ? esc(t) : cp("wish.reading.empty")}</div></div>`;
}

function wishSection() {
  const myId = S.me === "hero" ? "hero" : "door";     // 与 reading() 里的 me 同一套兜底
  const oId = otherOf(myId);
  const got = S.wishes.length > 0;
  return `<div class="rd-warm rd-sec rd-choice">
    <div class="col">
      <h2>${cp("wish.reading.title")}</h2>
      <p class="s">${cp("wish.reading.hint")}</p>
      <div class="both">${wishSide(myId)}${wishSide(oId)}
        <div class="both-note">${got ? cp("wish.reading.note.both") : cp("wish.reading.note.missing")}</div>
      </div>
    </div>
  </div>`;
}

/** 布置台上的折约定区。选中的那一条高亮，textarea 里始终是当前那一条。 */
function wishForm() {
  const cur = S.myWish;
  return `<div class="wish-box">
    <div class="h">${cp("wish.deskTitle")}</div>
    <div class="pick">${cp("wish.options").map((w) =>
      `<button type="button" data-pick="${esc(w)}"${w === cur ? ' class="on"' : ""}>${esc(w)}</button>`).join("")}</div>
    <form class="wish-own" data-form="wish">
      <textarea data-body rows="2" maxlength="${MAX_WISH}" aria-label="${cp("wish.own.a11y")}"
        placeholder="${cp("wish.own.placeholder")}">${esc(cur)}</textarea>
      <div class="composer-ops"><button type="submit" class="btn-solid">${cp("wish.own.submit")}</button></div>
    </form>
    <div class="wish-say">${cur ? cp("wish.say.done", { text: esc(cur) }) : cp("wish.say.idle")}</div>
  </div>`;
}

/* ── 约定：我自己那一条的本地镜像 ─────────────────────────────────────
   约定是「拉取一次」实现的（实时同步不在范围内，SPEC §Out of Scope）。
   那条接口挂了的时候，收尾要靠**已经存过**这件事本身撑住，不能开天窗。
   存本地镜像的只有我自己那一条：对方的答案永远不落本地，
   未解锁或断网时浏览器里也不该有任何一侧的对方内容。 */
const wishCache = {
  key: () => (S.me ? `wish:${S.me}` : ""),
  read() {
    const k = wishCache.key();
    if (!k) return "";
    // 沙箱 / 隐私模式 / file:// 下访问 localStorage 会直接抛，连取值那一下都可能炸：
    // 这里整体兜住，存不下就退化成「只有内存里那份」，功能不受影响。
    try { return window.localStorage.getItem(k) || ""; } catch { return ""; }
  },
  write(text) {
    const k = wishCache.key();
    if (!k) return;
    try { window.localStorage.setItem(k, text); } catch { /* 只留内存那份 */ }
  },
};

/** 折好一条约定。同一方再折是**覆盖**（服务端 wish 表以 person_id 为主键）。 */
async function saveWish(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) { S.err = cp("err.emptyText"); return render(); }
  const r = await call(API.wishSet, null, { text: t });
  if (!r.ok) return fail(r);
  S.err = "";
  S.myWish = t;
  wishCache.write(t);                                  // 存进去的那一份立刻进镜像
  if (S.wishes.length) S.wishes = S.wishes.map((w) => (w.id === S.me ? { ...w, text: t } : w));
  S.say = cp("toast.wishSaved");
  return render();
}

/** GET /api/wish 的白名单化：只留 {id, code, text} 三个字符串字段。
 *  拉不到就把 S.wishes 置空 —— 上层据此走「只显示我自己那一条」的收尾，不白屏。
 *  **网络层失败（status 0）除外**：断网时保留上一次读到的双方约定，
 *  地铁里重新打开页面也不该凭空多出「还没选」。 */
async function loadWish() {
  const r = await call(API.wish);
  if (r.status === 0) return S.wishes;               // 断网：保留上一次读到的
  const d = r.ok && r.data && typeof r.data === "object" ? r.data : null;
  const list = d && Array.isArray(d.wishes) ? d.wishes : [];
  const out = list
    .filter((w) => w && typeof w === "object" && (w.id === "door" || w.id === "hero"))
    // 就算服务端哪天多带了 role 或真名，到这一行为止也只剩代号与正文
    .map((w) => ({
      id: w.id,
      code: typeof w.code === "string" ? w.code : "",
      text: typeof w.text === "string" ? w.text : "",
    }));
  S.wishes = out;
  const mine = out.find((w) => w.id === S.me);
  if (mine && mine.text) { S.myWish = mine.text; wishCache.write(mine.text); }
  return out;
}

/* ── 图片加载失败：占位块，不是灰色方块（工单 06 · design.md §四 .ph）────
   10-5 当天除了白屏，第二种破相就是照片没读出来（对方网络差、图片被撤回、
   地铁里基站切换）。这里既不吞掉它，也不让它塌成一个空洞：
   把 <img> **原地**换成占位块，并把 <img> 上原有的 width/height 带过去，
   于是框还在 —— .pframe 仍是 4:5、九宫格仍是 1:1、形象图仍是原来那个直径。
   布局不塌陷，文字也还在（每条留言、每一段合照都还在原位）。

   <img> 的 error 事件**不冒泡**，所以用捕获阶段的 document 委托：
   照片信卡、九宫格、形象图、放大层里的图一处都不漏，也不用各写一遍 onerror。
   取图地址仍然只有 photoSrc() 一条 —— 这里只是不画那张图，不新增第二条路径。 */
/** 占位块的色与字：按它所在的位置认，不按文件名猜。 */
function fbTone(im) {
  if (im.closest(".grid3, .lb-frame")) return ["p3", cp("placeholder.shot")];
  if (im.closest(".pframe")) return ["p2", cp("placeholder.photo")];
  return ["p1", cp("placeholder.bub")];
}

function imgFallback(im) {
  if (!im.parentElement) return null;
  const [tone, label] = fbTone(im);
  // span 而不是 div：九宫格那一格是 <button>，按钮的内容模型只收短语内容
  const fk = document.createElement("span");
  fk.className = `ph ${tone} img-fb`;
  // 有 width/height 属性的（bub / polaroid）把尺寸原样带过来，盒子不会缩成一个点；
  // 没有的（.pframe / .g / .lb-frame 里的图）由 CSS 的 width/height:100% 撑满，
  // 外层容器的 aspect-ratio 照旧成立。
  const w = im.getAttribute("width");
  const h = im.getAttribute("height");
  if (w) fk.style.width = `${w}px`;
  if (h) fk.style.height = `${h}px`;
  fk.innerHTML = `<span>${esc(label)}</span>`;
  im.replaceWith(fk);
  return fk;
}

/* 破图占位块之前，九宫格那张先重试两次。
   占位块是**不可逆**的：imgFallback 一换，那一张在整场阅读里就一直是占位块。
   而九宫格是全站唯一一次**并发取九张图**的地方，也是唯一真出过瞬时失败的地方。

   ⚠️ 2026-10-04 归因更正。原先这里写的是「≥150KB 的那 5 张每次都被截断」，
   那是**症状**不是机制，会把下一个人引到「调前端 / 调超时」上去。真实原因是
   **nginx 的 proxy 缓冲临时目录权限错位**：worker 以 ubuntu 跑，而
   /var/lib/nginx/proxy 下的编号层目录是 www-data(uid 33)/700（7 月 3 日建的），
   响应体超内存缓冲要落盘时 EACCES —— 而**状态码 200 已经发出去了**，所以客户端
   收到的是「声明 N 字节、实到 N' 字节」的短 body，不是错误页。这解释了「有时候截断」：
   失败时已 flush 多少、nginx 是否回退 passthrough 都不确定。已 chown -R 修掉
   （证据 docs/evidence/nginx-proxy-temp-2026-10-04.json）。
   边界也不是 150KB，是 nginx 内存 proxy buffer 的容量：同批里 63KB 那张当场完整送达，
   101KB 那张被砍到 40KB。所以「≥150KB」这个数字是取样偏差，别再照它推理。

   这个重试**留着了**，但它的定位变了：它不再是「已知根因的补丁」，而是一层兜底 ——
   截断在响应层面伪装成成功，客户端唯一能察觉的信号就是解码失败。九宫格恰好是并发最高、
   一次坏掉就永久占位的地方，所以只有它值得为瞬时失败付 0.6s × 2。
   **别的图仍然一次失败就占位**：那个行为有测试钉着（ticket-06-images）—— 不顺手改它。 */

const GRID_RETRY_ATTR = "data-img-retry";
const GRID_RETRY = 2;

document.addEventListener("error", (e) => {
  const im = e.target;
  if (!im || im.tagName !== "IMG" || im.classList.contains("img-fb")) return;
  const left = Number(im.getAttribute(GRID_RETRY_ATTR) || 0);
  if (left > 0) {
    im.setAttribute(GRID_RETRY_ATTR, String(left - 1));
    const src = im.getAttribute("src");
    // 摘掉再挂回去：只写 im.src = src 在部分引擎里不会重新发起加载
    im.removeAttribute("src");
    setTimeout(() => { if (im.isConnected) im.setAttribute("src", src); }, 600);
    return;
  }
  imgFallback(im);
}, true);

/* ── 断网提示条（工单 06）─────────────────────────────────────────────
   建在 #app 之外（render() 不重画它），所以全程只插一次，也不需要任何定时器。
   提示只说「现在连不上、下面还能看」，不说「内容为空」——
   拿空列表冒充「没有内容」，等于把还能读的东西自己弄没了。 */
function ensureNet() {
  if (q("#netbar")) return;
  const el = document.createElement("div");
  el.id = "netbar";
  el.className = "netbar";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `<span class="nb-ico" aria-hidden="true">!</span>` +
    `<span class="nb-tx">${cp("offline.bar")}</span>` +
    `<button class="nb-retry" type="button" data-net-retry="1">${cp("offline.retry")}</button>`;
  document.body.appendChild(el);
}

function syncNet() {
  const el = q("#netbar");
  if (!el) return;
  const off = NET.state === "offline";
  el.classList.toggle("on", off);
  el.setAttribute("aria-hidden", off ? "false" : "true");
}

/* ── 背景音乐（2026-10-03）─────────────────────────────────────────────
   建在 #app 之外，理由和断网条一样：render() 把 #app 整个换掉，
   放在里面的 <audio> 每次重绘都会被重建一次 —— 音乐跟着从头开始。

   浏览器**禁止有声音频自动播放**（Chrome / Safari / iOS 全部），
   必须有一次用户手势之后才放得出来。所以「默认开启」在这里的真实含义是：
   进站先试一次 play()，放得出来就放；被拒就显示提示，
   并把她**第一次点页面任意处**当作那个手势。
   做不到「不点就响」—— 那是浏览器的规则，绕不过去，也不该绕。

   preload="none"：不进站就下 6MB，首屏与开门那一下不受它影响。
   音量默认 0.3：这是要陪她读很久的东西，不是一段要炸开的音效。
   她按掉之后记在 localStorage，下次进站仍然是关着的。 */
const MUSIC = { el: null, want: true, playing: false, blocked: false };

/** localStorage 在 jsdom 的 file:// 下**取值那一下就抛 SecurityError**，
    两处都包起来：读不到就用默认值，不让一个偏好设置把整页带崩。 */
function musicWasOff() {
  try { return localStorage.getItem("bgm") === "off"; } catch { return false; }
}
function musicRemember(on) {
  try { on ? localStorage.removeItem("bgm") : localStorage.setItem("bgm", "off"); } catch {}
}

function musicPlay() {
  const a = MUSIC.el;
  if (!a || typeof a.play !== "function") return;
  let p;
  try { p = a.play(); } catch { MUSIC.blocked = true; return musicSync(); }
  // 环境不支持、或根本没有真的开始（jsdom 的 play() 返回 undefined）：
  // 这种情况下**不假装成功**，也不假装失败 —— 状态留在原样，提示条不乱跳。
  if (!p || typeof p.then !== "function") return;
  p.then(() => { MUSIC.playing = true; MUSIC.blocked = false; })
   .catch(() => { MUSIC.playing = false; MUSIC.blocked = true; })
   .then(musicSync);
}

function musicPause() {
  const a = MUSIC.el;
  if (a && typeof a.pause === "function") { try { a.pause(); } catch {} }
  MUSIC.playing = false;
}

function musicSync() {
  const btn = q("#bgm-btn");
  if (btn) {
    btn.textContent = MUSIC.want ? cp("music.on") : cp("music.off");
    btn.setAttribute("aria-label", MUSIC.want ? cp("music.a11yOn") : cp("music.a11yOff"));
    btn.setAttribute("aria-pressed", String(MUSIC.want));
    btn.classList.toggle("on", MUSIC.want);
  }
  const hint = q("#bgm-hint");
  if (hint) {
    // 只在「她想要开、实际没响、而且是被浏览器拦下的」这三种同时成立时才提示。
    // 别的组合一律不提示：正在响的时候再弹一句是吵，离谱的是想关的人看到「轻触开启」。
    const show = MUSIC.want && !MUSIC.playing && MUSIC.blocked;
    hint.textContent = show ? cp("music.blocked") : "";
    hint.classList.toggle("on", show);
  }
  dwellerSync();     // 把手上那颗「还没响」的小点由同一个状态推出来，不另存一份
}

function musicToggle() {
  MUSIC.want = !MUSIC.want;
  musicRemember(MUSIC.want);
  if (MUSIC.want) musicPlay(); else musicPause();
  musicSync();
}

/* ══════════ 收纳（2026-10-03 晚）══════════
   收起态 = 右侧边缘一条竖排把手，展开 = 一小块面板，音乐开关与退出都在里面。

   为什么是「收起来」而不是「换个地方」：早先那颗开关常驻右上角，
   正好压住布置台顶部右上那只装饰熊与倒计时条（用户截图确认）。
   挪到中下方会撞底部添加栏，挪到左上会压另一只熊 —— 收起来是唯一
   既不挡任何内容、又随时拿得到的形状。

   退出收在这里而不是各屏各放一个：布置台原来在「已折好 N 件 ·」后面有一个行内退出，
   **解封后的阅读流一个都没有** —— 从那条路进去之后出不来。收进同一个组件，
   两种状态自然都有，判据也只有一个（有没有会话）。 */
const DW = { open: false };

/** 收纳的状态对齐。**只在有会话时**才给「退 出」——
    判据是 S.profile 而不是 S.screen：封印页也可能已登录（那时它显示「我先去布置」）。
    每一处查询都容得下 null：它在 ensureDweller() 之前就可能被 render() 调到。 */
function dwellerSync() {
  const out = q("#dw-out");
  if (out) out.hidden = !here();
  const panel = q("#dw-panel");
  if (panel) panel.hidden = !DW.open;
  const tab = q("#dw-tab");
  if (tab) {
    tab.setAttribute("aria-expanded", String(DW.open));
    tab.setAttribute("aria-label", DW.open ? cp("dweller.a11yClose") : cp("dweller.a11yOpen"));
    // 被浏览器拦下时给把手点一颗小点：收起状态下那句「轻触任意处」没人看得见，
    // 音乐就会一直不响，而她连「还没放出来」这件事都不知道。
    tab.classList.toggle("blocked", MUSIC.want && !MUSIC.playing && MUSIC.blocked);
  }
}

function dwellerSet(on) {
  DW.open = !!on;
  dwellerSync();
}

/** 整个收纳建在 #app 之外，只插一次 —— 放进去会被 render() 连同音乐一起重建。
 *  提示条**长在面板内部**，不做成浮在页面上的那一块：
 *  早先它是 body 上一个 fixed 元素，位置只能靠一堆 calc() 偏移去躲顶部装饰；
 *  收进面板之后它不挡任何内容，也不需要任何偏移 ——
 *  收起时那颗挂在把手上的小点就是它的替身（「还没响」这件事仍然看得见）。 */
function ensureDweller() {
  if (q("#dw")) return;
  const d = document.createElement("div");
  d.id = "dw";
  d.innerHTML = `
    <button id="dw-tab" type="button" aria-expanded="false" aria-controls="dw-panel"
      aria-label="${esc(cp("dweller.a11yOpen"))}">${esc(cp("dweller.tab"))}</button>
    <div id="dw-panel" class="dw-panel" role="group" aria-label="${esc(cp("dweller.title"))}" hidden>
      <div class="dw-h" aria-hidden="true">${esc(cp("dweller.title"))}</div>
      <div class="dw-row">
        <span class="dw-lbl" aria-hidden="true">${esc(cp("dweller.musicLabel"))}</span>
        <button id="bgm-btn" type="button" aria-pressed="true">${esc(cp("music.on"))}</button>
      </div>
      <div class="dw-row" id="dw-out" hidden>
        <button class="dw-out" type="button" data-logout="1">${esc(cp("dweller.logout"))}</button>
      </div>
      <div class="dw-hint" id="bgm-hint" role="status" aria-live="polite"></div>
    </div>`;
  document.body.appendChild(d);

  q("#dw-tab").addEventListener("click", (e) => { e.stopPropagation(); dwellerSet(!DW.open); });
  q("#bgm-btn").addEventListener("click", (e) => { e.stopPropagation(); musicToggle(); });

  // 点外面就收起。它常驻在右边缘，不收会一直挡着右半边。
  document.addEventListener("click", (e) => {
    if (!DW.open) return;
    if (e.target && e.target.closest && e.target.closest("#dw")) return;
    dwellerSet(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && DW.open) dwellerSet(false);
  });

  musicSync();
  dwellerSync();
}

function ensureMusic() {
  if (q("#bgm")) return;
  const a = document.createElement("audio");
  a.id = "bgm";
  a.loop = true;
  a.preload = "none";
  a.src = "/bgm.mp3";
  a.volume = 0.3;
  document.body.appendChild(a);
  MUSIC.el = a;
  MUSIC.want = !musicWasOff();

  // 她第一次碰页面 = 浏览器要的那一次手势。只装一次，装完就摘掉。
  document.addEventListener("pointerdown", function unlock(ev) {
    if (ev.target && ev.target.closest && ev.target.closest("#dw")) return;  // 点收纳本身走 click 那条路
    document.removeEventListener("pointerdown", unlock, true);
    if (MUSIC.want) musicPlay();
    musicSync();
  }, true);

  if (MUSIC.want) musicPlay();      // 进站先试一次：个别环境放行，就不用她动手
  else musicPause();
  musicSync();
}

/** 手动重试：再问一遍服务端，拿到什么显示什么。 */
async function retry() {
  NET.state = "unknown";
  syncNet();
  try {
    await load();
  } catch {
    NET.state = "offline";
  }
  syncNet();
  return render();
}

/* 断网 / 恢复网络各一条事件。事件不是定时器：全站仍然只有一个 setInterval。
   监听注册放在 boot() 里而不是模块顶层 —— 工单 03 取纯函数时把整份脚本用
   new Function 重跑一遍，那里的 window 是个空对象，只有 document 是打过桩的。 */
function ensureNetWatch() {
  if (ensureNetWatch.done) return;
  ensureNetWatch.done = true;
  window.addEventListener("offline", () => { NET.state = "offline"; syncNet(); });
  // 恢复网络时顺手重问一次，免得她出了地铁还要自己动手刷新
  window.addEventListener("online", () => { retry(); });
}

/* ══════════ 观察者入口（测试专用 · CONSTRAINTS §2b）══════════
   一条**只读**的旁路：用一个单独的口令换凭据，一次看到共同层 + 双方内容 + 双方约定，
   不受时间锁约束。后端在 src/observe.js，降级的理由、边界与撤销方式写在 CONSTRAINTS.md §2b。

   与「两个人那条路」分开的四条硬规矩：
     1. **入口是 URL hash**（#observe）。hash 不会发到服务器、不进 nginx 访问日志。
        界面上**任何一处都不链到它、也不写出它**（印章页 / 布置台 / 阅读流 / 页脚都没有）——
        两个人不该知道自己还有一个旁路；这条由 test/observer-frontend.test.js 盯着。
     2. **不碰 S.me 与 S.theirs**。它们是正常那条路的两个全局：改了它们，退出旁路之后
        reading() 就会拿观察者看到的东西去画阅读流。旁路自己起一份 OB。
     3. **只读**。观察者视图里没有任何写操作：没有留言框、没有撤回、没有上传，
        连约定都只是显示。口令那一栏是唯一的输入框，进门之后它就不存在了。
     4. **不另写一套渲染**。双方的内容走 card(e, i, "read")（与阅读流同一个渲染器，
        CONSTRAINTS §4 的「三处同源」），共同层走 grid3() + sharedRange()，
        取图仍然只有 photoSrc() 一条路 —— 不新增第二条取图路径（CONSTRAINTS §3）。

   这四条里，第 4 条是最容易悄悄破的：另写一个「只给观察者」的渲染器，
   于是验的是另一份代码，照片能不能显示出来就与 TA 那天看到的不再是同一件事了。 */
const OBSERVE_HASH = "#observe";

const OB = {
  on: false,     // 当前这一屏是观察者视图
  err: "",       // 口令门上的提示
  data: null,    // GET /api/observe 白名单化之后的结果
  busy: false,
};

const observeOn = () => String((window.location || {}).hash || "") === OBSERVE_HASH;

/* 共同层的白名单化：与 loadShared() 同一套做法（photos 缺 id 的行直接丢掉，
   不然 shotSrc 会拼出 /api/photo/undefined）。 */
function obShared(s) {
  const d = s && typeof s === "object" ? s : {};
  return {
    photos: Array.isArray(d.photos)
      ? d.photos.filter((p) => p && typeof p === "object" && (p.photoId || p.id))
      : [],
    blessing: typeof d.blessing === "string" ? d.blessing : "",
    from: typeof d.from === "string" ? d.from : "",
    to: typeof d.to === "string" ? d.to : "",
    days: Number(d.days) || 0,
  };
}

/** 一条条目：形状与 /api/entry 的 mine 逐字同构，所以 card(e, i, "read") 能原样吃下它。 */
function obEntry(e) {
  const p = e.photo && typeof e.photo === "object" && e.photo.id ? e.photo : null;
  return {
    id: String(e.id || ""),
    kind: e.kind === "photo" ? "photo" : "text",
    body: typeof e.body === "string" ? e.body : "",
    ord: Number(e.ord) || 0,
    created: Number(e.created) || 0,
    photo: p
      ? { id: String(p.id), mime: String(p.mime || ""), w: Number(p.w) || 0, h: Number(p.h) || 0 }
      : null,
  };
}

/** 两侧固定按 door / hero 走，不靠 Object.keys 的键序：界面上并排的左右不能因为
    服务端哪天改了键序就调个个儿。 */
const OB_SIDES = ["door", "hero"];

async function loadObserve() {
  const r = await call(API.observeList);
  if (r.status === 0) { OB.data = null; OB.err = cp("observe.err.offline"); return null; }
  if (!r.ok) { OB.data = null; OB.err = cp("observe.err.gone"); return null; }
  const d = r.data && typeof r.data === "object" ? r.data : {};
  const sides = {};
  for (const id of OB_SIDES) {
    const s = d.sides && typeof d.sides[id] === "object" ? d.sides[id] : {};
    sides[id] = {
      code: String(s.code || ""),
      entries: (Array.isArray(s.entries) ? s.entries : []).map(obEntry),
    };
  }
  // grid3() / sharedRange() 读的是 S.shared，而复用它们是「不另写一套渲染」的前提，
  // 所以共同层先放进 S.shared。**出门时一起清掉**（observeHash 里的那一行），
  // 于是正常那条路在任何时刻都看不到观察者读到的这份共同层。
  S.shared = obShared(d.shared);
  OB.data = {
    sides,
    shared: S.shared,
    wishes: (Array.isArray(d.wishes) ? d.wishes : [])
      .filter((w) => w && typeof w === "object" && (w.id === "door" || w.id === "hero"))
      .map((w) => ({
        id: w.id,
        code: String(w.code || ""),
        text: typeof w.text === "string" ? w.text : "",
      })),
  };
  return OB.data;
}

/** 进门。401 的提示是**服务端给的**（COPY.err.server.wrongObserver），原样显示 ——
    部署时用错了口令，前端不该自己编一句比服务端更准的话。 */
async function observeEnter(pin) {
  const v = String(pin == null ? "" : pin).trim();
  if (!v) { OB.err = cp("observe.err.empty"); return renderObserve(); }
  OB.busy = true;
  renderObserve();
  const r = await call(API.observeLogin, null, { pin: v });
  OB.busy = false;
  if (!r.ok) {
    // 锁定要单独分支：429 的响应体里没有 hint，落到下面那行会显示成「凭据没了」
    if (r.status === 429) { OB.err = cp("err.locked", { n: (r.data && r.data.retryAfter) || 600 }); return renderObserve(); }
    if (r.status === 0) { OB.err = cp("observe.err.offline"); return renderObserve(); }
    OB.err = (r.data && r.data.hint) || cp("observe.err.gone");
    return renderObserve();
  }
  OB.err = "";
  await loadObserve();
  return renderObserve();
}

async function observeLeave() {
  await call(API.observeLogout);
  try { window.location.hash = ""; } catch { /* 改不动就算了：下面这趟照样把界面交回去 */ }
  return observeHash();
}

/** hash 变了就走一趟：进旁路就画旁路，出去就 load() 一次交回正常入口。
    两边都清干净 —— 观察者读到的东西一件都不留在正常那条路的状态里。 */
async function observeHash() {
  const want = observeOn();
  if (want === OB.on) return;
  OB.on = want;
  OB.err = ""; OB.data = null; OB.busy = false;
  S.shared = null;                 // 共同层是借 S.shared 放进去的，出门一起清
  closeLB();
  if (want) return renderObserve();
  try { await load(); } catch { S.note = cp("err.generic"); NET.state = "offline"; }
  return render();
}

/** 注册放在 boot() 里而不是模块顶层：CONSTRAINTS §7 说顶层只准碰
    document.addEventListener（工单 03 的纯函数装置拿打桩 window 重跑整份脚本）。 */
function ensureObserveWatch() {
  if (ensureObserveWatch.done) return;
  ensureObserveWatch.done = true;
  window.addEventListener("hashchange", () => { observeHash(); });
}

/* ── 观察者视图 ──────────────────────────────────────────────────────
   结构上刻意贴着阅读流：共同层 → 双方各一块 → 约定。窄屏并排的两块自动上下排。 */
function observeGate() {
  return `<div class="col gate-body ob-gate">
    <h2>${cp("observe.title")}</h2>
    <p class="hint">${cp("observe.hint")}</p>
    <form class="ob-pin" data-form="observe">
      <input class="pin ${OB.err ? "err" : ""}" id="ob-pin" data-pin type="tel" maxlength="64"
             placeholder="${cp("observe.pin")}" aria-label="${cp("observe.pin")}">
      <div class="pmsg ${OB.err ? "err" : ""}" id="ob-msg">${esc(OB.err)}</div>
      <button class="go" type="submit" data-ob="enter" style="width:100%;margin-top:22px"
              ${OB.busy ? "disabled" : ""}>${cp("observe.enter")}</button>
    </form>
  </div>`;
}

/** 一侧：标题是代号，下面逐条走 card(e, i, "read")。
    照片排在留言前面，与布置台的墙序一致；i 同时当倾斜角与「第几张」用。

    外层那行 flex 是内联的：并排/换行那套在 style.css 的 .both 上，而
    .both .side 的 190px 基准是给约定那两栏（白底小卡）写的。直接套它的话，
    信卡就会变成白底上摆白卡，层次全没了 —— 所以这里只借它的 flex 行，
    基准值照抄同一个 190px，窄屏同样自己落回上下两格。 */
function observeSide(id, side) {
  const wall = [...side.entries.filter(isPhoto), ...side.entries.filter((e) => !isPhoto(e))];
  return `<div class="ob-side" data-side="${id}" style="flex:1 1 190px">
    <div class="rd-sub">${esc(side.code)}</div>
    <div class="wall ro">${wall.map((e, i) => card(e, i, "read")).join("")}</div>
    ${wall.length ? "" : `<div class="empty">${cp("observe.empty")}</div>`}
  </div>`;
}

function observeWishes(d) {
  return OB_SIDES.map((id) => {
    const w = d.wishes.find((x) => x.id === id) || {};
    const t = String(w.text || "").trim();
    return `<div class="side" data-wish="${id}"><div class="who">${esc(w.code || (CODES[id] || {}).code || "")}</div>
      <div class="v">${t ? esc(t) : cp("observe.wishEmpty")}</div></div>`;
  }).join("");
}

function observeView() {
  const d = OB.data;
  if (!d) return `<div class="screen gate" id="observe">${observeGate()}</div>`;
  const r = sharedRange();
  const blessing = String(d.shared.blessing || "").trim();
  return `<div class="screen" id="observe">
    <div class="ob-top desk-top">
      <div class="col">
        <h1>${cp("observe.title")}</h1>
        <p class="meta"><button class="linkish" type="button" data-ob="leave">${cp("observe.leave")}</button></p>
      </div>
    </div>

    <section class="ob-shared rd-warm rd-sec">
      <div class="col">
        <div class="rd-sub">${cp("observe.shared")}</div>
        ${grid3()}
        ${shots().length ? `<div class="grid-tip">${cp("reading.zoomHint")}</div>` : ""}
        <div class="letter-big">
          <div class="in">
            ${blessing
              ? `<p class="rd-blessing">${esc(blessing)}</p>`
              : `<p class="rd-none">${cp("reading.blessing.empty")}</p>`}
          </div>
        </div>
        <div class="rd-range">${r.from} &nbsp;—&nbsp; ${r.to} &nbsp;·&nbsp; ${cp("reading.range", { days: r.days })}</div>
      </div>
    </section>

    <section class="ob-sides rd-warm rd-sec">
      <div class="col">
        <div class="rd-sub">${cp("observe.side")}</div>
        <div class="both">${OB_SIDES.map((id) => observeSide(id, d.sides[id])).join("")}</div>
      </div>
    </section>

    <section class="ob-wishes rd-warm rd-sec">
      <div class="col">
        <div class="rd-sub">${cp("observe.wishes")}</div>
        <div class="both">${observeWishes(d)}</div>
      </div>
    </section>
  </div>`;
}

function renderObserve() {
  q("#app").innerHTML = observeView();
  syncNet();
  if (!OB.data) q("#ob-pin")?.focus();
}

/* ══════════ 路由 ══════════ */
function render() {
  // 旁路与正常那条路互斥：hash 在 #observe 时，任何一次重画都画旁路那一屏，
  // 正常那四屏（封印 / 身份 / 密码 / 布置台·阅读流）一条都不许露出来。
  if (OB.on) return renderObserve();
  // 开门后同一个入口变成阅读流（原型 ui-v4.html 的 desk 路由分流）
  const view = { seal, who, pass, desk: () => (open() ? reading() : desk()) }[S.screen] || seal;
  q("#app").innerHTML = view();
  if (S.screen === "pass") q("#pin")?.focus();
  tick();                                          // 只改倒计时文本，不建定时器
  syncNet();                                        // 提示条在 #app 之外，跟着重画一次对齐状态
  dwellerSync();                                    // 收纳里的「退 出」跟着会话走：退出后它要立刻消失
  if (S.editor && !S.editor.id) q("#new-body")?.scrollIntoView?.({ block: "center" });
}

/* ══════════ 数据 ══════════ */
async function load() {
  // 开门状态向服务端要，不问设备时钟。拿不到就按没开处理（fail closed）
  const st = await call(API.status);
  S.unlocked = st.ok && typeof st.data?.unlocked === "boolean" ? st.data.unlocked : false;

  const me = await call(API.me);
  // 网络层失败（status 0）时**就地返回**：已经读出来的身份与折好的东西全部留在界面上。
  // 服务端真给了回包（哪怕 401）才照它说的改 —— 会话没了要退出，数据没了要清空。
  if (me.status === 0) return;
  S.profile = me.ok ? me.data : null;
  if (!S.profile) {
    S.me = null; S.entries = []; S.count = 0;
    return;
  }
  S.me = S.profile.id;
  S.count = S.profile.count || 0;
  // 我自己那一条的本地镜像先垫上：下面那次拉取要是失败，收尾不至于开天窗
  S.myWish = wishCache.read();
  const list = await call(API.list);
  if (list.status === 0) return;        // 同理：断网时墙上的一件都不许消失
  // 只取 mine：未解锁时 theirs 恒为 []，前端也**从不读它**
  S.entries = list.ok && Array.isArray(list.data?.mine) ? list.data.mine : [];
  // 对方的内容、共同层与约定**只在开门后**才取。未解锁时这三个字段连碰都不碰：
  // 服务端 404 了但前端还留着数据，那道门等于只挡了一半。
  S.theirs = open() && Array.isArray(list.data?.theirs) ? list.data.theirs : [];
  S.shared = open() ? await loadShared() : null;
  if (open()) await loadWish(); else S.wishes = [];
}

/** GET /api/shared 的白名单化：只留渲染要用的字段，缺 id 的照片行直接丢掉
 *  （不然 photoSrc 会拼出 /api/photo/undefined）。 */
async function loadShared() {
  const r = await call(API.shared);
  if (r.status === 0) return S.shared;                 // 断网：保留上一次读到的共同层
  const d = r.ok && r.data && typeof r.data === "object" ? r.data : null;
  if (!d) return null;
  return {
    photos: Array.isArray(d.photos)
      ? d.photos.filter((p) => p && typeof p === "object" && (p.photoId || p.id))
      : [],
    blessing: typeof d.blessing === "string" ? d.blessing : "",
    from: typeof d.from === "string" ? d.from : "",
    to: typeof d.to === "string" ? d.to : "",
    days: Number(d.days) || 0,
  };
}

function signout(note) {
  S.profile = null; S.me = null; S.entries = []; S.count = 0;
  S.theirs = []; S.shared = null; S.wishes = [];   // 退出后共同层、对方的内容与约定一起清掉
  S.myWish = "";
  S.editor = null; S.err = ""; S.say = ""; S.screen = "seal"; S.note = note || "";
}

/* 失败提示：能给人看的就说人话，不把后端的 error 码直接甩到屏幕上 */
function fail(r) {
  const e = r.data && typeof r.data === "object" ? r.data : {};
  // 网络层失败：说清楚是连不上，并说明已经折好的还在。别退出会话——
  // 会话真的没了是 401，会走到下一行；这里只是暂时够不着服务端。
  if (r.status === 0) { S.err = cp("err.offline"); return render(); }
  if (e.error === "no_session") { signout(cp("err.noSession")); return render(); }
  if (r.status === 429) { S.err = cp("err.locked", { n: e.retryAfter || 600 }); return render(); }
  if (r.status === 400) { S.err = cp("err.incomplete"); return render(); }
  if (r.status === 404) { S.err = cp("err.gone"); return render(); }
  S.err = e.hint || cp("err.generic");
  return render();
}

async function submitPin() {
  const v = (q("#pin")?.value || "").replace(/\D/g, "");
  if (!v) { S.err = cp("err.emptyBirthday"); return render(); }
  S.busy = true;
  const r = await call(API.login, null, { code: CODES[S.me].code, birthday: v });
  S.busy = false;
  if (!r.ok) {
    // 锁定必须在这里单独分支：`submitPin()` 不走 fail()（fail 会把整个会话
    // 按 401 处理），而 429 的响应体里没有 hint 字段。少了这一行，被锁 10 分钟的人
    // 看到的是「不对。试试对方的生日。」——她会以为自己又输错了，然后接着试。
    if (r.status === 429) {
      S.err = cp("err.locked", { n: (r.data && r.data.retryAfter) || 600 });
      return render();
    }
    S.err = (r.data && r.data.hint) || cp("err.wrongBirthday");
    return render();                       // 重绘顺带清空输入框并触发抖动
  }
  S.err = ""; S.screen = "desk"; S.note = "";
  await load();
  return render();
}

async function createEntry(body) {
  const r = await call(API.create, null, { kind: "text", body });
  if (!r.ok) return fail(r);
  S.editor = null;
  if (r.data?.entry) S.entries.push(r.data.entry);
  S.count = S.entries.length;
  return render();
}

async function patchEntry(id, body) {
  const r = await call(API.patch, id, { body });
  if (!r.ok) return fail(r);
  S.editor = null; S.err = ""; S.say = cp("toast.saved");
  if (r.data?.entry) S.entries = S.entries.map((x) => (x.id === id ? r.data.entry : x));
  return render();
}

async function removeEntry(id) {
  const r = await call(API.remove, id);
  if (r.status !== 204 && !r.ok) return fail(r);
  S.entries = S.entries.filter((x) => x.id !== id);
  if (S.editor && S.editor.id === id) S.editor = null;
  S.count = S.entries.length;
  S.err = ""; S.say = cp("toast.withdrawn");
  return render();
}

async function uploadPhoto(file) {
  if (!/^image\//.test(file.type || "")) { S.err = cp("err.notImage"); S.say = ""; return render(); }
  S.busy = true; S.err = ""; S.say = cp("toast.compressing");
  render();                                              // 只重绘，不建定时器
  let done;
  try {
    done = await encodePhoto(file);
  } catch (e) {
    S.busy = false; S.say = "";
    S.err = e && e.message === ERR_NO_CANVAS
      ? cp("err.noCanvas")
      : cp("err.decodeFailed");
    return render();
  }
  const fd = new FormData();
  fd.append("photo", done.blob, "p.jpg");                // 字段名固定 photo（契约）
  const r = await call(API.upload, null, fd);
  S.busy = false; S.say = "";
  if (!r.ok) return fail(r);
  if (r.data?.entry) S.entries.push(r.data.entry);
  S.count = S.entries.length;
  S.say = cp("toast.photoUploaded");
  return render();
}

async function logout() {
  await call(API.logout);
  signout(cp("err.loggedOut"));
  return render();
}

/* ══════════ 事件：全部委托到 document ══════════
   密码页是按需渲染的，绑定时 #pin 还不存在；直接绑节点会因短路而永不注册。 */
document.addEventListener("click", (e) => {
  const t = e.target && e.target.closest && e.target.closest("#box,[data-who],[data-go],[data-add],[data-del],[data-cap],[data-edit],[data-cancel],[data-logout],[data-pick],[data-net-retry],[data-ob]");
  if (!t) return;
  // 旁路自己那颗按钮。放最前面：它与正常四屏的按钮没有任何共同属性，
  // 早退掉才不会掉进下面 [data-go] / [data-logout] 那几支里去。
  if ("ob" in t.dataset) {
    if (t.dataset.ob === "leave") return observeLeave();
    return;              // 进门那个是 type=submit：交给下面的 form 提交，打两遍就是两次 POST
  }
  // 提示条上的重试：它在 #app 之外，但事件一样冒到 document，所以走同一条委托
  if ("netRetry" in t.dataset) return retry();
  if (t.id === "box") {
    t.classList.remove("shake"); void t.offsetWidth; t.classList.add("shake");
    q("#nudge").textContent = open() ? cp("seal.nudge.unlocked") : cp("seal.nudge.locked", { md: UNLOCK_PARTS.md });
    return;
  }
  if (t.dataset.who) { S.me = t.dataset.who; S.screen = "pass"; S.err = ""; return render(); }
  if (t.dataset.go) {
    if (t.dataset.go === "desk" && S.screen === "pass") return submitPin();
    S.screen = t.dataset.go; S.err = ""; S.say = ""; S.note = "";
    return render();
  }
  if (t.dataset.add === "photo") { q("#pick-photo")?.click(); return; }   // 入口在常驻添加栏里
  if (t.dataset.add) { S.err = ""; S.say = ""; S.editor = { id: null, text: "" }; return render(); }
  // 取消 / 退出用 `in` 判存在，不判真值：无值属性 data-x 的 dataset.x 是空字符串，
  // 判真值会让这两个按钮永远点不动。
  if ("cancel" in t.dataset) { S.editor = null; return render(); }
  if (t.dataset.cap) {
    const en = S.entries.find((x) => x.id === t.dataset.cap);
    if (en) { S.err = ""; S.editor = { id: en.id, text: en.body || "" }; }
    return render();
  }
  if (t.dataset.edit) {
    const en = S.entries.find((x) => x.id === t.dataset.edit);
    if (en) S.editor = { id: en.id, text: en.body || "" };
    return render();
  }
  if (t.dataset.del) return removeEntry(t.dataset.del);
  if ("logout" in t.dataset) return logout();
  // 预填选项点一下就折好：选完立刻存，刷新页面也还在
  if (t.dataset.pick) return saveWish(t.dataset.pick);
});

/* 选图：文件框在常驻添加栏里，change 才是真正的入口（click 只是替人按下那个框） */
document.addEventListener("change", (e) => {
  const input = e.target.closest && e.target.closest("#pick-photo");
  if (!input) return;
  const file = input.files && input.files[0];
  input.value = "";                                        // 清掉，否则重选同一张不触发 change
  if (!file) return;
  return uploadPhoto(file);
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  // observe = 观察者口令。**在取正文之前就分出去**：它不是留言，
  // 落到下面那句就会变成往墙上写一条 observe。
  if (kind === "observe") return observeEnter(form.querySelector("[data-pin]")?.value || "");
  const text = (form.querySelector("[data-body]")?.value || "").trim();
  if (!text) { S.err = cp("err.emptyText"); return render(); }
  // wish = 自己写的那一条约定（选项之外的话）
  if (kind === "wish") return saveWish(text);
  return kind === "edit" ? patchEntry(form.dataset.id, text) : createEntry(text);
});

/* ══════════ 放大层：独立委托，不混进上面那条 ══════════
   它住在 #app 之外，render() 不重画它；也不建任何定时器。 */
document.addEventListener("click", (e) => {
  const opener = e.target && e.target.closest && e.target.closest("[data-lb-open]");
  if (opener) return openLB(+opener.dataset.lbOpen);
  if (!LB.on) return;
  const btn = e.target && e.target.closest && e.target.closest("[data-lb]");
  if (btn) {
    if (btn.dataset.lb === "close") return closeLB();
    return stepLB(btn.dataset.lb === "prev" ? -1 : 1);
  }
  // 点画框外空白处关闭。问不出 closest（target 不是 Element，比如事件派在 document 上）
  // 时它同样**不在**画框里，所以这里是 || 而不是 && —— 用 && 会把这一次点击整个咽掉。
  if (!e.target.closest || !e.target.closest(".lb-frame")) return closeLB();
});

/* 方向键在手机上不存在，所以不设媒体查询：桌面端自然可用 */
document.addEventListener("keydown", (e) => {
  if (!LB.on) return;
  if (e.key === "Escape") return closeLB();
  if (e.key === "ArrowLeft") return stepLB(-1);
  if (e.key === "ArrowRight") return stepLB(1);
});

/* ── bfcache 兜底：把生日从「浏览器自己恢复的表单」里抠掉 ──────────────
   上面那四条（one-time-code / 无 name / 不在 form 内 / 非 password）管的是
   **密码管理器**。它们管不到**浏览器自己的表单状态恢复**：
   她在密码页输了生日 → 按后退离开 → 又按前进回来，整张表单会被 bfcache
   原样恢复，值还在，点一下「进 去」就进去了。
   症状和"浏览器存了密码"一模一样，但成因完全不同，所以前四条一条都拦不住。

   `pageshow` 在两种情况下都响：正常导航（persisted=false）与从 bfcache
   回来（persisted=true）。这里**不区分**——两种情况下把 #pin 清空都是对的，
   正常导航时它本来就不存在（?. 直接短路），而 bfcache 时它就是那条漏网的值。
   不用监听 beforeunload / visibilitychange：那些在手机上不保证触发。 */
window.addEventListener("pageshow", () => {
  const pin = q("#pin");
  if (pin) pin.value = "";
  // 旁路那个口令框也是凭据字段，同一条兜底同样管它
  const ob = q("#ob-pin");
  if (ob) ob.value = "";
});

/* ══════════ 启动 ══════════ */
async function boot() {
  ensureLB();     // 放大层的骨架建一次：它在 #app 之外，render() 不会重画它。
  ensureNet();    // 断网条同理，建一次。两者都不需要定时器。
  ensureDweller(); // 收纳壳先建：音乐开关长在它里面，ensureMusic 要往那个开关上对状态
  ensureMusic();  // 背景音乐同样建在 #app 之外，否则每次重绘都从头播
  ensureNetWatch();
  ensureObserveWatch();
                  // 放 boot() 而不是模块顶层 —— 顶层只准碰 document.addEventListener，
                  // 工单 03 取纯函数时会用打桩 document 把整份脚本重跑一遍。
  // 旁路**不走 load()**：它一条正常接口都不该碰（/api/me、/api/entry、共同层全都不请求）。
  // 起来就是口令门，进门之后才会去问那条只读的 /api/observe。
  if (observeOn()) { OB.on = true; return renderObserve(); }
  try {
    await load();
  } catch {
    S.note = cp("err.generic");
    NET.state = "offline";
  }
  render();
}

/* 全站唯一的定时器。必须在 render() 之外：建在里面每次重绘都多一个。
   放大层与阅读流都不建定时器。 */
setInterval(tick, 1000);

/* 契约测试用的窄缝。__t02 是工单 02 留下的，形状不动；__t03 在它上面加照片那一侧。
   __t03 额外暴露照片的四个纯函数（EXIF 解析 / 矩阵 / 目标尺寸），
   它们不碰 DOM，可以在没有 canvas 的 jsdom 里取证。
   __t04 再加阅读流那一侧（共同层、放大层状态与操作）。
   boot() 只调一次：两次就是两轮 load()，把「启动请求数」这条证据搅浑。 */
const ready = boot();
window.__t02 = { S, render, card, UNLOCK_AT, ready };
window.__t03 = {
  S, render, card,
  exifOrientation, exifTransform, targetSize, swapAxes, photoSrc,
  MAX_EDGE, QUALITY, ready,
};
window.__t04 = {
  S, render, card, ready,
  UNLOCK_AT, SHOTS, LB, photoSrc, shotSrc, ph, grid3, reading, sharedRange,
  openLB, closeLB, stepLB, paintLB,
};
/* __t05 加约定那一侧：选项、布置台上的折约定区、阅读流收尾的并排两栏。 */
window.__t05 = {
  S, render, ready,
  cp, MAX_WISH, CODES,
  wishForm, wishSection, wishSide, loadWish, saveWish, wishCache,
};
/* __t06 加可靠性那一侧：断网状态与提示条、重试、破图占位块。
   取图路径与开门状态不在这里重新暴露：它们由 __t03 的 photoSrc 与 S.unlocked 说了算。 */
window.__t06 = {
  S, NET, ready,
  render, load, retry, syncNet,
  imgFallback, fbTone, cp,
  photoSrc, open,
};
/* __t07 加观察者那一侧：旁路的开关、取数、进门出门与那一屏的渲染。
   这一缝**只读**：它不暴露任何写路径，也不暴露 S.theirs —— 旁路压根不碰那个全局。 */
window.__t07 = {
  S, render, card, ready,
  OB, OB_SIDES, cp, CODES,
  observeOn, observeView, renderObserve,
  observeEnter, observeLeave, observeHash, loadObserve,
};
/* __t08 加背景音乐与收纳那一侧：状态、函数与「偏好记在哪」。
   暴露 musicPlay/musicPause 是为了让测试**替掉** HTMLMediaElement.play，
   真去断言「被拒之后提示条出现、被手势救回来之后它消失」——
   那条断言要能区分两种实现，就不能只在真浏览器里点。
   收纳也在这条缝上：它是常驻的（建在 #app 之外），所以「布置台和阅读流
   都有退出」这件事不必渲染两遍就能验 —— 数一次收纳里的那一颗就够。 */
window.__t08 = {
  S, render, ready, cp,
  MUSIC, ensureMusic, musicPlay, musicPause, musicSync, musicToggle,
  DW, ensureDweller, dwellerSync, dwellerSet, guide, desk, reading, here,
};
