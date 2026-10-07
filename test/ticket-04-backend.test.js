/**
 * 工单 04 · 阅读流与共同层 —— 后端线。
 *
 * 全部从外部可观察：HTTP 状态码、响应体、seed 进程的退出码与 stdout、
 * 磁盘上的文件字节、数据库里真实的行。不断言内部结构，不碰 public/（前端线独占）。
 *
 * 时间戳取样点用 helpers.js 写死的绝对 epoch，不从 UNLOCK_AT 推导——
 * 推导出来的取样点会让断言自指（见 helpers.js 的注释）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { startTestServer, client, JUST_BEFORE, AT_UNLOCK, TEST_SECRET } from "./helpers.js";
import { ROOT } from "../src/app.js";
import { SHARED_OWNER } from "../src/shared.js";

/** SPEC §一：【改这里：doorCode】用【改这里：heroCode】的生日进门，【改这里：heroCode】用【改这里：doorCode】的生日进门 */
const DOOR = { code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD };
const HERO = { code: "【改这里：heroCode】", birthday: TEST_SECRET.HERO_PASSWORD };

/** 工单契约逐字写死的纪念日区间，写在这里而不是从实现里推导 */
const FROM = "2024-10-05";
const TO = "2026-10-05";
const DAYS = 731;
const SLOTS = 9;

const PUBLIC_DIR = path.resolve(path.join(ROOT, "public"));

const SMALL = await sharp({
  create: { width: 120, height: 90, channels: 3, background: { r: 200, g: 120, b: 90 } },
})
  .jpeg({ quality: 90 })
  .toBuffer();

/* ------------------------------ 小工具 ------------------------------ */

async function login(base, who) {
  const c = client(base);
  const res = await c.post("/api/login", { code: who.code, birthday: who.birthday });
  assert.equal(res.status, 200, `${who.code} 应当进得门：${res.text}`);
  return c;
}

/** 手搓 multipart：字段名固定 photo，03 定的契约 */
function multipart(data) {
  const boundary = "----t04" + randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="photo.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`,
    "utf8",
  );
  const body = Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(c, data) {
  const { body, contentType } = multipart(data);
  return c.raw("/api/upload", { method: "POST", body, headers: { "content-type": contentType } });
}

/** 9 张各不相同的合照素材，文件名带前导零，顺带验证自然序而不是字典序 */
async function makeMaterial(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= SLOTS; i++) {
    const buf = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 15 * i, g: 200 - 12 * i, b: 90 + 10 * i },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    fs.writeFileSync(path.join(dir, `${String(i).padStart(2, "0")}.jpg`), buf);
  }
  return dir;
}

/** 真起 seed 进程跑 CLI：断言的是用户实际会执行的那条命令 */
function runSeed({ dbFile, materialDir }) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/seed-shared.mjs"], {
    cwd: ROOT,
    env: { ...process.env, DB_FILE: dbFile, MATERIAL_DIR: materialDir },
    encoding: "utf8",
  });
}

/** 另开一个连接直查同一个 SQLite 文件：看到的就是磁盘上的库，绕开进程内句柄 */
function withDirect(dbFile, fn) {
  const direct = new DatabaseSync(dbFile);
  try {
    return fn(direct);
  } finally {
    direct.close();
  }
}

const one = (dbFile, sql, ...a) => withDirect(dbFile, (d) => d.prepare(sql).get(...a));
const all = (dbFile, sql, ...a) => withDirect(dbFile, (d) => d.prepare(sql).all(...a));
const count = (dbFile, table) => one(dbFile, `SELECT COUNT(*) AS n FROM ${table}`).n;

/* ====================================================================== *
 * 1. 共同层路由：未解锁 404，开门后 200 且契约里的字段都在
 * ====================================================================== */

test("未解锁时共同层 404；开门后 200，契约里的字段逐字对齐", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const seed = runSeed({ dbFile: s.dbFile, materialDir: await makeMaterial(path.join(s.dir, "together")) });
  assert.equal(seed.status, 0, `seed 必须正常退出：\n${seed.stdout}\n${seed.stderr}`);

  // 未登录、未解锁：一样 404。共同层没有「先登录才看得到」这一说
  assert.equal((await client(s.base).get("/api/shared")).status, 404, "未解锁时未登录必须 404");

  const a = await login(s.base, DOOR);
  assert.equal((await a.get("/api/shared")).status, 404, "未解锁时已登录必须 404");
  assert.equal((await a.get("/API/SHARED")).status, 404, "大小写绕不过闸门");

  s.setNow(AT_UNLOCK);
  const r = await a.get("/api/shared");
  assert.equal(r.status, 200, `开门后必须 200：${r.text}`);

  assert.ok(Array.isArray(r.body.photos), "photos 必须是数组");
  for (const k of ["blessing", "from", "to", "days"]) {
    assert.ok(k in r.body, `响应里必须有 ${k} 这个键`);
  }
  /* 「731」与「2024-10-05」是一**对**，不是一个数。
     这条断言就是防「把 730 直接改成 731」那个改法：
     改完之后 days 显示 731 完全正常，但 from 会悄悄变成 2024-10-04。
     放在下面那两行 `from` / `to` 断言**之前**：它们会先红，但只说
     "2024-10-04 !== 2024-10-05"，不告诉你是**哪个常量**用错了。
     两个日期独立重算一遍，不信任被测代码里的任何一个常量。 */
  {
    const DAY_MS = 86400_000;
    const from = new Date(AT_UNLOCK - (DAYS - 1) * DAY_MS + 8 * 3600_000);
    const to = new Date(AT_UNLOCK + 8 * 3600_000);
    const p = (n) => String(n).padStart(2, "0");
    const ymdOf = (d) => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    assert.equal(
      ymdOf(from),
      FROM,
      `从开门时刻减 ${DAYS - 1} 天应当落在 ${FROM}，实际 ${ymdOf(from)} —— 起点错了一天`,
    );
    assert.equal(ymdOf(to), TO);
    const span = Math.round((to - from) / DAY_MS);
    assert.equal(span, DAYS - 1, `两个日期相隔应当是 ${DAYS - 1} 天，实际 ${span}`);
  }

  assert.equal(r.body.from, FROM);
  assert.equal(r.body.to, TO);
  assert.equal(r.body.days, DAYS);
  assert.equal(typeof r.body.blessing, "string");
  assert.ok(r.body.blessing.length > 0, "祝福语不该是空串——素材里没有 blessing.txt 时有默认文案");

  // photos 数组的元素形状与顺序
  assert.equal(r.body.photos.length, SLOTS, "九宫格固定 9 张");
  assert.deepEqual(
    r.body.photos.map((p) => p.id),
    Array.from({ length: SLOTS }, (_, i) => `sh${i + 1}`),
    "槽位 id 必须是 sh1..sh9 且按 ord 升序",
  );
  for (const p of r.body.photos) {
    assert.deepEqual(Object.keys(p).sort(), ["h", "id", "photoId", "w"], "元素只带这四个键");
    assert.match(p.photoId, /^p[0-9a-f]{24}$/, "photoId 必须是照片文件 id");
    assert.ok(p.w > 0 && p.h > 0, `尺寸必须是真的：${p.w}×${p.h}`);
  }
  // 九张各不相同：素材内容不同 → 文件 id 不同
  assert.equal(new Set(r.body.photos.map((p) => p.photoId)).size, SLOTS, "九张必须是九个不同的 id");
});

/* ====================================================================== *
 * 2. 缝二（延续）：数据确实在库里在盘上，而 B 在未解锁时拿到 404
 * ====================================================================== */

test("缝二延续：合照确实在库里在盘上，而 B 在未解锁时拿到 404", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  const seed = runSeed({ dbFile: s.dbFile, materialDir: await makeMaterial(path.join(s.dir, "together")) });
  assert.equal(seed.status, 0, `seed 必须正常退出：\n${seed.stdout}\n${seed.stderr}`);

  // ---- 直查同一个 SQLite 文件：这几条是「404 是门挡的、不是数据没写进去」的地基 ----
  const rows = all(s.dbFile, "SELECT id, kind, body, ord FROM shared WHERE kind='together_photo' ORDER BY ord");
  assert.equal(rows.length, SLOTS, "shared 行必须真的在库里——否则下面的 404 说明不了任何事");

  // 共同层只占一条哨兵 entry（owner 是 person 表里绝不会出现的保留值），
  // 合照的元数据复用 photo 表（那张表的本职就是「照片元数据，文件在 700 目录」）。
  const sentinel = one(s.dbFile, "SELECT * FROM entry WHERE id = ?", SHARED_OWNER);
  assert.ok(sentinel, "哨兵 entry 行必须在：photo.entry_id 是 NOT NULL 外键，合照总得指一条行");
  assert.equal(sentinel.owner, SHARED_OWNER);
  assert.equal(count(s.dbFile, "entry"), 1, "共同层只准占这一条，不许混进任何一个人的条目");
  assert.equal(count(s.dbFile, "photo"), SLOTS, "九张合照的元数据必须在 photo 表里");

  for (const [i, row] of rows.entries()) {
    assert.equal(row.id, `sh${i + 1}`, "槽位 id 按 ord 升序");
    assert.match(row.body, /^p[0-9a-f]{24}$/, "body 存的是照片文件 id");
    const file = path.join(s.photosDir, `${row.body}.jpg`);
    assert.ok(fs.existsSync(file), `合照必须真的落盘：${file}`);
    const meta = one(s.dbFile, "SELECT * FROM photo WHERE id = ?", row.body);
    assert.ok(meta, "尺寸元数据必须在");
    assert.equal(meta.entry_id, SHARED_OWNER, "合照挂哨兵 entry，不挂任何人的条目");
    assert.equal(meta.mime, "image/jpeg");
    assert.equal(meta.bytes, fs.statSync(file).size, "库里的 bytes 必须等于盘上的字节数");
    assert.ok(meta.w > 0 && meta.h > 0, "尺寸必须是真的");
  }

  // 照片目录不得落在静态根内：03 的启动自检不能被绕过去
  assert.equal(
    path.resolve(s.photosDir).startsWith(PUBLIC_DIR + path.sep),
    false,
    "合照绝不能落在 public/ 下",
  );
  assert.equal(path.resolve(s.photosDir), path.resolve(s.dir, "photos"), "合照必须与上传的照片同目录");

  // ---- 同一时刻，两个人的会话读同一张合照 ----
  const photoId = rows[0].body;
  const a = await login(s.base, DOOR);
  const b = await login(s.base, HERO);
  assert.equal((await b.get("/api/me")).status, 200, "B 的会话有效——404 不是因为她没登录");

  // 哨兵 entry 对 HTTP 完全不可见：谁的 mine/theirs 都不该出现它
  assert.deepEqual((await a.get("/api/entry")).body.mine, [], "哨兵 entry 不许漏进任何人的 mine");
  assert.deepEqual((await b.get("/api/entry")).body.theirs, [], "未解锁时也不许漏");

  const locked = await b.get(`/api/photo/${photoId}`);
  assert.equal(locked.status, 404, "未解锁时共同层合照对谁都读不到");
  assert.equal(
    (await a.get(`/api/photo/${photoId}`)).status,
    404,
    "未解锁时共同层合照对写它的那一方也读不到",
  );

  // ---- 开门后同一张：B 读得到，证明上面那个 404 是门挡的，不是路由坏了 ----
  s.setNow(AT_UNLOCK);
  const opened = await b.get(`/api/photo/${photoId}`);
  assert.equal(opened.status, 200, "开门后必须读得到，否则那个 404 证明不了时间锁");
  assert.equal(opened.headers.get("content-type"), "image/jpeg");
  assert.equal(
    opened.text.length,
    fs.statSync(path.join(s.photosDir, `${photoId}.jpg`)).size,
    "响应体就是落盘那份",
  );

  // 共同层合照没有第二条取图路径：猜静态路径照样 404
  for (const guess of [
    `/photos/${photoId}.jpg`,
    `/data/photos/${photoId}.jpg`,
    `/uploads/${photoId}.jpg`,
    `/public/photos/${photoId}.jpg`,
  ]) {
    assert.equal((await b.get(guess)).status, 404, `${guess} 必须是 404：合照只有 /api/photo/:id 一条路径`);
  }
});

/* ====================================================================== *
 * 3. 素材不存在 / 为空：seed 正常退出，共同层仍 200
 * ====================================================================== */

test("素材目录不存在或为空时 seed 不炸，共同层仍 200，photos 是空数组", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);

  // 目录不存在
  const missing = runSeed({ dbFile: s.dbFile, materialDir: path.join(s.dir, "no-such-dir") });
  assert.equal(missing.status, 0, `目录不存在时 seed 必须正常退出，实际 ${missing.status}：${missing.stderr}`);
  assert.match(missing.stdout, /不存在/, "退出前必须说明原因");
  assert.equal(missing.stderr, "", "这不是故障，不该往 stderr 写东西");

  // 目录存在但没有图片
  const empty = path.join(s.dir, "empty-together");
  fs.mkdirSync(empty, { recursive: true });
  const blank = runSeed({ dbFile: s.dbFile, materialDir: empty });
  assert.equal(blank.status, 0, `目录为空时 seed 必须正常退出，实际 ${blank.status}：${blank.stderr}`);
  assert.match(blank.stdout, /没有图片/, "退出前必须说明原因");

  // 没素材就一个字节都不许动库
  assert.equal(count(s.dbFile, "shared"), 0, "没有素材就不许建 shared 行");
  assert.equal(count(s.dbFile, "entry"), 0, "没有素材就不许建 entry 行（连哨兵行都不建）");
  assert.equal(count(s.dbFile, "photo"), 0, "没有素材就不许建 photo 行");
  assert.equal(fs.readdirSync(s.photosDir).length, 0, "没有素材就不许在盘上落照片");

  // 接口照旧 200，photos 是空数组：前端走占位块
  s.setNow(AT_UNLOCK);
  const a = await login(s.base, DOOR);
  const r = await a.get("/api/shared");
  assert.equal(r.status, 200, "没有合照也必须 200——不能塌成 404");
  assert.deepEqual(r.body.photos, [], "photos 是空数组");
  assert.equal(r.body.from, FROM);
  assert.equal(r.body.to, TO);
  assert.equal(r.body.days, DAYS);
  assert.equal(typeof r.body.blessing, "string");
});

/* ====================================================================== *
 * 4. 幂等：跑两次不产生重复行，也不重压
 * ====================================================================== */

test("seed 跑两次：shared 行数不变，照片不翻倍，第二遍全部命中复用", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const material = await makeMaterial(path.join(s.dir, "together"));

  const first = runSeed({ dbFile: s.dbFile, materialDir: material });
  assert.equal(first.status, 0, `第一遍必须成功：${first.stderr}`);
  const after1 = all(s.dbFile, "SELECT id, body FROM shared WHERE kind='together_photo' ORDER BY ord");
  const files1 = fs.readdirSync(s.photosDir).filter((f) => f.endsWith(".jpg")).sort();

  const second = runSeed({ dbFile: s.dbFile, materialDir: material });
  assert.equal(second.status, 0, `第二遍必须正常退出，实际 ${second.status}：${second.stderr}`);

  const after2 = all(s.dbFile, "SELECT id, body FROM shared WHERE kind='together_photo' ORDER BY ord");
  assert.equal(after2.length, after1.length, "shared 行数不变：不能出现重复行");
  assert.equal(after2.length, SLOTS, "shared 仍然只有 9 张合照");
  assert.equal(count(s.dbFile, "shared"), SLOTS + 1, "9 张合照 + 1 条祝福语，跑两次也是这么多");
  assert.equal(count(s.dbFile, "photo"), SLOTS, "photo 也不许翻倍");
  assert.equal(count(s.dbFile, "entry"), 1, "哨兵 entry 只一条");
  assert.deepEqual(after2, after1, "两遍之后 id 与照片文件 id 必须逐字相同");
  assert.deepEqual(
    fs.readdirSync(s.photosDir).filter((f) => f.endsWith(".jpg")).sort(),
    files1,
    "盘上的文件不许翻倍",
  );
  assert.match(second.stdout, new RegExp(`复用 ${SLOTS} 张`), "第二遍必须全部命中复用，不重新压缩");

  // 祝福语也幂等
  const blessings = all(s.dbFile, "SELECT id, body FROM shared WHERE kind='blessing'");
  assert.equal(blessings.length, 1, "祝福语只留一条");
  assert.equal(blessings[0].id, "blessing");
});

/* ====================================================================== *
 * 5. 只有文案、没有合照：祝福语仍然要落库
 * ====================================================================== */

test("素材目录里只有 blessing.txt、没有一张图：祝福语仍然写进库（九宫格空着不算失败）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const material = path.join(s.dir, "together");
  fs.mkdirSync(material, { recursive: true });
  // **按 CRLF 写**：记事本存出来的就是这个形态，这是默认路径不是边角情况。
  // 不归一的话库里会留一个裸 \r，应急页产物里变成 `两年了。\r<br>`。
  fs.writeFileSync(path.join(material, "blessing.txt"), "两年了。\r\n往后也一起。\r\n", "utf8");

  const r = runSeed({ dbFile: s.dbFile, materialDir: material });
  assert.equal(r.status, 0, `必须正常退出：${r.stderr}`);

  const rows = all(s.dbFile, "SELECT id, body FROM shared WHERE kind='blessing'");
  assert.equal(rows.length, 1, "祝福语没有落库——文案与合照是两件事，不该被同一条早退一起跳过");
  assert.equal(rows[0].body, "两年了。\n往后也一起。", "落库的必须是文件里那句（换行归一成 \\n），不是缺省文案");
  assert.ok(!rows[0].body.includes("\r"), "库里不许躺着一个裸 \\r——记事本存的是 CRLF，不归一的话应急页产物里会出现 `两年了。\\r<br>`");
  assert.equal(
    count(s.dbFile, "shared"),
    1,
    "没有素材就不该凭空造合照槽位",
  );
  // 日志要说清楚「九宫格这次是空的」，否则「导入 0 张」看起来像什么都没发生
  assert.match(r.stdout, /没有图片|九宫格/, `没说实话：${r.stdout}${r.stderr}`);

  // 幂等：重跑一次仍然只有一条
  assert.equal(runSeed({ dbFile: s.dbFile, materialDir: material }).status, 0);
  assert.equal(count(s.dbFile, "shared"), 1, "重跑不许写出第二条祝福语");
});

test("素材目录什么都没有（连 blessing.txt 都没有）：仍然空着，不写任何行", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const material = path.join(s.dir, "together");
  fs.mkdirSync(material, { recursive: true });

  const r = runSeed({ dbFile: s.dbFile, materialDir: material });
  assert.equal(r.status, 0, "什么都没有是正常状态，不是故障");
  assert.equal(count(s.dbFile, "shared"), 0, "没有素材也不该凭空写一行祝福语（否则读到的还是缺省文案，用户还不知道）");
});

/* ====================================================================== *
 * 6. 回归：自己的照片在未解锁时仍然读得到
 * ====================================================================== */

test("共同层上线后未解锁时自己的照片照旧读得到，扩判定不许把闸门放宽", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  runSeed({ dbFile: s.dbFile, materialDir: await makeMaterial(path.join(s.dir, "together")) });

  const a = await login(s.base, DOOR);
  const up = await upload(a, SMALL);
  assert.equal(up.status, 201, `未解锁时上传必须仍成功：${up.text}`);
  const ownId = up.body.entry.photo.id;
  const togetherId = one(s.dbFile, "SELECT body FROM shared WHERE id = 'sh1'").body;

  // 自己的条目下的照片：未解锁照样 200
  assert.equal((await a.get(`/api/photo/${ownId}`)).status, 200, "自己的照片任何时候都读得到");

  // 对方的照片仍然读不到：扩判定是为了加一条，不许顺手去掉原来那条
  const b = await login(s.base, HERO);
  assert.equal((await b.get(`/api/photo/${ownId}`)).status, 404, "未解锁时对方的照片仍读不到");

  // 自己的身份不解锁共同层合照：它不属于任何一方
  assert.equal((await a.get(`/api/photo/${togetherId}`)).status, 404, "登录了也不解锁共同层合照");
  assert.equal((await b.get(`/api/photo/${togetherId}`)).status, 404, "共同层合照对双方一视同仁");

  s.setNow(AT_UNLOCK);
  assert.equal((await a.get(`/api/photo/${togetherId}`)).status, 200, "开门后共同层合照读得到");
  assert.equal((await b.get(`/api/photo/${ownId}`)).status, 200, "开门后对方照片也读得到");
  assert.equal((await a.get("/api/entry")).status, 200, "共同层不许把 /api/entry 弄坏");
});
