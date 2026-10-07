/**
 * 子进程假时钟引导模块（只用 `node --import` 加载）。
 *
 * 为什么不给生产脚本加 `EXPORT_NOW` 之类的环境变量开关：
 * 那等于给时间锁开一个后门——任何人 `EXPORT_NOW=1791129600000 node scripts/export-standalone.mjs`
 * 就能在 10-5 之前导出一份完整、不可撤回的内容。开关是**长期留在代码里的攻击面**，
 * 而假时钟只活在测试进程里，退出即消失。
 *
 * 用法：`node --import ./test/fake-clock.mjs <主脚本>`，配合环境变量 `FAKE_NOW`（epoch ms）。
 * 不设 `FAKE_NOW` 时本模块什么都不做——子进程读真实时钟。
 *
 * 改的是**子进程的时钟**，不碰 `src/clock.js`、不碰任何判定路径。
 */
const raw = process.env.FAKE_NOW;
if (raw !== undefined && raw !== "") {
  const fixed = Number(raw);
  if (!Number.isFinite(fixed)) throw new Error(`FAKE_NOW 不是合法的 epoch 毫秒：${raw}`);

  const RealDate = globalThis.Date;
  // 同时接管 `Date.now()` 与 `new Date()`：
  // 只改前者的话，将来有人在脚本里写 `new Date()` 会静默读回真实时间，
  // 于是「假时钟失效」表现为一整套测试仍然全绿。
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate;
}
