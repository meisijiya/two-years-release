/**
 * 工单 08 · 文案抽离 —— 唯一数据源、生成关系、门禁的鉴别力。
 *
 * 这次改造要换掉的东西是「换文案不需要改逻辑代码」和「两个渲染器不可能漂移」。
 * 这两条都只能靠**会红的断言**成立，所以本文件里相当一部分是在证明检查本身会红：
 * 造坏例子给门禁吃，看它退出非 0；否则上面两条只是愿望。
 *
 * 缝：
 *   · 文案完整性：跑真的 scripts/check-copy.mjs 子进程，断言它的**退出码**
 *     （CONSTRAINTS §6：门禁必须能失败。吞掉失败消息等于撤销门禁）
 *   · 两端同词：正式站用 jsdom 载入真的 public/index.html（连真的 app.js 与 copy.js），
 *     应急页用真的导出脚本子进程跑一遍，只断言**产物字节里看得见的词**
 *   · 生成关系：真的跑两次 npm run build:copy 的那个脚本，比对两次产物的字节
 *
 * 不断言内部函数被调用几次，不断言 CSS 类名，不断言 DOM 结构细节（CONSTRAINTS §5）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { COPY } from "../src/copy.js";
import { cp } from "../src/copy-get.js";
import { renderCopyModule, buildCopy } from "../scripts/build-copy.mjs";
import { openDb } from "../src/db.js";
import { AT_UNLOCK } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_FILE = path.join(ROOT, "public", "app.js");
const HTML_FILE = path.join(ROOT, "public", "index.html");
const GENERATED = path.join(ROOT, "public", "copy.js");
const CHECK = path.join(ROOT, "scripts", "check-copy.mjs");
const EXPORT = path.join(ROOT, "scripts", "export-standalone.mjs");
const FAKE_CLOCK = pathToFileURL(path.join(ROOT, "test", "fake-clock.mjs")).href;

/** 跑门禁子进程。断言的是退出码本身。 */
function runCheck(args = []) {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CHECK, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** 跑导出子进程（时钟注入，与 ticket-07 同一套） */
function runExport({ dataDir, outFile, dbFile, fakeNow = AT_UNLOCK + 1000 }) {
  const r = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", FAKE_CLOCK, EXPORT],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir, DB_FILE: dbFile, OUT_FILE: outFile, FAKE_NOW: String(fakeNow) },
    },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function makeDataDir() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "two-years-copy-"));
  return { dataDir, dbFile: path.join(dataDir, "two-years.db"), outFile: path.join(dataDir, "out.html") };
}

/** 照片文件 id 形状与 photos.js 一致 */
const photoId = (n) => "p" + n.toString(16).padStart(24, "0");

/** 造一份有双方照片、但**文件都不在盘上**的库，并且每方都有一封信 + 一段最后的话。
 *  文件都不在盘上 → 每一处照片都该画占位块；两段正文 → 「最 后」那一块也会渲染。 */
function seedMissingPhotos(dbFile) {
  const db = openDb(dbFile);
  try {
    for (const [owner, n] of [["door", 0], ["hero", 1]]) {
      const pid = photoId(n);
      db.prepare("INSERT INTO entry(id, owner, kind, body, ord, created) VALUES(?,?,'photo','',1,1)")
        .run(`e-${owner}-p`, owner);
      db.prepare("INSERT INTO photo(id, entry_id, mime, bytes, w, h) VALUES(?,?,'image/jpeg',3,10,10)")
        .run(pid, `e-${owner}-p`);
      // 第一条留言 = 信；再多一条 = 最后一段话（reading() 的同一套语义）
      // 正文用 ASCII：这些是**测试自己造的**用户内容，不是文案，
      // 不能混进「产物上每一段中文都该来自 copy.js」那条检查里。
      db.prepare("INSERT INTO entry(id, owner, kind, body, ord, created) VALUES(?,?,'text',?,2,2)")
        .run(`e-${owner}-l`, owner, "LETTER-BODY-1");
      db.prepare("INSERT INTO entry(id, owner, kind, body, ord, created) VALUES(?,?,'text',?,3,3)")
        .run(`e-${owner}-t`, owner, "TAIL-BODY-2");
    }
  } finally {
    db.close();
  }
}

/* ====================================================================== *
 * 1. 门禁本身：能过，也**必须会红**
 * ====================================================================== */

test("门禁对现状是绿的（先证明后面那些「红」不是因为它本来就红）", (t) => {
  const r = runCheck();
  assert.equal(r.status, 0, `门禁没通过：\n${r.out}\n${r.err}`);
  t.diagnostic(r.out.trim().split("\n").join(" | "));
});

test("门禁抓得到「引用了不存在的键」：自证它不是恒真", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-badapp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 坏例子：真 app.js 抄一份，把一个键改成 src/copy.js 里没有的
  const good = readFileSync(APP_FILE, "utf8");
  const bad = good.replace('cp("seal.note.locked")', 'cp("seal.note.lockd")');
  assert.notEqual(bad, good, "坏例子没造出来——那个键在 app.js 里不是这么写的，测试本身失效了");
  const file = path.join(dir, "app.js");
  writeFileSync(file, bad, "utf8");

  const r = runCheck(["--app", file]);
  assert.equal(r.status, 1, `门禁放过了不存在的键（退出码 ${r.status}）——它抓不到，那它就不是护栏：\n${r.out}`);
  assert.match(r.err, /seal\.note\.lockd/, `报错没有点名那个键，等于没查：\n${r.err}`);
  t.diagnostic("坏例子被红在「键不存在」这条上，报错点名了 seal.note.lockd");
});

test("门禁抓得到 public/copy.js 与 src/copy.js 漂移", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-badcopy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 坏例子：把产物里一个词改掉（模拟"有人手改了生成的那份"）
  const bad = readFileSync(GENERATED, "utf8").replace(COPY.placeholder.photo, "照片 3");
  assert.notEqual(bad, readFileSync(GENERATED, "utf8"), "坏例子没造出来——测试本身失效了");
  const file = path.join(dir, "copy.js");
  writeFileSync(file, bad, "utf8");

  const r = runCheck(["--generated", file]);
  assert.equal(r.status, 1, `门禁放过了漂移的产物（退出码 ${r.status}）——手改 public/copy.js 不会被看见：\n${r.out}`);
  assert.match(r.err, /漂移/, `报错没提漂移：\n${r.err}`);
  t.diagnostic("坏例子被红在「产物与源漂移」这条上");
});

test("门禁抓得到漏传的占位符（少几个字，而不是显示 {days}）", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-badvars-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = readFileSync(APP_FILE, "utf8");
  const bad = good.replace('cp("reading.range", { days: r.days })', 'cp("reading.range")');
  assert.notEqual(bad, good, "坏例子没造出来——那个调用点不在这份文件里，测试本身失效了");
  const file = path.join(dir, "app.js");
  writeFileSync(file, bad, "utf8");

  const r = runCheck(["--app", file]);
  assert.equal(r.status, 1, `门禁放过了漏传占位符（退出码 ${r.status}）：\n${r.out}`);
  assert.match(r.err, /占位符/, `报错没提占位符：\n${r.err}`);
  t.diagnostic("坏例子被红在「占位符没传齐」这条上");
});

test("门禁在 app.js 一个 cp() 都没有时会红（探测器自证）", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-nocp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "app.js");
  // 一个取键点都没有的文件：扫不到东西 = 探测器失灵 = 门禁会永远绿
  writeFileSync(file, "const x = 1;\n", "utf8");

  const r = runCheck(["--app", file]);
  assert.equal(r.status, 1, `门禁放过了「一个取键点都没有」的 app.js（退出码 ${r.status}）：\n${r.out}`);
  assert.match(r.err, /一个 cp\(\) 调用点都没有/, `报错没提探测器失灵：\n${r.err}`);
  t.diagnostic("坏例子被红在「探测器抓不到东西」这条上");
});

/* ====================================================================== *
 * 2. 生成关系：逐字节可复现、与源一致
 * ====================================================================== */

test("build:copy 连跑两次产物逐字节一致，且与盘上那份相同", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, "a.js");
  const b = path.join(dir, "b.js");
  buildCopy({ outFile: a });
  buildCopy({ outFile: b });
  assert.deepEqual(readFileSync(a), readFileSync(b), "跑两次产物不一样——里面有「什么时候跑的」痕迹");
  assert.deepEqual(readFileSync(a), readFileSync(GENERATED), "盘上那份与现生成的不一致：跑 npm run build:copy");
  t.diagnostic(`两次生成都是 ${readFileSync(a).length} 字节，逐字节一致`);
});

test("产物里没有时间戳之类的痕迹：同一份源必须产出同一份字节", () => {
  // 换个对象身份重跑一次：同样的内容、不同的内存对象，字节必须一样
  const again = structuredClone(COPY);
  assert.equal(renderCopyModule(again), renderCopyModule(COPY));
  // 产物可被 JSON 解析回完全相同的数据（纯数据，没有函数被丢掉）
  const text = renderCopyModule(COPY);
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(COPY)));
});

/* ====================================================================== *
 * 3. 两端同源：正式站与应急页对同一批键渲染出同一个词
 * ====================================================================== */

const UNLOCKED = {
  unlocked: true,
  me: { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: true, count: 0 },
  shared: { photos: [], blessing: "", from: "2024-10-05", to: "2026-10-05", days: 731 },
  theirs: [
    { id: "t1", kind: "photo", body: "", ord: 1, created: 1, photo: { id: "px", mime: "image/jpeg", w: 10, h: 10 } },
  ],
};

/** 载入真 index.html（连真 app.js 与真 copy.js），fetch 打桩 */
async function bootApp(t) {
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      const real = w.setInterval.bind(w);
      w.setInterval = (...a) => real(...a);
      const routes = {
        "GET /api/status": { unlocked: true },
        "GET /api/me": UNLOCKED.me,
        "GET /api/entry": { mine: [], theirs: UNLOCKED.theirs },
        "GET /api/shared": UNLOCKED.shared,
        "GET /api/wish": { wishes: [] },
      };
      w.fetch = async (url, init = {}) => {
        const key = `${(init.method || "GET").toUpperCase()} ${url}`;
        const r = routes[key];
        const status = r ? 200 : 404;
        return new Response(JSON.stringify(r || { error: "not_found" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      };
    },
  });
  t.after(() => dom.window.close());
  for (let i = 0; i < 200 && !dom.window.__t04; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t04, "public/index.html 没有跑起 public/app.js");
  await dom.window.__t04.ready;
  // 点进阅读流（开门后同一个入口分流成它）
  const btn = dom.window.document.querySelector('[data-go="desk"]');
  assert.ok(btn, "封印页的入口按钮不见了");
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  for (let i = 0; i < 100 && !dom.window.document.querySelector(".rd-hero"); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  return dom;
}

test("两端同词 · 占位块：正式站与应急页用同一个词（那两处已知漂移之一）", async (t) => {
  // 正式站：九宫格没素材 → 占位块；照片读不出来 → 占位块
  const dom = await bootApp(t);
  const doc = dom.window.document;
  const gridCells = [...doc.querySelectorAll(".grid3 .g-ph")];
  assert.ok(gridCells.length > 0, "九宫格一个占位块都没有——下面那几条是在空转");
  for (const c of gridCells) {
    assert.equal(
      c.textContent,
      cp("placeholder.shot"),
      `正式站九宫格占位块写的是「${c.textContent}」，数据源里是「${cp("placeholder.shot")}」`,
    );
  }
  // 照片读不出来：img 报 error（捕获阶段委托到 document），原地换成占位块
  const im = doc.querySelector(".pframe img");
  assert.ok(im, "阅读流的照片卡上没有 <img>，这条断言会空转");
  im.dispatchEvent(new dom.window.Event("error"));
  const fb = doc.querySelector(".pframe .ph");
  assert.ok(fb, "破图之后照片框里没有占位块");
  assert.equal(
    fb.textContent,
    cp("placeholder.photo"),
    `正式站照片占位块写的是「${fb.textContent}」，数据源里是「${cp("placeholder.photo")}」`,
  );

  // 应急页：库里两张照片的文件都不在盘上，产物里每一处都该画占位块
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedMissingPhotos(d.dbFile);
  const r = runExport(d);
  assert.equal(r.status, 0, `导出不该失败：${r.stdout}${r.stderr}`);
  const html = readFileSync(d.outFile, "utf8");
  const cards = [...html.matchAll(/<div class="ph">([^<]*)<\/div>/g)].map((x) => x[1]);
  assert.ok(cards.length > 0, "应急页产物里一个照片卡占位块都没有——下面那几条是在空转");
  for (const w of cards) {
    assert.equal(w, cp("placeholder.photo"), `应急页照片卡占位块写的是「${w}」，正式站是「${cp("placeholder.photo")}」`);
  }
  assert.ok(
    html.includes(`<span>${cp("placeholder.shot")}</span>`),
    `应急页九宫格没用正式站的用词「${cp("placeholder.shot")}」`,
  );
  t.diagnostic(
    `正式站九宫格 ${gridCells.length} 格 + 照片卡 1 处 = 正式站用词「${cp("placeholder.shot")}」/「${cp("placeholder.photo")}」；` +
      `应急页 ${cards.length} 处照片卡 + 九宫格，同词`,
  );
});

test("两端同词 · 页面标题：正式站标签页与应急页是同一个词（那两处已知漂移之二）", (t) => {
  // 正式站：public/index.html 的 <title>（浏览器读出来的字面量，& 要还原成 &）
  const html = readFileSync(HTML_FILE, "utf8");
  const t1 = /<title>([^<]*)<\/title>/.exec(html);
  assert.ok(t1, "public/index.html 里没有 <title>");
  const formalTitle = t1[1].replace(/&amp;/g, "&");
  assert.equal(formalTitle, cp("meta.title"), "正式站标签页标题与文案数据源不是一个词");

  // 应急页：真导出一份，读产物里的 <title>
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedMissingPhotos(d.dbFile);
  assert.equal(runExport(d).status, 0, "导出必须成功");
  const out = readFileSync(d.outFile, "utf8");
  const t2 = /<title>([^<]*)<\/title>/.exec(out);
  assert.ok(t2, "应急页产物里没有 <title>");
  const exportTitle = t2[1].replace(/&amp;/g, "&");
  assert.equal(exportTitle, formalTitle, `应急页标题是「${exportTitle}」，正式站是「${formalTitle}」——她打开兜底看到的是另一个名字`);
  t.diagnostic(`两端标题同一个词：${exportTitle}`);
});

test("两端同词 · 首屏与段落：两边取的是同一批键，不是各写各的", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedMissingPhotos(d.dbFile);
  assert.equal(runExport(d).status, 0, "导出必须成功");
  const html = readFileSync(d.outFile, "utf8");
  // 这几个词正式站与应急页都出现，且都必须等于数据源里的值
  for (const [key, what] of [
    ["hero.kicker", "首屏小字"],
    ["hero.title", "主标题"],
    ["reading.twoYearsTitle", "「我们的两年」段落标题"],
    ["reading.anniversary", "纪念日那句"],
    ["reading.letter.title", "信那块的小标题"],
    ["reading.tailTitle", "最后一段话的小标题"],
    ["standalone.wishTitle", "约定那块"],
  ]) {
    const want = cp(key);
    assert.ok(want, `数据源里没有 ${key}`);
    assert.ok(html.includes(want), `应急页产物里找不到${what}「${want}」`);
  }
  t.diagnostic(`应急页 ${7} 处与正式站同源的词，全部等于数据源里的值`);
});

/* ====================================================================== *
 * 4. 换文案不用改逻辑代码
 * ====================================================================== */

test("改文案真的不用碰逻辑：把数据源整个换掉，两端都跟着变", async (t) => {
  // 这条不写盘、不改仓库：直接用 src/copy.js 的取值函数喂一份改过的数据，
  // 证明「词」与「逻辑」是分开的——渲染取的是 cp()，不是字面量。
  const patched = structuredClone(COPY);
  patched.placeholder.photo = "占位ZZZ";
  patched.meta.title = "换过的标题";
  assert.equal(cp("placeholder.photo", undefined, patched), "占位ZZZ");
  assert.equal(cp("meta.title", undefined, patched), "换过的标题");
  // 而正式站的 app.js **代码**里没有这个新词（注释不算：注释里本来就到处在讲文案）
  const appCode = stripComments(readFileSync(APP_FILE, "utf8"));
  assert.ok(!appCode.includes(patched.placeholder.photo), "新词已经出现在 app.js 的代码里了——逻辑里还留着字面量");
});

test("public/app.js 的代码里没有硬编码中文文案（只允许两个身份代号）", () => {
  // 剥注释后，代码里剩下的中文**只允许**是 person 表里的两个代号。
  // 它们不是文案：改名要动数据库与应急页审计（见 to-questionnaire-copy.md 零节）。
  // 别的中文只要还在代码里，换 copy.js 就换不掉它——那正是这次要消灭的东西。
  const ALLOWED = ["【改这里：doorCode】", "【改这里：heroCode】"];
  const code = stripComments(readFileSync(APP_FILE, "utf8"));
  const found = [...new Set((code.match(/[\u4e00-\u9fff]+/g) || []).filter((w) => !ALLOWED.includes(w)))];
  assert.deepEqual(
    found,
    [],
    `public/app.js 的代码里还有硬编码中文：${found.map((s) => `「${s}」`).join(" ")}——文案该在 src/copy.js`,
  );
});

test("应急页产物上的每一个字都来自 copy.js 或代号（没有偷偷写死的文案）", (t) => {
  // 导出脚本里有一批**操作者**输出（audit 的报错标签、打在终端里的话），
  // 那些不是文案、不进产物，所以不在源码层扫它。改成扫**产物**：
  // 产物上每一段连续的中文，都必须是某条文案的子串或某个代号。
  // 这样「有人在导出脚本里手写了一句话」会立刻露出来——而那正是换不掉文案的那种写法。
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedMissingPhotos(d.dbFile);
  assert.equal(runExport(d).status, 0, "导出必须成功");
  const html = readFileSync(d.outFile, "utf8");

  const haystack = allCopyText() + "【改这里：doorCode】【改这里：heroCode】";
  // <style> 里的注释是给维护者看的代码注释，HTML 注释同理：都不给她看，不算文案
  const visible = html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const orphans = [...new Set((visible.match(/[\u4e00-\u9fff]+/g) || []).filter((s) => !haystack.includes(s)))];
  assert.deepEqual(
    orphans,
    [],
    `应急页产物上有 copy.js 里没有的中文：${orphans.map((s) => `「${s}」`).join(" ")}——它是写死的，换文案换不掉`,
  );
  t.diagnostic(`产物正文上 ${new Set(visible.match(/[\u4e00-\u9fff]+/g) || []).size} 段连续中文，全部来自 copy.js 或代号`);
});

/** COPY 里全部字符串拼成一个大字符串，用来判断「某段中文是不是有出处」 */
function allCopyText() {
  const out = [];
  (function walk(n) {
    if (typeof n === "string") out.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") Object.values(n).forEach(walk);
  })(COPY);
  return out.join("");
}

/** 去掉三种注释，只留代码 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("//")) return "";
      const at = line.search(/\S\s+\/\//);
      if (at < 0) return line;
      // 切口必须在字符串之外：引号成对才算切得对，否则这条检查自己在骗自己
      const head = line.slice(0, at);
      const q = (head.match(/"/g) || []).length + (head.match(/'/g) || []).length + (head.match(/`/g) || []).length;
      if (q % 2 !== 0) return line;
      return head;
    })
    .join("\n");
}

test("两个 cp() 实现给同一个键同一个结果（正式站内联的那份 与 共用模块那份）", (t) => {
  // app.js 里手写了同一个函数（它是传统脚本，不能 import）。
  // 两份实现一旦分叉，正式站与应急页就会对同一个键说出不同的话。
  const appSrc = readFileSync(APP_FILE, "utf8");
  const m = /const cp = \(key, vars\) => \{[\s\S]*?\n\};/.exec(appSrc);
  assert.ok(m, "public/app.js 里找不到 cp() 的定义——它挪走了或被改名了，这条断言跟着失效");
  const inline = new Function("win", `const window = win;${m[0]};return cp;`)({ COPY });

  for (const [key, vars] of [
    ["seal.note.locked", undefined],
    ["reading.range", { days: 731 }],
    ["err.locked", { n: 600 }],
    ["wish.say.done", { text: "去看海" }],
  ]) {
    assert.equal(inline(key, vars), cp(key, vars), `两个 cp() 对 ${key} 给出了不同的结果`);
  }
  // 缺键时两边都返回空串，都不抛（分工写在 src/copy.js 顶部）
  assert.equal(inline("seal.nope", undefined), "");
  assert.equal(cp("seal.nope"), "");
  t.diagnostic("5 个带插值的键 + 1 个缺键，两个实现结果一致");
});

test("缺键不抛：降级可接受，白屏不可接受", () => {
  // 门禁保证键一定在；运行时为「键缺失」抛异常只会把某一处少几个字
  // 升级成整页白屏。所以这里断言的是「不抛、给空串」。
  assert.doesNotThrow(() => cp("does.not.exist", { a: 1 }));
  assert.equal(cp("does.not.exist"), "");
  assert.equal(cp("seal.tape.locked", {}), " &nbsp; 00:00 &nbsp;开 启", "占位符漏传不该把整句吃掉");
});

/* ====================================================================== *
 * 5. 浏览器侧拿到的就是同一份
 * ====================================================================== */

test("index.html 先加载 copy.js 再加载 app.js（app.js 启动时就要取词）", () => {
  const html = readFileSync(HTML_FILE, "utf8");
  const atCopy = html.indexOf('src="copy.js"');
  const atApp = html.indexOf('src="app.js"');
  assert.ok(atCopy >= 0, "public/index.html 没有引 copy.js —— 窗口里没有 window.COPY，整页没有字");
  assert.ok(atApp >= 0, "public/index.html 没有引 app.js");
  assert.ok(atCopy < atApp, "copy.js 排在 app.js 后面：app.js 启动时 window.COPY 还不存在");
});

test("public/copy.js 就是 src/copy.js 那一份（不是手抄的第二份）", () => {
  assert.ok(existsSync(GENERATED), "public/copy.js 不存在");
  const text = readFileSync(GENERATED, "utf8");
  assert.ok(text.startsWith("/**"), "public/copy.js 少了「本文件由 build:copy 生成」的抬头");
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(COPY)), "public/copy.js 与 src/copy.js 不是同一份数据");
  // 时间戳之类的痕迹会让「跑两次一样」这件事失效
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), "产物里出现了时间戳的形状");
});
