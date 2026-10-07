/**
 * 工单 03 · 时间锁·文件层 —— 后端线。
 *
 * 全部从外部可观察：HTTP 状态码、响应体、响应头、磁盘上的文件字节、数据库里真实的行。
 * 不断言内部函数被调用了几次，不断言模块结构，不碰 public/（前端线独占）。
 *
 * 时间戳断言全部打在注入的时钟上：created 必须是注入值，真实 Date.now()
 * 一旦混进业务代码，这里立刻红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { startTestServer, client, JUST_BEFORE, AT_UNLOCK, TEST_SECRET } from "./helpers.js";
import { createApp, ROOT } from "../src/app.js";
import { openDb } from "../src/db.js";
import { MAX_UPLOAD_BYTES } from "../src/photos.js";

/** SPEC §一：【改这里：doorCode】用【改这里：heroCode】的生日进门，【改这里：heroCode】用【改这里：doorCode】的生日进门 */
const DOOR = { code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD };
const HERO = { code: "【改这里：heroCode】", birthday: TEST_SECRET.HERO_PASSWORD };

/** SPEC §四 图片处理：服务端兜底的硬指标，写死在这里而不是从实现里 import */
const MAX_EDGE = 1600;
const MAX_BYTES = 300 * 1024;

const PUBLIC_DIR = path.join(ROOT, "public");

/* ------------------------------ 测试素材 ------------------------------ */

/** 小图：绝大多数测试用它，快 */
const SMALL = await sharp({
  create: { width: 120, height: 90, channels: 3, background: { r: 200, g: 120, b: 90 } },
})
  .jpeg({ quality: 90 })
  .toBuffer();

/**
 * 大图：3000×2000 纯噪声，q95 下有好几 MB。
 *
 * 噪声是刻意的：渐变与实心色压几下就掉到几十 KB，兜底压缩就测不出「降质」这一段了。
 * 噪声在长边 1600 / q80 下仍在 700KB 量级，必须真的走降质阶梯才收得进 300KB。
 */
const BIG = await sharp(randomBytes(3000 * 2000 * 3), { raw: { width: 3000, height: 2000, channels: 3 } })
  .jpeg({ quality: 95 })
  .toBuffer();

/* ------------------------------ 小工具 ------------------------------ */

async function login(base, who) {
  const c = client(base);
  const res = await c.post("/api/login", { code: who.code, birthday: who.birthday });
  assert.equal(res.status, 200, `${who.code} 应当进得门：${res.text}`);
  return c;
}

/** 手搓 multipart：字段名固定 photo，契约要求的 */
function multipart(data, opts = {}) {
  const boundary = "----t03" + randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${opts.field ?? "photo"}"; ` +
      `filename="${opts.filename ?? "photo.jpg"}"\r\n` +
      `Content-Type: ${opts.type ?? "image/jpeg"}\r\n\r\n`,
    "utf8",
  );
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  return {
    body: Buffer.concat([head, body, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(c, data, opts = {}) {
  const { body, contentType } = multipart(data, opts);
  return c.raw("/api/upload", { method: "POST", body, headers: { "content-type": contentType } });
}

/** 取二进制：client() 只留 text，图片断言要字节 */
async function fetchBytes(base, cookie, p) {
  const res = await fetch(base + p, { headers: { cookie } });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** 照片在盘上的位置。文件名就是随机 id，与库里的 photo.id 一一对应 */
const fileOf = (s, photoId) => path.join(s.photosDir, `${photoId}.jpg`);

/** 另开一个连接直查同一个 SQLite 文件：绕开进程内那个句柄，看到的就是磁盘上的库 */
function queryDirect(dbFile, sql, ...args) {
  const direct = new DatabaseSync(dbFile);
  try {
    return direct.prepare(sql).get(...args);
  } finally {
    direct.close();
  }
}

/* ====================================================================== *
 * 1. 未解锁时上传自己的照片成功 —— 她必须能提前布置
 * ====================================================================== */

test("未解锁时她能上传自己的照片，并立刻在布置台上看到", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  const up = await upload(a, SMALL);
  assert.equal(up.status, 201, `未解锁时上传必须成功：${up.text}`);

  // 契约形状逐字对齐：id / kind / body / ord / created / photo{id,mime,w,h}
  assert.deepEqual(up.body.entry, {
    id: up.body.entry.id,
    kind: "photo",
    body: null,
    ord: 1,
    created: JUST_BEFORE, // 注入的时钟，不是 Date.now()
    photo: { id: up.body.entry.photo.id, mime: "image/jpeg", w: 120, h: 90 },
  });
  // 响应里不带任何文件名或路径：那是给「猜路径」留的线头
  assert.equal(/file|path|dir|name/i.test(JSON.stringify(up.body)), false, "上传响应不许泄露路径");

  const list = await a.get("/api/entry");
  assert.equal(list.status, 200);
  assert.equal(list.body.mine.length, 1, "她自己的条目必须立刻可见");
  assert.equal(list.body.mine[0].photo.id, up.body.entry.photo.id);
  assert.deepEqual(list.body.theirs, [], "未解锁时对方的东西不该出现在任何响应里");
});

/* ====================================================================== *
 * 2. 缝二：数据确实在库里、确实在磁盘上，而对方的响应里没有它
 * ====================================================================== */

test("缝二：照片确实在库里在盘上，而对方在同一时刻拿到 404", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  const up = await upload(a, SMALL);
  assert.equal(up.status, 201, `上传必须成功：${up.text}`);
  const entryId = up.body.entry.id;
  const photoId = up.body.entry.photo.id;

  // ---- 直查同一个 SQLite 文件：这两条断言是整条时间锁的地基 ----
  const entryRow = queryDirect(s.dbFile, "SELECT * FROM entry WHERE id = ?", entryId);
  assert.ok(entryRow, "entry 行必须真的在库里——否则下面的 404 只说明数据没写进去");
  assert.equal(entryRow.owner, "door");
  assert.equal(entryRow.kind, "photo");
  assert.equal(entryRow.deleted, null);

  const photoRow = queryDirect(s.dbFile, "SELECT * FROM photo WHERE id = ?", photoId);
  assert.ok(photoRow, "photo 行必须真的在库里");
  assert.equal(photoRow.entry_id, entryId);
  assert.equal(photoRow.mime, "image/jpeg");

  // ---- 确实在磁盘上，且库里的字节数与盘上的字节数对得上 ----
  const file = fileOf(s, photoId);
  assert.ok(fs.existsSync(file), `照片必须真的落盘：${file}`);
  assert.equal(fs.statSync(file).size, photoRow.bytes, "库里的 bytes 必须等于盘上的字节数");
  const onDisk = fs.readFileSync(file);

  // ---- 同一时刻，两个人的会话读同一张 ----
  const b = await login(s.base, HERO);
  assert.equal((await b.get("/api/me")).status, 200, "B 的会话是有效的——404 不是因为她没登录");

  const seenByB = await b.get(`/api/photo/${photoId}`);
  assert.equal(seenByB.status, 404, "未解锁时对方拿不到照片文件");

  const seenByA = await fetchBytes(s.base, a.cookie, `/api/photo/${photoId}`);
  assert.equal(seenByA.status, 200, "她自己任何时候都读得到");
  assert.equal(seenByA.headers.get("content-type"), "image/jpeg");
  assert.equal(seenByA.headers.get("cache-control"), "private, no-store");
  assert.equal(Buffer.compare(Buffer.from(seenByA.bytes), onDisk), 0, "响应字节必须就是盘上那份");

  // ---- 开门后同一张：B 读得到，证明上面那个 404 是门挡的，不是路由坏了 ----
  s.setNow(AT_UNLOCK);
  const opened = await b.get(`/api/photo/${photoId}`);
  assert.equal(opened.status, 200, "开门后对方必须读得到，否则 404 证明不了时间锁");
  assert.equal(opened.headers.get("content-type"), "image/jpeg");
});

/* ====================================================================== *
 * 3. 404 的三种情形必须无法互相区分
 * ====================================================================== */

test("未解锁 404 / 已解锁 200 / 不存在 404，外加未登录 401", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  const up = await upload(a, SMALL);
  const photoId = up.body.entry.photo.id;
  const b = await login(s.base, HERO);
  const stranger = client(s.base);

  s.setNow(JUST_BEFORE);
  const locked = await b.get(`/api/photo/${photoId}`);
  assert.equal(locked.status, 404, "未解锁时对方 404");

  const missing = await b.get(`/api/photo/p${"0".repeat(24)}`);
  assert.equal(missing.status, 404, "不存在的 id 也是 404");
  assert.equal(missing.text, locked.text, "两种 404 必须逐字相同：不能泄露「对方有这张照片」");
  assert.equal(missing.headers.get("content-type"), locked.headers.get("content-type"));
  assert.equal(missing.headers.get("cache-control"), locked.headers.get("cache-control"));

  // 各种畸形 id（含目录穿越）一律 404，不许碰到文件系统
  for (const id of [
    "..",
    "%2e%2e",
    `..%2F..%2Fdata%2Fphotos%2F${photoId}.jpg`,
    "../../etc/passwd",
    photoId.toUpperCase(),
    `${photoId}extra`,
    "",
  ]) {
    const r = await b.get(`/api/photo/${id}`);
    assert.equal(r.status, 404, `畸形 id ${JSON.stringify(id)} 必须是 404，实际 ${r.status}`);
    assert.equal(r.text, locked.text, `畸形 id ${JSON.stringify(id)} 的响应体与标准 404 必须相同`);
  }

  assert.equal((await stranger.get(`/api/photo/${photoId}`)).status, 401, "没登录不许读图");
  assert.equal((await stranger.post("/api/upload", {})).status, 401, "没登录不许传图");

  s.setNow(AT_UNLOCK);
  assert.equal((await b.get(`/api/photo/${photoId}`)).status, 200, "开门后同一张 200");
  assert.equal((await b.get(`/api/photo/p${"0".repeat(24)}`)).status, 404, "开门后不存在的仍是 404");
});

/* ====================================================================== *
 * 4. 没有第二条取图路径
 * ====================================================================== */

test("猜静态路径拿不到照片：连她自己也不行", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  const up = await upload(a, SMALL);
  const photoId = up.body.entry.photo.id;
  const file = fileOf(s, photoId);
  assert.ok(fs.existsSync(file), "先确认照片真的在盘上，否则下面全是空断言");

  const guesses = [
    `/photos/${photoId}.jpg`,
    `/data/photos/${photoId}.jpg`,
    `/uploads/${photoId}.jpg`,
    `/public/photos/${photoId}.jpg`,
    `/Photos/${photoId}.jpg`,
    `/DATA/PHOTOS/${photoId}.jpg`,
    `/Uploads/${photoId}.jpg`,
    `/static/photos/${photoId}.jpg`,
    `/api/photo/../photos/${photoId}.jpg`,
    `/api/photos/${photoId}.jpg`,
    `/api/upload/${photoId}.jpg`,
  ];
  for (const p of guesses) {
    const r = await a.get(p);
    assert.equal(r.status, 404, `${p} 必须是 404——照片只有 /api/photo/:id 一条路径`);
  }

  // 唯一那条路径是通的
  assert.equal((await a.get(`/api/photo/${photoId}`)).status, 200);

  // 照片目录不在静态目录下
  assert.ok(file.startsWith(s.photosDir + path.sep), "照片必须落在照片目录里");
  assert.equal(file.startsWith(PUBLIC_DIR + path.sep), false, "照片绝不能落在 public/ 下");
});

test("照片目录权限 700（win32 没有 POSIX 位，跳过）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  const up = await upload(a, SMALL);
  const file = fileOf(s, up.body.entry.photo.id);

  assert.ok(fs.existsSync(s.photosDir), "照片目录必须被建出来");
  if (process.platform === "win32") {
    t.diagnostic("win32 上没有 POSIX 权限位，700/600 断言跳过");
    return;
  }
  assert.equal(fs.statSync(s.photosDir).mode & 0o777, 0o700, "照片目录必须是 700");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "照片文件必须是 600");
});

/* ====================================================================== *
 * 5. 服务端兜底压缩真的发生
 * ====================================================================== */

test("兜底压缩真的发生：落盘的是长边 ≤1600 的 JPEG，且小于 300KB", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  // 先确认这张图确实超标：不然后面「压下去了」是空断言
  const bigMeta = await sharp(BIG).metadata();
  assert.equal(bigMeta.format, "jpeg");
  assert.equal(bigMeta.width, 3000, "素材本身长边 3000");
  assert.ok(BIG.length > MAX_BYTES, `素材本身必须超过 300KB，实际 ${BIG.length}`);

  const a = await login(s.base, DOOR);
  const up = await upload(a, BIG);
  assert.equal(up.status, 201, `大图必须收下：${up.text}`);

  const photoId = up.body.entry.photo.id;
  const file = fileOf(s, photoId);

  // 盘上的那份：格式、尺寸、体积都按 SPEC §四 判，不看库里怎么写
  const meta = await sharp(file).metadata();
  assert.equal(meta.format, "jpeg", "落盘必须是 JPEG");
  assert.ok(
    Math.max(meta.width, meta.height) <= MAX_EDGE,
    `长边必须 ≤1600，实际 ${meta.width}×${meta.height}`,
  );
  assert.ok(
    Math.min(meta.width, meta.height) > 0 && meta.width * meta.height < 3000 * 2000,
    "尺寸必须比原图小",
  );
  const bytes = fs.statSync(file).size;
  assert.ok(bytes < MAX_BYTES, `单张必须 <300KB，实际 ${bytes}`);

  // 库里的元数据与盘上那份一致
  const row = queryDirect(s.dbFile, "SELECT * FROM photo WHERE id = ?", photoId);
  assert.equal(row.bytes, bytes, "库里的 bytes 必须等于盘上的字节数");
  assert.equal(row.w, meta.width);
  assert.equal(row.h, meta.height);
  assert.equal(row.mime, "image/jpeg");

  // HTTP 交出去的也是压过的那份
  const got = await fetchBytes(s.base, a.cookie, `/api/photo/${photoId}`);
  assert.equal(got.status, 200);
  assert.equal(got.bytes.length, bytes, "响应体就是落盘那份，不是原图");
  assert.ok(got.bytes.length < BIG.length, "响应体必须比原图小");
});

/* ====================================================================== *
 * 6. 上传是不可信输入面
 * ====================================================================== */

test("非图片一律 400，且什么也不落地", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  const before = fs.readdirSync(s.photosDir).length;
  const bad = { error: "bad_request", hint: "只收图片" };

  // 改名成 .jpg 的文本：MIME 骗得过 fileFilter，骗不过解码
  const renamed = await upload(a, "这不是图片，这是一段文字。", { filename: "photo.jpg", type: "image/jpeg" });
  assert.equal(renamed.status, 400, "改名成 .jpg 的文本必须被拒");
  assert.deepEqual(renamed.body, bad, "响应体逐字对齐契约");

  // 老老实实说自己是文本
  const text = await upload(a, "hello", { filename: "note.txt", type: "text/plain" });
  assert.equal(text.status, 400, "text/plain 必须被拒");
  assert.deepEqual(text.body, bad);

  // 字段名不是 photo
  const wrongField = await upload(a, SMALL, { field: "file" });
  assert.equal(wrongField.status, 400, "字段名必须是 photo");

  // 空文件
  const empty = await upload(a, Buffer.alloc(0));
  assert.equal(empty.status, 400, "空文件不是图片");

  assert.equal(fs.readdirSync(s.photosDir).length, before, "被拒的上传不许在盘上留下任何文件");
  assert.equal(queryDirect(s.dbFile, "SELECT COUNT(*) AS n FROM entry").n, 0, "被拒的上传不许建行");
  assert.equal(queryDirect(s.dbFile, "SELECT COUNT(*) AS n FROM photo").n, 0, "被拒的上传不许建 photo 行");
});

test("超过原始体积上限一律 400", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  // 一张真图后面缀一大坨：过线的是体积，校验的仍是同一条规则
  const fat = Buffer.concat([SMALL, Buffer.alloc(MAX_UPLOAD_BYTES + 1024 * 1024)]);
  const r = await upload(a, fat);
  assert.equal(r.status, 400, `超过 ${MAX_UPLOAD_BYTES} 字节必须被拒，实际 ${r.status}`);
  assert.deepEqual(r.body, { error: "bad_request", hint: "只收图片" });
  assert.equal(queryDirect(s.dbFile, "SELECT COUNT(*) AS n FROM photo").n, 0, "超限不许建行");
});

/* ====================================================================== *
 * 7. 撤回是软删：列表消失，库里留痕
 * ====================================================================== */

test("撤回 = 硬删：行、photo 行、盘上文件一起没", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  const up = await upload(a, SMALL);
  const entryId = up.body.entry.id;
  const photoId = up.body.entry.photo.id;
  const file = fileOf(s, photoId);
  assert.ok(fs.existsSync(file), "前置：删之前文件确实在盘上");

  const del = await a.del(`/api/entry/${entryId}`);
  assert.equal(del.status, 204);

  const list = await a.get("/api/entry");
  assert.deepEqual(list.body.mine, [], "撤回后列表里必须消失");

  /* 这四条断言各自独立：任何一条改回软删就会红。
     写成「行还在但 deleted 有值」是不够的 —— 那种实现在界面上表现完全一样，
     只有「查不到」和「文件不在了」才区分得开硬删与软删。 */
  assert.equal(
    queryDirect(s.dbFile, "SELECT * FROM entry WHERE id = ?", entryId),
    undefined,
    "硬删：entry 行必须查不到（软删会留一行 deleted 非空）",
  );
  assert.equal(
    queryDirect(s.dbFile, "SELECT * FROM photo WHERE id = ?", photoId),
    undefined,
    "硬删：photo 行必须查不到",
  );
  assert.equal(fs.existsSync(file), false, "硬删：盘上那个压缩过的 JPEG 也要删掉");
  // 删掉之后连按 id 直接取图都取不到（原来那条路由还能凭 id 读出字节）
  assert.equal((await a.get(`/api/photo/${photoId}`)).status, 404, "撤回后自己也读不到了");
  assert.equal((await a.del(`/api/entry/${entryId}`)).status, 404, "同一条再删一次是 404，不是 204");
});

/* ====================================================================== *
 * 8. 给照片配一句话
 * ====================================================================== */

test("PATCH 给照片配一句话，走的是条目那套接口", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const a = await login(s.base, DOOR);
  const up = await upload(a, SMALL);
  const entryId = up.body.entry.id;
  const photoId = up.body.entry.photo.id;

  const patched = await a.patch(`/api/entry/${entryId}`, { body: "这是 2024 年冬天，你把围巾绕在我脖子上那天的早上" });
  assert.equal(patched.status, 200, `配文必须写得上：${patched.text}`);
  assert.equal(patched.body.entry.body, "这是 2024 年冬天，你把围巾绕在我脖子上那天的早上");
  assert.equal(patched.body.entry.photo.id, photoId, "配文不能把照片搞丢");

  const list = await a.get("/api/entry");
  assert.equal(list.body.mine[0].body, "这是 2024 年冬天，你把围巾绕在我脖子上那天的早上");
  assert.equal((await a.get(`/api/photo/${photoId}`)).status, 200, "写完配文照片照旧读得到");

  // 配文也走时间锁：未解锁时 B 读列表读不到它
  const b = await login(s.base, HERO);
  const seenByB = await b.get("/api/entry");
  assert.deepEqual(seenByB.body.theirs, [], "未解锁时对方的配文一个字都不许进响应");
  s.setNow(AT_UNLOCK);
  assert.equal((await b.get("/api/entry")).body.theirs[0].body, "这是 2024 年冬天，你把围巾绕在我脖子上那天的早上");
});

/* ====================================================================== *
 * 照片目录是软链接指向 public/ 时，服务必须拒绝启动
 *
 * 早先那道启动断言只做 path.resolve 的**字面**比较，而 express.static 走
 * fs.stat **会跟随链接**。于是「data/photos 是一个指向 public/evil 的链接」
 * 这形态在字面比较下完全看不出来，实测服务照常启动、照片从静态路 200 出字节——
 * 带有效会话、门没开也一样拿得到。CONSTRAINTS §2 写的「不满足直接起不来」
 * 在这种形态下是假的。
 * ====================================================================== */

/** 建一个目录链接。Windows 的 'junction' 不需要管理员权限；'dir' 通常需要。 */
function linkDir(target, linkPath) {
  for (const type of ["junction", "dir"]) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return type;
    } catch {
      /* 换下一种，两种都建不出来就是本机不允许 */
    }
  }
  return null;
}

test("照片目录是指向 public/ 的目录链接：服务拒绝启动（字面比较看不出来这种形态）", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "two-years-link-"));
  let db;
  t.after(() => {
    try {
      db?.close();
    } catch {}
    // 目录链接必须先摘掉再删目录：Windows 上 rmSync 顺着 junction 递归会 EPERM。
    // 摘链接用 unlink（删的是链接本身，不动它指的目标），所以 public/evil 是安全的。
    try {
      fs.unlinkSync(path.join(dataDir, "photos"));
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const publicDir = path.join(dir, "public");
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(path.join(publicDir, "evil"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const kind = linkDir(path.join(publicDir, "evil"), path.join(dataDir, "photos"));
  if (!kind) return t.skip(`本机建不出目录链接（${process.platform}），这条没验成`);

  // 对照前提：字面比较确实看不出来。少了这一行，这条测试可能在测一个
  // 「本来就被字面比较挡住」的形态，红了也说明不了是软链这一遍在承重。
  assert.ok(
    !path.resolve(path.join(dataDir, "photos")).startsWith(path.resolve(publicDir) + path.sep),
    "前提错了：这个形态本来就该被字面比较挡住，实验说明不了任何事",
  );

  db = openDb(path.join(dataDir, "two-years.db"));

  assert.throws(
    () => createApp({ db, now: () => JUST_BEFORE, publicDir, dataDir }),
    /静态资源目录/,
    `照片目录是一个指向 public/ 的${kind}，服务却起来了——` +
      "照片会被 express.static 零鉴权直出，时间锁当场作废",
  );
  t.diagnostic(`${kind} → public/evil：createApp 抛错，服务起不来`);
});

test("照片目录本身合规时必须**不拦**（拦了会误伤正常部署）；反向形态不在启动断言职责内", (t) => {
  // 这条钉的是启动断言的**边界**，不是它能防住什么：
  // 照片目录没落在静态根里，就不该拦——拦了会让正常部署起不来。
  //
  // 反方向（「public/ 里放一个指回照片的链接」）**有意不演示**：那种形态下
  // 照片确实会被直出，演示它等于把一个已知缺口写进测试当预期行为。
  // 它的边界写在 CONSTRAINTS §2 里，认那条就行。
  // 早先这条的标题写的是「public/ 里有指回照片的链接」，而函数体从未建过那条
  // 链接——标题说验 A、实际验 B，读的人会以为 A 已被覆盖。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "two-years-link2-"));
  let db;
  t.after(() => {
    try {
      db?.close();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const publicDir = path.join(dir, "public");
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  db = openDb(path.join(dataDir, "two-years.db"));
  assert.doesNotThrow(
    () => createApp({ db, now: () => JUST_BEFORE, publicDir, dataDir }),
    "照片目录没落在静态根里就不该拦——拦了会误伤正常部署",
  );
  t.diagnostic("照片目录本身合规：正常启动。public/ 里的反向链接由「照片不进 public/」这条纪律负责，不是启动断言");
});