/**
 * 工单 07 · 应急静态单文件。
 *
 * 只断言**产物本身**：磁盘上那一个 .html 的字节与内容。
 * 不测内部函数、不起 HTTP 服务——这份页面的存在意义就是"服务挂了也能看"，
 * 服务起没起跟它无关。
 *
 * 跑法上的两条硬规矩：
 *   1. `DATA_DIR` 一律指**临时目录**。产物不进仓库的 data/，测试不能留垃圾。
 *   2. 导出脚本当**子进程**跑，断言它的退出码。脚本自检失败时必须红——
 *      吞掉自检等于撤销自检。
 *
 * 时间锁在这里**要测**，且两侧都测：未开门拒绝导出、已开门照常导出。
 * 单测一侧的话，闸门在 10-5 当天自己失效都没人知道（或者反过来，
 * 「一直拒绝」也能全绿）。时钟由子进程注入，不读本机真实时间。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb } from "../src/db.js";
import { OUT_MIME, ensurePhotosDir, writePhoto } from "../src/photos.js";
import { AT_UNLOCK } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "export-standalone.mjs");
/**
 * 假时钟引导模块：子进程用它接管自己的 Date，生产代码里没有这个开关。
 * `--import` 只吃 URL，Windows 上必须转 file://（绝对路径会被当成 d: 这个协议）。
 */
const FAKE_CLOCK = pathToFileURL(path.join(ROOT, "test", "fake-clock.mjs")).href;

/** 照片文件 id 形状与 photos.js 一致：p + 24 位十六进制 */
const photoId = (n) => "p" + n.toString(16).padStart(24, "0");

/* -------------------------------------------------------------------------- *
 * 小工具
 * -------------------------------------------------------------------------- */

/** 造一个带内容的临时库，返回 { dataDir, outFile, dbFile, photosDir } */
function makeDataDir() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "two-years-standalone-"));
  return {
    dataDir,
    dbFile: path.join(dataDir, "two-years.db"),
    photosDir: path.join(dataDir, "photos"),
    outFile: path.join(dataDir, "standalone", "two-years-standalone.html"),
  };
}

/**
 * 跑一次导出脚本。返回 { status, stdout, stderr } —— 退出码本身就是要断言的东西。
 *
 * `fakeNow` 注入的是**子进程自己的时钟**（`node --import test/fake-clock.mjs`），
 * 不在生产代码里留任何 `EXPORT_NOW` 之类的后门。缺省给「已开门」。
 *
 * 为什么缺省不是「开 force」：时钟注入一旦失效，脚本会读真实时间 → 今天未开门 →
 * 退出 1 → **测试变红**。若缺省开了 force，它就会静默退化成「反正 force 也能过」，
 * 全绿却什么都没验。
 *
 * @param {object} o
 * @param {string} o.dataDir @param {string} o.outFile @param {string} o.dbFile
 * @param {number} [o.fakeNow] 子进程时刻（epoch ms）
 * @param {boolean} [o.force] 是否强行导出
 */
function runExport({ dataDir, outFile, dbFile, fakeNow = AT_UNLOCK + 1000, force = false }) {
  const args = ["--disable-warning=ExperimentalWarning", "--import", FAKE_CLOCK, SCRIPT];
  if (force) args.push("--force");
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DB_FILE: dbFile,
      OUT_FILE: outFile,
      FAKE_NOW: String(fakeNow),
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 统计子串出现次数（正则的 g 语义，但按字面量匹配，避免正则元字符干扰） */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * 造一份**有内容**的库。
 *
 * 直接写库而不是走 HTTP：这份测试要的是一个"库里有对方内容"的样本，
 * 走 HTTP 还得先登录再解锁再上传，那是工单 02–05 的活。
 * 这里只证明"库里有 → 产物里就有"。
 *
 * @param {string} dbFile
 * @param {string} photosDir
 */
function seedFullLibrary(dbFile, photosDir) {
  const db = openDb(dbFile);
  try {
    // 3 张合照：9 格里的 3 格，其余走占位
    const sharedPhotos = [1, 2, 3].map((i) => ({
      id: photoId(i),
      file: path.join(photosDir, `${photoId(i)}.jpg`),
    }));
    // 各一方 2 张专属照片
    const giftPhotos = [4, 5, 6, 7].map((i) => ({
      id: photoId(i),
      file: path.join(photosDir, `${photoId(i)}.jpg`),
    }));

    // 落盘：字节是**可辨认的占位内容**。导出脚本只把字节原样 base64，
    // 不解码，所以这里不需要造真 JPEG——但内容唯一，测试才能反查内联的是哪张。
    const all = [...sharedPhotos, ...giftPhotos];
    ensurePhotosDir(photosDir);
    for (const p of all) {
      writePhoto(photosDir, p.id, Buffer.from(`FAKE-JPEG-BYTES-${p.id}`, "utf8"));
    }

    db.exec("BEGIN");
    try {
      // 共同层：哨兵 entry + 3 个合照槽位 + 祝福语
      db.prepare(
        "INSERT INTO entry(id, owner, kind, body, ord, created, deleted) " +
          "VALUES('@shared-layer', '@shared-layer', 'photo', NULL, 0, 1000, NULL)",
      ).run();
      const upsertSlot = db.prepare(
        "INSERT INTO shared(id, kind, body, ord) VALUES(?, 'together_photo', ?, ?)",
      );
      const upsertPhoto = db.prepare(
        "INSERT INTO photo(id, entry_id, mime, bytes, w, h) VALUES(?, ?, ?, 16, 100, 100)",
      );
      sharedPhotos.forEach((p, i) => {
        upsertSlot.run(`sh${i + 1}`, p.id, i + 1);
        upsertPhoto.run(p.id, "@shared-layer", OUT_MIME);
      });
      db.prepare("INSERT INTO shared(id, kind, body, ord) VALUES('blessing', 'blessing', ?, 0)").run(
        "七百三十个日夜。走过一些路，也吵过一些架。",
      );

      // 双方各自：信（第一条留言）+ 两张照片 + 最后一段话（最后一条留言）
      const putEntry = db.prepare(
        "INSERT INTO entry(id, owner, kind, body, ord, created, deleted) VALUES(?,?,?,?,?,?,NULL)",
      );
      for (const [owner, who] of [
        ["hero", "【改这里：heroCode】"],
        ["door", "【改这里：doorCode】"],
      ]) {
        const mine = giftPhotos.filter((_, i) => (owner === "hero" ? i < 2 : i >= 2));
        putEntry.run(`${owner}-t1`, owner, "text", `${who}写给你的第一封信。往后余生，也请多指教。`, 1, 1000);
        mine.forEach((p, i) => {
          putEntry.run(`${owner}-p${i}`, owner, "photo", `${who}留的第 ${i + 1} 张照片`, i + 2, 1100 + i);
          upsertPhoto.run(p.id, `${owner}-p${i}`, OUT_MIME);
        });
        putEntry.run(
          `${owner}-t2`,
          owner,
          "text",
          `${who}想说的最后一段话：明年还要一起过。`,
          99,
          9000,
        );
      }

      // 双方约定
      db.prepare("INSERT INTO wish(person_id, text) VALUES('door', ?)").run("搬到一起住");
      db.prepare("INSERT INTO wish(person_id, text) VALUES('hero', ?)").run("学会做对方最爱吃的那道菜");

      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { shared: sharedPhotos.length, gifts: giftPhotos.length, total: all.length };
  } finally {
    db.close();
  }
}

/* ====================================================================== *
 * 1. 产物存在且是**单个** .html
 * ====================================================================== */

test("导出一次：产物存在、是一个非空的 .html、目录里只有它一个文件", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);

  const r = runExport(d);
  assert.equal(r.status, 0, `导出必须成功退出：${r.stdout}${r.stderr}`);

  assert.ok(existsSync(d.outFile), `产物没落在 ${d.outFile}：${r.stdout}${r.stderr}`);
  assert.ok(d.outFile.endsWith(".html"), "产物是 .html，双击就能用浏览器打开");
  const size = statSync(d.outFile).size;
  assert.ok(size > 0, "产物不能是空文件");

  // 「单文件」的真正含义：目录里除了它没有别的东西。
  // 多一个 .css / .js 目录，双击打开时就全丢了——那就不是兜底，是把内容搬了个地方。
  const siblings = readdirSync(path.dirname(d.outFile));
  assert.deepEqual(siblings, ["two-years-standalone.html"], `产物目录里只该有这一个文件，实际：${siblings}`);
  t.diagnostic(`产物 ${(size / 1024).toFixed(1)} KB，目录内仅此一个文件`);
});

/* ====================================================================== *
 * 2. 打开零网络请求
 * ====================================================================== */

test("产物里 <img src=\"http 出现 0 次、外链 script 0 次、整个文件没有任何 http(s) 引用", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);
  assert.equal(runExport(d).status, 0, "导出必须成功");

  const html = readFileSync(d.outFile, "utf8");

  assert.equal(countOf(html, '<img src="http'), 0, "产物里不许有外链图片——双击打开时会发请求");
  assert.equal(countOf(html, '<script src="http'), 0, "产物里不许有外链脚本");
  assert.equal(countOf(html, "<script"), 0, "这份页面不需要任何脚本，一个 <script> 都不该有");
  // 这条只对**本样本**成立：这份种子数据里没有链接，所以全文无 http(s) 字样。
  // 它不是脚本的自检策略——自检只盯「打开时会发请求」的属性位置，刻意不扫全文
  // （用户在信里贴一个链接是正常内容，不是联网行为）。策略本身由上面两条，
  // 加下一节那条「信里有链接照样导出」的回归测试一起钉住。
  assert.equal(
    (html.match(/\bhttps?:\/\//gi) || []).length,
    0,
    "产物里出现了 http(s) 字样，列一下它出现在哪：",
  );
  t.diagnostic('`<img src="http` 0 次；`<script` 0 次；全文无 http(s)');
});

/* ====================================================================== *
 * 3. 图片真的内联了（数量对得上）
 * ====================================================================== */

test("每张库里的照片都内联成 data: URI，src=\"data:image/ 的出现次数等于图片总数", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  const seeded = seedFullLibrary(d.dbFile, d.photosDir);
  assert.equal(runExport(d).status, 0, "导出必须成功");

  const html = readFileSync(d.outFile, "utf8");
  const inlined = countOf(html, 'src="data:image/');

  assert.equal(
    inlined,
    seeded.total,
    `库里一共 ${seeded.total} 张照片（共同层 ${seeded.shared} + 双方专属 ${seeded.gifts}），` +
      `产物里必须正好有 ${seeded.total} 个内联 data: URI，实际 ${inlined}`,
  );
  // 逐张点名：内联的必须是这 7 个真实文件 id 的字节，不是占位。
  // 只对数量的话，"7 张占位块"也能把数字凑对——它证明不了图片真的在里面。
  for (let i = 1; i <= seeded.total; i++) {
    const id = photoId(i);
    const b64 = Buffer.from(`FAKE-JPEG-BYTES-${id}`, "utf8").toString("base64");
    assert.ok(
      html.includes(`data:image/jpeg;base64,${b64}`),
      `照片 ${id} 的字节没有出现在产物里——图片没有真正内联`,
    );
  }
  t.diagnostic(`${seeded.total} 张照片逐张按字节对上`);
});

/* ====================================================================== *
 * 4. 幂等：跑两次逐字节一致
 * ====================================================================== */

test("同一份库跑两次，产物逐字节一致（时间戳之类不许进产物）", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);

  assert.equal(runExport(d).status, 0, "第一次导出必须成功");
  const first = readFileSync(d.outFile);
  assert.equal(runExport(d).status, 0, "第二次导出必须成功");
  const second = readFileSync(d.outFile);

  assert.equal(
    Buffer.compare(first, second),
    0,
    `同一份库两次导出产物不一致（${first.length} vs ${second.length} 字节）。` +
      "多半是产物里掺了导出时刻或随机值——找出第一个不同的字节位置对着看。",
  );
  // 再导一次，覆盖「同一进程连着导」之外的另一条路径
  assert.equal(runExport(d).status, 0, "第三次导出必须成功");
  assert.equal(Buffer.compare(first, readFileSync(d.outFile)), 0, "第三次仍然要一致");
  t.diagnostic(`三次导出均一致，${first.length} 字节`);
});

/* ====================================================================== *
 * 5. 内容齐全：库里有 → 产物里就有
 * ====================================================================== */

test("库里有对方内容时，产物里一字不少地看得见（应急页就是要在开门当天能看全）", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);
  assert.equal(runExport(d).status, 0, "导出必须成功");
  const html = readFileSync(d.outFile, "utf8");

  // 逐段点名。**包括对方的**——应急页的兜底价值正在这里：
  // 她打开这一个文件，看到的是全部，不是自己那一半。
  const must = [
    // 共同层
    "七百三十个日夜。走过一些路，也吵过一些架。", // 祝福语
    // 双方各自的信
    "【改这里：heroCode】写给你的第一封信。往后余生，也请多指教。",
    "【改这里：doorCode】写给你的第一封信。往后余生，也请多指教。",
    // 双方各自的最后一段话
    "【改这里：heroCode】想说的最后一段话：明年还要一起过。",
    "【改这里：doorCode】想说的最后一段话：明年还要一起过。",
    // 照片配文
    "【改这里：heroCode】留的第 1 张照片",
    "【改这里：heroCode】留的第 2 张照片",
    "【改这里：doorCode】留的第 1 张照片",
    "【改这里：doorCode】留的第 2 张照片",
    // 双方约定
    "搬到一起住",
    "学会做对方最爱吃的那道菜",
  ];
  for (const text of must) {
    assert.ok(html.includes(text), `产物里没有这段内容：${text.slice(0, 20)}…`);
  }
  t.diagnostic(`${must.length} 段内容逐条命中（含双方的信/照片配文/最后一段话/约定）`);
});

/* ====================================================================== *
 * 6. 空库不炸
 * ====================================================================== */

test("空库导出：不炸，退出码 0，产出占位说明页", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  // 故意只建空库：连 person 之外的行都没有，合照/信/约定全空
  openDb(d.dbFile).close();

  const r = runExport(d);
  assert.equal(r.status, 0, `空库导出必须退出 0 而不是抛错：${r.stdout}${r.stderr}`);
  assert.ok(existsSync(d.outFile), "空库也要产出一个文件");
  const html = readFileSync(d.outFile, "utf8");
  assert.ok(html.includes("<html"), "空库产物也得是完整的 HTML");
  assert.ok(html.includes("</html>"), "空库产物也得以 </html> 收尾");
  // 占位说明得说清楚「还空着」，而不是给一片白
  assert.ok(html.includes("还没"), "空库产物应当说明这些块还空着");
  t.diagnostic(`空库：退出 0，${statSync(d.outFile).size} 字节占位页`);
});

/* ====================================================================== *
 * 7. 素材缺失不炸：库里有 photo 行，盘上文件没了
 * ====================================================================== */

test("照片文件缺失：照常产出占位，退出码 0，不炸", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  const seeded = seedFullLibrary(d.dbFile, d.photosDir);
  // 删掉一张共同层合照的文件：库里的行还在，盘上没了
  rmSync(path.join(d.photosDir, `${photoId(1)}.jpg`), { force: true });
  assert.ok(seeded.total > 1);

  const r = runExport(d);
  assert.equal(r.status, 0, `缺一张照片文件不该让整份导出失败：${r.stdout}${r.stderr}`);
  const html = readFileSync(d.outFile, "utf8");
  // 剩下 6 张照常内联
  assert.equal(
    countOf(html, 'src="data:image/'),
    seeded.total - 1,
    "缺一张就少一张，其余全部照常内联",
  );
  t.diagnostic(`缺 1 张文件：退出 0，内联 ${seeded.total - 1} 张`);
});

/* ====================================================================== *
 * 8. 同一个东西，两处措辞必须一致
 * ====================================================================== */

/**
 * 从正式站**用的那份文案数据**里把占位块的词取出来。
 *
 * 断言的不是「两边都写『照 片』」——那会允许有人把两边一起改掉、悄悄变回不一致。
 * 真正的不变量是**「应急页和正式站用同一个词」**，所以词本身从正式站读，
 * 应急页按它来对。正式站改了，应急页这边会红，那才是要的效果。
 *
 * ⚠️ 2026-10-03 文案抽到 src/copy.js 之后，这一条**只改了「词从哪读」**：
 * 原来从 public/app.js 的 `FB = {...}` 字面量里抠，现在从正式站浏览器侧
 * 真正加载的那份数据（public/copy.js）里读。断言的内容一个字没动：
 * 仍是「应急页产物里的词 === 正式站那份数据里的词」。之所以不再读 app.js：
 * 用词搬进 copy.js 之后 app.js 里已经没有那个字面量了（这条断言自己
 * 原来的失败消息就写着「占位块用词搬走了，这条断言改一下」）。
 */
function formalPlaceholderWord(key) {
  const src = readFileSync(path.join(ROOT, "public", "copy.js"), "utf8");
  // 先把 placeholder 那一块单独抠出来再找 key：生成的 JSON 里 `photo` 这个键名
  // 在 card.kind 下**也**有一份（那张卡的标题），全文件搜会搜错那一份去。
  const block = /"placeholder":\s*\{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(block, "public/copy.js 里找不到 placeholder 那一块 —— 占位块用词搬走了，这条断言改一下");
  const m = new RegExp(`"${key}":\\s*"([^"]*)"`).exec(block[1]);
  assert.ok(m, `public/copy.js 的 placeholder 里找不到 ${key} —— 占位块用词搬走了，这条断言改一下`);
  return m[1];
}

test("应急页的占位块用词与正式站同一个（照片卡 / 九宫格）", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);
  // 删掉一张**双方照片**（不是共同层合照）：合照走 grid()，照片走 photoCard()，两条路
  rmSync(path.join(d.photosDir, `${photoId(4)}.jpg`), { force: true });
  rmSync(path.join(d.photosDir, `${photoId(1)}.jpg`), { force: true });

  const r = runExport(d);
  assert.equal(r.status, 0, `导出不该失败：${r.stdout}${r.stderr}`);
  const html = readFileSync(d.outFile, "utf8");

  const photoWord = formalPlaceholderWord("photo");   // 正式站「照 片」
  const shotWord = formalPlaceholderWord("shot");     // 正式站「合 照」

  // 把产物里那一块**实际写出来的字**取出来对，而不是问「包不包含某个串」——
  // 后者在两边都不匹配时只告诉你「没有」，不告诉你是哪个字。报实际值。
  const found = /<div class="ph">([^<]*)<\/div>/.exec(html);
  assert.ok(found, "产物里一个照片卡的占位块都没有 —— 前面的断言全在空转");
  assert.equal(
    found[1],
    photoWord,
    `应急页照片卡缺文件时顶上那块写的是「${found[1]}」，正式站是「${photoWord}」—— 同一个东西两处措辞必须一致` +
      (/\d/.test(found[1]) ? "（带编号是早先那版，编号不该出现在这一块上）" : ""),
  );
  assert.ok(
    html.includes(`<span>${shotWord}</span>`),
    `应急页九宫格缺图时没有用正式站的用词「${shotWord}」`,
  );
  t.diagnostic(`照片卡「${found[1]}」/ 九宫格「${shotWord}」两处与正式站一致`);
});

test("应急页的 alt 保留编号：它与可见占位块不是一回事", (t) => {  // alt 是给读屏软件念的，念「照片 3」才说得出第几张；
  // 可见占位块那一条是给人看的，所以不带编号。**别把两者一起改。**
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);
  rmSync(path.join(d.photosDir, `${photoId(4)}.jpg`), { force: true });

  const r = runExport(d);
  assert.equal(r.status, 0, `导出不该失败：${r.stdout}${r.stderr}`);
  const html = readFileSync(d.outFile, "utf8");
  assert.match(html, /alt="照片 \d+"/, "应急页照片卡的 alt 丢了编号 —— 读屏用户听不出这是第几张");
});

test("应急页的标签页标题与正式站同一个词", (t) => {
  /* 与占位块同一条纪律：断言的是「两边一样」，不是「两边都写某串」。
     词从 public/index.html 里取，所以正式站改标题时这里会红。 */
  const htmlFile = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const title = /<title>([^<]*)<\/title>/.exec(htmlFile);
  assert.ok(title, "public/index.html 里没有 <title>");

  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);
  assert.equal(runExport(d).status, 0, "导出必须成功");
  const html = readFileSync(d.outFile, "utf8");

  const got = /<title>([^<]*)<\/title>/.exec(html);
  assert.ok(got, "应急页产物里没有 <title>");
  assert.equal(
    got[1],
    title[1],
    `应急页标题是「${got[1]}」，正式站是「${title[1]}」—— 兜底页不该是另一个名字`,
  );
  // & 在 HTML 源码里必须转义：裸的 & 虽然浏览器大多能容错，但那是躺在交付文件里的隐患
  assert.ok(got[1].includes("&amp;"), "标题里的 & 必须写成 &amp;，不能是裸的 &");
  t.diagnostic(`两处标题一致：${got[1]}`);
});

/* ====================================================================== *
 * 8. 代号，不是真名
 * ====================================================================== */

test("产物里出现的是代号（【改这里：doorCode】 / 【改这里：heroCode】），不出现真名与角色", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);
  assert.equal(runExport(d).status, 0, "导出必须成功");
  const html = readFileSync(d.outFile, "utf8");

  // 代号必须在
  assert.ok(html.includes("【改这里：doorCode】"), "产物里必须有代号 【改这里：doorCode】");
  assert.ok(html.includes("【改这里：heroCode】"), "产物里必须有代号 【改这里：heroCode】");
  // role 字段（【改这里：girlfriend】/【改这里：boyfriend】）不该出现：站上只用代号，role 只给后端用
  for (const leak of ["【改这里：girlfriend】", "【改这里：boyfriend】"]) {
    assert.ok(!html.includes(leak), `产物里出现了角色字样：${leak}`);
  }
  t.diagnostic("两个代号都在；【改这里：girlfriend】/【改这里：boyfriend】 一个都没有");
});

/* ====================================================================== *
 * 自检的判别力：它该拦的拦，不该拦的别拦
 *
 * 这一节钉的是**自检的边界**，不是产物内容。
 * 早先自检用 `/\bhttps?:\/\//i` 扫全文，于是她在信里贴一个链接 → 自检不过 →
 * 零产物 → 应急页在 10-5 当天当场归零，而报错指向自检项，看不出是内容导致。
 * 「零外链」是硬指标，「文本里不许有链接」不是——后者会把兜底页变成一次性炸弹。
 * ====================================================================== */

test("自检·信里贴了 https 链接照样能导出，链接原样保留", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  const db = openDb(d.dbFile);
  try {
    db.prepare(
      "INSERT INTO entry(id, owner, kind, body, ord, created, deleted) " +
        "VALUES('door-t1', 'door', 'text', ?, 1, 1000, NULL)",
    ).run("我们第一次看的电影在这儿 https://example.com/watch?v=1 ，记得买两张票。");
  } finally {
    db.close();
  }

  const r = runExport(d);
  assert.equal(
    r.status,
    0,
    `信里一个链接就让整份应急页导出失败、零产物——兜底当场归零：\n${r.stdout}${r.stderr}`,
  );
  assert.ok(existsSync(d.outFile), "导出失败了，产物没落盘");
  const html = readFileSync(d.outFile, "utf8");
  assert.ok(html.includes("example.com/watch"), "链接本身该原样在里面（不可点即可，丢内容不行）");
  t.diagnostic("信里的 https 链接：导出成功，内容原样保留");
});

/* ====================================================================== *
 * 时间锁：没到开门时刻拒绝导出
 *
 * 这份产物是一份**可转发、不可撤回**的完整副本。10-4 有人「先导出试试」就会
 * 永久生成一份绕过时间锁的完整内容，事后闸门怎么改都追不回来。
 *
 * 两侧都测：闸门把「该开的时候也拒绝」当成通过，是一种很安静的死法。
 * ====================================================================== */

test("时间锁·未开门：退出码 1、说明原因，产物与产物目录都不落盘", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);

  const r = runExport({ ...d, fakeNow: AT_UNLOCK - 1000 });
  assert.equal(r.status, 1, `未开门却导出成功了（exit ${r.status}）：\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /拒绝导出/, "没有说明为什么拒绝");
  assert.ok(!existsSync(d.outFile), "拒绝导出却把文件写出来了");
  assert.ok(!existsSync(path.dirname(d.outFile)), "拒绝导出却把产物目录建出来了");
  t.diagnostic(`未开门：退出码 ${r.status}，产物目录也没建`);
});

test("时间锁·已开门：不加 --force 照常导出，产物里没有水印", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);

  const r = runExport({ ...d, fakeNow: AT_UNLOCK + 1000 });
  assert.equal(r.status, 0, `已开门却导不出（exit ${r.status}）：\n${r.stdout}${r.stderr}`);
  assert.ok(existsSync(d.outFile), "已开门却没产出文件");
  const html = readFileSync(d.outFile, "utf8");
  assert.ok(!html.includes("之前导出的"), "正常导出的产物不该带「未解锁导出」水印");
  t.diagnostic("已开门：正常导出，无水印");
});

test("时间锁·未开门但 --force：能导出，且产物必须打上「未解锁导出」水印", (t) => {
  const d = makeDataDir();
  t.after(() => rmSync(d.dataDir, { recursive: true, force: true }));
  seedFullLibrary(d.dbFile, d.photosDir);

  const r = runExport({ ...d, fakeNow: AT_UNLOCK - 1000, force: true });
  assert.equal(r.status, 0, `--force 是逃生口，不该失败：\n${r.stdout}${r.stderr}`);
  const html = readFileSync(d.outFile, "utf8");
  // 强行导出和正常导出若长得一模一样，就没人分得出这一份早于开门时刻存在过。
  assert.ok(
    html.includes("之前导出的") && html.includes("绕过了时间锁"),
    "强行导出的产物没有水印——错误消息承诺了水印，产物就得真的有",
  );
  t.diagnostic("强行导出：水印在，导出成功");
});
