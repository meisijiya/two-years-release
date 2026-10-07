/**
 * 工单 07 · 应急静态单文件 —— 从当前数据库导出一份可离线双击打开的 HTML。
 *
 * 存在的意义只有一个：10-5 当天早上交一份**双击就能看、内容一字不少**的兜底。
 * 万一服务挂了、或者她那边网络打不开，这个文件救场。
 *
 * 它是导出脚本，不是运行时代码：跑一次产出一个 .html，产物自己就是全部。
 * 打开过程零网络请求——图片全部 base64 内联，字体用系统衬线（零下载），
 * **完全不写 `<script>`**：单文件页没有任何需要 JS 才能显示的内容，
 * 写一个空 script 标签都只会多一个「万一被当成外链入口」的审查面。
 *
 * 三条不变量：
 *   1. **内容只来自库**。共同层合照/祝福语、双方各自的信与照片、最后一段话、
 *      双方约定——全走 SELECT，不猜、不补、不写死。库是空的就出占位说明页。
 *   2. **幂等到字节**。同一份库跑两次产物逐字节一致，所以页面里
 *      一个时间戳都不写（CONSTRAINTS §1 的同一个精神：产物内容不掺"什么时候跑的"）。
 *   3. **代号而非真名**。person 表里就只有 code，全站只认代号（CONSTRAINTS §3）。
 *      脚本不引入任何别的来源的身份信息。
 *   4. **文案只从 src/copy.js 取**，与正式站 public/app.js 同一份数据源。
 *      这里**不再抄一份**：抄一份就是"同一个东西的两种措辞"，而这个项目
 *      已经因为它出过两次事故（占位块写「照片 3」而正式站写「照 片」；
 *      主标题一处「两年了」一处「我们的两年」）。与正式站同源的句子
 *      （首屏、两年、信、最后、约定那些）取的是**同一批键**。
 *
 *   node scripts/export-standalone.mjs
 *
 * 环境变量：
 *   DATA_DIR     库与照片目录的位置，默认 <仓库>/data（与 src/server.js 同一个）
 *   DB_FILE      直接指定库文件，优先于 DATA_DIR（测试用）
 *   OUT_FILE     产物路径，默认 <DATA_DIR>/standalone/two-years-standalone.html
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { photosDirFor, readPhoto } from "../src/photos.js";
import { ANNIVERSARY_DAYS, START_AT, ymd } from "../src/shared.js";
import { isUnlocked, UNLOCK_LABEL } from "../src/clock.js";
import { cp } from "../src/copy-get.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "two-years.db");
const OUT_FILE =
  process.env.OUT_FILE || path.join(DATA_DIR, "standalone", "two-years-standalone.html");

/* -------------------------------------------------------------------------- *
 * 读取
 * -------------------------------------------------------------------------- */

/**
 * 照片 → data: URI。
 *
 * 读盘只有 `readPhoto` 一条路：照片文件按 `p<24位hex>.jpg` 落在库旁边的 700 目录
 * （src/photos.js）。文件不在（被手工删了）时给 `null`，渲染层画占位块——
 * 一张坏图不该让整份应急页导出失败，那天她打开的就是一片空白。
 *
 * @param {string} photosDir
 * @param {string} id 照片文件 id
 * @returns {string|null} data URI，文件缺失时 null
 */
function photoDataUri(photosDir, id) {
  const buf = readPhoto(photosDir, id);
  if (!buf || buf.length === 0) return null;
  // 落盘的永远是 JPEG（src/photos.js 只写 .jpg），不猜扩展名
  return "data:image/jpeg;base64," + buf.toString("base64");
}

/** 按 id 升序稳定排序 */
function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 把库读成一个与渲染无关的纯数据结构。
 *
 * 单独拎出来是为了让"读"和"排版"互不干扰：这一段只 SELECT，产出可预测的数组；
 * 渲染那一段才决定怎么摆。空库 / 半满的库都在这里自然退化成空数组，
 * 后面一律走占位，不会抛。
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} photosDir
 */
function collect(db, photosDir) {
  const persons = db
    .prepare("SELECT id, code, role FROM person ORDER BY id")
    .all()
    .map((r) => ({ ...r }));

  // 共同层合照：shared 的槽位 body 存的是 photo 文件 id（src/shared.js 的契约）
  const together = db
    .prepare(
      "SELECT s.id, s.ord, p.id AS photo_id FROM shared s " +
        "JOIN photo p ON p.id = s.body WHERE s.kind = 'together_photo' ORDER BY s.ord, s.id",
    )
    .all()
    .map((r) => ({ id: r.id, uri: photoDataUri(photosDir, r.photo_id) }));

  const blessRow = db
    .prepare("SELECT body FROM shared WHERE kind = 'blessing' ORDER BY ord LIMIT 1")
    .get();
  const blessing = blessRow && typeof blessRow.body === "string" ? blessRow.body.trim() : "";

  // 双方各自的信与照片。owner 取 person 表里的真实 id，不硬编码
  const entries = persons.map((p) => {
    const rows = db
      .prepare(
        "SELECT e.id, e.kind, e.body, e.ord, p.id AS photo_id FROM entry e " +
          "LEFT JOIN photo p ON p.entry_id = e.id " +
          "WHERE e.owner = ? AND e.deleted IS NULL ORDER BY e.ord, e.created, e.id",
      )
      .all(p.id)
      .map((r) => ({ ...r }));

    const texts = rows.filter((r) => r.kind === "text");
    const photos = rows
      .filter((r) => r.kind === "photo")
      .map((r) => ({
        id: r.id,
        caption: typeof r.body === "string" ? r.body.trim() : "",
        uri: r.photo_id ? photoDataUri(photosDir, r.photo_id) : null,
      }))
      .sort(byId);

    return {
      id: p.id,
      code: p.code,
      // 与 public/app.js 的 reading() 同一套语义：第一条留言=信，最后一条=最后一段话
      letter: texts.length ? (texts[0].body ?? "") : "",
      tail: texts.length > 1 ? (texts[texts.length - 1].body ?? "") : "",
      photos,
    };
  });

  // 双方约定：person_id → text，顺序跟 person 表一致
  const wishes = persons.map((p) => {
    const row = db.prepare("SELECT text FROM wish WHERE person_id = ?").get(p.id);
    return { id: p.id, code: p.code, text: row && typeof row.text === "string" ? row.text : "" };
  });

  return { persons, together, blessing, entries, wishes };
}

/* -------------------------------------------------------------------------- *
 * 渲染
 * -------------------------------------------------------------------------- */

/** HTML 转义。内容是用户写的信，`<` `&` 一个都不该有解释权。 */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 正文按段落拆，保留用户换行的意思。转义之后再拼标签。 */
function paragraphs(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  return t
    .split(/\n{2,}/)
    .map((block) => `<p>${esc(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** 共同层九宫格：固定 9 格，够不着的走占位块，布局不塌。 */
function grid(together) {
  const cells = [];
  for (let i = 0; i < 9; i++) {
    const shot = together[i];
    cells.push(
      shot && shot.uri
        ? `<div class="g"><img src="${shot.uri}" alt="${esc(cp("standalone.gridAlt", { n: i + 1 }))}" loading="lazy" decoding="async"></div>`
        : `<div class="g g-ph"><span>${cp("placeholder.shot")}</span></div>`,
    );
  }
  return `<div class="grid3">${cells.join("")}</div>`;
}

/** 一张照片 + 它的配文。缺文件/缺配文都不留半个空标签。
 *
 *  照片文件缺失时顶上那块写「照 片」，**与正式站的 photoBlock() 同一个词**。
 *  早先这里写的是「照片 3」（带编号），于是同一个东西两处措辞不同。
 *  编号不该出现在这一块上：卡片标题里已经写着「第 N 张」，这里再报一次是重复；
 *  应急页这一块又没有卡片标题，所以只留词、不留号。
 *
 *  ⚠️ alt 里的「照片 N」**故意保留编号**，它与这块可见文字不是一回事：
 *  alt 是给读屏软件念的，念「照片 3」才说得出这是第几张。
 *  正式站那边 alt 一律写空，是因为卡片有可见文字兜着；应急页没有，别照抄。 */
function photoCard(p, i) {
  const img = p.uri
    ? `<img src="${p.uri}" alt="${esc(cp("standalone.photoAlt", { n: i + 1 }))}" loading="lazy" decoding="async">`
    : `<div class="ph">${cp("placeholder.photo")}</div>`;
  return `<figure class="card">${img}${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`;
}

/** 一个 section 壳 */
function section(kicker, body) {
  return `<section class="sec"><div class="kicker">${kicker}</div>${body}</section>`;
}

/**
 * 组装完整 HTML。
 *
 * 零 `<script>`、零外链、零 `@font-face`、零 `url(http…)`：
 * 字体只写 `font-family` 的系统衬线栈，样式全部内联在 `<style>` 里。
 * 页面里唯一的数据来源就是参数 `model`，不读环境、不读时钟——所以同库必同字节。
 *
 * @param {ReturnType<typeof collect>} model
 * @param {{from: string, to: string, days: number}} range 纪念日区间（由调用方从常量推）
 * @param {{forced?: boolean}} [opts] forced=true 表示在开门时刻之前用 --force 强行导出
 * @returns {string}
 */
function render(model, range, opts = {}) {
  const { together, blessing, entries, wishes } = model;

  const sharedPart = section(
    cp("reading.twoYearsTitle"),
    grid(together) +
      `<div class="letter-big">` +
      (blessing
        ? `<div class="bless">${paragraphs(blessing)}</div>`
        : `<div class="none">${cp("standalone.blessingEmpty")}</div>`) +
      `</div>` +
      `<div class="range">${esc(range.from)} — ${esc(range.to)} · ${cp("reading.range", { days: range.days })}</div>`,
  );

  // 双方各一段：「TA 留给你的」——信 → 照片 → 最后一段话，与阅读流同序
  const giftParts = entries
    .map((e) =>
      section(
        `${esc(e.code)} ${cp("standalone.giftKicker")}`,
        `<div class="letter-big"><div class="h">${cp("reading.letter.title")}</div>` +
          (e.letter.trim() ? paragraphs(e.letter) : `<div class="none">${cp("standalone.noLetter")}</div>`) +
          `</div>` +
          (e.photos.length
            ? `<div class="rd-sub">${cp("standalone.photosTitle", { n: e.photos.length })}</div>` +
              `<div class="wall">${e.photos.map(photoCard).join("")}</div>`
            : `<div class="none">${cp("standalone.noPhotos")}</div>`) +
          (e.tail.trim()
            ? `<div class="letter-big"><div class="h">${cp("reading.tailTitle")}</div>${paragraphs(e.tail)}</div>`
            : ""),
      ),
    )
    .join("");

  const wishPart = section(
    cp("standalone.wishTitle"),
    `<div class="wishes">` +
      wishes
        .map(
          (w) =>
            `<div class="wish"><div class="code">${esc(w.code)}</div>` +
            (w.text.trim() ? paragraphs(w.text) : `<div class="none">${cp("standalone.noWish")}</div>`) +
            `</div>`,
        )
        .join("") +
      `</div>`,
  );

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(cp("meta.title"))}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #fbf7f1; color: #33291f; line-height: 1.85;
  /* 系统衬线栈：一个字都不下载。离线打开时零网络请求的第一道保险 */
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, "Times New Roman", serif;
  -webkit-text-size-adjust: 100%;
}
.screen { max-width: 480px; margin: 0 auto; padding: 0 20px 72px; }
.hero { padding: 84px 0 56px; text-align: center; }
.kicker { font-size: 12px; letter-spacing: .5em; color: #a08e7c; text-transform: none; }
h1 { font-size: 30px; font-weight: 500; margin: 14px 0 6px; letter-spacing: .04em; }
.sub { color: #8d7c6c; font-size: 14px; }
.sec { padding: 44px 0; border-top: 1px solid #eee2d2; }
.sec:first-of-type { border-top: 0; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 18px 0 26px; }
.g { aspect-ratio: 1 / 1; border-radius: 8px; overflow: hidden; background: #f2e9dc; }
.g img { width: 100%; height: 100%; object-fit: cover; display: block; }
.g-ph { border: 1px dashed #e0cfba; display: flex; align-items: center; justify-content: center;
  color: #c3b29c; font-size: 11px; letter-spacing: .2em; }
.letter-big { background: #fffdf9; border: 1px solid #efe3d2; border-radius: 14px; padding: 26px 22px; }
.letter-big .h { font-size: 13px; letter-spacing: .4em; color: #a08e7c; margin-bottom: 12px; }
.letter-big p { margin: 0 0 14px; }
.letter-big p:last-child { margin-bottom: 0; }
.bless { white-space: normal; }
.range { margin-top: 14px; text-align: center; color: #a08e7c; font-size: 12px; letter-spacing: .06em; }
.rd-sub { margin: 30px 0 12px; font-size: 13px; letter-spacing: .3em; color: #a08e7c; }
.wall { display: flex; flex-direction: column; gap: 18px; }
.card { margin: 0; background: #fffdf9; border: 1px solid #efe3d2; border-radius: 14px; padding: 10px; }
.card img, .card .ph { width: 100%; border-radius: 10px; display: block; }
.card .ph { aspect-ratio: 3 / 4; background: #f2e9dc; color: #c3b29c; display: flex;
  align-items: center; justify-content: center; font-size: 12px; }
.card figcaption { padding: 10px 6px 4px; font-size: 14px; color: #6b5b4c; }
.none { color: #b6a794; font-size: 14px; }
.wishes { display: flex; flex-direction: column; gap: 12px; }
.wish { background: #fffdf9; border: 1px solid #efe3d2; border-radius: 14px; padding: 20px; }
.wish .code { font-size: 13px; letter-spacing: .3em; color: #a08e7c; margin-bottom: 10px; }
.wish p { margin: 0 0 10px; font-size: 15px; }
.foot { margin-top: 56px; text-align: center; color: #c3b29c; font-size: 12px; letter-spacing: .1em; }
.wm { background: #8a2f2f; color: #fff; padding: 10px 14px; border-radius: 10px;
  font-size: 13px; line-height: 1.6; letter-spacing: .02em; }
</style>
</head>
<body>
<main class="screen">
${opts.forced ? `  <div class="wm">${esc(cp("standalone.watermark", { unlock: UNLOCK_LABEL }))}</div>\n` : ""}  <div class="hero">
    <div class="kicker">${cp("hero.kicker")}</div>
    <h1>${cp("hero.title")}</h1>
    <div class="sub">${esc(cp("standalone.range", { from: range.from, to: range.to }))}<br>${cp("reading.anniversary")}</div>
  </div>
  ${sharedPart}
  ${giftParts}
  ${wishPart}
  <div class="foot">${cp("standalone.foot")}</div>
</main>
</body>
</html>
`;
}

/* -------------------------------------------------------------------------- *
 * 自检
 * -------------------------------------------------------------------------- */

/**
 * 产物出厂前的自检。任何一条不过就**不写文件**、退出码 1——
 * 一份会偷偷联网的应急页比没有应急页更糟：她以为打开的是全部。
 *
 * @param {string} html
 * @param {string[]} codes 允许出现的代号
 * @returns {string[]} 违规描述，空数组表示通过
 */
function audit(html, codes) {
  const bad = [];
  // 0 命中是硬指标：任何 http(s) 图片 / 外链脚本都意味着打开时会发请求。
  //
  // 关键：**只扫属性位置**，不要扫全文。用户写的信里出现一个链接是**正常内容**，
  // 不是「打开时会发请求」。早先这里用 `/\bhttps?:\/\//i` 扫全文，
  // 结果她在信里贴一个链接就导出失败、零产物，且报错指向自检项看不出是内容导致
  // ——兜底在 10-5 当天当场归零。文本里的链接该被转义成不可点，而不是让整个导出失败。
  for (const [label, re] of [
    ['<img src="http', /<img[^>]+src=["']https?:/i],
    ["外链 <script src=", /<script[^>]+src=/i],
    ["外链 <link href=", /<link[^>]+href=["']https?:/i],
    ["CSS url(http", /url\(\s*["']?https?:/i],
    ["<iframe|<embed", /<(iframe|embed|object)\b/i],
  ]) {
    if (re.test(html)) bad.push(`${label} 出现 ${(html.match(re) || []).length} 次`);
  }
  // 标签成对：写坏一次结构，浏览器会容错地把后半页吞进 body 或直接丢弃
  for (const tag of ["html", "head", "body", "main", "style"]) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    if (open !== 1 || close !== 1) bad.push(`<${tag}> 开 ${open} 次 / 闭 ${close} 次，必须各 1 次`);
  }
  // 只有代号。person 表里根本没有真名字段，这里是最后一道：万一将来有人
  // 在别处引了真实姓名进来，这一行会红。
  for (const c of codes) if (c && !html.includes(c)) bad.push(`产物里没有代号「${c}」`);
  return bad;
}

/* -------------------------------------------------------------------------- *
 * 主流程
 * -------------------------------------------------------------------------- */

let exitCode = 0;
let db;
try {
  // ---- 时间锁：没到开门时刻，拒绝导出 ------------------------------------
  // 这份产物的唯一用途就是「开门当天发给她」，它是一份**可转发、不可撤回**的完整副本。
  // 早先这里没有这道闸门，于是 10-4 有人「先导出试试」就会生成一份永久绕过时间锁的
  // 完整内容，事后无论闸门怎么改都追不回来。
  // 应急页的兜底价值发生在 10-5 早上，那时闸门本来就该是开的，所以这道闸门
  // 不会削弱它的用途，只挡住「提前把惊喜偷渡出去」。
  //
  // 用 --force 可以在闸门前强行导出（会打水印标记）。
  const force = process.argv.includes("--force") || process.env.EXPORT_FORCE === "1";
  const locked = !isUnlocked(Date.now());
  if (locked && !force) {
    console.error(
      `[export-standalone] 还没到开门时刻（${UNLOCK_LABEL}），拒绝导出。\n` +
        `[export-standalone] 这份文件是可转发、不可撤回的完整副本，提前导出会让时间锁永久失效。\n` +
        `[export-standalone] 确实需要（自测？留档？）就加 --force，产物会打上「未解锁导出」水印。`,
    );
    process.exit(1);
  }
  // 强行导出 = 时间锁被绕过。产物必须自己说清楚，否则这一份和正常导出的那份
  // 长得一模一样，没人会知道它早于开门时刻存在过。
  const forced = locked && force;

  db = openDb(DB_FILE);
  // 照片目录跟着库走（src/photos.js 的约定），读盘只有 readPhoto 一条路
  const model = collect(db, photosDirFor(db));

  // 纪念日区间从常量推，不读时钟——时钟一进来，幂等立刻没了。
  // 终点同样由 START_AT 推，不另解一个日期字面量：少一个能悄悄漂一年的地方。
  const range = {
    from: ymd(START_AT),
    to: ymd(START_AT + ANNIVERSARY_DAYS * 86400 * 1000),
    days: ANNIVERSARY_DAYS,
  };

  const html = render(model, range, { forced });
  const problems = audit(html, model.persons.map((p) => p.code));
  if (problems.length) {
    // 宁可不产出：一份联网的兜底页比没有兜底页更危险
    console.error("[export-standalone] 自检未通过，未写出产物：");
    for (const p of problems) console.error("  - " + p);
    exitCode = 1;
  } else {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, html, "utf8");

    const inlined = (html.match(/src="data:image\//g) || []).length;
    const bytes = fs.statSync(OUT_FILE).size;
    console.log(`[export-standalone] 产物 ${OUT_FILE}`);
    console.log(`[export-standalone] ${(bytes / 1024).toFixed(1)} KB，内联图片 ${inlined} 张，零外链、零脚本`);
    if (forced) console.log("[export-standalone] 注意：本次为 --force 强行导出，产物已打上「未解锁导出」水印");
    const missing = model.together.filter((t) => !t.uri).length;
    if (missing) console.log(`[export-standalone] 注意：共同层有 ${missing} 个槽位没读到文件，已画占位块`);
  }
} catch (err) {
  console.error(`[export-standalone] 失败：${err?.message ?? err}`);
  exitCode = 1;
} finally {
  if (db) {
    try {
      db.close();
    } catch {}
  }
}

process.exit(exitCode);
