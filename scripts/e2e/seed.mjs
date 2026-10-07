/**
 * E2E 数据准备 —— 造一份**独立**的临时库，给双方各写带唯一标记的内容。
 *
 * 为什么用唯一标记：「解封后看到的是对方的东西」这句话，光靠「界面上有某句话」
 * 证明不了 —— 那句话在任何内容下都出现（这个项目栽过两次恒真断言）。
 * 必须用**只可能来自某一方的串**去点名：MK-door-xxxx 只可能出现在【改这里：doorCode】写的内容里。
 *
 * ⚠️ 刻意**走真实写入路径**（HTTP API + 生产 seed 脚本），不手写 SQL：
 * 手写 SQL 绕过了校验、ord 分配、照片压缩、鉴权，测出来的「通过」证明不了部署。
 * - 专属层（信/照片/约定）→ 真的 POST /api/entry、/api/upload、/api/wish
 * - 共同层（合照/祝福语）→ 真的跑 scripts/seed-shared.mjs，喂 MATERIAL_DIR
 *
 * 隔离：默认写到 %TEMP% 下的独立目录，**绝不碰 data/**。
 *
 *   node scripts/e2e/seed.mjs [--dir <路径>] [--photos 2] [--shots 3]
 *
 * 产出：<dir>/markers.json，断言脚本读它，不猜谁写了什么。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createApp } from "../../src/app.js";
import { openDb } from "../../src/db.js";
import { UNLOCK_AT } from "../../src/clock.js";
import { TEST_SECRET, useTestSecrets } from "../../test/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DIR = path.resolve(argOf("--dir", fs.mkdtempSync(path.join(os.tmpdir(), "two-years-e2e-"))));
const N_PHOTOS = Math.max(1, Number(argOf("--photos", 2)));
const N_SHOTS = Math.max(1, Number(argOf("--shots", 3)));
const DB_FILE = path.join(DIR, "two-years.db");
const PHOTOS_DIR = path.join(DIR, "photos");
const MATERIAL_DIR = path.join(DIR, "together");

/** SPEC §一：【改这里：doorCode】密码是【改这里：heroCode】的生日，【改这里：heroCode】密码是【改这里：doorCode】的生日。
 *  人造测试口令，不是真人生日；与下面 createApp 前注入的是同一批值。 */
const LOGIN = {
  door: { code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD },
  hero: { code: "【改这里：heroCode】", birthday: TEST_SECRET.HERO_PASSWORD },
};

const mark = (who) => `MK-${who}-${crypto.randomBytes(6).toString("hex")}`;

/** 真 JPEG（走 sharp 的编码），不是塞一串字节 —— 上传路径要过真实的解码与压缩 */
async function makeJpeg(label) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500">
       <rect width="1200" height="1500" fill="#efe4d4"/>
       <text x="600" y="770" font-size="64" text-anchor="middle" fill="#4a382a">${label}</text>
     </svg>`,
  );
  return sharp(svg).jpeg({ quality: 90 }).toBuffer();
}

/** 真实 HTTP 客户端：自带 cookie jar（会话就在 cookie 里，两个角色各一个 jar） */
function client(base, jar) {
  return async (method, url, body, headers = {}) => {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload = body;
    // FormData 必须原样发出：JSON.stringify 出来是 "{}", multipart 的 boundary 也没了。
    // 生产代码里 call() 对这一条有专门分支，这里照抄同一个判断。
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isForm && !h["content-type"]) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${url}`, { method, headers: h, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(";");
      const idx = kv.indexOf("=");
      const k = kv.slice(0, idx), v = kv.slice(idx + 1);
      if (v === "") jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 也如实返回 */ }
    return { status: res.status, text, json, headers: res.headers };
  };
}

const listen = (app) => new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });

const main = async () => {
  fs.mkdirSync(PHOTOS_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(PHOTOS_DIR, 0o700);

  const markers = { dir: DIR, db: DB_FILE, photos: PHOTOS_DIR, door: {}, hero: {}, shared: {} };
  const marks = { door: mark("door"), hero: mark("hero"), shared: mark("shared") };

  /* ---- 1. 共同层：素材目录 + 生产 seed 脚本 ---- */
  fs.mkdirSync(MATERIAL_DIR, { recursive: true });
  markers.shared.photoIds = [];
  for (let i = 0; i < N_SHOTS; i++) {
    const f = path.join(MATERIAL_DIR, `shot-${i + 1}.jpg`);
    fs.writeFileSync(f, await makeJpeg(`shared-${i + 1}`));
    markers.shared.photoIds.push(f);
  }
  markers.shared.blessing = `${marks.shared} 共同层的祝福语。`;
  fs.writeFileSync(path.join(MATERIAL_DIR, "blessing.txt"), markers.shared.blessing, "utf8");

  await new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "seed-shared.mjs")], {
      env: { ...process.env, DATA_DIR: DIR, MATERIAL_DIR },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`seed-shared 退出 ${c}: ${err}`))));
  });

  /* ---- 2. 起一个**已开门**的服务，用真实 API 写双方内容 ----
     写内容不需要开门，但用已开门的实例顺带证明了 seed 出来的数据在开门态下读得到。
     出门时刻注入在 createApp 的 now 上，不是改系统时间、不是环境变量后门。 */
  // 口令必须在 createApp 之前注入：src/auth.js 与 src/observer-auth.js 没有缺省值了。
  useTestSecrets();
  const db = openDb(DB_FILE);
  const app = createApp({ db, now: () => UNLOCK_AT + 60_000, dataDir: path.dirname(DB_FILE) });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const who of ["door", "hero"]) {
      const jar = new Map();
      const call = client(base, jar);
      const m = markers[who];

      const login = await call("POST", "/api/login", LOGIN[who]);
      if (login.status !== 200) throw new Error(`${who} 登录失败：${login.status} ${login.text}`);

      // 一封长信（第一条 = 阅读流的「一封信」）
      m.letterMark = mark(who);
      m.letter = `${m.letterMark} 这是${who === "door" ? "【改这里：doorCode】" : "【改这里：heroCode】"}写给对方的信。`.repeat(3);
      const r1 = await call("POST", "/api/entry", { kind: "text", body: m.letter });
      if (r1.status !== 201 && r1.status !== 200) throw new Error(`${who} 写留言失败：${r1.status} ${r1.text}`);

      // 照片：首张带配文、其余不带（测「没配文整块不渲染」）
      m.photoIds = [];
      for (let i = 0; i < N_PHOTOS; i++) {
        const buf = await makeJpeg(`${who}-photo-${i + 1}`);
        const fd = new FormData();
        fd.append("photo", new Blob([buf], { type: "image/jpeg" }), "p.jpg");
        const up = await call("POST", "/api/upload", fd);
        if (up.status !== 201 && up.status !== 200) throw new Error(`${who} 传照片失败：${up.status} ${up.text}`);
        const pid = up.json?.entry?.photo?.id;
        if (!pid) throw new Error(`${who} 上传回包里没有 photo.id：${up.text}`);
        m.photoIds.push(pid);
        if (i === 0) {
          m.capMark = mark(who);
          m.caption = `${m.capMark} 给这张照片写的配文。`;
          const p = await call("PATCH", `/api/entry/${encodeURIComponent(up.json.entry.id)}`, { body: m.caption });
          if (p.status !== 200) throw new Error(`${who} 写配文失败：${p.status} ${p.text}`);
        }
      }

      // 最后一段话（最后一条留言 = 阅读流的「最后」）
      m.tailMark = mark(who);
      m.tail = `${m.tailMark} 这是最后一段话。`;
      const r2 = await call("POST", "/api/entry", { kind: "text", body: m.tail });
      if (r2.status !== 201 && r2.status !== 200) throw new Error(`${who} 写最后一段失败：${r2.status} ${r2.text}`);

      // 约定
      m.wishMark = mark(who);
      m.wish = `${m.wishMark} ${who === "door" ? "【改这里：doorCode】" : "【改这里：heroCode】"}折的约定。`;
      const r3 = await call("POST", "/api/wish", { text: m.wish });
      if (r3.status !== 200 && r3.status !== 201) throw new Error(`${who} 折约定失败：${r3.status} ${r3.text}`);
    }

    /* ---- 3. 记下「谁看到了什么」的权威答案：直接从库里读，不靠我们以为 ---- */
    const rows = db.prepare("SELECT id, owner, kind, body FROM entry WHERE deleted IS NULL ORDER BY ord, created, id").all();
    for (const who of ["door", "hero"]) {
      markers[who].entryIds = rows.filter((r) => r.owner === who).map((r) => r.id);
      const photos = db.prepare("SELECT p.id AS photoId, p.entry_id AS entryId FROM photo p JOIN entry e ON e.id = p.entry_id WHERE e.owner = ? AND e.deleted IS NULL ORDER BY p.id").all(who);
      markers[who].photoIdToEntry = Object.fromEntries(photos.map((p) => [p.photoId, p.entryId]));
    }
    markers.shared.days = db.prepare("SELECT body FROM shared WHERE kind = 'blessing'").get() ? true : false;
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }

  fs.writeFileSync(path.join(DIR, "markers.json"), JSON.stringify(markers, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, dir: DIR, markers: path.join(DIR, "markers.json") }, null, 2));
};

main().catch((e) => { console.error("[e2e-seed] 失败：", e); process.exit(1); });
