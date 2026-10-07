/**
 * 线上冒烟：打**真实公网域名**（走 nginx + HTTPS + 正式 systemd 实例），
 * 验那些只在真实部署形态下才成立的东西。
 *
 * 与 check.mjs 的分工：check.mjs / browser.mjs 验业务逻辑（对端视角对不对），
 * 这里验**链路**——TLS、Secure cookie、HTTP→HTTPS 跳转、时间锁在真实域名上关着、
 * 猜照片目录返 404、以及公网压根连不到应用进程。
 *
 * 这一层本地跑没有意义：本地没有 nginx、没有证书、没有 X-Forwarded-Proto。
 *
 *   node scripts/e2e/online-smoke.mjs
 *   node scripts/e2e/online-smoke.mjs --report=docs/evidence/online-smoke.json
 *   BASE=https://example.com DOOR_PASSWORD=… HERO_PASSWORD=… node scripts/e2e/online-smoke.mjs
 *
 * ⚠️ BASE 与口令都**只从环境变量读，仓库里不留**。
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE;
const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass: !!pass, detail }); };

/**
 * 🔴 真实口令**从环境变量读，仓库里不留**。
 *
 * 这个脚本打的是**真实公网域名**，登录的是**生产实例**，所以它需要真值。
 * 但真值在仓库里就是公开的（哪怕私有仓库）—— 本仓已把真实生日从
 * `src/` 与 `test/` 全部抽离，这个文件是最后一个需要它的地方，
 * 同样不该例外。
 *
 * 以前这里是写死的生日字面量。改法不是「换个占位符」（那会让线上冒烟
 * 永远登录失败，而失败原因还很难看出来），而是**显式要求注入**：
 *
 *   DOOR_PASSWORD=… HERO_PASSWORD=… node scripts/e2e/online-smoke.mjs
 *
 * ⚠️ 跑线上冒烟时**务必确认口令正确**：登录连错 5 次会触发限流，
 * 而限流表是两个人**共用**的 —— 会把两个人的账号一起锁 10 分钟。
 */
const DOOR_PASSWORD = process.env.DOOR_PASSWORD;
const HERO_PASSWORD = process.env.HERO_PASSWORD;
const OBSERVER_PASSWORD = process.env.OBSERVER_PASSWORD;

// ⚠️ BASE 同样**没有缺省值**。写死一个真实公网域名有两个问题：
// 一是那个域名跟着仓库走（哪怕私有仓库）；二是它会**静默地**把冒烟打到
// 那个站上 —— 忘配 BASE 或变量名写错，人不会发现自己正在测线上生产。
// 缺了就退出，并把怎么给写清楚。
if (!BASE) {
  console.error(
    "线上冒烟需要一个 BASE，但仓库里不留真实域名。\n" +
      "  BASE=https://<你的站点> node scripts/e2e/online-smoke.mjs\n" +
      "本地自测可以指向 http://127.0.0.1:<端口>，不需要公网。",
  );
  process.exit(1);
}

if (!DOOR_PASSWORD || !HERO_PASSWORD) {
  console.error(
    "线上冒烟需要真实口令，但仓库里不再保留它们（敏感值已抽离到配置）。\n" +
      "  DOOR_PASSWORD=<真实生日> HERO_PASSWORD=<真实生日> node scripts/e2e/online-smoke.mjs\n" +
      "真实值在服务器 /etc/two-years/two-years.env（0600 root，不在仓库里）。\n" +
      "⚠️ 确认口令正确再跑：连错 5 次会触发限流，两个人一起锁 10 分钟。",
  );
  process.exit(1);
}

const ROLES = [
  { who: "door", code: "【改这里：doorCode】", birthday: DOOR_PASSWORD },
  { who: "hero", code: "【改这里：heroCode】", birthday: HERO_PASSWORD },
];

async function main() {
  // 1. 开门状态：真实域名上时间锁必须是关的
  const st = await (await fetch(`${BASE}/api/status`)).json();
  ok("时间锁关着（unlocked=false）", st.unlocked === false, `unlocked=${st.unlocked}`);
  ok("开门时刻 epoch 正确", st.unlockAt === 1791129600000, `unlockAt=${st.unlockAt}`);
  ok("开门标签正确", st.unlockLabel === "2026-10-05T00:00:00+08:00", st.unlockLabel);

  // 2. 标题。HTML 源码里 & 写作 &amp;，浏览器读出来才是字面量 & ——
  //    拿源码去比字面量，比的是编码不是标题。
  const html = await (await fetch(`${BASE}/`)).text();
  const raw = /<title>([^<]*)<\/title>/.exec(html)?.[1] || "";
  const title = raw.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  ok("标题是「【改这里：doorCode】&【改这里：heroCode】の两周年」", title === "【改这里：doorCode】&【改这里：heroCode】の两周年", `源码="${raw}" 解码="${title}"`);

  // 3. HTTP → HTTPS 跳转
  const r = await fetch(BASE.replace(/^https:/, "http:") + "/api/status", { redirect: "manual" });
  ok("HTTP 301 跳 HTTPS", r.status === 301 || r.status === 308, `实际 ${r.status}`);
  ok("跳转目标是 https", (r.headers.get("location") || "").startsWith("https://"), r.headers.get("location") || "(无)");

  // 4. 两个人各自登录，cookie 必须带 Secure
  for (const role of ROLES) {
    const res = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: role.code, birthday: role.birthday }),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const sid = setCookie.find((c) => c.startsWith("sid=")) || "";
    ok(`${role.code} 登录成功`, res.status === 200, `status=${res.status}`);
    // 走 HTTPS 却没带 Secure：凭据下一次会在明文连接上重发一次
    ok(`${role.code} 的 cookie 带 Secure`, /;\s*Secure/i.test(sid), sid || "(没发 cookie)");
    ok(`${role.code} 的 cookie 没有正的 Max-Age`, !/Max-Age=[1-9]/.test(sid), sid || "(没发 cookie)");
    ok(`${role.code} 的 cookie 是 HttpOnly`, /;\s*HttpOnly/i.test(sid), sid || "(没发 cookie)");

    // 5. 锁着的时候，即便已登录，共同层/留言读接口一律 404。
    //    大小写变体一并断：nginx 的前缀 location 大小写敏感，`/API/SHARED`
    //    曾匹配不上而掉进 SPA 回落变成 200，应用里那道闸门压根没被走到。
    for (const p of ["/api/shared", "/api/wish", "/API/SHARED", "/Api/Shared", "/API/WISH"]) {
      const rr = await fetch(`${BASE}${p}`, { headers: { cookie: sid.split(";")[0] } });
      ok(`${role.code} 已登录但未解锁，${p} → 404`, rr.status === 404, `实际 ${rr.status}`);
    }

    // 5b. /api/entry **不在**闸门里，而且这是对的：她必须能提前把布置台摆好，
    //     10-5 当天才不用手忙脚乱（SPEC §四）。所以这里要断的不是「404」，
    //     而是「只回自己的」—— 回的是对方的就说明闸门漏了。
    const ent = await fetch(`${BASE}/api/entry`, { headers: { cookie: sid.split(";")[0] } });
    const entBody = await ent.json().catch(() => null);
    const list = Array.isArray(entBody) ? entBody : entBody?.entries || [];
    const foreign = list.filter((e) => e.author && e.author !== role.who);
    ok(`${role.code} 未解锁能布置自己的台（/api/entry 放行）`, ent.status === 200, `实际 ${ent.status}`);
    ok(`${role.code} 的 /api/entry 里没有对方的条目`, foreign.length === 0,
      `共 ${list.length} 条，其中 ${foreign.length} 条不是自己的`);

    // 6. /api/me 认得出是谁
    const me = await fetch(`${BASE}/api/me`, { headers: { cookie: sid.split(";")[0] } });
    const meBody = await me.json().catch(() => ({}));
    ok(`${role.code} 的 /api/me 认出自己`, me.status === 200 && meBody.id === role.who, JSON.stringify(meBody).slice(0, 120));
  }

  // 7. 公网连不到应用进程（回环绑定的实际效果）
  const host = new URL(BASE).hostname;
  try {
    const probe = await fetch(`http://${host}:8300/api/status`, { signal: AbortSignal.timeout(6000) });
    ok(`公网 ${host}:8300 连不上（应用只绑回环）`, false, `竟然连上了，status=${probe.status}`);
  } catch (e) {
    ok(`公网 ${host}:8300 连不上（应用只绑回环）`, true, e.name || e.message);
  }

  // 8. 照片目录不在静态根里（CONSTRAINTS §2：猜这些路径一律 404）
  for (const p of ["/photos/", "/photos", "/data/", "/data", "/uploads/", "/uploads", "/public/", "/public"]) {
    const rr = await fetch(`${BASE}${p}`, { redirect: "manual" });
    ok(`猜 ${p} → 404`, rr.status === 404, `实际 ${rr.status}`);
  }

  const pass = results.filter((x) => x.pass).length;
  for (const x of results) console.log(`${x.pass ? "OK  " : "FAIL"} ${x.name}${x.detail ? " — " + x.detail : ""}`);
  console.log(`\n线上冒烟：${pass}/${results.length} 通过`);

  // 留一份可复核的产物。聊天里说过的话会沉底，报告不会。
  const out = process.argv.find((a) => a.startsWith("--report="))?.slice("--report=".length);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        { base: BASE, total: results.length, pass, fail: results.length - pass, at: new Date().toISOString(), results },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`报告：${out}`);
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("冒烟脚本自身崩了：", e);
  process.exit(2);
});
