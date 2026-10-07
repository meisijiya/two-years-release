/**
 * 运维日志门禁的变异实验。
 *
 * 判据：**删掉它会不会有东西变红**。不是「它写在那儿」。
 * 每条变异都改一处源码，然后只跑 ticket-11 那一个测试文件，
 * 期望：**KILLED**（有用例红）而不是 SURVIVED（变异活着 = 断言没用）。
 *
 * 还原必须 sha256 校验 + 重试 + 硬失败：
 * Windows 上文件锁会让一次写失败，还原失败会**静默**把变异留在源码里，
 * 而 `git status` 看着干净 —— 这是本项目 2026-10-04 踩过的坑。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST = "test/ticket-11-ops-log.test.js";
const TARGETS = ["src/logging.js", "src/app.js", "src/server.js"];

/** 备份：内容 + sha256。还原时必须 sha 对上才算还原成功。 */
const backup = new Map();
for (const rel of TARGETS) {
  const abs = path.join(ROOT, rel);
  const content = readFileSync(abs, "utf8");
  backup.set(rel, { abs, content, sha: createHash("sha256").update(content).digest("hex") });
}

/** 还原：最多 3 次（Windows 文件锁），每次后校验 sha。失败 = 硬失败。 */
function restoreAll() {
  for (const [rel, b] of backup) {
    let ok = false;
    for (let i = 0; i < 3; i++) {
      try {
        writeFileSync(b.abs, b.content, "utf8");
        const now = createHash("sha256").update(readFileSync(b.abs, "utf8")).digest("hex");
        if (now === b.sha) { ok = true; break; }
      } catch {}
    }
    if (!ok) {
      console.error(`\n✖ 还原失败：${rel} 的 sha256 与备份不符 —— 变异可能仍留在源码里！`);
      console.error(`  期望 ${b.sha}`);
      process.exit(1);
    }
  }
}

function patch(rel, from, to) {
  const b = backup.get(rel);
  const content = readFileSync(b.abs, "utf8");
  if (!content.includes(from)) {
    console.error(`\n✖ 锚点在 ${rel} 里没命中：${JSON.stringify(from.slice(0, 60))}`);
    console.error("  变异没生效 —— 测出来的「SURVIVED」是假的（锚点失效，不是断言没用）。");
    process.exit(1);
  }
  writeFileSync(b.abs, content.replace(from, to), "utf8");
}

function runTests() {
  const r = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", "./test/preload-secrets.mjs", "--test", TEST],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /# fail (\d+)/.exec(out) || /ℹ fail (\d+)/.exec(out);
  const passed = (out.match(/ℹ pass (\d+)/) || [])[1];
  const failed = m ? Number(m[1]) : out.includes("not ok") ? 1 : 0;
  return { failed: Number(failed), passed: Number(passed || 0), out };
}

const MUTATIONS = [
  {
    id: "M1",
    name: "query string 不再丢弃（凭据走 URL 就直接落盘）",
    file: "src/logging.js",
    from: 'const cut = p.indexOf("?");\n  const bare = cut === -1 ? p : p.slice(0, cut);',
    to: 'const bare = p;',
  },
  {
    id: "M2",
    name: "路径不再参数化（照片 id 逐个进日志）",
    file: "src/logging.js",
    from: '.replace(/\\/api\\/photo\\/[^/]+/g, "/api/photo/:id")',
    to: '',
  },
  {
    id: "M3",
    name: "假名不再哈希（明文 IP 直接落盘）",
    file: "src/logging.js",
    from: 'return "c-" + crypto.createHash("sha256").update(String(salt) + "|" + String(ip)).digest("hex").slice(0, 8);',
    to: 'return String(ip);',
  },
  {
    id: "M4",
    name: "保留期失效：从不删超期文件（7 天变成永远留着）",
    file: "src/logging.js",
    from: "if (dayOrdinal(f.slice(7, 17)) < cutoff) {",
    to: "if (false) {",
  },
  {
    id: "M5",
    name: "容量上限失效：超量也不删（一天就能写爆盘）",
    file: "src/logging.js",
    from: "      if (total <= maxBytes) break;",
    to: "      if (true) break;",
  },
  {
    id: "M6",
    name: "日志写失败不吞：让磁盘满把请求带崩",
    file: "src/logging.js",
    from: "      } catch {\n        // 日志失败绝不能连累请求：磁盘满、权限变了都不该让服务 500。",
    to: "      } catch (e) {\n        throw e;\n        // 日志失败绝不能连累请求：磁盘满、权限变了都不该让服务 500。",
  },
  {
    id: "M7",
    name: "默认打开日志（测试目录凭空多出日志文件）",
    file: "src/app.js",
    from: "  logWriter = null,\n}) {",
    to: "  logWriter = null,\n}) {\n  if (!logWriter) logWriter = createLogWriter({ dir: path.join(dataDir, 'logs') });",
  },
  {
    id: "M8",
    name: "中间件不挂（请求全部不落日志）",
    file: "src/app.js",
    from: "  if (logWriter) app.use(accessLog({ writer: logWriter, now }));",
    to: "  if (false && logWriter) app.use(accessLog({ writer: logWriter, now }));",
  },
  {
    id: "M9",
    name: "状态码记成 200（4xx/5xx 全被抹平，运维看不出服务坏了）",
    file: "src/logging.js",
    from: "          s: res.statusCode,",
    to: "          s: 200,",
  },
  {
    id: "M10",
    name: "盐每次随机（假名跨实例不可比，历史日志的前后对比失效）",
    file: "src/logging.js",
    from: "  const created = crypto.randomBytes(32).toString(\"hex\");\n  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });",
    to: "  const created = crypto.randomBytes(32).toString(\"hex\");\n  return created;",
  },
  // ── 以下三条是 2026-10-06 独立复审逼出来的 ──────────────────────────
  // 它们对应三个**代码注释与测试标题都声称已覆盖、而实现没有**的性质：
  {
    id: "M11",
    name: "容量判定退回「只在当天第一次写」（50MB 上限当天不生效）",
    file: "src/logging.js",
    from: "      // 写完立刻判容量：这是「一天之内被写爆」的唯一防线\n      if (totalBytes() > maxBytes) prune();",
    to: "      // 变异：写完不判容量",
  },
  {
    id: "M12",
    name: "prune 不再跳过今天那份（正在被写的文件被删掉，当天内容凭空消失）",
    file: "src/logging.js",
    from: "      if (`access-${today}.jsonl` === f) continue;",
    to: "      // 变异：不再跳过今天",
  },
  {
    id: "M13",
    name: "空的 .log-salt 静默换盐（没人察觉的假名轮换）",
    file: "src/logging.js",
    from: "  if (text !== null) {\n    // 文件在但内容是空的：那是损坏，不是「还没有」\n    throw new Error(",
    to: "  if (false) {\n    // 变异：把损坏当成「还没有」，静默换盐\n    throw new Error(",
  },
];

console.log(`变异实验：${MUTATIONS.length} 条，判据 = ${TEST} 里有用例变红\n`);

const results = [];
for (const mut of MUTATIONS) {
  restoreAll();
  try {
    patch(mut.file, mut.from, mut.to);
  } catch (e) {
    console.error(`✖ ${mut.id} patch 失败：${e.message}`);
    process.exit(1);
  }
  const r = runTests();
  const killed = r.failed > 0;
  results.push({ ...mut, killed, failed: r.failed, passed: r.passed });
  console.log(
    `${killed ? "✔ KILLED  " : "✖ SURVIVED"}  ${mut.id.padEnd(4)} ${mut.name}` +
      `  (fail ${r.failed} / pass ${r.passed})`,
  );
  if (!killed) {
    console.log(`        ↑ 这条断言够不着这个变异：把 src/logging.js 的输出读完也发现不了它。`);
  }
}

restoreAll();

// 基线复跑：证明还原后回到全绿，而不是「反正都 KILLED 了」
const base = runTests();
console.log(`\n还原后基线：pass ${base.passed} / fail ${base.failed}`);

const survived = results.filter((r) => !r.killed);
console.log(`\n结论：${results.length - survived.length}/${results.length} KILLED`);
if (base.failed !== 0) {
  console.error("✖ 还原后基线不绿 —— 变异被留在源码里了，必须人工检查后再跑。");
  process.exit(1);
}
if (survived.length) {
  console.error(`✖ ${survived.length} 条存活：${survived.map((s) => s.id).join(", ")}`);
  process.exit(1);
}
console.log("0 存活，还原后基线全绿。");
