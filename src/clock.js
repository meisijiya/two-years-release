/**
 * 开门时刻 —— 整个应用唯一的时间真相。
 *
 * 硬编码为东八区 2026-10-05T00:00:00，不读设备时区、不读服务器时区。
 *
 * 两条禁止（design.md §八 硬约束 4）：
 *   ❌ new Date("2026-10-05")   —— 按 UTC 解析，会提前 8 小时开门
 *   ❌ getFullYear() / getMonth() / toLocaleString() —— 随设备时区漂移
 *   ✅ Date.UTC(2026,9,5,0,0,0) - 8*3600*1000
 */

/** 2026-10-05T00:00:00+08:00 对应的 epoch 毫秒 */
export const UNLOCK_AT = Date.UTC(2026, 9, 5, 0, 0, 0) - 8 * 3600 * 1000;

/** 开门时刻的人类可读形式，仅用于日志与断言消息，不参与判定 */
export const UNLOCK_LABEL = "2026-10-05T00:00:00+08:00";

/**
 * 是否已开门。
 * @param {number} now 当前时刻（epoch ms），由调用方注入，便于测试替换
 */
export function isUnlocked(now = Date.now()) {
  return now >= UNLOCK_AT;
}

/** 距开门还有多少毫秒，已开门返回 0 */
export function remainingMs(now = Date.now()) {
  return Math.max(0, UNLOCK_AT - now);
}

/** 倒计时分段，天/时/分/秒 */
export function countdown(now = Date.now()) {
  let s = Math.floor(remainingMs(now) / 1000);
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  const seconds = s - minutes * 60;
  return { days, hours, minutes, seconds };
}

/** 生产时钟。测试注入别的实现即可整条时间锁跟着变。 */
export const systemClock = () => Date.now();
