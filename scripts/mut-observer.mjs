/**
 * 观察者入口的变异装置。
 *
 * 存在的理由是本仓自己的不变量（AGENTS.md 工作规则）：门禁要有人守。
 * 一条「看着在守」的断言，如果把被守的代码改坏之后它还是绿的，那它守的其实是自己。
 *
 * 之所以是**仓内文件**而不是临时脚本：只躺在 .scratch/ 里的变异实验等于不存在 ——
 * 下一个改落点的人看不见它，也就无从判断那些断言到底承不承重。
 *
 * 形状（每条**独立**，改完立刻还原）：
 *   备份 → 替换 → 跑 → 还原（按字节 + sha256 比对）→ 分类
 *
 * 分类分两个桶：
 *   killed  = 目标断言自己红了（AssertionError）
 *   crashed = 跑到那条路径就崩（TypeError）—— **判别力 0，不算覆盖**
 * 崩掉的变异比没跑还糟：它会让报告看起来是绿的。
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根从脚本自己的位置推出来。早先写死了开发机那条 worktree 路径，
 *  换一台机器 / 换 worktree 就直接跑不动 —— 而「跑不动」的变异装置
 *  和「没有」在证据上是同一件事。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP = path.join(ROOT, ".scratch", "mut-backup-observer");
const TEST = "test/observer-backend.test.js";

const FILES = ["src/routes.js", "src/observe.js", "src/observer-auth.js", "src/app.js"];

/**
 * expectTest 是**测试标题**里的一段，用来认「哪一条用例该红」。
 * 早先这版匹配的是断言消息，于是「被更早的那条断言红掉」会被误报成杀错对象。
 * 判据收窄成一句：目标用例只要以 AssertionError 变红，就算守住。
 */
const MUTATIONS = [
  {
    id: "M1",
    what: "取图不再认观察者凭据（回到只有本人会话能看图）",
    expectTest: "能顺着 id 真的取到字节",
    file: "src/routes.js",
    from: "const isObserver = !req.person && !!observerAuth?.fromRequest(req);",
    to: "const isObserver = false;",
  },
  {
    id: "M2",
    what: "观察者也被时间锁管起来（未解锁给 404）",
    expectTest: "未解锁时一次读到双方条目",
    file: "src/observe.js",
    from: '    if (!observerAuth.fromRequest(req)) return noAuth(res);',
    to: "    if (!observerAuth.fromRequest(req)) return noAuth(res);\n    if (now() < 1791129600000) return res.status(404).json({ error: 'not_found' });",
  },
  {
    id: "M3",
    what: "撤回的条目也给了观察者（去掉 !row.deleted）",
    expectTest: "已撤回的条目不给了",
    file: "src/routes.js",
    from: "      ? !!row && !row.deleted",
    to: "      ? !!row",
  },
  {
    id: "M4",
    what: "观察者登录不限流（旁路单开一扇没锁的门）",
    expectTest: "限流与登录共用一套",
    file: "src/observe.js",
    from: "    if (!pinMatches(req.body?.pin)) {",
    to: "    if (false) {",
  },
  {
    id: "M5",
    what: "观察者只看得到一方（漏掉另一半）",
    expectTest: "未解锁时一次读到双方条目",
    file: "src/observe.js",
    from: "    for (const p of PERSONS) {",
    to: "    for (const p of PERSONS.slice(0, 1)) {",
  },
  {
    id: "M6",
    what: "凭据不验签（拿到什么 token 都放行）",
    expectTest: "凭据被改一位就作废",
    file: "src/observe.js",
    from: "    if (!observerAuth.fromRequest(req)) return noAuth(res);",
    to: "    if (false) return noAuth(res);",
  },
  {
    id: "M7",
    what: "观察者绕过时也把已撤回的条目拼进响应",
    expectTest: "已撤回的条目不给了",
    file: "src/observe.js",
    from: '  const liveByOwner = db.prepare(\n    "SELECT id, kind, body, ord, created FROM entry WHERE owner = ? AND deleted IS NULL ORDER BY ord, created",\n  );',
    to: '  const liveByOwner = db.prepare(\n    "SELECT id, kind, body, ord, created FROM entry WHERE owner = ? ORDER BY ord, created",\n  );',
  },
  {
    // 独立复审补的一条：前七条里没有「**少传一张**」这一类，
    // 所以仓库自带的装置证明不了张数对账是承重的。
    // 症状很具体：`> 0 && broken === 0` 只能分辨「全都没传」，
    // 传了 6 张而应该是 7 张，它照样绿。
    id: "M8",
    what: "每一方少返回最后一条（少传一张，「双方都在」照样成立）",
    expectTest: "一次读到双方条目",
    file: "src/observe.js",
    from: "      sides[p.id] = { code: p.code, role: p.role, entries: listOf(p.id) };",
    to: "      sides[p.id] = { code: p.code, role: p.role, entries: listOf(p.id).slice(0, -1) };",
  },
];

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
const abs = (f) => path.join(ROOT, f);

mkdirSync(BACKUP, { recursive: true });
const baseHash = {};
for (const f of FILES) {
  copyFileSync(abs(f), path.join(BACKUP, f.replace(/\//g, "__")));
  baseHash[f] = sha(abs(f));
}

function restoreAll() {
  for (const f of FILES) copyFileSync(path.join(BACKUP, f.replace(/\//g, "__")), abs(f));
}

function runTests() {
  try {
    const out = execFileSync(
      "node",
      ["--disable-warning=ExperimentalWarning", "--test", "--test-reporter=tap", TEST],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 },
    );
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout || "") + (err.stderr || "") };
  }
}

const results = [];
for (const m of MUTATIONS) {
  const file = abs(m.file);
  const src = readFileSync(file, "utf8");
  if (!src.includes(m.from)) {
    results.push({ id: m.id, verdict: "SKIP", what: m.what, note: "锚点没匹配上（源码已变，先更新脚本）" });
    continue;
  }
  writeFileSync(file, src.replace(m.from, m.to), "utf8");

  const r = runTests();

  restoreAll();

  const back = sha(file) === baseHash[m.file];

  // ---- 分类：按 TAP 的每一条 not ok 读**错误类型**，不靠整段文本里有没有某个词 ----
  // 早先那版用 /TypeError/.test(整段输出)，它把「别的断言红了」和「崩了」混成一桶，
  // 结论是错的。分类逻辑比护栏更容易出错 —— 它必须先自己站得住。
  const blocks = r.out.split(/\n(?=not ok \d+ - )/);
  const fails = [];
  for (const b of blocks) {
    const title = /^not ok \d+ - (.+)$/m.exec(b)?.[1]?.trim();
    if (!title) continue;
    const name = /name: '?([A-Za-z]*Error)'?/.exec(b)?.[1] ?? "unknown";
    fails.push({ title, name });
  }

  const targeted = fails.filter((f) => f.title.includes(m.expectTest));
  const asserted = targeted.filter((f) => f.name === "AssertionError").length;
  const crashedTarget = targeted.filter((f) => f.name !== "AssertionError").length;

  let verdict;
  if (r.code === 0) verdict = "SURVIVED";
  else if (targeted.length === 0) verdict = "KILLED_OTHER";
  else if (crashedTarget > 0 && asserted === 0) verdict = "CRASHED";
  else if (asserted > 0) verdict = "KILLED";
  else verdict = "CRASHED";

  results.push({
    id: m.id,
    what: m.what,
    verdict,
    restored: back,
    targeted: targeted.map((f) => `${f.title.slice(0, 34)} [${f.name}]`),
    otherCount: fails.length - targeted.length,
  });
}

restoreAll();
for (const f of FILES) {
  if (sha(abs(f)) !== baseHash[f]) throw new Error("还原失败：" + f);
}

const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log("");
console.log("观察者入口 · 变异装置");
console.log("─".repeat(78));
for (const r of results) {
  console.log(
    `${r.id}  ${pad(r.verdict, 14)} ${r.what ?? ""}${r.note ? " — " + r.note : ""}`,
  );
  if (r.targeted?.length) {
    for (const t of r.targeted) console.log(`${" ".repeat(6)}红了：${t}`);
    if (r.otherCount > 0) console.log(`${" ".repeat(6)}（另有 ${r.otherCount} 条用例一并变红，不计入判定）`);
  }
}
const killed = results.filter((r) => r.verdict === "KILLED").length;
const survived = results.filter((r) => r.verdict === "SURVIVED").length;
const crashed = results.filter((r) => r.verdict === "CRASHED").length;
const skipped = results.filter((r) => r.verdict === "SKIP").length;
const other = results.filter((r) => r.verdict === "KILLED_OTHER").length;
console.log("─".repeat(78));
console.log(
  `断言变红 ${killed} / 崩溃(判别力 0，不算覆盖) ${crashed} / 被别的用例红掉 ${other} / 存活 ${survived} / 跳过 ${skipped} / 共 ${results.length}`,
);
const bad = survived + skipped + crashed + other;
console.log(bad === 0 ? "结论：每条变异都被**目标用例自己的断言**挡住" : `结论：有 ${bad} 条没被目标断言挡住，别把这份报告当成全绿`);
for (const r of results) if (r.restored === false) console.log(`!! ${r.id} 还原失败，源码已被改坏`);

rmSync(BACKUP, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);
