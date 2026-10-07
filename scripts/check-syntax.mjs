/**
 * 语法门禁：对仓库里每个 .js/.mjs 跑一次 `node --check`。
 * 不执行模块，只做解析——server.js 会被 import 执行，node --check 不会。
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "test", "scripts", "public"];

function walk(dir, out = []) {
  let full;
  try {
    full = path.join(ROOT, dir);
    if (!statSync(full).isDirectory()) return out;
  } catch {
    return out;
  }
  for (const name of readdirSync(full)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(full, name);
    if (statSync(p).isDirectory()) walk(path.join(dir, name), out);
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(d));
if (files.length === 0) {
  console.error("no .js/.mjs found — nothing checked, refusing to pass");
  process.exit(1);
}

/**
 * 仓库里**被 git 跟踪**的文件 —— 行尾检查只该看这些。
 *
 * 早先一版是 walkAll(ROOT) 扫整个磁盘，那在服务器上直接崩了：
 * 部署目录 /opt/two-years 里有运行数据目录 data/（photos 700 权限，
 * CONSTRAINTS §2 规定的），以非属主身份读会 EACCES，门禁**崩在读目录上**
 * 而不是给出结论。164/164 的本地测试完全测不到这条 —— 本地没有 700 目录。
 *
 * 更根本的问题是「磁盘上的东西」≠「仓库里的东西」：data/、photos/、
 * node_modules/ 都在 .gitignore 里，扫它们没有意义。
 * git ls-files 拿到的正是 .gitattributes 作用的那一批，两边口径一致。
 *
 * 不在 git 仓库里（tarball 导出等）时退回目录遍历，并对读不了的目录跳过而不是崩。
 */
function trackedFiles() {
  const r = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status === 0 && r.stdout) {
    return r.stdout.split("\n").filter(Boolean).map((p) => path.join(ROOT, p));
  }
  return walkAll(ROOT);
}

/** 目录遍历：读不了的目录跳过，不让一条读不出来的路径把门禁打崩。 */
function walkAll(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out; // EACCES（运行数据目录）等：跳过，记在别处，不在这里崩
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    try {
      if (statSync(p).isDirectory()) walkAll(p, out);
      else out.push(p);
    } catch {
      // 断链、竞态删除等：同样跳过
    }
  }
  return out;
}

// 零测试 = 绿。`node --test` 的 glob 匹配到 0 个文件时同样退 0，
// 于是测试被改名、挪目录或误删，门禁会一路放行——而这正是门禁要防的事。
const testFiles = walk("test").filter((f) => f.endsWith(".test.js") || f.endsWith(".test.mjs"));
if (testFiles.length === 0) {
  console.error("no test files found under test/ — the gate cannot fail, refusing to pass");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${path.relative(ROOT, file)}\n${(r.stderr || r.stdout || "").trim()}\n`);
  }
}

if (failed) {
  console.error(`${failed}/${files.length} file(s) failed to parse`);
  process.exit(1);
}

/* ── 行尾：交给 Linux 执行的文件必须是 LF ─────────────────────────────
 *
 * `.js/.mjs` 解析得了 CRLF，node 也不在意。但 `.sh` 在意：
 * CRLF 的 bash 脚本在 Linux 上直接 `bad interpreter: /usr/bin/env bash^M`，
 * 或者每个命令后面多一个看不见的 `\r`（`cd /opt/two-years\r` 找不到目录）。
 *
 * 这类失败**只在线上炸**：本机 Windows 有 Git Bash 兜底、门禁全绿、部署脚本
 * 一行不差地跑完，一到服务器就死。而 `deploy/deploy.sh` 是整个部署的唯一入口。
 * 仓库有 .gitattributes 强制 LF，但那条只在**提交与全新检出**时生效 ——
 * 已经躺在工作区里的 CRLF 文件不受影响，所以这里再查一遍盘上的实际字节。
 */
const CRASHERS = /\.(sh|service|conf)$/;
let crlf = 0;
let crlfChecked = 0;
// 扫**整个仓库**，不是硬编码的几个目录。早先写死 `init.sh` + `deploy/`，
// 而这两个位置恰好覆盖了当时全部的 .sh/.service/.conf —— 于是它长期是绿的，
// 日后有人在 scripts/ 下新增一个 foo.sh 就会漏掉，且没人会发现这条门禁已经名不副实。
// 「恰好全覆盖」和「覆盖全」在当下观测不出来，得从机制上保证。
for (const f of trackedFiles()) {
  if (!CRASHERS.test(f)) continue;
  crlfChecked++;
  let buf;
  try {
    buf = readFileSync(f);
  } catch {
    continue; // 读不出来就不下结论，跳过（下一轮会再报数量）
  }
  if (buf.includes(0x0d)) {
    crlf++;
    console.error(
      `FAIL ${path.relative(ROOT, f)} 含 CR（0x0D）—— 这类文件在 Linux 上会执行失败。` +
        `用 .gitattributes 归一化，或 ` +
        `git add --renormalize . 后重新检出。`,
    );
  }
}
if (crlfChecked === 0) {
  console.error("没找到任何 .sh/.service/.conf —— 这条检查等于没跑，拒绝放行");
  process.exit(1);
}
if (crlf) {
  console.error(`${crlf}/${crlfChecked} file(s) 带 CR`);
  process.exit(1);
}

console.log(
  `syntax OK — ${files.length} file(s) parsed, ${testFiles.length} test file(s) present, ` +
    `${crlfChecked} 个部署文件行尾为 LF`,
);
