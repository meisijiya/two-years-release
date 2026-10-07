/**
 * 密码与会话。
 *
 * 密码 = 对方的生日，scrypt 加盐哈希。**库里只存哈希，不存明文生日**；
 * 4 位月日与 8 位完整生日两种形态各存一份哈希，登录时只做比对，不做补全猜测。
 *
 * 会话 token 32 字节随机、base64url，走 httpOnly cookie。同 IP 失败 5 次锁 10 分钟。
 *
 * 时间戳一律由调用方注入（跟 createApp({ now }) 同一个来源），本文件不碰 Date.now()。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt 参数：交互式登录的常用档位，够慢（爆破成本高），不至于卡住浏览器 */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

/** SPEC §三 安全约定：同 IP 失败 5 次锁 10 分钟 */
export const MAX_FAILS = 5;
export const LOCK_MS = 10 * 60 * 1000;

export const SESSION_COOKIE = "sid";

/**
/**
 * 生日来源：**只有环境变量**。
 *
 * ⚠️ 这里曾经是 `{ env: "DOOR_PASSWORD", fallback: "<4位月日>" }` ——
 *    真实口令焊在源码里，且 `||` 兜底让「环境没配也能用真实口令登录」成立。
 *    两个问题：① 值在版本库里（已轮换过 git 历史之外的一切公开面）；
 *    ② 结构上「不配置也能跑」，于是配置漏了没人发现 —— 直到线上才发现
 *    观察者 PIN 落回了缺省值（那个 PIN 与一方登录口令同值）。
 *
 * 现在**没有缺省值**：拿不到就抛，进程起不来。
 * 与 src/photos.js 的口径同一条 —— **宁可启动失败，也不能悄悄用一个人人都知道的值开门**。
 * 真实值放 /etc/two-years/two-years.env（0600 root，不入库），
 * 模板见 deploy/two-years.env.example（只有占位符，不是来源）。
 */
const SEEDS = {
  door: { env: "DOOR_PASSWORD", who: "【改这里：doorCode】" },
  hero: { env: "HERO_PASSWORD", who: "【改这里：heroCode】" },
};

/**
 * 补全 4 位月日用的出生年份。
 *
 * 从环境变量来，**没有缺省值** —— 它本身就是出生年份，与口令同属个人数据，
 * 不该焊在源码里。拿不到就抛，与口令同一条口径。
 *
 * ⚠️ 它只参与「4 位补成 8 位」的推导，**登录时不校验年份**（CONSTRAINTS §3），
 *    所以它错了不会让口令失效，但会让 8 位形态的口令对不上 —— 那正是
 *    「生日」这个产品定义在起作用。生产 env 里由 deploy.sh 显式写出。
 */
const BIRTH_YEAR = (() => {
  const raw = process.env.BIRTH_YEAR;
  if (raw === undefined || String(raw).trim() === "") {
    throw new Error(
      "BIRTH_YEAR 没有注入。它是出生年份（个人数据），只用于把 4 位月日补成 8 位。" +
        "生产 env 里由 deploy.sh 写出；本地单测由 test/helpers.js 的 TEST_SECRET 注入。",
    );
  }
  return String(raw).trim();
})();

/* ------------------------------------------------------------------ *
 * 密码：scrypt 加盐哈希
 * ------------------------------------------------------------------ */

function derive(secret, salt, opts) {
  return scryptSync(String(secret).normalize("NFKC"), salt, KEYLEN, opts);
}

/** 生成一条自描述的哈希串：scrypt$N$r$p$salt$hash，各段 base64url / 十进制 */
export function hashSecret(secret) {
  const salt = randomBytes(16);
  const key = derive(secret, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifySecret(encoded, secret) {
  if (typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64url");
  if (expected.length !== KEYLEN) return false;
  let actual;
  try {
    actual = derive(secret, Buffer.from(saltB64, "base64url"), { N: Number(N), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 从环境变量里的生日得到两种形态。补全只发生在这里，不在登录时。 */
function birthdayForms(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 8) return { short: digits.slice(4), full: digits };
  if (digits.length === 4) return { short: digits, full: BIRTH_YEAR + digits };
  return { short: digits, full: digits };
}

/**
 * 建库时把两位的密码哈希写进 person 表。
 *
 * pw4 / pw8 两列由 db.js 的 SCHEMA 建出来（工单 02 起加在 person 表里），
 * 这里只负责把环境变量算出的哈希写进去 —— 每次启动重算，
 * 等价于「环境变量是唯一的真相来源」，改密码不需要迁移。
 */
/**
 * 取出生日口令。**没有缺省值** —— 拿不到就抛，调用方让它一路冒到启动。
 *
 * 为什么不是「空口令」或「随便一个」：那等于把「忘记配置」变成一个
 * 可登录的固定串，而门禁恰恰是防这种的。启动失败是响的，猜得到是哑的。
 */
function passwordFromEnv(env, who) {
  const raw = process.env[env];
  if (raw === undefined || String(raw).trim() === "") {
    throw new Error(
      `${env} 没有注入（【改这里：doorCode】/【改这里：heroCode】的进门口令）。` +
        `真实值放 /etc/two-years/two-years.env（0600 root，不在仓库里），` +
        `模板见 deploy/two-years.env.example —— 模板不是来源。` +
        `本地单测由 test/helpers.js 注入。` +
        `${who} 这一侧拿不到口令就**不该起来**：宁可启动失败，也不能用一个人人都知道的值开门。`,
    );
  }
  return String(raw).trim();
}

export function ensureCredentials(db) {
  const upd = db.prepare("UPDATE person SET pw4 = ?, pw8 = ? WHERE id = ?");
  for (const [id, seed] of Object.entries(SEEDS)) {
    const { short, full } = birthdayForms(passwordFromEnv(seed.env, seed.who));
    upd.run(hashSecret(short), hashSecret(full), id);
  }
}

/**
 * 校验生日。输入已由调用方剥掉非数字；两种形态比对，任一命中即通过。
 * 不存明文、不补全、不做「是不是差几位」的猜测。
 */
export function checkPassword(db, personId, digits) {
  if (!digits) return false;
  const row = db.prepare("SELECT pw4, pw8 FROM person WHERE id = ?").get(personId);
  if (!row) return false;
  return verifySecret(row.pw4, digits) || verifySecret(row.pw8, digits);
}

/* ------------------------------------------------------------------ *
 * 会话
 * ------------------------------------------------------------------ */

/** 32 字节随机、base64url（43 字符，无 padding） */
export function createSession(db, personId, created) {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO session(token, person_id, created) VALUES(?,?,?)").run(token, personId, created);
  return token;
}

export function destroySession(db, token) {
  db.prepare("DELETE FROM session WHERE token = ?").run(token);
}

/** token 换身份；token 无效、被登出、已过期都返回 null */
export function personByToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      "SELECT p.id, p.code, p.role FROM session s JOIN person p ON p.id = s.person_id WHERE s.token = ?",
    )
    .get(token);
  return row ? { ...row } : null;
}

export function tokenFromCookie(header) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== SESSION_COOKIE) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {}
    return v || null;
  }
  return null;
}

/**
 * 这一条连接是**明文**还是加密。
 *
 * 应用只监听回环，浏览器直连的一定是 nginx（走 HTTPS），所以看 `X-Forwarded-Proto`；
 * 真的直连到 8300（本地调试、SSH 端口转发）时按明文算。
 *
 * ⚠️ **不要写成「总是加 Secure」**：裸 HTTP 的页面上浏览器会**直接拒收**标了 Secure 的
 * cookie（CONSTRAINTS §3 的原话），两个人当天都登不进去，礼物当场作废。
 * 反过来也一样 —— 走 HTTPS 却不加，凭据会在第一次跳转时以明文发一次。
 * 所以按连接协议决定，两边都对。
 *
 * @param {import("express").Request} req
 * @returns {boolean} 该不该加 Secure
 */
export function isSecureRequest(req) {
  const proto = req.get?.("x-forwarded-proto") || req.protocol || "";
  return String(proto).split(",")[0].trim().toLowerCase() === "https";
}

/** 契约冻结的 cookie 属性：HttpOnly + SameSite=Lax + Path=/；HTTPS 时额外加 Secure */
export function setSessionCookie(res, token, secure = false) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}`);
}

export function clearSessionCookie(res, secure = false) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
}

/* ------------------------------------------------------------------ *
 * 登录爆破锁定
 * ------------------------------------------------------------------ */

/**
 * 当前锁定状态。
 *
 * fails 有两种含义：从来没锁过 → 累计的猜测次数；锁窗已过 → 从头计数，
 * 否则一次错手会立刻再锁 10 分钟，用户永远走不出这个坑。
 * @returns {{locked: boolean, retryAfter: number, fails: number}}
 */
export function lockState(db, ip, now) {
  const row = db.prepare("SELECT fails, locked_until FROM login_fail WHERE ip = ?").get(ip);
  if (!row) return { locked: false, retryAfter: 0, fails: 0 };
  if (row.locked_until > now) {
    return { locked: true, retryAfter: Math.max(1, Math.ceil((row.locked_until - now) / 1000)), fails: row.fails };
  }
  const expired = row.locked_until > 0;
  return { locked: false, retryAfter: 0, fails: expired ? 0 : row.fails };
}

/** 记一次失败；到第 MAX_FAILS 次当场锁上 */
export function recordFailure(db, ip, now) {
  const state = lockState(db, ip, now);
  const next = state.fails + 1;
  const lockedUntil = next >= MAX_FAILS ? now + LOCK_MS : 0;
  db.prepare(
    `INSERT INTO login_fail(ip, fails, locked_until) VALUES(?,?,?)
     ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`,
  ).run(ip, next, lockedUntil);
  if (lockedUntil > now) {
    return { locked: true, retryAfter: Math.ceil((lockedUntil - now) / 1000), fails: next };
  }
  return { locked: false, retryAfter: 0, fails: next };
}

export function clearFailures(db, ip) {
  db.prepare("DELETE FROM login_fail WHERE ip = ?").run(ip);
}
