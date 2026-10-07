/**
 * 取文案的那**一个**函数。渲染代码只准通过 `cp()` 取用户可见的字符串。
 *
 * 为什么单独一个模块：键路径与占位符的填法在这里只写一遍，
 * scripts/check-copy.mjs 扫的就是 `cp("…")` 这种字面量键，两边不会各认一套。
 *
 * 为什么**不抛**：分工写在 src/copy.js 顶部——「键一定存在」由构建期的门禁保证
 * （scripts/check-copy.mjs 挂在 npm run check 上，缺一个键就退出非 0）。
 * 既然门禁已经兜住了，运行时再为「键缺失」抛异常就只剩一个作用：
 * 10-5 当天把某一处字取空，升级成整页白屏。降级可接受，白屏不可接受。
 * 所以这里返回空串，让那一处少几个字，别的照常显示。
 */
import { COPY } from "./copy.js";

/** 按点号路径取值。中间任一段不存在就返回 undefined（不抛）。 */
export function resolvePath(copy, path) {
  let node = copy;
  for (const seg of String(path).split(".")) {
    if (node === null || typeof node !== "object" || !(seg in node)) return undefined;
    node = node[seg];
  }
  return node;
}

/**
 * 填 `{name}` 占位符。
 * 没给值的占位符**填空串**而不是把花括号原样留在屏幕上——
 * 门禁会挡住漏传，但万一漏了，屏幕上出现一个「{days}」比少一个字更刺眼。
 */
export function fill(template, vars) {
  if (vars === undefined) return template;
  return String(template).replace(/\{(\w+)\}/g, (_m, key) =>
    vars[key] === undefined || vars[key] === null ? "" : String(vars[key]),
  );
}

/**
 * 取一条文案。
 *
 * @param {string} path 点号路径，如 "seal.tape.locked"
 * @param {Record<string, unknown>} [vars] 插值，键名对应值里的 `{name}`
 * @param {object} [copy] 数据源，仅测试注入用
 * @returns {string|unknown} 字符串 / 数组（wish.options 那种原样返回）；键不存在时返回 ""
 */
export function cp(path, vars, copy = COPY) {
  const v = resolvePath(copy, path);
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return v;
  return fill(v, vars);
}
