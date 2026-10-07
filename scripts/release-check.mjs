/**
 * Release 自检：**这个包能不能公开**。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────
 * 「本地跑通只说明代码逻辑对」在泄露这件事上有个更凶的版本：
 * 一个包看起来是源码，实际上带着别人的照片。真发布出去，**收不回来**。
 * 所以这里不是「扫一遍没报错就算干净」，而是有三组各自能失败的判据。
 *
 * ── 三组判据 ───────────────────────────────────────────────────────────
 * ① **结构性**（不需要知道真值）：数据目录、库文件、密钥、图片白名单。
 *    这组能证伪：把 `photos/together/01.jpg` 塞进包里，它当场报红。
 *
 * ② **内容性**（真值从环境变量传入）：真实口令、文案片段、照片 sha256、
 *    真实域名。**脚本本身一个真值都不写** ——
 *    写进去就是 `check-secrets.mjs` 注释里那个 `FORBIDDEN_AS_TEST_SECRET` 悖论。
 *
 * ③ **阳性对照**（本文件最要紧的一处设计）：
 *    **一个真值都没传时，拒绝放行**。
 *    否则就会出现这个形状：传 0 个真值 → 0 处命中 → 打印「干净」→ 退出 0。
 *    那个 0 处命中证明的是「你没给我要找的东西」，不是「包里没有」。
 *    2026-10-06 本项目已经吃过同族的一次亏：`tools/mut` 报 SURVIVED 时，
 *    真因是变异压根没传到被测物，而报告读起来像「判据太弱」。
 *
 * 用法：
 *   node scripts/release-check.mjs --dir <解包目录>
 *   # 带真值（发布前**必须**带）：
 *   REL_REAL_PORTS=… REL_REAL_TEXT=… REL_REAL_PHOTO_SHA=… REL_REAL_DOMAIN=… \
 *     node scripts/release-check.mjs --dir <解包目录>
 * 退出码：0 = 可公开；1 = 有 FAIL；2 = 用法错或自身跑不起来。
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * 命令行解析。**`--key=value` 与 `--key value` 两种写法都要认。**
 *
 * 只认等号那一种是个真 bug：`make-release.mjs` 的收尾提示与 `ops/LOGGING.md`
 * 里写的都是 `--dir <目录>`（空格分隔），于是 `DIR` 变成字符串 `"true"`，
 * 报出来的是「读不了 true」——一个看起来像路径写错的错，真实原因是解析器
 * 把下一个参数吃掉了。2026-10-06 实测。
 *
 * 判据是**文档与提示里怎么写，就怎么支持**：那里出现的是空格形式。
 */
function parseArgs(argv) {
  const out = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(rest[i]);
    if (!m) continue;
    const key = m[1];
    if (m[2] !== undefined) {
      out[key] = m[2];
    } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
      out[key] = rest[++i];
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const DIR = args.dir ? String(args.dir) : null;
if (!DIR) {
  console.error("用法：node scripts/release-check.mjs --dir <解包目录>");
  process.exit(2);
}

/** 真值从 env 进来。**仓库里一个真值都不留。 */
const REAL_PORTS = (process.env.REL_REAL_PORTS || "").split(",").map((s) => s.trim()).filter(Boolean);
const REAL_TEXTS = (process.env.REL_REAL_TEXT || "").split("\n").map((s) => s.trim()).filter(Boolean);
const REAL_PHOTO_SHAS = (process.env.REL_REAL_PHOTO_SHA || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// 多个真域名用逗号分隔（真实部署常有主站 + 别名/子域，全都要搜干净）。
const REAL_DOMAINS = (process.env.REL_REAL_DOMAIN || "").split(",").map((s) => s.trim()).filter(Boolean);

let fails = 0;
const ok = (m) => console.log(`  \x1b[32mOK  \x1b[0m ${m}`);
const bad = (m) => {
  fails++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
};
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function walk(root) {
  const out = [];
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(path.relative(root, p).replace(/\\/g, "/"));
    }
  };
  rec(root);
  return out;
}

console.log(`Release 自检  dir=${DIR}`);

let files;
try {
  files = walk(DIR);
} catch (e) {
  console.error(`读不了 ${DIR}：${e.message}`);
  process.exit(2);
}
console.log(`共 ${files.length} 个文件`);

// ── ① 结构性 ───────────────────────────────────────────────────────────
head("① 结构性：有没有不该在包里的东西");

const BANNED_DIRS = ["data/", "photos/", ".scratch/", ".worktrees/", ".git/", "node_modules/", "dist/"];
for (const b of BANNED_DIRS) {
  const hit = files.filter((f) => f.startsWith(b));
  if (hit.length) bad(`${b} 在包里（${hit.length} 个）：${hit.slice(0, 3).join(", ")}${hit.length > 3 ? " …" : ""}`);
  else ok(`没有 ${b}`);
}

const BANNED_FILE = [
  [/\.db(-wal|-shm|-journal)?$/, "SQLite 库文件"],
  [/(^|\/)\.observer-key$/, "观察者 HMAC 密钥"],
  [/(^|\/)\.log-salt$/, "日志假名盐（它是密钥，不是日志）"],
  [/(^|\/)\.env(\..*)?$/, "环境变量文件"],
  [/copy\.local\.js$/, "本地文案覆盖"],
  [/\.tgz$/, "嵌套部署包"],
  [/(^|\/)verify.*\.out$|\.out$/, "一次性命令输出"],
];
for (const [re, what] of BANNED_FILE) {
  const hit = files.filter((f) => re.test(f));
  if (hit.length) bad(`${what}：${hit.slice(0, 3).join(", ")}`);
  else ok(`没有${what}`);
}

// 图片白名单：**只有站点自己的美术素材可以留**。
// 真实照片（共同层合照、双方上传）一张都不能在包里。
const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp|heic|mp4|mov)$/i;
const IMG_ALLOW = /^(public|prototype)\/yier-bubu\/|^docs\/screenshots\//;
const imgs = files.filter((f) => IMAGE_RE.test(f));
const badImgs = imgs.filter((f) => !IMG_ALLOW.test(f));
if (badImgs.length) {
  bad(`白名单外的图片 ${badImgs.length} 个：${badImgs.slice(0, 5).join(", ")}`);
} else {
  ok(`${imgs.length} 个图片全部在白名单内（站点美术素材 + docs/screenshots/ 产品截图）`);
}
// docs/screenshots/ 为什么可以放行（2026-10-06 加，理由写在白名单里而不是脑子里）：
//   它拍的是**占位符化产物**，所以图里的界面文字全是 `【改这里：…]`、照片是 seed
//   生成的占位块 —— 零真实内容是**构造保证**，不是「看着像没问题」。
//   而且下面还有两条交叉判据盯着它：README 引用的图必须与包里的图一一对应，
//   以及这 6 个身份/地名词在**所有文本文件**里零出现。
//   ⚠️ 如果哪天真往这里塞了真照片，上面两条**都不会报红** ——
//      它们查的是文本与引用关系。所以这一层的正确用法是：
//      换截图时重跑 `docs/release-screenshots/README.md` 里那套构建流程，
//      别手把一张图丢进来。

// mp3：生日 BGM 是私人素材，绝不能跟出去
const audios = files.filter((f) => /\.(mp3|wav|m4a|flac|ogg)$/i.test(f));
if (audios.length) bad(`音频文件：${audios.join(", ")} —— BGM 是私人素材`);
else ok("没有音频文件");

// 2026-10-06 加的：产物里的 HTML 必须**结构上**能被浏览器解析。
//
// 为什么这道闸在这里：事故当天产物的 public/index.html 里那段注释没闭合，
// 浏览器把后面整份文档当注释 —— 没有样式表、标题为空、页面完全不样式化。
// 而 check-syntax（只解析 JS）、check-copy（只比文案）、release-check 的
// 其余判据（只扫秘密）、以及 250 条测试，**全部是绿的**。
// 一句话：那道损坏只在**真浏览器打开它**时才可见。
// 所以「结构可解析」不能靠人看，也不能靠别的门禁顺手 —— 它自己就是一条判据。
const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
let htmlBad = 0;
for (const hf of htmlFiles) {
  const t = readFileSync(path.join(DIR, hf), "utf8");
  const opens = (t.match(/<!--/g) || []).length;
  const closes = (t.match(/-->/g) || []).length;
  // 未闭合的注释会把后续整份文档吞掉：浏览器不报错，只是安静地什么都不渲染。
  if (opens !== closes) { bad(`${hf}：HTML 注释不配平（<!-- ${opens} 个 / --> ${closes} 个）`); htmlBad++; continue; }
  // 取 head/title/link 前**先遮蔽注释**。事故当天 index.html 的注释里**本身
  // 就写着字面量 `<title>`**；不遮蔽的话非贪婪 `<title>…</title>` 会从注释里
  // 那个开始匹配、把 `-->` 和真标题一起吞进捕获组 —— 于是「标题非空」这条判据
  // 变成**恒真式**（真标题被吞了它仍绿，真标题被删了它反而红，与意图相反）。
  // 独立复审用「置空真 title、release-check 仍 exit 0」实测到这个恒真式（2026-10-06）。
  // 遮罩用等长 \u0000，索引与原文一一对应。
  const masked = t.replace(/<!--[\s\S]*?-->/g, (m) => "\u0000".repeat(m.length));
  const headPart = masked.slice(0, (masked.search(/<\/head>/i) + 1) || masked.length);
  if (!/<link[^>]+rel=["']?stylesheet/i.test(headPart)) {
    bad(`${hf}：<head> 里没有样式表链接 —— 页面会完全没有样式`); htmlBad++; continue;
  }
  const title = headPart.match(/<title>([\s\S]*?)<\/title>/i);
  if (!title || !title[1].trim()) { bad(`${hf}：<title> 不存在或是空的`); htmlBad++; }
  // 挂载点必须在注释外。把 <div id="app"> 关进一段**配平**的注释，上面三条
  // 全过（注释确实配平、link 和 title 都还在注释外），浏览器却渲染一片空白 ——
  // 与事故同一类后果、同一个盲区，所以挂载点也得当成一条判据。
  const bodyPart = masked.slice(masked.search(/<body[\s>]/i), masked.search(/<\/body>/i));
  if (!/id=["']?app["'\s>]/i.test(bodyPart)) {
    bad(`${hf}：注释外找不到挂载点 id="app" —— 页面会空白（它被关进注释了？）`); htmlBad++;
  }
}
if (!htmlFiles.length) bad("包里一个 HTML 都没有 —— 这个包不该是空的（判据失效，拒绝放行）");
else if (!htmlBad) ok(`${htmlFiles.length} 个 HTML 结构完好（注释配平 / 样式表在位 / 标题非空 / 挂载点在注释外）`);

// 2026-10-06 加的：产物里不许有**中文身份代号**（判据本体在下面 textFiles 声明之后）。
//
// 为什么这道闸是补上去的：给 README 截图时在登录页看见两个按钮写着那两个词。
// 前三道门禁全绿 —— check-secrets 的判据全是 ASCII 形态，release-check 的内容性
// 比的是真实文案/照片/口令/域名，6 条阳性对照塞的也都是那几类。**中文一个都不在判据里。**
// 而这两个词是**两个真实的人的代号**，出现在公开仓库里等于点名。
//
// 为什么主仓保留而 Release 必须去掉：主仓里它们是 person 表里的**数据**（code），
// check-copy 的白名单明写「改它要动库与审计」；公开版里那是两个人的身份。
// 同一件事在两个仓库里结论相反 —— 所以它只能由**产物自检**兜住，不能靠人记得。

// ── ② 内容性：真值比对 ────────────────────────────────────────────────
head("② 内容性：包里有没有真值");

const textFiles = files.filter((f) => /\.(js|mjs|md|json|txt|sh|conf|service|html|css|yml|yaml|env\.example)$/i.test(f));

// 身份代号判据放在这里，因为它是**唯一一条需要 textFiles 而不需要真值**的：
// 「这个包该不该出现这两个词」不需要知道它们是什么，只要知道**该排除哪些形状**。
// 放在①里就得把 textFiles 提前声明，而①段的 `files` 与②段的口径不同，
// 提前声明会让两处扫的不是同一批文件 —— 那比顺序错更坏（看起来在扫，实际漏）。
const IDENTITY_TERMS = ["【改这里：doorCode】", "【改这里：heroCode】", "【改这里：boyfriend】", "【改这里：girlfriend】", "【改这里：place】", "【改这里：place】"];
{
  const idHits = [];
  for (const tf of textFiles) {
    let t;
    try { t = readFileSync(path.join(DIR, tf), "utf8"); } catch { continue; }
    for (const term of IDENTITY_TERMS) {
      const n = t.split(term).length - 1;
      if (n) idHits.push(`${tf}:${term}×${n}`);
    }
  }
  if (idHits.length) bad(`产物里有中文身份代号 ${idHits.length} 处 —— 那是两个真实的人的代号：${idHits.slice(0, 6).join(", ")}`);
  else ok(`中文身份代号零出现（${IDENTITY_TERMS.length} 个词 × ${textFiles.length} 个文本文件）`);
}

// README 里引用的截图必须**真的在包里**。断链的图在 GitHub 上是一个空占位，
// 而那不会让任何现有门禁变红 —— 所以「README 引用的每一张图都得存在」是它自己的判据。
// 反向也查：包里有多余的图，说明 README 与产物对不上。
{
  const SHOT_DIR = "docs/screenshots";
  const shots = files.filter((f) => f.startsWith(`${SHOT_DIR}/`) && /\.png$/i.test(f));
  const readmePath = path.join(DIR, "README.md");
  if (!existsSync(readmePath)) bad("包里没有 README.md —— 判据失效，拒绝放行");
  else {
    const r = readFileSync(readmePath, "utf8");
    const refs = [...r.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1].replace(/^\.\//, ""));
    if (!refs.length) bad("README 里一张图都没引用 —— 要么图没进包，要么模板改丢了那一段");
    else {
      const missing = refs.filter((p) => !existsSync(path.join(DIR, p)));
      if (missing.length) bad(`README 引用了 ${missing.length} 张不存在的图：${missing.join(", ")}`);
      else ok(`README 引用的 ${refs.length} 张图都在包里`);
    }
    const orphan = shots.filter((f) => !refs.includes(f));
    if (orphan.length) bad(`包里有图但 README 没引用（多出来或改名了）：${orphan.join(", ")}`);
    else if (shots.length) ok(`${shots.length} 张 PNG 与 README 的引用一一对应`);
  }
}

if (REAL_DOMAINS.length) {
  // 每个真域名都要搜干净。**只搜长域名那一个、而独立别名不含它为子串时**，
  // 别名会残留而「域名零出现」照样绿 —— 2026-10-06 实测踩到（残留 21 处）。
  const hit = [];
  const nameHit = [];
  for (const f of textFiles) {
    try {
      const t = readFileSync(path.join(DIR, f), "utf8");
      if (REAL_DOMAINS.some((d) => t.includes(d))) hit.push(f);
    } catch { /* 读不了就跳过 */ }
  }
  for (const f of files) if (REAL_DOMAINS.some((d) => f.includes(d))) nameHit.push(f);
  if (hit.length || nameHit.length) {
    bad(`真实域名出现在 ${[...hit, ...nameHit].slice(0, 5).join(", ")} —— 那是攻击面定位信息`);
  } else {
    ok(`真实域名零出现（${REAL_DOMAINS.length} 个域名，已扫 ${textFiles.length} 个文本文件 + 全部文件名）`);
  }
} else {
  console.log("  \x1b[33mSKIP\x1b[0m 真实域名（未传 REL_REAL_DOMAIN）");
}

if (REAL_PORTS.length) {
  const hit = [];
  for (const f of textFiles) {
    let t;
    try {
      t = readFileSync(path.join(DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const p of REAL_PORTS) if (t.includes(p)) hit.push(f);
  }
  if (hit.length) bad(`真实口令出现在：${[...new Set(hit)].slice(0, 5).join(", ")}`);
  else ok(`${REAL_PORTS.length} 个真实口令零出现`);
} else {
  console.log("  \x1b[33mSKIP\x1b[0m 真实口令（未传 REL_REAL_PORTS）");
}

if (REAL_TEXTS.length) {
  const hit = [];
  for (const f of textFiles) {
    let t;
    try {
      t = readFileSync(path.join(DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const x of REAL_TEXTS) if (x.length >= 6 && t.includes(x)) hit.push(f);
  }
  if (hit.length) bad(`真实文案出现在：${[...new Set(hit)].slice(0, 5).join(", ")}`);
  else ok(`${REAL_TEXTS.length} 段真实文案零出现`);
} else {
  console.log("  \x1b[33mSKIP\x1b[0m 真实文案（未传 REL_REAL_TEXT）");
}

if (REAL_PHOTO_SHAS.length) {
  const hit = [];
  for (const f of files) {
    if (!IMAGE_RE.test(f)) continue;
    let buf;
    try {
      buf = readFileSync(path.join(DIR, f));
    } catch {
      continue;
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    if (REAL_PHOTO_SHAS.includes(sha)) hit.push(f);
  }
  if (hit.length) bad(`真实照片的字节出现在：${hit.join(", ")} —— 按字节判定，改名改扩展名都躲不掉`);
  else ok(`${REAL_PHOTO_SHAS.length} 张真实照片的 sha256 零命中（按字节比对）`);
} else {
  console.log("  \x1b[33mSKIP\x1b[0m 真实照片（未传 REL_REAL_PHOTO_SHA）");
}

// ── ③ 阳性对照 ────────────────────────────────────────────────────────
head("③ 阳性对照：这次自检到底验到了什么");

const provided = REAL_PORTS.length + REAL_TEXTS.length + REAL_PHOTO_SHAS.length + (REAL_DOMAINS.length ? 1 : 0);
const skipped = [
  !REAL_DOMAINS.length && "域名",
  !REAL_PORTS.length && "口令",
  !REAL_TEXTS.length && "文案",
  !REAL_PHOTO_SHAS.length && "照片",
].filter(Boolean);

if (provided === 0) {
  // 关键：不是「警告」，是**拒绝放行**。
  console.log(`  \x1b[31mFAIL\x1b[0m 一条真值都没传 —— 上面②整组都在空跑。`);
  console.log(`        「0 处命中」证明的是「你没给我要找的东西」，不是「包里没有」。`);
  console.log(`        发布前必须带上 REL_REAL_PORTS / REL_REAL_TEXT / REL_REAL_PHOTO_SHA / REL_REAL_DOMAIN。`);
  fails++;
} else if (skipped.length) {
  console.log(`  \x1b[33mWARN\x1b[0m 只验了 ${provided} 项，${skipped.join("/")} 没传 —— 这些维度未被证明。`);
} else {
  ok(`四类真值全部验过（${REAL_PORTS.length} 口令 / ${REAL_TEXTS.length} 文案 / ${REAL_PHOTO_SHAS.length} 照片 / 域名）`);
}

// ── 结论 ────────────────────────────────────────────────────────────────
console.log("");
if (fails) {
  console.log(`\x1b[31m结论：${fails} 项 FAIL —— 不能公开。\x1b[0m`);
  process.exit(1);
}
if (skipped.length) {
  console.log(`\x1b[33m结论：结构性全过，但内容性只验了部分（${skipped.join("/")} 缺真值）。这不是「已证明干净」。\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m结论：结构性 + 内容性都过，可以公开。\x1b[0m");
process.exit(0);
