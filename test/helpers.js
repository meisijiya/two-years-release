/**
 * 缝一（主）：真 Express + 真 SQLite（临时文件库）+ 可注入时钟 + 真 HTTP 监听 + 真 cookie。
 *
 * 为什么在 HTTP 这一层开缝：产品的核心承诺「10-5 前读不到她写的东西」只在
 * 路由 + 会话 + 鉴权这一层才真正成立；只测服务层会漏掉静态目录泄露、
 * cookie 属性、路由鉴权这些只在 HTTP 层暴露的问题。
 */

/**
 * ⚠️ 这个 import 必须在**给 env 赋值之前**求值，但它一定会先跑完 ——
 *    ESM 的 import 没有「先设变量再加载依赖」的写法（`require` 有，ESM 没有）。
 *    所以这里的顺序是个真问题，见下面 useTestSecrets() 的说明。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";

/**
 * 测试用的口令。**这不是生产值** —— 生产的 DOOR_PASSWORD / HERO_PASSWORD
 * 放在服务器 /etc/two-years/two-years.env（0600 root，不在仓库里）。
 *
 * 以前它们与源码里的缺省值逐字相同，于是「改掉源码里的值」这件事对测试
 * 完全不可见 —— 真实口令从来没有真正离开过版本库。抽离之后，两边彻底分开：
 * 仓库里只有测试值，真实值只在线上。
 *
 * 形状保持一致（4 位月日 / 8 位完整生日）是有意的：测试要覆盖
 * `birthdayForms` 的两种形态与容错分支，用一个明显不同的值就测不到了。
 * 但它**不应该是任何真人的生日** —— 下面加了断言守住这条。
 */
export const TEST_SECRET = {
  DOOR_PASSWORD: process.env.DOOR_PASSWORD_TEST || "00010101",
  HERO_PASSWORD: process.env.HERO_PASSWORD_TEST || "00020202",
  OBSERVER_PASSWORD: process.env.OBSERVER_PASSWORD_TEST || "00030303",
  BIRTH_YEAR: "2004",
};

/**
 * 拦住「把真生日当测试口令」。
 *
 * ⚠️ 这个黑名单**不能硬编码真实值** —— 早先它把四个真实生日字面量直接写进
 *    `new Set([...])`，而那正是它要防的值：一道为了「别把真口令留在仓库里」
 *    的守卫，自己把真口令写进了仓库。secrets 门禁解除 src/ test/ 豁免后
 *    立刻把它报了出来（连注释里举例的那一行也照报）。
 *
 * 现在从**环境变量**派生：想在本地跑「真值不许当测试值」这条断言时，
 * 把真值经 `REAL_DOOR_PASSWORD=… npm test` 传进来即可，仓库里一个字都不留。
 * 没传就退化成「测试值必须是 8 位人造数字」这条仍然有效的弱判据。
 */
const REAL_VALUES = new Set(
  [process.env.REAL_DOOR_PASSWORD, process.env.REAL_HERO_PASSWORD, process.env.REAL_OBSERVER_PASSWORD]
    .map((v) => String(v || "").replace(/\D/g, ""))
    .filter(Boolean),
);
for (const [k, v] of Object.entries(TEST_SECRET)) {
  const digits = String(v).replace(/\D/g, "");
  if (REAL_VALUES.has(digits) || REAL_VALUES.has(digits.slice(4))) {
    throw new Error(
      `test/helpers.js 的 ${k} 用了真实生日当测试口令。` +
        `测试值必须是明显不同的人造值 —— 否则真实口令又回到版本库里了，` +
        `而这次抽离的全部意义就是让它离开。` +
        `（真值经 REAL_DOOR_PASSWORD / REAL_HERO_PASSWORD / REAL_OBSERVER_PASSWORD 传入才启用这条断言）`,
    );
  }
}

/**
 * 把测试口令注入 process.env。**必须在第一次 createApp 之前调用**。
 *
 * 为什么需要这个函数：`src/auth.js` 的 `BIRTH_YEAR` 在**模块顶层**读 env，
 * `ensureCredentials` 在 `createApp` 里被调到。所以注入必须早于建 app。
 * 本文件是所有 HTTP 测试的共同入口，注入点收在这里，而不是散在 10 个
 * 测试文件里各写一遍 —— 后者的形状是「漏一个文件，那一个文件就红」，
 * 而红的理由（拿不到口令）离真正的原因（谁该注入）很远。
 */
export function useTestSecrets(extra = {}) {
  for (const [k, v] of Object.entries({ ...TEST_SECRET, ...extra })) {
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
}

/**
 * 开门前 1 秒 / 开门瞬间：时区边界断言的固定取样点。
 *
 * **写死绝对 epoch，不从 `UNLOCK_AT` 推导。**
 * 推导出来的取样点会让断言自指：把开门时刻改成 `new Date("2026-10-05")`
 * （即提前 8 小时开门）时，取样点跟着一起漂，整套时间锁测试照样全绿——
 * 断言的是「在它自己声称的开门时刻前后 1 秒」，而不是「在真实的那个时刻前后」。
 *
 * 1791129600000 = 2026-10-05T00:00:00+08:00
 */
export const AT_UNLOCK = 1791129600000;
export const JUST_BEFORE = AT_UNLOCK - 1000;

/** 起测试服务器。**默认先注入测试口令** —— 忘了注入会当场抛，而不是 401 到看不懂。 */
export async function startTestServer({
  now = () => JUST_BEFORE,
  bindHost = "127.0.0.1",
  secrets,
} = {}) {
  useTestSecrets(secrets);
  const dir = mkdtempSync(path.join(tmpdir(), "two-years-test-"));
  const dbFile = path.join(dir, "test.db");
  const photosDir = path.join(dir, "photos");
  const db = openDb(dbFile);
  let clock = now;
  // bindHost 一路传进 createApp：它决定采不采信 X-Forwarded-For。
  // 测试服务器实际只绑 127.0.0.1，但这里可以**声明**成非回环，
  // 用来验证「非回环时不采信 XFF」那条分支（见 ticket-02 的伪造 XFF 用例）。
  // dataDir 必须传：观察者的签名密钥落在它里面（observer-auth.js），
  // 不传就落到仓库的 data/ 下 —— 测试之间共用一把密钥，且污染工作区。
  const app = createApp({ db, now: () => clock(), bindHost, dataDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    app,
    db,
    dbFile,
    photosDir,
    dir,
    setNow(t) {
      clock = () => t;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          try {
            db.close();
          } catch {}
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      });
    },
  };
}

/** 带 cookie 的 HTTP 客户端。手动管 cookie，因为 node 的 fetch 没有 cookie jar。
 *
 *  同时收两个人的 cookie：`sid`（会话）与 `obs`（观察者）。它们**互不覆盖** ——
 *  前者只认 `sid=`，后者只认 `obs=`。写成「认任意一种」会让一条用例
 *  悄悄用着上一个人的会话还全绿。
 */
export function client(base) {
  const jar = { sid: "", obs: "" };
  const TRACKED = ["sid", "obs"];
  async function req(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    const held = TRACKED.map((k) => (jar[k] ? `${k}=${jar[k]}` : "")).filter(Boolean);
    if (held.length) headers.cookie = held.join("; ");
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(base + pathname, { ...options, headers, redirect: "manual" });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(";")[0];
      for (const k of TRACKED) {
        if (pair.startsWith(`${k}=`)) jar[k] = pair.slice(k.length + 1);
      }
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      headers: res.headers,
      setCookie,
      body: json,
      text,
    };
  }
  return {
    req,
    get: (p, o) => req(p, { ...o, method: "GET" }),
    post: (p, body, o) => req(p, { ...o, method: "POST", body: JSON.stringify(body) }),
    patch: (p, body, o) => req(p, { ...o, method: "PATCH", body: JSON.stringify(body) }),
    del: (p, o) => req(p, { ...o, method: "DELETE" }),
    raw: (p, o) => req(p, o),
    setCookie: (c) => {
      const i = c.indexOf("=");
      const k = c.slice(0, i);
      jar[k] = c.slice(i + 1);
    },
    clearCookie: () => {
      jar.sid = "";
      jar.obs = "";
    },
    get cookie() {
      return TRACKED.map((k) => (jar[k] ? `${k}=${jar[k]}` : ""))
        .filter(Boolean)
        .join("; ");
    },
  };
}
