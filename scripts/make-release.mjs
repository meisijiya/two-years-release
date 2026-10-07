/**
 * 构建纯净 Release 产物。
 *
 * ── 为什么用白名单而不是黑名单 ─────────────────────────────────────────
 * 黑名单（"剔掉这些"）的失效形态是**新增一个顶层目录忘了加进黑名单**，
 * 它就直接进了公开仓库。而这个包里最要紧的东西恰恰是「不该在」：
 * 真实照片、真实文案、真实部署记录。白名单让「漏掉」的方向反过来了 ——
 * 新增目录的默认后果是**不在包里**，那是安全的那一侧。
 *
 * 这不是理论洁癖：本项目 2026-10-04 那次审计手工脱敏了 49 个文件，
 * 事后证明「没有任何东西守着」，于是才有 `check-secrets.mjs`。
 * 一次性清单靠不住，能进包的东西要有个稳定的定义方式。
 *
 * ── 白名单里为什么是这些 ───────────────────────────────────────────────
 *   src/ public/ deploy/ scripts/ test/   代码与门禁，项目的本体
 *   init.sh package.json package-lock.json  规范入口与依赖锁
 *   .gitignore .gitattributes             行尾与忽略规则（**必须带**，否则
 *                                         二次开发者会把自己的照片提交进去）
 *   CONSTRAINTS.md                        质量基线，这个项目的精华
 *   README.md PLACEHOLDERS.md             本脚本生成，面向二次开发者
 *
 * 不在白名单里的（各自有理由，写在这里免得将来有人以为是漏了）：
 *   ops/            真实主机别名、/opt/two-years 路径、真实 nginx 位置
 *   docs/evidence/  对真实站点跑过的证据：写真实域名、真实行数、真实部署细节
 *   docs/contracts/ 本项目的工单契约
 *   AGENTS.md       写给编码代理的协作指令，与使用者无关
 *   design.md SPEC.md feature-spec.md TEST-STRATEGY.md RUNBOOK.md
 *                  本项目的内部决策记录，含真实代号与内容设计
 *   prototype/      内部设计稿
 *   deploy/README.md 里面的 8443 预览流程是本项目专属操作，不是通用部署说明
 *
 * 用法：
 *   node scripts/make-release.mjs            # 解包到 .scratch/release/pkg
 *   node scripts/make-release.mjs --tar      # 额外打一个 tgz
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".scratch", "release");
const PKG = path.join(OUT, "pkg");
const WANT_TAR = process.argv.includes("--tar");

/**
 * 要脱敏的域名。
 *
 * ⚠️ **从环境变量读，不在这里硬编码** —— 2026-10-06 第一版把真域名的
 *    主机名部分写死在这份文件里，那是把真域名的第二份副本放进脚本，
 *    而 `check-secrets.mjs` 的 `ALLOWED_DOMAINS` 已经是第一份。
 *    域名一改，脚本会**静默变成什么都不替换**，自检却因为传的是同一个值而全绿 ——
 *    「脱敏的输入」与「自检要找的值」来自同一个错误源头时，两边一起错。
 *
 * 跑法：`REL_REAL_DOMAIN=<你的域名> node scripts/make-release.mjs`
 * 不传就直接拒绝构建：脱敏域名写错的后果是整个包带着真域名发出去。
 */
// 真实部署往往不止一个域名（主站 + 别名/子域），nginx 的 server_name 里逐个列出。
// **只替换其中一个、其余原样留下，等于把别名也发出去** —— 而自检若也只搜那一个，
// 同样扫不到，于是「域名零出现」是假绿。2026-10-06 实测踩到：长域名（主站）
// 替换干净，而短域名（独立 server_name，**不含**长域名为子串）在 3 个 nginx conf
// + check-secrets.mjs 里**残留 21 处**，门禁全绿放行。
// 跑法：`REL_REAL_DOMAIN=<域名1>,<域名2> node scripts/make-release.mjs`
// 多个值逗号分隔；**长域名优先替换**（长含短时先换长，短的一并带走）。
const REAL_DOMAINS = String(process.env.REL_REAL_DOMAIN || "")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .sort((a, b) => b.length - a.length);
if (!REAL_DOMAINS.length) {
  console.error("缺少 REL_REAL_DOMAIN —— 这是要脱敏掉的域名（多个用逗号分隔），不传就不构建。");
  console.error("  （它不在仓库里是有意的：check-secrets.mjs 的 ALLOWED_DOMAINS 才是它的单一真相源）");
  process.exit(2);
}
const PLACEHOLDER_DOMAIN = "example.com";

/** 进包的东西。**新增顶层目录的默认后果是「不在包里」**。 */
const INCLUDE = [
  "src", "public", "deploy", "scripts", "test",
  "init.sh", "package.json", "package-lock.json",
  ".gitignore", ".gitattributes", "CONSTRAINTS.md",
  // 2026-10-06 加：README 要有产品图。
  // 走**白名单路径**而不是整个 docs/ —— docs/ 下还有 evidence/ 与 contracts/，
  // 那两个目录各有各的不该进包的理由（见文件头）。只点名 docs/release-screenshots/，
  // 于是将来在 docs/ 下新建别的目录时，默认仍然不在包里。
  "docs/release-screenshots",
];

/**
 * **实际剔除**的文件（构建期删掉）。
 *
 * ⚠️ 这份清单与下面的 `EXPECT_EXCLUDE` **必须是两件事**。
 *   2026-10-06 实测踩到：早先只有这一个列表，后来为了修「正向判据把
 *   「那个带域名的 nginx 配置」报成缺少」，顺手把改名后的文件也加了进来 ——
 *   于是它**被直接删掉**而不是改名成 `site-443.conf`，产物里那份 nginx 配置
 *   凭空消失，而构建脚本没报错、自检全绿、正向判据也全绿。
 *   「这个文件最后不在包里」有**两种**原因（删掉 / 改名），
 *   把它们混进一个清单就分不出是哪种 —— 而分不出的后果是**静默少一个文件**。
 */
const EXCLUDE_PATHS = [
  "deploy/README.md",              // 8443 预览流程是本项目专属操作
  "public/bgm.mp3",                // 私人 BGM，见 2b
  "scripts/check-evidence.mjs",    // 与 docs/evidence/ 同进同出，见 2d
];

/**
 * 只用于**正向判据的期望集**（见 7b）：树里有、但构建期会以别的方式处理掉，
 * 因而不该出现在产物里 —— 目前只有「被改名」这一类。它**不**参与剔除。
 *
 * ⚠️ 这里**不能写死文件名**。2026-10-06 第一版写的是
 * `deploy/nginx/<真域名>-top.conf`，于是真域名的**主机名部分**以第二份副本的形式
 * 留在了这个脚本里（注释里也有一处）。而 `check-secrets.mjs` 的域名规则
 * `skipFiles` 含 `\\.mjs` —— **它看不见 .mjs 里的域名**，所以门禁也不会报。
 * 改名那一步改成**从目录里探测**那个文件名，真域名一个都不进源码。
 */
const EXPECT_EXCLUDE = [];

console.log("构建 Release …");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(PKG, { recursive: true });

// 1. 白名单 archive —— 文件名里不会带 docs/contracts 的中文名，
//    顺带绕开了 Windows tar 处理非 ASCII 文件名的 bug（实测 2026-10-06）。
//
//    ⚠️ **必须用 `git write-tree` 而不是 `HEAD`** —— 2026-10-06 实测踩到：
//    第一版写的是 `git archive ... HEAD`，而当轮改动都还在**暂存区**没 commit。
//    `git archive HEAD` 打的是**那个 commit 的字节**，于是产物里
//    缺了本轮新增的每一个文件（logging.js、ops-check.mjs、那 18 条测试…），
//    而**构建脚本没报错、Release 自检全绿、产物看上去完好** ——
//    判据是「包里有没有不该有的」，不是「该有的在不在」。
//    同样那句报错只有**真去装它的人**才会撞上（产物 verify 少 18 条测试）。
//
//    `git write-tree` 写的是**暂存区**的树：包含已 add 的新文件与改动，
//    不含未跟踪的（data/ / photos/ / .scratch/ 天然不在里面），
//    且**不要求先 commit**。这正是「发版的是我手上的这份改动」这句话的实现。
const tgz = path.join(OUT, "src.tgz");
const exist = INCLUDE.filter((p) => existsSync(path.join(ROOT, p)));
const missing = INCLUDE.filter((p) => !existsSync(path.join(ROOT, p)));
if (missing.length) {
  console.error(`白名单里有东西不存在：${missing.join(", ")} —— 仓库结构变了，更新这个列表`);
  process.exit(1);
}
const tree = execFileSync("git", ["write-tree"], { cwd: ROOT, encoding: "utf8" }).trim();
execFileSync("git", ["archive", "--format=tar.gz", "-o", tgz, tree, "--", ...exist], { cwd: ROOT, stdio: "inherit" });

// 记下打进包里的文件清单，末尾（7b）与解包结果逐字比对。
// ⚠️ 这里**只扣「真删掉」的**（EXCLUDE_PATHS）。被**改名**的那一份留在集合里 ——
//   7b 会用两个清单的并集算出期望集合，顺序上必须一致，否则会误报「缺少」。
const archived = execFileSync("git", ["ls-tree", "-r", "--name-only", tree], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/).filter(Boolean)
  .filter((f) => INCLUDE.some((d) => f === d || f.startsWith(d + "/")))
  .filter((f) => !EXCLUDE_PATHS.includes(f));
console.log(`  git archive（白名单 ${exist.length} 项，树 ${tree.slice(0, 7)}）完成`);

execFileSync("tar", ["-xzf", tgz, "-C", PKG], { stdio: "inherit" });
rmSync(tgz);

// 2e. 全站文案 → 占位符。
//
//     `src/copy.js` 是**全站每一个「人会读到的字」**的真实内容：
//     代号（【改这里：doorCode】 / 【改这里：heroCode】）、标题、布置台与阅读流的每一句话。
//     它不含凭据，所以 `release-check.mjs` 的四类真值判据**看不见它** ——
//     但它是两个人之间的私密文案，开源包里一个字都不该留。
//     2026-10-06 独立复审把这列成第一条证据缺口，判得对。
//
//     为什么**换值而不删键**：
//     · `scripts/check-copy.mjs` 断言「每个被 `cp("…")` 取到的键都真实存在」；
//       删键会让它当场报红，而那个门禁在产物里是要跑的。
//     · `public/copy.js` 必须与 `src/copy.js` **逐字节一致**（漂移检测），
//       所以改完要在产物里重跑一次 `build:copy`。
//     · 值里不能带首尾空白，也不能用 `{name}` 包整句 —— 那个形状是
//       check-copy 的「插值占位符」，调用方要传值，整句包进去会报「占位符传齐」失败。
//     所以形状是**保留键、只换值**。
async function replaceCopyText() {
  const copyFile = path.join(PKG, "src", "copy.js");
  if (!existsSync(copyFile)) return;
  const src = readFileSync(copyFile, "utf8");

  // 找 `export const COPY = {` 与文件末尾的 `};`，中间那段是纯对象字面量
  const start = src.indexOf("export const COPY =");
  if (start === -1) {
    console.error("  ✖ src/copy.js 里找不到 `export const COPY =` —— 形状变了，拒绝盲改");
    process.exit(1);
  }
  const objStart = src.indexOf("{", start);
  const objEnd = src.lastIndexOf("}");
  if (objStart === -1 || objEnd <= objStart) {
    console.error("  ✖ src/copy.js 的 COPY 不是预期的对象字面量");
    process.exit(1);
  }
  const head = src.slice(0, objStart + 1);
  const body = src.slice(objStart + 1, objEnd);
  const tail = src.slice(objEnd);

  // 逐个替换「键: "值"」里的值。**只动双引号/单引号字符串字面量**，
  // 注释、键名、嵌套结构一律原样保留 —— 这样 diff 最小、check-copy 的结构断言不受影响。
  const seen = [];
  const replaced = body.replace(
    /(\b[A-Za-z_$][\w$]*\s*:\s*)("(?:[^"\\]|\\.)*")/g,
    (_m, prefix, valueLiteral) => {
      let value;
      try {
        value = JSON.parse(valueLiteral);
      } catch {
        return _m; // 单引号等非 JSON 写法，交给下一步的兜底
      }
      if (typeof value !== "string" || !value) return _m;
      seen.push(value);
      const key = prefix.replace(/\s*:\s*$/, "").trim();
      return `${prefix}JSON.stringify("【改这里：${key}】")`;
    },
  );

  // ⚠️ 第二遍：**数组元素**。2026-10-06 实测踩到过 ——
  //   上面那个正则只认「键: "值"」，而 `wish.options` 是
  //   `options: ["去【改这里：place】游【改这里：place】", "搬到一起住", …]` 这种**没有键前缀**的数组，
  //   于是六条预填项**原样进了公开包**。那六条是那两个人自己写的愿望，
  //   里面还有具体的地名与店名。
  //   第一遍替换 165 个叶子而 check-copy 数的是 175 —— 差的 10 个里就有这个数组。
  //
  // 所以数组不是「顺手补一下」，它是**判据覆盖不到的那一类**：
  //   没有键就没有名字可以放进占位符，所以这里用「键 + 下标」。
  const isPlaceholderLeaf = (v) => {
    const s = v.replace(/^[\s"'“”‘’`]+/, "").replace(/[\s"'“”‘’`]+$/, "");
    return s.startsWith("【改这里：");
  };
  let arraySeen = 0;
  const withArrays = replaced.replace(
    /(\b[A-Za-z_$][\w$]*\s*:\s*\[)([\s\S]*?)(\n\s*\])/g,
    (whole, open, inner, close) => {
      const key = open.replace(/\s*:\s*\[$/, "").trim();
      let i = 0;
      const next = inner.replace(/"((?:[^"\\]|\\.)*)"/g, (lit, raw) => {
        if (!raw) return lit;
        // ⚠️ **已经占位符化的字面量必须跳过。**
        //   `guide.items` 是「对象数组」（`[{ k: "写 几 句", v: "…" }, …]`），
        //   第一遍已经把 k/v 的值换成占位符了；第二遍若不认形状就会**再改一遍**，
        //   于是占位符的名字从 `k` 变成 `guide.items[0]` —— 内容还在，
        //   但**指引二次开发者该填哪个键**的信息没了。
        //   症状极其隐蔽：叶子数对不上（203 vs 175），而所有叶子**仍然是占位符**，
        //   所以「全部是占位符」那条判据照样绿 —— 它验的是「有没有占位符」，
        //   不是「占位符指向得对不对」。
        let decoded;
        try { decoded = JSON.parse(lit); } catch { return lit; }
        if (typeof decoded === "string" && isPlaceholderLeaf(decoded)) return lit;
        arraySeen++;
        return JSON.stringify(`【改这里：${key}[${i++}]】`);
      });
      return open + next + close;
    },
  );
  if (arraySeen) seen.push(...Array(arraySeen).fill("<数组元素>"));

  // 门槛从「> 20」提到**逐叶自证**：占位符化之后 import 回来，
  // 每一个字符串叶子都必须是 `【改这里：…】`。这条与正则形状无关 ——
  // 将来 copy.js 里再加数组、再加嵌套，漏了都会在这里被抓到。
  //
  // ⚠️ 判据不能写成 `/^【改这里：/`：原值里**有些自带引号**（形如 `"【改这里：doorCode】…"`，
  //   引号是值的一部分），替换后占位符被包在中间 ——
  //   第一次写成 `^【改这里：` 时它报「165 个叶子不是占位符」，
  //   而那 165 个**全都是**占位符。判据过严会让人去「放宽它」，
  //   而正确做法是让判据认得真正的形状：**剥掉两端的引号与空白后**再比。
  //
  // 定义在数组遍**之前**：数组遍要用它识别「已经占位符化、不要再改一遍」的字面量。
  {
    const probe = path.join(PKG, ".probe-copy.mjs");
    // ⚠️ 必须写**完整模块**（head + 体 + tail），不是只写体 ——
    //   只写体的话探针是一个残缺的 JS，报「Unexpected token }」，
    //   而那个错**指向探针文件**，离真正的原因（少了 head/tail）很远。
    writeFileSync(probe, head + withArrays + tail, "utf8");
    const mod = await import(pathToFileURL(probe).href);
    rmSync(probe, { force: true });
    const leaves = [];
    (function walk(v, k) {
      if (typeof v === "string") leaves.push([k, v]);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${k}[${i}]`));
      else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, `${k}.${kk}`);
    })(mod.COPY, "");
    const leftover = leaves.filter(([, v]) => !isPlaceholderLeaf(v));
    if (leftover.length) {
      console.error(`  ✖ 占位符化之后还有 ${leftover.length} 个字符串叶子不是占位符，例如：`);
      for (const [k, v] of leftover.slice(0, 5)) console.error(`     ${k} = ${JSON.stringify(v).slice(0, 60)}`);
      console.error("     宁可停下报错，也不要产出一个「看起来脱敏了、其实还留着真文案」的包。");
      process.exit(1);
    }
    console.log(`  逐叶自证：${leaves.length} 个字符串叶子全部是占位符（无残留）`);
    if (leaves.length < seen.length) {
      console.error(`  ✖ 叶子数对不上：替换计数 ${seen.length} > import 回来的 ${leaves.length}`);
      process.exit(1);
    }
  }

  writeFileSync(copyFile, head + withArrays + tail, "utf8");
  console.log(`  全站文案已占位符化：src/copy.js 的 ${seen.length} 个字符串叶子（含 ${arraySeen} 个数组元素）`);

  // index.html 的 <title> 由 COPY.meta.title 决定，两边必须一致（check-copy 第 6 条）
  const htmlFile = path.join(PKG, "public", "index.html");
  if (existsSync(htmlFile)) {
    // ⚠️ **直接 import 拿运行时真相，不要用正则从文本里解析。**
    //   两版都错在同一个地方：第一版靠正则找 `title: "..."`，
    //   而替换之后值是 `JSON.stringify("…")` 形态，正则匹配不到；
    //   第二版改成从替换结果里取，又因为键名其实是 `title`（`meta.` 是父层）
    //   而拼了 `【改这里：meta.title】`，与 check-copy 判的逐字不等，报红。
    //
    //   正确做法是问**被测对象自己**：`COPY.meta.title` 到底是多少。
    //   占位文案**只有生成它的那个地方知道**，别处不许重造 ——
    //   哪怕重造出来长得一样，形状一变就会分叉。
    const url = pathToFileURL(path.join(PKG, "src", "copy.js")).href;
    const { COPY } = await import(url);
    if (typeof COPY?.meta?.title !== "string" || !COPY.meta.title) {
      console.error("  ✖ import 产物里的 copy.js 拿不到 COPY.meta.title");
      process.exit(1);
    }
    const newTitle = COPY.meta.title;
    const html = readFileSync(htmlFile, "utf8");

    // ⚠️ **不能直接 `/<title>[\s\S]*?<\/title>/` 在原文上替换。**
    //   2026-10-06 实测踩过：那行注释里**本身就写着 `<title>`**，
    //   非贪婪从注释里那个开始匹配，一路吃到真正 `<title>` 的 `</title>` ——
    //   于是把 `-->`、换行和整个标题一起吞了。产物里 index.html 的注释**没闭合**，
    //   浏览器把后面整份文档当注释，**没有 <link rel=stylesheet>、<title> 为空、
    //   页面完全不样式化**。而 release-check / check-copy / check-syntax / npm test
    //   **全部是绿的** —— 只有真在浏览器里打开它才会看见。
    //
    //   做法：**先把注释遮掉再找 title，位置对上了再在原文上切片。**
    //   遮罩用等长的 \u0000，偏移量与原文一一对应，替换不会挪动任何东西。
    const masked = html.replace(/<!--[\s\S]*?-->/g, (m) => "\u0000".repeat(m.length));
    const hit = masked.match(/<title>[\s\S]*?<\/title>/);
    if (!hit || hit.index === undefined) {
      console.error("  ✖ public/index.html 的正文里（注释外）找不到 <title> —— check-copy 第 6 条会红");
      process.exit(1);
    }
    const next = html.slice(0, hit.index) + `<title>${newTitle}</title>` + html.slice(hit.index + hit[0].length);

    // 替换完立刻自查结构，不把「改坏了」交给下游的三个门禁去发现。
    // 这一条是 2026-10-06 那次事故的直接产物：**文档结构坏了，三道门禁都看不见。**
    const opens = (next.match(/<!--/g) || []).length;
    const closes = (next.match(/-->/g) || []).length;
    if (opens !== closes) {
      console.error(`  ✖ 替换 title 之后 HTML 注释不配平（<!-- ${opens} 个 / --> ${closes} 个）—— 产物会坏在这里`);
      process.exit(1);
    }
    if (!/<link[^>]+rel=["']?stylesheet/i.test(next)) {
      console.error("  ✖ 替换 title 之后 <link rel=stylesheet> 不见了 —— 页面会完全没有样式");
      process.exit(1);
    }
    writeFileSync(htmlFile, next, "utf8");
    console.log(`  public/index.html 的 <title> 同步为同一个占位符（直接 import COPY.meta.title 取值）`);
    console.log(`  自查：注释配平 ${opens}/${closes}、样式表在位 —— 改坏了这里就会退出，不靠下游发现`);
  }

  // 重新生成 public/copy.js，否则它与 src/copy.js 不一致（check-copy 第 5 条会红）
  const gen = execFileSync(process.execPath, [path.join(PKG, "scripts", "build-copy.mjs")], {
    cwd: PKG, encoding: "utf8",
  });
  console.log(`  重跑 build:copy —— ${String(gen).trim().split(/\r?\n/).pop()}`);
}

/* ── 2d. 身份代号与关系称谓：这两个词是**那两个人**的代号，公开版里一个都不能留 ──
 *
 * 2026-10-06 实测事故：给 README 截图时在登录页看到 `【改这里：doorCode】` / `【改这里：heroCode】` 两个按钮。
 *
 * 为什么前三道门禁都没拦住 —— 这一次不是「判据太弱」，是**判据里根本没有这一类**：
 *   · check-secrets 的判据全是 ASCII 形态（域名 / 生日 / PIN / IP / 路径 / 主机别名）
 *   · release-check 的内容性判据比的是 2 段真实文案 + 照片字节 + 口令 + 域名
 *   · 6 条阳性对照塞的也都是上面那几类
 * 而这两个词是**中文**。它们一路绿灯穿过了所有门禁，最后是**人眼在浏览器里**看见的。
 *
 * 为什么主仓要保留、Release 却必须去掉 —— 这是同一件事在两个仓库里的**相反**结论：
 *   · 主仓：它们是 `person` 表里的**数据**（code），改它要动库、要重跑审计。
 *     `check-copy` 的 NON_COPY_LITERALS 白名单里明写着「身份代号：…改它要动库与审计」。
 *   · Release：那是**两个真实的人的代号**，出现在公开仓库里等于点名。
 * 所以这一步**无条件执行**，与 REL_PLACEHOLDER_COPY 无关 ——
 * 它不是「文案占位符化」这个产品决策的一部分，它是**泄露**。
 */
const IDENTITY_TERMS = [
  ["【改这里：doorCode】", "doorCode"],
  ["【改这里：heroCode】", "heroCode"],
  ["【改这里：boyfriend】", "boyfriend"],
  ["【改这里：girlfriend】", "girlfriend"],
  // 下面两个是 2026-10-06 第二轮才发现的：它们不在 copy.js 的**值**里，
  // 而在**注释**里 —— 占位符化只动值，注释原样保留，于是地名与店名留在了公开包里。
  // （值里的那六条预填选项由上面的数组遍处理掉了；注释里的这两个没人管。）
  ["【改这里：place】", "place"],
  ["【改这里：place】", "place"],
];
{
  const TEXT_EXT = /\.(js|mjs|html|css|json|md|txt|sh|conf|service|yml|yaml|env\.example)$/i;
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (TEXT_EXT.test(e.name)) out.push(p);
    }
    return out;
  };
  let files = 0, hits = 0;
  const touched = new Map();
  for (const f of walk(PKG)) {
    const before = readFileSync(f, "utf8");
    let after = before;
    for (const [term, key] of IDENTITY_TERMS) {
      const n = (after.match(new RegExp(term, "g")) || []).length;
      if (!n) continue;
      after = after.split(term).join(`【改这里：${key}】`);
      hits += n;
      touched.set(term, (touched.get(term) || 0) + n);
    }
    if (after !== before) { writeFileSync(f, after, "utf8"); files++; }
  }
  console.log(`  身份代号占位符化：${files} 个文件、${hits} 处（` +
    [...touched].map(([k, v]) => `${k}×${v}`).join(" ") + "）");
  // 替换完立刻自查。宁可构建失败，也不要把一个自称做过的替换发到公开仓库。
  const still = [];
  for (const f of walk(PKG)) {
    const t = readFileSync(f, "utf8");
    for (const [term] of IDENTITY_TERMS) if (t.includes(term)) still.push(`${path.relative(PKG, f)}:${term}`);
  }
  if (still.length) {
    console.error(`  ✖ 替换之后产物里还有 ${still.length} 处身份代号：${still.slice(0, 5).join(", ")}`);
    process.exit(1);
  }
  console.log(`  自查：产物里这 ${IDENTITY_TERMS.length} 个词零出现 —— 写错了就在这里退出，不靠下游发现`);
  // 已知残留：产物里 check-copy 的 NON_COPY_LITERALS 白名单会变成两个占位符条目，
  // 它那句 notes「只留下 N 个身份代号」于是**不再准确**（实际是 0 个）。
  // 那条是 note 不是断言，白名单机制本身照样生效 —— 记在这里是为了下一个人
  // 看到它不一致时不用重新查一遍。
}

// `REL_PLACEHOLDER_COPY=0` 时**保留 copy.js 原样**。
// 2026-10-06 实测两者的差别，是给用户决策用的实测数据，不是实现上的优柔：
//   · 占位符化（默认）：`src/copy.js` 165 个字符串叶子全变 `【改这里：键名】`，
//     index.html <title> 同步，build:copy 重跑 —— `npm run check` **全绿**
//     （check-copy 认键、数 175 个叶子、逐字节一致性都过），
//     `npm run boot` 也绿；但 `npm test` **红 50 条**，散布在 13 个测试文件。
//     那些用例守的是**产品行为**（音乐开关、引导五条、九宫格渲染、退出），
//     它们红的原因只是界面上不再出现那几个具体词。
//     数字的来历（别再估）：`node --test --test-reporter=tap` 跑产物，`not ok` 计数
//     才是权威值 —— 数「✖ 行」会多数，数「at TestContext.<anonymous> 栈帧」会**少 5**
//     （有 5 条是从辅助函数里抛的，没有那个栈帧形状）。
//   · 保留原样：产物 `npm test` **全绿**；而 copy.js 里**没有凭据、没有 PII** ——
//     「【改这里：doorCode】」「【改这里：heroCode】」「两年了」是界面文案，两个人的事实在照片、生日、
//     各自写的信里，不在按钮文字里。`check-secrets.mjs` 与 `release-check.mjs`
//     都判它干净。
// 这是「私密内容」与「产品功能文案」的边界判断，属用户拍板范围。
if (process.env.REL_PLACEHOLDER_COPY === "0") {
  console.log("  REL_PLACEHOLDER_COPY=0 —— 保留 copy.js 原样（产品功能文案，不含凭据与 PII）");
} else {
  await replaceCopyText();
}

// 2c. 真实祝福语：仓库里有一处**兜底默认值**写着真正的祝福语
//     （src/shared.js 的 DEFAULT_BLESSING）。它是全仓唯一一处真文案，
//     2026-10-06 被 release-check 的文案判据逮到。
//     替换成占位符而不是删掉 —— 删掉会让 `seed:shared` 少一条路径。
const sharedFile = path.join(PKG, "src", "shared.js");
if (existsSync(sharedFile)) {
  const before = readFileSync(sharedFile, "utf8");
  const after = before.replace(
    /export const DEFAULT_BLESSING =[\s\S]*?;\n/,
    'export const DEFAULT_BLESSING =\n' +
      '  "（占位文案：请把这里换成你想让对方读到的那段话。\\n" +\n' +
      '  "正式内容以 photos/together/blessing.txt 为准 —— 那个文件才是对方真正读到的。）";\n',
  );
  if (before !== after) {
    writeFileSync(sharedFile, after, "utf8");
    console.log("  真实祝福语已替换为占位符（src/shared.js 的 DEFAULT_BLESSING）");
  } else {
    console.error("  ⚠️ 没匹配上 DEFAULT_BLESSING —— 上游改了形状，真文案可能还在包里。停。");
    process.exit(1);
  }
}
for (const f of EXCLUDE_PATHS) {
  const p = path.join(PKG, f);
  if (existsSync(p)) {
    rmSync(p);
    console.log(`  剔除 ${f}`);
  }
}

// 2b. 私人 BGM：**这是一首具体的歌**，属于「两个人的东西」那一类。
//     绝不跟出去 —— 音频与照片是同一类问题，而它连文件名都没��必要保留。
//     缺失后的行为见 PLACEHOLDERS.md 第 7 项（前端**不会**自动隐藏音乐按钮）。
const bgm = path.join(PKG, "public", "bgm.mp3");
if (existsSync(bgm)) {
  rmSync(bgm);
  console.log("  剔除 public/bgm.mp3（私人 BGM）");
}

// 2d. check-evidence 门禁与它的取证目录要**同进同出**。
//
//     2026-10-06 实测踩到：产物里留了 `scripts/check-evidence.mjs`，
//     但 `docs/evidence/` 整个被剔掉了（剔得对 —— 里面有真实域名与真实部署证据）。
//     于是开源用户第一次 `npm run verify` 就红在
//     「没有 docs/evidence/ —— 证据落点没了，拒绝放行」。
//     产物看上去完好、构建脚本没报错、Release 自检也全绿，
//     **只有真去装它的人才会撞上**。
//
//     处置：把门禁本身也剔掉，并把 package.json 的 check 链改短。
//     理由不是「让它变绿」，而是**没有取证记录的门禁本来就不该装** ——
//     那条判据防的是「证据索引数字漂移」，而这个包里一份证据都没有。
//     剩下三段（语法 / 文案 / 秘密）本来就是核心，与取证目录无关。
const pkgFile = path.join(PKG, "package.json");
const ceFile = path.join(PKG, "scripts", "check-evidence.mjs");
if (existsSync(ceFile)) {
  rmSync(ceFile);
  console.log("  剔除 scripts/check-evidence.mjs（取证目录不在包内，门禁与目录同进同出）");
}
if (existsSync(pkgFile)) {
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const before = pkg.scripts.check;
  pkg.scripts.check = "node scripts/check-syntax.mjs && node scripts/check-copy.mjs && node scripts/check-secrets.mjs";
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`  package.json 的 check 链去掉 check-evidence：\n    原 ${before}\n    现 ${pkg.scripts.check}`);
}

// 3. 域名占位符
let replaced = 0;
const TEXT = /\.(js|mjs|md|json|txt|sh|conf|service|html|css|yml|yaml)$/i;
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!TEXT.test(e.name)) continue;
    const before = readFileSync(p, "utf8");
    // 按**完整域名**替换，不拼 `"\\.top"` 之类的后缀 —— 域名换了整级时
    // 拼后缀那个版本会静默变成「什么都不替换」。
    // 每个真域名都换（REL_REAL_DOMAIN 可逗号分隔多个），已按长度降序：
    // 长域名先换，长含短时短的一并带走。
    let after = before;
    for (const d of REAL_DOMAINS) after = after.split(d).join(PLACEHOLDER_DOMAIN);
    if (before !== after) {
      writeFileSync(p, after, "utf8");
      replaced++;
    }
  }
})(PKG);
console.log(`  域名替换：${replaced} 个文件`);

// 4. 文件名里的域名
//
// ⚠️ 源文件名**从目录里探测**，不拼 `REL_REAL_DOMAIN` 的主机名部分。
//    拼出来的话，那个主机名就以第二份副本的形式住进了这个脚本 ——
//    而 `check-secrets.mjs` 的域名规则 `skipFiles` 含 `\.mjs`，
//    **它看不见 .mjs 里的域名**，门禁不会报。探测则一个真域名都不进源码。
const nginxDir = path.join(PKG, "deploy", "nginx");
const renamedTo = "site-443.conf";
if (existsSync(nginxDir)) {
  // 仓库里那份带真域名的配置：deploy/nginx 下唯一一个文件名含 `-top.conf` 的
  const candidates = readdirSync(nginxDir).filter((e) => e.endsWith("-top.conf"));
  const src0 = candidates.length === 1 ? candidates[0] : null;
  if (src0) {
    renameSync(path.join(nginxDir, src0), path.join(nginxDir, renamedTo));
    console.log(`  文件改名 deploy/nginx/${src0} → ${renamedTo}`);
  }
  // 改名是「文件从 A 不在变成 B 在」—— 只查 A 不在了**分不出**是被删还是被改名。
  // 2026-10-06 实测：剔除清单误收了它，那份 nginx 配置被静默删掉，
  // 而正向判据只查「树里有的都在」，改名后的 site-443.conf 不在树里，照样全绿。
  // 所以这里**两个方向都查**：A 不在（已改名/已删）且 B 必须在（真改名了）。
  if (!existsSync(path.join(nginxDir, renamedTo))) {
    console.error(`\n✖ deploy/nginx/ 里没有 ${renamedTo} —— 产物会**缺一份 nginx 配置**。`);
    console.error("  白名单含 deploy/，所以它本该在。查仓库里那份带域名的配置还在不在。");
    process.exit(1);
  }
  if (src0) {
    EXPECT_EXCLUDE.push(`deploy/nginx/${src0}`);
  } else {
    // 探测不到源文件时**不静默**：没有可改名的文件，说明白名单或仓库形状变了，
    // 而下面那条「site-443.conf 必须在」的检查会兜住后果并给出可读的错误。
    console.log(`  注意：deploy/nginx/ 里没找到 *-top.conf；现有 ${JSON.stringify(readdirSync(nginxDir))}`);
  }
}

// 5a. 截图目录改名：仓库里叫 `docs/release-screenshots/`，公开包里叫 `docs/screenshots/`。
//     改名而不是复制 —— 复制会让包里多出一份同样的字节。
//     名字本身也是设计：进到别人的仓库里，`docs/release-screenshots/` 这种
//     「从哪来的」命名会让人以为这是别人的发布流程残留。
{
  const from = path.join(PKG, "docs", "release-screenshots");
  const to = path.join(PKG, "docs", "screenshots");
  if (existsSync(from)) {
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    // 改名前的路径必须登记进 EXPECT_EXCLUDE（=「被改名，不是不在」）。
    // 不登记的话收尾那句双向判据（树里有、包里没有）会把**刚成功改名**的文件
    // 报成「缺少」—— 与真删掉的那一类长得一模一样。nginx 改名那一步也是这么处理的。
    for (const f of readdirSync(from)) EXPECT_EXCLUDE.push(`docs/release-screenshots/${f}`);
    renameSync(from, to);
    const pngs = readdirSync(to).filter((f) => f.endsWith(".png"));
    console.log(`  截图改名 docs/release-screenshots → docs/screenshots（${pngs.length} 张 PNG）`);
    if (pngs.length < 5) {
      console.error(`  ✖ docs/screenshots/ 只有 ${pngs.length} 张 PNG —— README 会指向不存在的图。`);
      console.error("     截图是 docs/release-screenshots/ 里那些，先查那个目录。");
      process.exit(1);
    }
  } else {
    console.error("  ✖ docs/release-screenshots/ 不在产物里 —— INCLUDE 里写了它，白名单或目录名变了。");
    process.exit(1);
  }
}

// 5. README：面向二次开发者的全新内容。
//    不复用仓库那份 —— 它的文档索引指向 ops/ 与 docs/evidence/，
//    而那些不在包里，留着就是一个一个点不开的链接。
const readme = `# 两周年纪念网页应用

> 两个人各自用「代号 + 对方的生日」进入同一个入口。开门时刻之前，界面上只有
> 属于自己的布置台；开门之后，同一个入口变成阅读流。

**这是一个纯净的开源版本**：里面没有你的照片、你的文案、你的生日。
按 [PLACEHOLDERS.md](./PLACEHOLDERS.md) 填完那 8 个位置，它就是你自己的礼物站。

## 你拿到的就是这个样子

下面这些截图是**这份纯净版自己跑起来**拍的（种子数据，不是任何真照片）。
满屏的 \`【改这里：键名】\` 就是**占位符**——它们精确地指出你要把自己的文案填在哪。
装上它、跑起它，第一眼看到的就是这个样子。

### 未开门：封印页 + 倒计时

![封印页](docs/screenshots/01-seal-locked.png)

### 未开门：布置台（留言 / 照片 / 预填选项）

![布置台](docs/screenshots/02-desk.png)

### 开门后：同一个入口变成阅读流

![阅读流首屏](docs/screenshots/03-reading-hero.png)

### 阅读流：信与照片卡

![信与照片卡](docs/screenshots/04-reading-content.png)

### 阅读流的收尾：约定区

![约定区](docs/screenshots/05-reading-tail.png)

> 这几张图里的 \`MK-…\` 是 e2e 的标记（\`docs/evidence/markers.json\` 讲这套标记法），
> 意思是「这段内容来自种子数据」。你自己填完之后，它们就不在了。

技术栈：Node.js \`>= 22.5\`（ESM）+ Express + SQLite（Node 内置 \`node:sqlite\`）
+ multer + sharp。前端无框架、无打包工具，浏览器直接加载 \`public/\` 下的单页。
**除 Node 外没有构建步骤。**

---

## 它做什么

### 时间锁（这是整个项目的骨架）

开门时刻硬编码在 \`src/clock.js\` 的 \`UNLOCK_AT\`，不读设备时区、不读服务器时区，
换一台机器结论相同。

- 服务端在**所有路由之前**设一道闸门：未解锁时 \`/api/shared\`、\`/api/wish\` 的读请求
  一律 **404**。写请求放行 —— 约定要能提前折好，不挡写入。
- 未解锁时 \`GET /api/entry\` 只返回自己的条目，响应体里**没有对方的 id**；
  对方的照片经 \`GET /api/photo/:id\` 取同样是 **404**。
- 前端只认 \`GET /api/status\` 的 \`unlocked\`，且 **fail closed**：问不到就按没开。
  门关着时界面上不存在共同层或对方内容的任何占位。

### 布置台 / 阅读流

- **未解锁**：只有布置台 —— 信封墙，可写留言、上传照片、给每张照片配一句话、
  改配文、撤回。自己的内容只有自己看得到。
- **已解锁**：同一个入口切成阅读流 —— 先共同层九宫格，再对方的信、照片卡、
  收尾的一段话，最后双方约定的并排揭示。
- **两端同源**：布置台与阅读端共用 \`public/app.js\` 里同一个 \`card(e, i, mode)\`，
  \`mode\` 决定是否渲染撤回角标与操作区。各写各的早晚会长歪。

### 共同层

九张合照排成 3×3 九宫格，点开进放大层（环形翻页、计数、三种关闭方式、
打开时锁背景滚动），配一段关于这两年的文字。共同层只对两个人可见。

### 照片鉴权

- 照片文件落在 \`$DATA_DIR/photos/\`，目录权限 **700**，**绝不进 \`public/\`** 静态根。
- 服务启动时硬断言照片目录不在静态根之内（字面与 \`realpathSync\` 软链解析**各判一遍**），
  不满足**直接起不来**。宁可启动失败也不能悄悄开门。
- 图片字节只有一条出口：\`GET /api/photo/:id\`，带鉴权。

---

## 快速开始

前置：Node.js **>= 22.5**（\`node:sqlite\` 的下限）。

\`\`\`bash
npm ci
npm run verify        # 规范验证入口 = check && test && boot
npm start             # 默认只绑 127.0.0.1，前面放 nginx 反代
\`\`\`

| 脚本 | 验什么 |
|---|---|
| \`npm run check\` | 每个 \`.js\`/\`.mjs\` 都能解析；交给 Linux 执行的部署文件行尾必须是 LF；文案键完整性与 \`public/copy.js\` 漂移；秘密门禁（私钥 / 公网 IP / 完整生日口令 / SSH 主机别名 / 云实例 ID / 真实域名） |
| \`npm test\` | 全量测试（HTTP 缝 + 直查库缝 + jsdom 前端缝） |
| \`npm run boot\` | 依赖就位 + 服务真能起 + 时间锁闸门在关 + 默认绑定只走回环 |
| \`npm run ops:check\` | 线上只读体检（部署之后才用得上） |

> 原仓库的 \`check\` 还有第四段 \`check-evidence.mjs\`（校验 \`docs/evidence/\` 索引里的
> 数字与它索引的 JSON 实际一致）。**开源版没有那一段**，因为取证目录
> \`docs/evidence/\` 也不在包里 —— 那里面记的是**对某个真实域名跑过**的测试，
> 带着真实地址与部署细节。门禁与它的目录同进同出：没有证据可校，门禁就是空转。
> 你若要恢复它，把 \`docs/evidence/\` 与 \`scripts/check-evidence.mjs\` 一起加回来，
> 并在 \`package.json\` 的 \`check\` 里补上那个命令。

\`./init.sh\` 是同一批脚本的 bash 包装，供 Linux / 服务器 / 装了 node 的 WSL 使用。
**在 Windows + PowerShell 上跑它会 \`exit 127\`**，本机一律用 \`npm run verify\`。

文案改 \`src/copy.js\`，然后 \`npm run build:copy\` 生成 \`public/copy.js\` ——
页面加载的是**构建产物**，只改 \`src/\` 不重建，\`npm run check\` 会报漂移。

---

## ⚠️ 第一次 \`npm test\` 会有若干条红 —— 这是预期行为，不是包坏了

这份 Release 把 \`src/copy.js\` 里的**全部界面文案换成了 \`【改这里：键名】\`**。
于是**把「界面上必须出现那几个具体字」当抓手**的断言会跟着一起红。

**红多少条会随版本变**（它跟着占位符化范围走），所以这里**不写死数字** ——
以你自己那次运行为准：

\`\`\`bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
\`\`\`

（2026-10-06 对本包的一次实测是 52 条，落在若干个前端 / 导出 / 文案测试文件里。
**刻意不给逐文件分布表**：那个统计的覆盖口径不稳 —— 按失败块归属会漏掉一部分
异步断言，写死它只会变成下一个会自己漂的数字。）

要看的不是「红」，是**红在哪**：失败信息会直接告诉你期望的是哪几个字，例如
\`BGM：开关关掉 → 真的停、按钮变「音 乐 关」\`、\`引导里没有开门日期「10 月 5 日」\`、
\`应急页的标签页标题与正式站同一个词\`。

那些用例守的是**产品行为**——音乐真的停、引导真的有五条、九宫格破图时真的是占位块、
空库导出真的不炸。文案只是它们的**抓手**：抓手换成 \`【改这里：…】\`，断言就抓空了。

**怎么办**：按 [PLACEHOLDERS.md](./PLACEHOLDERS.md) 填完自己的文案之后，
把失败输出里点名的那些**具体字**换成你自己的。
注意别只无脑改期望值：有几条同时断言「行为」与「词」（音乐停下是行为、
按钮写什么字是词），改完词之后**顺手确认那条行为断言仍然成立**。

**\`npm run check\` 与 \`npm run boot\` 在本包里是全绿的**（实测，\`boot\` 退出码 0）
—— 它们只查键齐不齐、构建产物有没有漂移、服务起不起来，**不咬具体文案**。

所以这两种红的处理方式完全不同：

- **只有 \`test\` 红** → 你还没把文案换成自己的，正常，按上面改期望值。
- **\`check\` 或 \`boot\` 红** → 你真的弄坏了什么，去查。

别把后者当前者处理，也别把前者当后者去查。

---

## 项目结构

| 路径 | 职责 |
|---|---|
| \`src/\` | 后端：应用工厂、路由、SQLite 访问层、鉴权、照片处理、开门时钟、运维日志 |
| \`public/\` | 公开静态资源：单页、样式、前端脚本、文案构建产物、站点美术素材；无鉴权直出 |
| \`test/\` | \`node --test\` 测试 |
| \`scripts/\` | 门禁脚本、运维体检、Release 构建与自检、e2e |
| \`deploy/\` | systemd unit、部署脚本、端口探测、env 模板、测试实例、nginx 配置 |
| \`CONSTRAINTS.md\` | **质量基线：什么算对**，以及不得放宽的约束 |
| \`.gitignore\` | 已挡掉 \`photos/\` 与 \`data/\` —— **别绕过它** |

---

## 数据与隐私设计

- **口令不进库。** 口令是「对方的生日」，只以 scrypt 加盐哈希存进
  \`person.pw4\` / \`person.pw8\`（4 位月日与 8 位完整生日两种形态各存一条），
  比对走 \`timingSafeEqual\`。
- **照片不进静态根。** 库里只存元数据（mime / 字节数 / 宽高），唯一的读图路径带鉴权。
- **未解锁时读不到。** 共同层与约定 404、对方条目不出现在列表里、对方的照片 404、
  猜静态路径同样 404。这是**服务端属性**，不是前端藏起来。
- **会话是短期凭据。** token 32 字节随机，\`httpOnly\` + \`SameSite=Lax\` cookie，
  **不加正的** \`Max-Age\` / \`Expires\`；\`Secure\` 按这一条连接是否加密决定；
  永不加 \`Domain\`。
- **浏览器不许替你记住生日。** 生日必须每次亲手敲 —— 那正是这个东西存在的理由。
- **BGM 缺失不会自动隐藏音乐按钮。** \`public/app.js\` 无条件建 \`<audio src="/bgm.mp3">\`，
  文件不在时按钮照常显示、点了不响。要么放自己的 mp3，要么把 \`copy.js\` 的
  \`music.*\` 与按钮一起去掉（见 [PLACEHOLDERS.md](./PLACEHOLDERS.md)）。
- **限流共用一张表。** 同 IP 登录失败 5 次锁 10 分钟。
- **全站只用代号**，不出现真名。
- **运行期数据不入版本库。** \`data/\`（SQLite 库 + 照片目录）与 \`photos/\`
  （你的合照）在 \`.gitignore\` 里并有门禁断言。

诚实的边界：数据库文件在服务器磁盘上，机器主人技术上可以直接读。
这个应用靠信任，不靠物理隔离。

---

## 运维

\`npm run ops:check\` 是**只读**的线上体检，一个命令回答「服务还好不好」：
进程答不答话、开门状态对不对、闸门有没有被翻掉、照片有没有被静态直出、
库的不变量（限流表为 0、哨兵在、零测试标记）、照片目录权限、日志占用。

它不改任何配置、不写库、不重启服务。退出码 \`0\` 全绿 / \`1\` 有问题 /
\`2\` **体检脚本自己坏了**（与服务状态无关）。

部署细节看 \`deploy/\` 里的 systemd unit、\`deploy.sh\`（默认 dry-run，
要 \`--execute\` 才动手）与 \`two-years.env.example\`。
两条部署门禁在本机跑（它们是 bash 脚本）：

\`\`\`bash
npm run check:env-expand    # 挡 eval 转义：命令在数组里 eval 一次，值会不对
npm run check:node-source   # 挡「守卫查错了对象」：PATH 上的 node 与 unit 里的可能不是同一个
\`\`\`

---

## 二次开发

按 [PLACEHOLDERS.md](./PLACEHOLDERS.md) 填。动手前读
[CONSTRAINTS.md](./CONSTRAINTS.md) —— 它写的是「什么算对」，
**不要为了让某个改动通过而放宽里面任何一条**。
放宽一条约束 = 撤销了它保护的东西，必须在同一次提交里说明理由。
`;
writeFileSync(path.join(PKG, "README.md"), readme, "utf8");

// 6. 占位符清单
const placeholders = `# 占位符清单 —— 二次开发者要自己填的东西

这个包是**纯净版**：里面没有你的照片、你的文案、你的生日。
按下面这张表填完之后，它就是你自己的礼物站。

| # | 位置 | 放什么 | 必需 |
|---|---|---|---|
| 1 | \`photos/together/01.jpg\` … \`09.jpg\` | 共同层九宫格的 **9 张合照**。目录要自己建（它在 \`.gitignore\` 里） | 必需 |
| 2 | \`photos/together/blessing.txt\` | 共同层那一段**祝福语**，纯文本 | 必需 |
| 2b | \`src/shared.js\` 的 \`DEFAULT_BLESSING\` | 同上的**兜底文案**。正式内容以 \`blessing.txt\` 为准，这个只是文件没读到时的兜底，两处语气不一致会先露馅 | 必需 |
| 3 | \`data/two-years.db\` | **不手写**。跑下面那条 \`seed:shared\` 建出来 | 必需 |
| 4 | 服务器 \`/etc/two-years/two-years.env\` | \`DOOR_PASSWORD\` / \`HERO_PASSWORD\` / \`OBSERVER_PASSWORD\` | 必需 |
| 5 | \`src/clock.js\` 的 \`UNLOCK_AT\` | **开门时刻**，必须带时区偏移 | 必需 |
| 6 | \`src/copy.js\` | 全站文案：代号、称呼、布置台与阅读流的每一句话。改完跑 \`npm run build:copy\` | 必需 |
| 7 | \`public/bgm.mp3\` | 生日 BGM。**纯净包里没有这个文件**（它是一首具体的歌，属于「两个人的东西」）。放置你自己的 mp3 后音乐就能响 | 可选 |
| 8 | \`deploy/nginx/*.conf\` | 你的域名、证书路径 | 必需 |

## 上手顺序

\`\`\`bash
npm ci
npm run verify                     # 先确认这份代码在你自己机器上是绿的

# 填 1、2 两项，然后播种共同层（走真实写入路径，产出库与照片）：
node scripts/seed-shared.mjs --photos photos/together

# 填 5、6 两项；改完文案记得：
npm run build:copy

npm start                          # 默认只绑 127.0.0.1，前面放 nginx 反代
npm run ops:check -- --base http://127.0.0.1:8300 \\
  --db ./data/two-years.db --photos-dir ./data/photos
\`\`\`

## 三条不要碰的地方

1. **\`DATA_DIR\` 绝不能落在 \`public/\` 里面。** 那样照片会被 \`express.static\`
   **零鉴权直出**，时间锁当场作废且不报任何错。\`createApp\` 在启动时硬断言这件事，
   不满足**直接起不来** —— 这是故意的，不是 bug。
2. **\`UNLOCK_AT\` 必须带时区偏移。** 写 \`new Date("2026-10-05")\` 会按 UTC 解析，
   比东八区的 00:00 **提前 8 小时开门**。见 \`CONSTRAINTS.md\` §1。
3. **密码 = 对方的生日**，这是产品定义。剥掉非数字后同时接受 4 位月日与
   8 位完整生日（所以 \`0607\` 与 \`20150607\` 是同一个人的两种写法）。
   **这个值只放 env 文件，绝不写进源码或测试** —— 仓库里出现它就是事故。

### 关于 \`public/bgm.mp3\` 缺失时的真实行为

**音乐按钮不会自动消失。** \`public/app.js\` 无条件建 \`<audio src="/bgm.mp3">\`，
文件不在时加载失败会被记成 \`MUSIC.blocked\`，于是按钮照常显示、
点了却永远不响（\`musicSync()\` 只在 \`want && !playing && blocked\` 时
显示 \`copy.js\` 里 \`music.blocked\` 那句提示）。

所以两个选择：① 放一个你自己的 mp3 进去（推荐）；② 不想有音乐就把
\`copy.js\` 里 \`music.*\` 那几个键改成空串，并从 \`public/index.html\`
去掉音乐按钮。**别以为放着不管就是「没音乐」** —— 那是一个点不开的按钮。

## 别把私人的东西提交进版本库

\`.gitignore\` 已经挡住 \`photos/\`、\`data/\`、\`.observer-key\`、\`.log-salt\`、
\`*.db\`、\`.scratch/\`，并且 \`npm run check\` 里的 \`check-secrets.mjs\`
会扫私钥、公网 IP、完整生日口令、SSH 主机别名、云实例 ID 与真实域名。
**别绕过它，也别给它加豁免。**
`;
writeFileSync(path.join(PKG, "PLACEHOLDERS.md"), placeholders, "utf8");

// 7. 统计
//
// 7b 先做**正向判据**：产物必须与打进包的那棵树逐字一致。
//
// 这一步挡的是 2026-10-06 那个真实踩到的问题：`git archive HEAD` 打的是
// commit 而不是暂存区，于是「你改了文件但没 add」会**静默产出一个旧包**。
// Release 自检为什么抓不到：它判的是「包里有没有**不该有的**」，
// 而一个旧包缺的全是**该有的** —— 方向正好相反，两边一起全绿。
//
// 所以这里用正向判据：解包后的文件集必须等于「白名单 ∩ 树 − 剔除项」。
// 少一个就说明暂存区与工作区不一致（多半是忘了 add），**直接失败**。
function listFiles(root) {
  const out = [];
  (function rec(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(path.relative(root, p).replace(/\\/g, "/"));
    }
  })(root);
  return out.sort();
}
const inPkg = new Set(listFiles(PKG));
inPkg.delete("README.md");        // 构建期新生成，不在树里
inPkg.delete("PLACEHOLDERS.md");  // 同上
// 改名后产生的新名字：它不在树里，但它是**期望产物的一部分**。
// 不登记它的话，「多出」那条判据会把一次正确的改名报成错误 ——
// 那会让正确的构建永远红，久而久之就没人看这条判据了。
if (inPkg.has(`deploy/nginx/${renamedTo}`)) inPkg.delete(`deploy/nginx/${renamedTo}`);
// 截图目录的改名同理：docs/release-screenshots/ → docs/screenshots/
// **逐个文件**登记（目录级登记不行 —— inPkg 里放的是文件路径）。
for (const f of readdirSync(path.join(PKG, "docs", "screenshots"))) {
  inPkg.delete(`docs/screenshots/${f}`);
}
// 期望集合 = 树里的文件 − 真删掉的（EXCLUDE_PATHS）− 被改名的（EXPECT_EXCLUDE）。
// ⚠️ 两个清单都要在这里减。第 1 步只减了 EXCLUDE_PATHS，
//    因为 EXPECT_EXCLUDE 到第 4 步（改名那步运行时探测）才填得上。
//    漏减任何一个的后果是：被改名的那个文件被报成「缺少」——
//    2026-10-06 实测，正是这个漏减让正向判据对着正确构建报红。
const wantSet = new Set(archived.filter((f) => !EXPECT_EXCLUDE.includes(f)));
// ⚠️ 两条都要用 wantSet，不能用 archived。
//    archived 是「树里白名单内的全部」，含真删掉的与被改名的；
//    拿它算「缺少」会把那两类正常剔除的文件报成缺失 ——
//    2026-10-06 实测，正向判据对着一次完全正确的构建报红，报的还是
//    `deploy/nginx/<真域名>-top.conf` 这个**刚刚才成功改名**的文件。
const absent = [...wantSet].filter((f) => !inPkg.has(f));
const extra = [...inPkg].filter((f) => !wantSet.has(f));
if (absent.length) {
  console.error(`\n✖ 产物缺少 ${absent.length} 个本该在的文件：${absent.slice(0, 8).join(", ")}${absent.length > 8 ? " …" : ""}`);
  console.error("  几乎总是同一个原因：**你改了文件但没有 `git add`**。");
  console.error("  `git write-tree` 打的是暂存区，所以未 add 的改动不会进包 ——");
  console.error("  而自检只看「包里有没有不该有的」，一个旧包缺的全是该有的，方向正好相反。");
  process.exit(1);
}
if (extra.length) {
  console.error(`\n✖ 产物多出 ${extra.length} 个不在树里的文件：${extra.slice(0, 8).join(", ")}`);
  process.exit(1);
}

/**
 * 反方向那一条：**工作区里有、树里没有的文件**。
 *
 * 少了它，上面的判据就只抓「树里有而产物没有」，
 * 而「改了文件忘了 add」是**反方向**的 —— 那个文件压根不在树里，
 * 于是产物少一个「该有的」，自检与正向判据**都看不见**。
 * 2026-10-06 实测：加了正向判据后跑一次仍然是绿的，
 * 因为本轮新增的文件全部只在暂存区、树是对的、产物也是「对的」——
 * 错的是「对的是旧东西」。方向反了，判据就反着失效。
 */
const SKIP_DIR = new Set(["node_modules", "data", "photos", ".git", ".scratch", ".worktrees", "coverage"]);
const inWorkspace = [];
for (const d of INCLUDE) {
  const abs = path.join(ROOT, d);
  if (!existsSync(abs)) continue;
  if (statSync(abs).isDirectory()) {
    (function rec(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!SKIP_DIR.has(e.name)) rec(path.join(dir, e.name));
        } else {
          inWorkspace.push(path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/"));
        }
      }
    })(abs);
  } else {
    inWorkspace.push(d);
  }
}
const notStaged = inWorkspace.filter(
  (f) =>
    !wantSet.has(f) &&
    !EXCLUDE_PATHS.includes(f) &&
    !EXPECT_EXCLUDE.includes(f) && // 被改名的那个不算「漏掉」
    !SKIP_DIR.has(path.basename(f)),
);
if (notStaged.length) {
  console.error(`\n✖ 工作区里有 ${notStaged.length} 个文件没进包（多半是没 git add）：`);
  for (const f of notStaged.slice(0, 10)) console.error(`    ${f}`);
  if (notStaged.length > 10) console.error(`    … 还有 ${notStaged.length - 10} 个`);
  console.error("  `git write-tree` 打的是**暂存区**。产物自检只看「包里有没有不该有的」，");
  console.error("  一个少了东西的旧包缺的全是**该有的** —— 那个方向它看不见。");
  process.exit(1);
}
console.log(`  产物与树一致：${archived.length} 个文件逐字对上，且工作区无未暂存文件（少一个 / 漏一个即失败）`);

let count = 0;
let bytes = 0;
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      count++;
      bytes += statSync(p).size;
    }
  }
})(PKG);

if (WANT_TAR) {
  const out = path.join(OUT, "two-years-release.tgz");
  execFileSync("tar", ["-czf", out, "-C", PKG, "."], { stdio: "inherit" });
  console.log(`\n产物 tgz：${out}`);
}
console.log(`\n解包目录：${PKG}`);
console.log(`${count} 个文件 / ${(bytes / 1024).toFixed(0)} KB，域名替换 ${replaced} 个文件`);
console.log(`\n下一步 —— 自检（真值从环境变量进，仓库里一个真值都不留）：`);
console.log(`  node scripts/release-check.mjs --dir .scratch/release/pkg`);
