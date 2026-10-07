/**
 * 秘密门禁：已跟踪文件里不许出现真实凭据与真实线上环境信息。
 *
 * 为什么需要它：2026-10-04 那次脱敏是一次性手工做的，做完仓库是干净的，
 * 但**没有任何东西守着**。下一次有人在 SPEC 里贴一条真实 IP、或把生日写进
 * 新文档，`npm run check` 照样全绿。这条门禁就是那次手工动作的守门人。
 *
 * ── 口径 ─────────────────────────────────────────────────────────────
 * 扫**被 git 跟踪**的文件（`git ls-files`），不扫磁盘：data/、photos/、
 * .scratch/、node_modules/ 都在 .gitignore 里，扫它们只会制造噪音。
 * 与 check-syntax.mjs 的行尾检查同一口径。
 *
 * ⚠️ 已知边界：**未 `git add` 的新文件不在扫描范围内**。新建文件塞真实
 * 凭据，门禁不会报 —— 实测过：add 之后立刻报红。所以「先 add 再跑门禁」
 * 是使用前提；提交前的 verify 天然满足（暂存区里的文件已被 ls-files 收录）。
 *
 * ── 豁免：已取消 ─────────────────────────────────────────────────────
 * 早先豁免 `test/` 与 `src/`，理由是「那里的口令夹具与 `src/auth.js` 的
 * fallback 必须逐字一致，改了会砸掉 226 个用例」。**2026-10-04 那次配置
 * 抽离把这个前提消掉了**：真实生日已从 `src/auth.js`（fallback）与全部
 * 测试夹具中移除，测试改用 `test/helpers.js` 的 `TEST_SECRET`
 * （人造值 00010101 / 00020202 / 00030303）。
 *
 * 继续豁免会让门禁在**唯一最该守的地方**失守 —— 正是真实口令最可能
 * 再被粘回去的 `src/`。所以现在零豁免。`test/helpers.js` 里那条
 * `FORBIDDEN_AS_TEST_SECRET` 是反向守卫：谁再拿真生日当测试值，
 * import 那一刻就抛。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 要扫的源码目录。
 *
 * ⚠️ 2026-10-06 改口径：早先只扫 `git ls-files`。那在**解包目录**里直接失效 ——
 *    `git ls-files` 返回非 0 / 空，于是「读不到 git ls-files —— 这条检查等于没跑，
 *    拒绝放行」。实测：Release 产物解压后 `npm run verify` 红在这里，
 *    而产物本身一个秘密都没有。
 *    换机器、换发行形态（zip / npm 包 / 拷贝目录）都会撞上同一件事。
 *
 * 现在改成**目录遍历 + 显式源码目录白名单**，与 `check-syntax.mjs` 同一形状
 * （那条在解包目录里一直是好的，正因为它不依赖 git）。
 *
 * 代价与取舍：目录遍历会扫到**未跟踪的新文件**。
 * 早先那版的注释说「未 add 的新文件不在扫描范围内，add 之后立刻报红」——
 * 那是它的**已知边界**，而边界之外更糟的后果是「整条检查在换形态后静默失灵」。
 * 扫到未跟踪文件只会多报一次让人来看一眼，漏扫则可能让真值直接进版本库。
 * 两者不对称，所以选前者。
 */
const SCAN_DIRS = ["src", "test", "scripts", "public", "deploy", "docs", "ops", "prototype", "."];

/**
 * 跳过：依赖与运行期数据，以及**门禁自己的豁免**。
 *
 * 跳过 `node_modules` 不只是为了快 —— 141 个包几万个文件，
 * 里面的第三方 registry 地址全会被域名规则误报，那是一条 100% 误报的规则。
 * 跳过 `data` / `photos` / `.scratch` 与 `.gitignore` 的意图一致：
 * 真实照片、真实文案、库文件、临时工作区都不该被扫（也不该被提交）。
 */
const SKIP_DIRS = new Set(["node_modules", "data", "photos", ".git", ".scratch", ".worktrees", "coverage"]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/"));
    }
  }
  return out;
}

/**
 * 豁免前缀：2026-10-04 配置抽离后**已清空**。
 *
 * 保留这个数组（而不是删掉）是为了让「以后有人再加豁免」必须回到这里，
 * 在一个显眼的位置改 —— 而不是把跳过逻辑散落到扫描循环里。
 */
const EXEMPT_PREFIX = [];
const EXEMPT_WHY = "（无豁免：真实值已从 src/ 与 test/ 全部抽离，见文件头说明）";

/**
 * 真实顶级域白名单。刻意**短**：宁可多报一次让人来看一眼，
 * 也不要把这里变成一个「所有见过的域名都能进」的名单。
 */
const TLDS =
  "com|net|org|top|io|dev|app|xyz|me|cc|cn|co|info|biz|cloud|site|online|" +
  "tech|store|blog|pro|edu|gov|mil|int|name";

/** 域名形态：至少两段标签 + 白名单里的顶级域，前面不接 [\w.@-]，后面不接 [\w-]。 */
const DOMAIN_RE = new RegExp(
  String.raw`(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS})(?![\w-])`,
  "g",
);

/**
 * 允许出现的域名。
 *
 * ⚠️ 写在这里的不是凭据。凭据进这个文件是 `FORBIDDEN_AS_TEST_SECRET`
 * 那个悖论的形状（防真值泄漏的守卫自己把真值写进仓库），**本名单不属于那一类**：
 * 礼物站点的地址本来就是公开的 —— 收到礼物的人拿到的就是它。
 * 它之所以必须留下，是因为 nginx 里的 `server_name` 与
 * `/etc/letsencrypt/live/<域名>/` 是 load-bearing 的，替换成占位符之后
 * 那份配置既不能复制去用，也无法与服务器上的实际配置逐字核对；
 * 而 docs/evidence/*.json 记的是**对真实站点跑过**的测试，改掉等于伪造证据。
 *
 * 想改这个名单之前先答一句：「这条域名是不是**必须**出现在配置里？」不是就删掉它。
 */
const ALLOWED_DOMAINS = [
  // 本站（礼物网站）—— 公开地址，且是 nginx 配置的 load-bearing 部分。
  "example.com",
  // 文档占位符。README 与导出测试用它举例。
  "example.com",
];

/** 命中值是否属于白名单：本域本身，或它的任一子域。 */
function allowedDomain(hit) {
  return ALLOWED_DOMAINS.some((d) => hit === d || hit.endsWith("." + d));
}

/**
 * 每条规则：名字、判定用的正则、人类可读的处置建议。
 *
 * 正则一律要求**足够长的上下文或明确的形态**，避免误伤：
 * - 公网 IP 排除了 127. / 10. / 192.168. / 172.16-31.（绑定语义与内网）
 * - 私钥只要 BEGIN 行
 * - 生日要求 2004- 开头，因为这是本项目两人各自的出生年份写死值
 * - 域名锚在真实顶级域白名单上，并限定不扫 .js/.mjs（那里全是代码标识符）
 */
const RULES = [
  {
    name: "私钥",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    fix: "私钥绝不入库。放到服务器 /etc 下的 0600 文件，仓库里只留路径。",
  },
  {
    name: "公网 IP",
    // 排除四类**不可能是真主机**的地址：
    //   127.        环回
    //   10. 192.168. 172.16-31.  RFC1918 私网
    //   169.254.    链路本地
    //   192.0.2. 198.51.100. 203.0.113.  RFC 5737 **文档专用网段**
    // 最后一类是被门禁自己逮出来的：test/ticket-02-backend.test.js:280-282
    // 用它们验「X-Forwarded-For 取最右一个」—— 那是 RFC 5737 专门留给
    // 文档与测试的网段，写在那儿是**正确**的，不该被当成泄露改掉。
    // 反过来，正是它抓出了 SPEC.md 里两个真的备用服务器 IP。
    //
    // ⚠️ 2026-10-06 补记：那个「教科书 IP」（1 + 2 + 3 + 4 那串）**不在**豁免里，
    //   尽管它同样不可能是真主机。写 `test/ticket-11-ops-log.test.js` 的客户端标签
    //   用例时顺手用了它，门禁当场报红 —— 而**写下这段说明的第一个版本也报红了**，
    //   因为注释里复述了那串数字。
    //   **没有为它加豁免** —— 加豁免就得写「为什么它安全」，而那句话本身是在论证
    //   「我们相信判断而不是相信形状」；正确处置是改用 RFC 5737 网段。
    //   两条教训：
    //     ① **豁免名单要窄**，每一条都要能一句话说清为什么；说不清就改代码别加豁免。
    //     ② **门禁的规则文档自己也服从门禁。** 规则与它的说明分离在两处，
    //        或者说明里只写形状不写字面量 —— 否则「禁止某值」这件事本身
    //        就成了该值的一个副本。
    re: /\b(?!127\.|10\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|169\.254\.)(\d{1,3}\.){3}\d{1,3}\b/g,
    fix: "换 <公网IP>。真实 IP 是攻击面定位信息，配上口令即构成入侵路径。",
  },
  {
    name: "完整生日口令",
    re: /\b2004(10|11|12|01)\d{2}\b/g,
    fix: "换 <8位完整生日>。这既是可登录凭据，也是出生日期 PII。",
  },
  {
    name: "SSH 主机别名",
    re: /\b\d+core_\d+gb_\w+\b/g,
    fix: "换 <服务器别名>。别名与 IP 同时出现时补齐了目标指纹的最后一块。",
  },
  {
    name: "云实例 ID",
    re: /\blhins-[a-z0-9]+\b/g,
    fix: "换 <实例ID>。实例 ID 可用于云控制台的定位与枚举。",
  },
  {
    name: "真实域名",
    // 锚在**真实顶级域**上，而不是「像域名」：不加 TLD 白名单时
    // assert.equal / path.join / r.status 全都会被当成域名（全仓 7941 处）。
    re: DOMAIN_RE,
    // 假阳性几乎全在代码里：ui.app / r.name / r.top / band.top / out.info …
    // 实测（2026-10-04）：不限定文件时 TLD 口径仍有 274 处命中、其中约 38 处
    // 是这类标识符；**限定在非 .js/.mjs 后只剩 37 处且全部正当**（礼物自己的
    // 域名 + example.com），零假阳性。所以这条规则**必须**带 skipFiles 才可用 ——
    // 一条 90% 误报的规则等于没有规则。
    //
    // 2026-10-06 复核过「要不要把 `.mjs` 也纳进来」，结论是**不纳**，实测数在这：
    // 22 个 `.mjs` × 本正则 = **51 处命中**，三分桶是
    //   · 属性链噪声 **41**（`e.name` / `r.top` / `band.top` / `f.name` / `ui.app` …）— 80.4%
    //   · 已在白名单的正当域名 **8**（本站的 + 文档占位符）
    //   · 真正的第三方域名 **2**：`www.w3.org`（e2e 种子里的 SVG 命名空间）
    //     与 `registry.npmmirror.com`（lockfile 之外手写的 registry 地址）
    // 关键在最后那 2 条：**它们都不是凭据**。一条是 XML 命名空间 URI，
    // 一条是包 registry —— 都不是「这个值现在是谁在用」意义上的秘密。
    // 纳进来 = 80.4% 噪声换一个零净收益，**所以不纳**。这是已知边界，不是漏网：
    // 真实域名若被写进 `.mjs`，本轮 Release 的构建（`make-release.mjs`）
    // 与自检（`release-check.mjs`）都**不扫 `.mjs`** 之外的东西——
    // 它们扫的是**整个产物目录的全部文本文件**，含 `.mjs`，由那条链路兜住。
    // 要改这个决定前先答一句：「那 2 条第三方域名，凭什么算秘密？」答不上就别改。
    //
    // package-lock.json 一并跳过：它是**生成文件**，里面全是第三方 registry 的
    // 地址（registry.npmmirror.com 等）。那些不是本项目的部署形态，
    // 由 lockfile 自己管，不需要人看。
    skipFiles: /\.(js|mjs)$|(^|\/)package-lock\.json$/,
    // 白名单只有两类，都不是「密钥」：
    //  ① 本站自己的域名与它的子域 —— 它是**公开地址**（礼物网站的门面），
    //     且在 nginx 里是 load-bearing：`server_name` 与
    //     `/etc/letsencrypt/live/<域名>/` 抽掉之后那份配置既不能用也无法核对；
    //     docs/evidence/*.json 记的是**对真实站点跑过**的测试，改掉就是伪造证据。
    //  ② 文档占位符 example.com。
    // 这不是 `FORBIDDEN_AS_TEST_SECRET` 那个悖论：那里禁的是把**凭据**写进
    // 门禁，这里是一个本来就公开、且必须留在配置里的地址。
    allow: ALLOWED_DOMAINS,
    fix:
      "换 <你的域名> 或 example.com。若这是站点自己的域名并确实需要留在配置里" +
      "（server_name / letsencrypt 路径），在 ALLOWED_DOMAINS 里显式登记并写清理由 —— " +
      "凭空出现的域名会连带暴露部署形态。",
  },
];

/** 二进制/非文本后缀：不 decode，按字节查。 */
const SKIP_BIN = /\.(png|jpg|jpeg|gif|webp|heic|mp3|mp4|mov|woff2?|ttf|ico|pdf|zip|gz|tgz)$/i;

/**
 * 取要扫的文件：白名单目录各扫一遍，根目录只取散在根上的那几个文件
 * （`"."` 那一项若也递归就会把所有目录重复扫一遍）。
 */
function tracked() {
  const files = new Set();
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    try {
      if (!statSync(abs).isDirectory()) {
        files.add(d);
        continue;
      }
    } catch {
      continue; // 白名单里有目录不存在（Release 剔掉了 docs/ 等）——跳过，不是错
    }
    if (d === ".") {
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (e.isFile()) files.add(e.name);
        else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name)).forEach((f) => files.add(f));
      }
      continue;
    }
    for (const f of walk(abs)) files.add(f);
  }
  const list = [...files].filter((f) => f !== "package-lock.json").sort();
  if (list.length === 0) {
    console.error("一个可扫文件都没有 —— 这条检查等于没跑，拒绝放行");
    process.exit(1);
  }
  return list;
}

const files = tracked();
const scanned = files.filter((f) => !EXEMPT_PREFIX.some((p) => f.startsWith(p)));
const exempt = files.length - scanned.length;
let found = 0;

/** 命中行只报行号与那一行，够定位即可；不回显整行避免把口令再抄进 CI 日志。 */
for (const rel of scanned) {
  if (SKIP_BIN.test(rel)) continue;
  let text;
  try {
    text = readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue; // 读不出来就不下结论（断链等），跳过
  }
  const lines = text.split("\n");
  for (const rule of RULES) {
    // 逐规则的文件口径。不是每条规则都需要：只有「形态在代码里天然会长得
    // 像命中」的那些（如域名 vs r.top）才需要，写在这里是为了让「为什么
    // 这条要限定文件」能跟规则待在一起，而不是散在别处。
    if (rule.skipFiles && rule.skipFiles.test(rel)) continue;
    for (let i = 0; i < lines.length; i++) {
      // 每行只报一次，避免同一行多个形态刷屏
      const hits = lines[i].match(rule.re);
      if (!hits) continue;
      const real = rule.allow ? hits.filter((h) => !allowedDomain(h)) : hits;
      if (real.length === 0) continue;
      found++;
      console.error(
        `FAIL ${rel}:${i + 1} 命中「${rule.name}」 ${real.length} 处\n` +
          `     ${rule.fix}`,
      );
      break;
    }
  }
}

// 与上面同源的纪律：扫了 0 个可扫文件也算没跑。
if (scanned.length === 0) {
  console.error("豁免规则把所有文件都吃掉了 —— 这条检查等于没跑，拒绝放行");
  process.exit(1);
}

if (found) {
  console.error(
    `\n${found} 处敏感值在已跟踪文件里。` +
      `仓库是私有的，但「私有」不等于「只有你能看」——有协作者就是敞开的。\n` +
      `处置：换 <占位符>，并把真实值挪到服务器 env / 0600 文件。`,
  );
  process.exit(1);
}

console.log(
  `secrets OK — ${scanned.length} 个已跟踪文件已扫（豁免 ${exempt} 个：` +
    `${EXEMPT_PREFIX.join("、")}），未发现真实凭据或线上环境信息`,
);
