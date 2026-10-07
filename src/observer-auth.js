/**
 * 观察者凭据的**机制**。不含路由、不含 express、不碰 db。
 *
 * 拆出来是因为它有两个消费者：observe.js 的路由、routes.js 的取图鉴权。
 * 放一起会让 routes.js 反向依赖一个路由模块，或者让 observe.js 变成什么都干。
 *
 * ⚠️ 这是 CONSTRAINTS.md §2 的一次**显式降级**。理由与撤销方式写在 CONSTRAINTS.md §2b。
 *
 * 凭据是**无状态 HMAC**：没有会话行、没有撤销表。
 *   · 往 person / session 加行会连带影响 /api/wish 的 PERSONS.map、db.js 的 otherId()，
 *     以及把表数量钉死在 7 张的测试 —— 所以不加行。
 *   · 代价是**登出只是清 cookie**（服务端不记得发过什么），这对一个测试入口可接受。
 * 时间戳由调用方注入（与 createApp({ now }) 同源），本文件不碰 Date.now()。
 */
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 观察者的 cookie 名。与 sid 分开：动 sid 会波及两个人那条已经跑通的流程。 */
export const OBSERVER_COOKIE = "obs";

/** 凭据有效期。测试入口，短一点；长到够看完一遍，又不至于忘在浏览器里。 */
export const OBSERVER_TTL_MS = 12 * 3600 * 1000;

/**
 * PIN。**只有环境变量，没有缺省值。**
 *
 * ⚠️ 这里曾经是 `process.env.OBSERVER_PASSWORD || "<4位月日>"`，
 *    而那个缺省值与 `HERO_PASSWORD` 的缺省值**同值** —— 一把钥匙开两个门。
 *    更隐蔽的是：**deploy.sh 写的 env 里从来没有 `OBSERVER_PASSWORD` 这个键**
 *    （实测线上 /etc/two-years/two-years.env 只有 HOST/PORT/DATA_DIR/
 *    DOOR_PASSWORD/HERO_PASSWORD 五个），所以那句「部署时应当显式给」
 *    实际上从没被兑现过，线上一直在用缺省值。
 *
 * 现在缺省值没了：拿不到 PIN 就抛。
 * 判据是「观察者入口是一个**测试开关**」—— 它绕过时间锁、能一次读全双方内容，
 * 所以它的凭据不能是「万一没配就凑合用」的那种东西。
 *
 * 每次调用都重读 env 而不是模块加载时读一次：测试要在同一进程里改这个值。
 */
export function observerPin() {
  const raw = process.env.OBSERVER_PASSWORD;
  if (raw === undefined || String(raw).trim() === "") {
    throw new Error(
      "OBSERVER_PASSWORD 没有注入。观察者入口能一次读全双方内容且不受时间锁约束，" +
        "凭据不能有缺省 —— 拿不到就该拒绝服务，而不是用一个默认 PIN 开门。" +
        "真实值放 /etc/two-years/two-years.env（0600 root，不在仓库里）。" +
        "**注意：手工往那个文件加这一行不够 —— deploy.sh 每次部署会重写整个文件，" +
        "必须在 deploy.sh 的写入列表里补上 OBSERVER_PASSWORD。**" +
        "本地单测由 test/helpers.js 注入。",
    );
  }
  return String(raw).trim();
}

/* ------------------------------------------------------------------ *
 * 签名密钥
 * ------------------------------------------------------------------ */

/**
 * 密钥落在数据目录里，进程重启后不变 —— 否则每次部署观察者都被登出。
 *
 * **不**放 person 表（会动表）、**不**放 env 文件：env 是 root-only 600，
 * 放进去就得 root 才能改，而这是个测试开关，调起来会很难受。
 * 首次使用时生成，权限 600。
 *
 * ⚠️ 「读不到」与「不存在」必须**分开**。
 *    早先这里是个光秃秃的 try/catch：读失败一律当成「还没有，建一把」。
 *    权限不对（EACCES）时它会走到建新密钥那一步 —— 要是那步还写得进去，
 *    就是一个**没人察觉的密钥轮换**：所有已发出的观察者凭据当场失效，
 *    而日志里什么异常都没有。权限不对时它写不进去，于是变成一句
 *    「EACCES: open .observer-key」，报在**启动**上，报在**部署的人**头上 ——
 *    实测就是这样把生产弄停的。
 *    所以只有 ENOENT 走「新建」，其余错误原样抛，并说清楚是哪一种。
 */
function loadKey(dataDir) {
  const file = path.join(dataDir, ".observer-key");
  let buf = null;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw new Error(
        `读不到观察者签名密钥 ${file}（${err?.code || err}）。` +
          `这**不是**「还没有」—— 别去删它重建：` +
          `重建会换一把密钥，把所有已发出的观察者凭据全部作废。` +
          `多半是属主不对（服务以 two-years 跑，文件却是 root:root 600，` +
          `早先有一次门禁是以 root 跑完的）。修法：chown two-years:two-years ${file}`,
      );
    }
  }
  if (buf && buf.length >= 32) return buf;
  if (buf && buf.length < 32) {
    throw new Error(`观察者签名密钥 ${file} 只有 ${buf.length} 字节（应当 ≥32），已损坏。删掉它会换新密钥，需要你确认后手动处理。`);
  }

  const key = randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上没有 chmod 语义，忽略 */
  }
  return key;
}

/** token = v1.<过期时刻>.<hmac> */
function sign(key, expiresAt) {
  const body = `v1.${expiresAt}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function verify(key, token, now) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || now() >= expiresAt) return false;
  const expected = createHmac("sha256", key).update(`v1.${expiresAt}`).digest("base64url");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parts[2], "utf8");
  // 长度不等时 timingSafeEqual 会抛，那本身就是「不通过」
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 剥掉非数字再比：与另外两个登录同一个容错口径（CONSTRAINTS §3）。 */
export function pinMatches(input, want = observerPin()) {
  const raw = String(input ?? "").replace(/\D/g, "");
  const target = String(want ?? "").replace(/\D/g, "");
  if (!raw || !target) return false;
  const a = Buffer.from(raw, "utf8");
  const b = Buffer.from(target, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header, name) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * 观察者的鉴权句柄。routes.js 的取图与 observe.js 的路由共用同一个实例，
 * 所以「谁在这次请求里是观察者」只有一个判定入口。
 *
 * @param {{dataDir: string, now?: () => number, isSecure?: (req: any) => boolean}} opts
 */
export function createObserverAuth({ dataDir, now = Date.now, isSecure = () => false }) {
  const key = loadKey(dataDir);

  return {
    /** 从请求里解出凭据并验签。无凭据 / 伪造 / 过期 / 改一位 —— 一律 false。 */
    fromRequest(req) {
      return verify(key, readCookie(req?.headers?.cookie, OBSERVER_COOKIE), now);
    },

    /** 签发一条新凭据（登录成功时用） */
    issue() {
      return sign(key, now() + OBSERVER_TTL_MS);
    },

    /** 写 cookie。Secure 按**实际连接协议**决定，不能写死（见 auth.js 的 isSecureRequest 注释）。 */
    setCookie(res, req, token) {
      res.append(
        "Set-Cookie",
        `${OBSERVER_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/` +
          (isSecure(req) ? "; Secure" : ""),
      );
    },

    /** 清 cookie。无状态凭据没法真的撤销，这一刀只保证浏览器不再带它。 */
    clearCookie(res, req) {
      res.append(
        "Set-Cookie",
        `${OBSERVER_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` +
          (isSecure(req) ? "; Secure" : ""),
      );
    },
  };
}
