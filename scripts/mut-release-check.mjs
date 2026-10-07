#!/usr/bin/env node
// Release 自检的**阳性对照**：把已知真内容塞进包副本，确认自检会报红。
//
// 判据是「删掉它会不会有东西变红」。一份从没红过的自检，
// 与一份没有的自检在输出上完全一样 —— 所以必须让它红过一次。
import { cpSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const SRC = path.join(ROOT, ".scratch", "release", "pkg");
const TMP = path.join(ROOT, ".scratch", "release", "probe");
const PHOTOS = path.join(ROOT, "photos", "together");

const secrets = readFileSync(path.join(ROOT, ".scratch", "rel-secrets.txt"), "utf8")
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const blessing = readFileSync(path.join(PHOTOS, "blessing.txt"), "utf8").trim();
const shas = ["01.jpg", "02.jpg", "03.jpg", "04.jpg", "05.jpg", "06.jpg", "07.jpg", "08.jpg", "09.jpg"]
  .map((f) => createHash("sha256").update(readFileSync(path.join(PHOTOS, f))).digest("hex"));

/**
 * 真域名从环境变量进来。
 *
 * ⚠️ 第一版把它硬编码在文件里 —— 那样「脱敏的输入」与
 *    「自检要找的值」来自同一个写死的源头，域名一改，**两边一起错**：
 *    构建脚本什么都不替换，自检也查不出「因为它以为真域名就是那个」。
 *    两处都必须走外部输入。
 */
// 多个真域名用逗号分隔（主站 + 独立别名），按长度降序。真实泄露形状是：
// 「只替换 / 只搜了长域名，独立别名不含它为子串 → 残留」—— P4 用长的、P13 用短的。
const REL_REAL_DOMAINS = String(process.env.REL_REAL_DOMAIN || "").split(",").map((s) => s.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
const REL_REAL_DOMAIN = REL_REAL_DOMAINS[0] || "";             // 最长的，P4 用
const REL_SHORT_DOMAIN = REL_REAL_DOMAINS[1] || REL_REAL_DOMAINS[0]; // 短/别名，P13 用
if (!REL_REAL_DOMAINS.length) {
  console.error("需要 REL_REAL_DOMAIN=<要脱敏的真实域名>（多个用逗号分隔）");
  process.exit(2);
}

const env = {
  ...process.env,
  REL_REAL_PORTS: secrets.join(","),
  REL_REAL_TEXT: blessing,
  REL_REAL_PHOTO_SHA: shas.join(","),
  REL_REAL_DOMAIN: REL_REAL_DOMAINS.join(","),
};

function run(dir) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "release-check.mjs"), "--dir", dir], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

function fresh() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  cpSync(SRC, TMP, { recursive: true });
}

const cases = [
  {
    id: "P1",
    name: "把真照片拷成 public/logo.jpg（换名换目录）",
    act: () => copyFileSync(path.join(PHOTOS, "01.jpg"), path.join(TMP, "public", "logo.jpg")),
    expect: /真实照片的字节/,
  },
  {
    id: "P2",
    name: "把真口令写进 src/copy.js 的注释里",
    act: () => appendFileSync(path.join(TMP, "src", "copy.js"), `\n// 她的生日是 ${secrets[1]}\n`, "utf8"),
    expect: /真实口令/,
  },
  {
    id: "P3",
    name: "把真祝福语写进 deploy/two-years.env.example",
    act: () => appendFileSync(path.join(TMP, "deploy", "two-years.env.example"), `\n# 共同层文案：${blessing}\n`, "utf8"),
    expect: /真实文案/,
  },
  {
    id: "P4",
    name: "把真实域名写回 nginx 配置（改回去是最容易犯的那一步）",
    act: () => {
      const p = path.join(TMP, "deploy", "nginx", "site-443.conf");
      writeFileSync(p, readFileSync(p, "utf8").split("example.com").join(REL_REAL_DOMAIN), "utf8");
    },
    expect: /真实域名/,
  },
  {
    id: "P5",
    name: "把 data/ 目录连库带照片塞进包",
    act: () => {
      mkdirSync(path.join(TMP, "data", "photos"), { recursive: true });
      copyFileSync(path.join(ROOT, "data", "two-years.db"), path.join(TMP, "data", "two-years.db"));
      copyFileSync(path.join(PHOTOS, "02.jpg"), path.join(TMP, "data", "photos", "x.jpg"));
    },
    expect: /data\/ 在包里/,
  },
  {
    id: "P6",
    name: "把观察者密钥塞进包",
    act: () => {
      mkdirSync(path.join(TMP, "data"), { recursive: true });
      writeFileSync(path.join(TMP, "data", ".observer-key"), "deadbeef", "utf8");
    },
    expect: /观察者 HMAC 密钥/,
  },
  {
    id: "P7",
    name: "把 public/index.html 的 HTML 注释改成不闭合（2026-10-06 真实事故的形状）",
    // 这不是假想的变异 —— 当天产物就是这么坏的：<title> 替换的正则从注释里那个
    // `<title>` 开始匹配，把 `--> ` 与整个标题一起吞了。浏览器于是把后面整份文档
    // 当注释：没有样式表、标题为空、页面完全不样式化。
    // 而 check-syntax / check-copy / 秘密扫描 / 250 条测试 **全部是绿的**。
    // ⚠️ 第一版这个变异写的是 `t.replace(/\n\s*-->/, "\n")`，**一个字节都没改** ——
    //   它假设 `-->` 单独占一行，实际它在正文行尾（`……退出非 0。 -->`）。
    //   于是文件仍是好的，自检当然放行，harness 报 SURVIVED。
    //   症状有欺骗性：它看起来像「新判据太弱」，而真相是「变异没生效」。
    //   现在直接删掉第一个 `-->`，不依赖它在哪一行。
    act: () => {
      const p = path.join(TMP, "public", "index.html");
      writeFileSync(p, readFileSync(p, "utf8").replace("-->", ""), "utf8");
    },
    expect: /注释不配平/,
  },
  {
    id: "P8",
    name: "把中文身份代号写回产物（2026-10-06 真实事故的形状）",
    // 同一次事故的另一半。那两个词在**主仓**是有意保留的（person 表里的数据，
    // check-copy 白名单写着「改它要动库与审计」），所以前三道门禁都不会报 ——
    // check-secrets 的判据全是 ASCII 形态，内容性判据比的是文案/照片/口令/域名。
    // 中文一个都不在判据里，于是它一路绿灯进了公开仓库。
    act: () => {
      appendFileSync(path.join(TMP, "public", "app.js"), `\n// 门是 【改这里：doorCode】，门后是【改这里：heroCode】\n`, "utf8");
    },
    expect: /中文身份代号/,
  },
  {
    id: "P9",
    name: "把预填选项数组（含地名与店名）写回产物",
    // 数组是**判据覆盖不到的那一类**：占位符化的第一遍只认「键: \"值」，
    // 而 `wish.options` 是没有键前缀的字符串数组，于是六条原样进了公开包。
    // 那六条里带着具体的地名与店名 —— 是那两个���自己写的愿望。
    act: () => {
      appendFileSync(path.join(TMP, "src", "copy.js"), `\nexport const LEAKED = ["去【改这里：place】游【改这里：place】", "搬到一起住"];\n`, "utf8");
    },
    expect: /中文身份代号/,
  },
  {
    id: "P10",
    name: "README 引用一张不存在的图（GitHub 上就是一个空占位，且没有任何现有门禁会红）",
    act: () => {
      const p = path.join(TMP, "README.md");
      writeFileSync(p, readFileSync(p, "utf8") + `\n![没了](docs/screenshots/99-ghost.png)\n`, "utf8");
    },
    expect: /不存在的图/,
  },
  {
    id: "P11",
    name: "把 public/index.html 的真 <title> 置空（注释里那个字面量 <title> 还在）",
    // 2026-10-06 独立复审实测到的**恒真式**：title 判据原先拿未遮蔽注释的
    // headPart 做非贪婪匹配，会从**注释里那个字面量 <title>** 开始吃、把真标题
    // 吞进捕获组 —— 真标题被置空它仍 exit 0（真标题被删反而红，与意图相反）。
    // 现在判据先遮蔽注释再取 title；这条变异钉住那个修复不会退化。
    act: () => {
      const p = path.join(TMP, "public", "index.html");
      const html = readFileSync(p, "utf8");
      const masked = html.replace(/<!--[\s\S]*?-->/g, (m) => "\u0000".repeat(m.length));
      const open = masked.search(/<title>/i);
      const close = masked.indexOf("</title>", open);
      if (open < 0 || close < 0) throw new Error("没找到真 <title>");
      writeFileSync(p, html.slice(0, open) + "<title></title>" + html.slice(close + "</title>".length), "utf8");
    },
    expect: /不存在或是空/,
  },
  {
    id: "P12",
    name: "把挂载点 <div id=\"app\"> 关进一段配平的注释里（页面渲染成空白）",
    // 注释配平判据看不见这个：注释**确实配平**，link 与 title 也都还在注释外，
    // 唯独浏览器找不到挂载点、渲染一片空白。挂载点判据专治这一种。
    act: () => {
      const p = path.join(TMP, "public", "index.html");
      const html = readFileSync(p, "utf8");
      writeFileSync(p, html.replace('<div id="app"></div>', '<!--<div id="app"></div>-->'), "utf8");
    },
    expect: /挂载点/,
  },
  {
    id: "P13",
    name: "把独立短别名域名写回 nginx 配置（2026-10-06 真实泄露：只替换/只搜长域名，短别名不含它为子串 → 残留 21 处，门禁全绿）",
    // 真形状：真实部署有主站 + 别名两个域名，make-release 只替换 REL_REAL_DOMAIN
    // 那一个、release-check 也只搜那一个 → 别名在 3 个 nginx conf + check-secrets.mjs
    // 里原样留下，而「域名零出现」照样绿。P4 用长域名、P13 用短别名，各钉一个方向。
    act: () => {
      const p = path.join(TMP, "deploy", "nginx", "site-443.conf");
      writeFileSync(p, readFileSync(p, "utf8").split("example.com").join(REL_SHORT_DOMAIN), "utf8");
    },
    expect: /真实域名/,
  },
];

let survived = 0;
let harnessErr = 0;

/**
 * 目录指纹：把 TMP 里每个文件的相对路径 + 内容 sha256 拼起来哈希。
 *
 * 存在的理由（2026-10-06 P7 事故）：一个写错的变异 —— `replace(/\n\s*-->/, ...)`
 * 假设 `-->` 单独占一行，而它实际在正文行尾 —— **一个字节都没改**。
 * 文件仍是好的，自检当然放行，harness 报 SURVIVED。
 * 那个症状极具欺骗性：它看起来像「新判据太弱」，第一反应是去加强判据 ——
 * 而真相是「变异根本没生效」。**判据弱与变异没生效，在 harness 的输出里长得一模一样。**
 *
 * 所以在跑自检**之前**先问一句「TMP 真的变了吗」。没变就是 harness 自己坏了，
 * 归 HARNESS_ERROR，不计入 survived —— 别让一个假变异把真缺口藏起来。
 */
function fingerprint(dir) {
  const h = createHash("sha256");
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(p, rel + "/");
      else { h.update(rel); h.update(readFileSync(p)); }
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

for (const c of cases) {
  fresh();
  const before = fingerprint(TMP);
  c.act();
  const after = fingerprint(TMP);
  if (before === after) {
    console.log(`⚠ HARNESS_ERROR  ${c.id}  变异一个字节都没改 —— 判据没被验证到  ${c.name}`);
    console.log("        这一条不算 SURVIVED（那是「判据太弱」），是 harness 自己的错。");
    harnessErr++;
    continue;
  }
  const r = run(TMP);
  const caught = r.code !== 0 && c.expect.test(r.out);
  console.log(`${caught ? "✔ KILLED  " : "✖ SURVIVED"}  ${c.id}  ${c.name}  (exit ${r.code})`);
  if (!caught) {
    survived++;
    const line = r.out.split("\n").find((l) => l.includes("FAIL")) || "(没找到 FAIL 行)";
    console.log("        " + line.trim());
  }
}

// 阴性对照：干净的包必须是绿的，否则上面那些「报红」没有意义
fresh();
const clean = run(TMP);
const cleanOk = clean.code === 0;
console.log(`${cleanOk ? "✔ OK" : "✖ FAIL"}  P0  阴性对照：干净的包必须通过  (exit ${clean.code})`);

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${cases.length - survived - harnessErr}/${cases.length} KILLED，阴性对照${cleanOk ? "通过" : "失败"}`);
if (harnessErr) console.log(`⚠️ 另有 ${harnessErr} 条 HARNESS_ERROR（变异没生效，不计入 SURVIVED）`);
process.exit(survived === 0 && cleanOk && harnessErr === 0 ? 0 : 1);
