/**
 * 文案完整性门禁 —— 整个「零耦合」改造的承重墙。
 *
 *   node scripts/check-copy.mjs
 *
 * 它保证一件具体的事：**public/app.js 与 scripts/export-standalone.mjs 里
 * 取到的每一个键，在 src/copy.js 里都真的存在。**
 * 有了这道门禁，生产环境取到的一定是真字符串，于是运行时**不需要**为
 * 「键缺失」抛异常（分工见 src/copy.js 顶部）。
 *
 * 六条检查，任何一条不过就退出非 0：
 *   1. 取键扫描器**自己抓得到东西**（抓到 0 个调用点 = 探测器失灵 = 门禁恒真）
 *   2. 每个 `cp("…")` 的键都真实存在
 *   3. 带插值的调用点把占位符**传齐了**（漏传 → 界面上少几个字）
 *   4. 文案值不带首尾空白（免得有人在编辑器里手抖删掉一个尾随空格）
 *   5. public/copy.js 与 src/copy.js **逐字节一致**（漂移检测）
 *   6. public/index.html 的 <title> 与 COPY.meta.title 一致
 *
 * 另外还钉死一件事：COPY **只有一条取法**。app.js 里 `window.COPY` 只能
 * 出现一次（在 cp 那个函数体内），export-standalone.mjs 里 COPY 只能出现在
 * import 那一行。绕开 cp() 直接摸 window.COPY 的人，就是下一个漂移的来源。
 *
 * --app / --export / --generated / --html 可把被检查的文件指到别处，
 * 供 test/ticket-08-copy.test.js 造坏例子自证「这道门禁会红」用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COPY } from "../src/copy.js";
import { resolvePath } from "../src/copy-get.js";
import { renderCopyModule } from "./build-copy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 解析 --key value 形式的覆盖参数 */
function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (m && argv[i + 1] && !argv[i + 1].startsWith("--")) out[m[1]] = argv[++i];
  }
  return out;
}

const opt = flags(process.argv.slice(2));
const APP_FILE = opt.app || path.join(ROOT, "public", "app.js");
const EXPORT_FILE = opt.export || path.join(ROOT, "scripts", "export-standalone.mjs");
const GENERATED_FILE = opt.generated || path.join(ROOT, "public", "copy.js");
const HTML_FILE = opt.html || path.join(ROOT, "public", "index.html");

const problems = [];
const notes = [];

/**
 * 去掉注释，让扫描只落在**代码**上。
 *
 * 三种注释都要去掉：块注释、行注释、模板字符串里那段 HTML 注释。
 * 行注释只在**行首**才认——这是本仓库的写法（行内注释一律跟代码同行）。
 * 按别的规则去剥会误伤字符串里的 `//`（比如 URL），宁可漏也不误伤。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, " ");
}

/** 从 `cp(` 的左括号开始，按括号配平取出完整的实参文本 */
function argText(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * 扫出一个文件里所有 `cp(` 调用点。
 *
 * 只认**第一个实参是字符串字面量**的调用——那种是静态可核对的。
 * 第一实参不是字面量的（本文件里不该有）单独报出来，不静默跳过。
 *
 * @returns {{path: string, vars: string[]|null, dynamic: boolean}[]}
 */
export function findCopyCalls(src) {
  const code = stripComments(src);
  const calls = [];
  const re = /\bcp\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const args = argText(code, m.index + m[0].length - 1);
    if (args === null) {
      calls.push({ path: null, vars: null, dynamic: true });
      continue;
    }
    const head = /^\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/.exec(args);
    if (!head) {
      // 键不是字面量：静态核对不了，交给调用方那条检查去红
      calls.push({ path: null, vars: null, dynamic: true });
      continue;
    }
    // 第二个实参是对象字面量时，取它**顶层**的键（按括号深度只进第一层）
    const rest = args.slice(head[0].length);
    const vars = [];
    const objMatch = /^\s*,?\s*\{/.exec(rest);
    if (objMatch) {
      const objStart = rest.indexOf("{", objMatch.index);
      let depth = 0;
      let end = objStart;
      for (let i = objStart; i < rest.length; i++) {
        if (rest[i] === "{") depth++;
        else if (rest[i] === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      let d = 0;
      // 从 objStart+1 起：开括号自己不计入深度，否则里面每一处都是 d>=1，永远匹配不到
      for (let i = objStart + 1; i < end; i++) {
        if (rest[i] === "{") d++;
        else if (rest[i] === "}") d--;
        else if (d === 0) {
          const k = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(rest.slice(i));
          if (k) vars.push(k[1]);
        }
      }
    }
    calls.push({ path: head[1] ?? head[2] ?? head[3], vars: objMatch ? vars : null, dynamic: false });
  }
  return calls;
}

/** 取出值里所有 `{name}` 占位符 */
const placeholdersOf = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

/** 检查一个消费者文件：键存在 + 占位符传齐 + 只有一条取法 */
function checkConsumer(file, label, extra) {
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) {
    problems.push(`${label} 不存在：${path.relative(ROOT, abs)}`);
    return 0;
  }
  const raw = fs.readFileSync(abs, "utf8");
  const code = stripComments(raw);

  // —— 只有一条取法 ——
  if (extra.singleAccessor) {
    const hits = code.match(/window\.COPY/g) || [];
    if (hits.length !== 1) {
      problems.push(
        `${label} 里 window.COPY 出现了 ${hits.length} 次，必须恰好 1 次（在 cp() 函数体内）。` +
          `COPY 只能经 cp() 取——直接摸 window.COPY 就是下一个漂移的来源。`,
      );
    }
    const without = code.replace(/window\.COPY/g, "");
    if (/\bCOPY\b/.test(without)) {
      problems.push(`${label} 里出现了 cp() 以外的 COPY 引用：${/\bCOPY\b/.exec(without)[0]}`);
    }
  } else {
    const strippedImport = code.replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*copy\.js["'];?/g, " ");
    if (/\bCOPY\b/.test(strippedImport)) {
      problems.push(`${label} 里 import 之外还出现了 COPY 引用；文案只准经 cp() 取`);
    }
  }

  // —— 键存在 + 占位符传齐 ——
  const calls = findCopyCalls(raw);
  for (const c of calls) {
    if (c.dynamic) {
      problems.push(`${label} 里有键不是字符串字面量的 cp() 调用 —— 静态核对不了，改成字面量`);
      continue;
    }
    const v = resolvePath(COPY, c.path);
    if (v === undefined) {
      problems.push(`${label} 取了 src/copy.js 里不存在的键：cp("${c.path}")`);
      continue;
    }
    if (typeof v === "object") continue;                 // wish.options 那种数组不插值
    if (c.vars === null) {
      if (placeholdersOf(v).length) {
        problems.push(
          `${label} 的 cp("${c.path}") 漏传占位符：${placeholdersOf(v).map((k) => `{${k}}`).join(" ")}（整个值都没传）`,
        );
      }
      continue;
    }
    const need = placeholdersOf(v);
    const missing = need.filter((k) => !c.vars.includes(k));
    if (missing.length) {
      problems.push(`${label} 的 cp("${c.path}") 漏传占位符：${missing.map((k) => `{${k}}`).join(" ")}`);
    }
  }
  return calls.length;
}

/* ── 1~3：两个消费者 ─────────────────────────────────────────────── */
const appCalls = checkConsumer(APP_FILE, "public/app.js", { singleAccessor: true });
const exportCalls = checkConsumer(EXPORT_FILE, "scripts/export-standalone.mjs", { singleAccessor: false });

/* 探测器自证：扫到 0 个调用点，这条门禁就是恒真的，必须拒绝通过 */
const totalCalls = appCalls + exportCalls;
if (totalCalls === 0) {
  problems.push(
    `一个 cp() 调用点都没扫到（app.js ${appCalls} 个 / export-standalone.mjs ${exportCalls} 个）——` +
      `探测器失灵了，这条门禁会永远绿。`,
  );
} else if (appCalls === 0) {
  problems.push("public/app.js 里一个 cp() 调用点都没有 —— 文案还在代码里硬编码着？");
}
notes.push(`取键调用点：app.js ${appCalls} 个 / export-standalone.mjs ${exportCalls} 个`);

/* ── 4：值不带首尾空白 ─────────────────────────────────────────────── */
let leafCount = 0;
(function walk(node, at) {
  if (typeof node === "string") {
    leafCount++;
    if (node !== node.trim()) {
      problems.push(`COPY.${at} 的值带首尾空白（${JSON.stringify(node)}）——元素之间的空格写在模板里`);
    }
    return;
  }
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${at}[${i}]`));
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) walk(node[k], at ? `${at}.${k}` : k);
  }
})(COPY, "");
notes.push(`文案叶子（字符串）${leafCount} 条`);

/* ── 5：产物与源逐字节一致 ────────────────────────────────────────── */
if (!fs.existsSync(GENERATED_FILE)) {
  problems.push(`public/copy.js 不存在：${path.relative(ROOT, path.resolve(ROOT, GENERATED_FILE))} —— 跑一次 npm run build:copy`);
} else {
  const onDisk = fs.readFileSync(path.resolve(ROOT, GENERATED_FILE));
  const fresh = Buffer.from(renderCopyModule(COPY), "utf8");
  if (!onDisk.equals(fresh)) {
    problems.push(
      `public/copy.js 与 src/copy.js 漂移了（盘上 ${onDisk.length} 字节 / 应为 ${fresh.length} 字节）` +
        `—— 跑 npm run build:copy 重新生成。漂移的两份是同一个东西的两种措辞。`,
    );
  } else {
    notes.push(`public/copy.js 与 src/copy.js 逐字节一致（${onDisk.length} 字节）`);
  }
}

/* ── 6：index.html 的标题 ─────────────────────────────────────────── */
if (!fs.existsSync(path.resolve(ROOT, HTML_FILE))) {
  problems.push(`public/index.html 不存在：${HTML_FILE}`);
} else {
  const html = fs.readFileSync(path.resolve(ROOT, HTML_FILE), "utf8");
  const t = /<title>([^<]*)<\/title>/.exec(html);
  if (!t) {
    problems.push("public/index.html 里没有 <title>");
  } else {
    // HTML 源码里 & 写成 &amp;；浏览器读出来才是字面量。比较的是**读出来的字**。
    const shown = t[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    if (shown !== COPY.meta.title) {
      problems.push(
        `public/index.html 的 <title> 是「${shown}」，COPY.meta.title 是「${COPY.meta.title}」——` +
          `标签页标题与应急页必须是同一个词（正式站改了这儿会红，正是要的效果）`,
      );
    } else {
      notes.push(`index.html <title> 与 COPY.meta.title 一致：${shown}`);
    }
  }
}

/* ── 7：消费者文件里不许再有中文字符串字面量（白名单除外）──────────────
   前面几条只查「cp() 取到的键都在」。有一种漏法它们**看不见**：
   把某个 cp() 调用删掉、换成写死的字 —— 不产生坏键，键检查照样绿，
   而文案从此有两份、可以各改各的。
   方向是反的：不是「每个字面量都得在 copy.js 里」（那样导出脚本的
   运维输出、身份代号都会被误伤），而是**白名单**。
   白名单里每一条都写了它**为什么不是文案**；往里加东西等于承认
   「这个字用户看不见」——加错了它就会永远绿。 */
const NON_COPY_LITERALS = new Set([
  // 身份代号：person 表里的**数据**（code），改它要动库与审计，不是措辞
  "【改这里：doorCode】",
  "【改这里：heroCode】",
]);

/** 允许留在消费者文件里的中文**（导出脚本的运维输出与自检标签，人看的不是页面） */
const OPERATOR_PREFIX = "[export-standalone]";
const AUDIT_LABELS = new Set(["外链 <script src=", "外链 <link href=", "<img src=\"http", "CSS url(http", "<iframe|<embed"]);

function isNonCopyLiteral(s) {
  if (NON_COPY_LITERALS.has(s)) return true;
  if (s.startsWith(OPERATOR_PREFIX)) return true;
  if (AUDIT_LABELS.has(s)) return true;
  // 自检/日志的拼装句：含 ${…} 插值，指向的是「出了什么问题」而不是页面上一句话
  if (s.includes("${") && /出现|开 |闭 |没有|自检/.test(s)) return true;
  return false;
}

for (const [file, label] of [[APP_FILE, "public/app.js"], [EXPORT_FILE, "scripts/export-standalone.mjs"]]) {
  const code = stripComments(fs.readFileSync(path.resolve(ROOT, file), "utf8"));
  for (const m of code.matchAll(/["'`]([^"'`\n]*[一-鿿][^"'`\n]*)["'`]/g)) {
    const lit = m[1];
    if (isNonCopyLiteral(lit)) continue;
    problems.push(
      `${label} 里出现了一个中文字面量「${lit.trim().slice(0, 40)}」——` +
        `页面文案只能从 src/copy.js 取（写 cp("…")）。` +
        `它不是文案的话，先进白名单 NON_COPY_LITERALS 并写清理由。`,
    );
  }
}
notes.push(`消费者里的中文：只留下 ${NON_COPY_LITERALS.size} 个身份代号 + 导出脚本的运维输出`);

/* ── 出结果 ────────────────────────────────────────────────────────── */
if (problems.length) {
  console.error("[check-copy] 文案完整性检查未通过：");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
for (const n of notes) console.log(`  OK   ${n}`);
console.log("[check-copy] 文案完整性 OK —— 每个键都真实存在，占位符传齐，产物与源一致");
