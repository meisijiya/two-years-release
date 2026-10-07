/**
 * 测试口令的 preload —— **在 app.js 之前**给 process.env 赋值。
 *
 * ── 为什么必须是独立文件 ─────────────────────────────────────────────
 * `src/auth.js` 的 `BIRTH_YEAR` 在**模块顶层**求值（`const BIRTH_YEAR = ...`），
 * 而 ESM 的所有 import 都在当前模块的顶层代码**之前**执行。
 * 于是写在 test/helpers.js 里再晚也来不及：
 *
 *   import { openDb } from "../src/db.js";   ← 这一行就已经把 auth.js 拉进来了
 *   useTestSecrets();                        ← 注入发生在这之后，太晚
 *
 * 早先 `BIRTH_YEAR` 有一个 `|| "2004"` 兜底，正是这个顺序问题的**症状**：
 * 兜底让「注入来不及」这件事在测试里永远不显形，于是默认值就一直留在源码里。
 * 把兜底去掉之后，它立刻现形了 —— **这条约束是这条门禁发现的，不是读代码看出来的。**
 *
 * 所以注入必须用 `node --import`（或 `--env-file`）：它在**任何**应用模块之前跑。
 * npm scripts 里那几个 `node --test` 都加了 --import。
 *
 * ── 值从哪来 ─────────────────────────────────────────────────────────
 * 这里是**人造测试值**，不是任何真人的生日。真实值在服务器
 * /etc/two-years/two-years.env（0600 root，不在仓库里）。
 * 形状（4 位/8 位数字）与真值一致是有意的：测试要覆盖 birthdayForms
 * 的两种形态与容错分支，用一个明显不同的值就测不到了。
 */

// 与 test/helpers.js 的 TEST_SECRET 保持一致；两处都改，否则登录会 401。
const SECRETS = {
  DOOR_PASSWORD: process.env.DOOR_PASSWORD_TEST || "00010101",
  HERO_PASSWORD: process.env.HERO_PASSWORD_TEST || "00020202",
  OBSERVER_PASSWORD: process.env.OBSERVER_PASSWORD_TEST || "00030303",
  BIRTH_YEAR: process.env.BIRTH_YEAR_TEST || "2004",
};

// 不覆盖外部已给的值：check-boot 起 server.js 子进程时自己会传，
// 那条路径要验的是「生产入口按注入的 env 起得来」，不能被这里顶掉。
for (const [k, v] of Object.entries(SECRETS)) {
  if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
}
