/**
 * 由 src/copy.js 生成浏览器侧的那一份：public/copy.js（`window.COPY = {...};`）。
 *
 *   npm run build:copy
 *
 * ── 逐字节可复现 ───────────────────────────────────────────────────
 * 产物里**不写时间戳、不写版本号、不写任何「什么时候跑的」痕迹**，
 * 换行固定 LF、末尾固定一个换行。同一份 src/copy.js 跑两次产物逐字节相同——
 * 同样的精神见 export-standalone.mjs 第 2 条不变量与 CONSTRAINTS.md §1：
 * 产物内容不掺「什么时候跑的」。
 *
 * 为什么必须是**生成**而不是手抄：手抄的那份迟早会与源文件漂移，
 * 而漂移的两份是**同一个东西的两种措辞**——这个项目已经因此出过两次事故。
 *
 * 序列化用 JSON.stringify：COPY 是纯数据（带插值的地方用 {name} 占位符而不是函数），
 * 所以两个渲染器拿到的结构保证完全一致。对象键序即源码里的书写序，Node 保证稳定。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COPY } from "../src/copy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_FILE = path.join(ROOT, "src", "copy.js");
const OUT_FILE = path.join(ROOT, "public", "copy.js");

/**
 * 拼出产物全文。抽成函数是为了让 check-copy.mjs 能**复用同一段拼接逻辑**——
 * 两边各拼一次的话，拼法迟早分叉，而分叉的后果是门禁拿着错误的期望值说「一致」。
 *
 * @param {unknown} copy
 * @returns {string} 产物全文，恒以单个 \n 结尾
 */
export function renderCopyModule(copy) {
  return (
    "/** 本文件由 `npm run build:copy` 从 src/copy.js 生成，请勿手改。\n" +
    " *  手改它会和源文件漂移，而漂移的两份是同一个东西的两种措辞——\n" +
    " *  scripts/check-copy.mjs 会发现并让 `npm run check` 退出非 0。 */\n" +
    "window.COPY = " +
    JSON.stringify(copy, null, 2) +
    ";\n"
  );
}

/** 写盘。UTF-8 无 BOM，LF。 */
export function buildCopy({ outFile = OUT_FILE, copy = COPY } = {}) {
  const text = renderCopyModule(copy);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // 逐字节覆盖写：同源同内容时连 mtime 都不该变，"重新生成"不该在 git 里留下痕迹
  fs.writeFileSync(outFile, text, "utf8");
  return { outFile, bytes: Buffer.byteLength(text, "utf8") };
}

/* 直接当脚本跑时才写盘。被 import 时（check-copy / 测试）只提供函数。 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outFile, bytes } = buildCopy();
  console.log(`[build-copy] 已生成 ${path.relative(ROOT, outFile)}（${bytes} 字节，源 ${path.relative(ROOT, SRC_FILE)}）`);
}
