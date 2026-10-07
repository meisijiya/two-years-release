/**
 * 时间锁的文字层：登录 / 会话 / 我的留言 / 对方的留言。
 *
 * 两条不变量贯穿全文件：
 *   1. 开门判定只走 clock.js 的 isUnlocked(now())，now 由 createApp 注入。
 *   2. 未解锁时对方的条目不进响应体 —— 不是「传了但前端不显示」。
 */
import express from "express";
import multer from "multer";
import { randomBytes } from "node:crypto";
import { isUnlocked } from "./clock.js";
import { otherId, plain, PERSONS } from "./db.js";
import { SHARED_OWNER, prepareShared, shapeShared } from "./shared.js";
import { cp } from "./copy-get.js";
import {
  MAX_UPLOAD_BYTES,
  OUT_MIME,
  acceptsMime,
  assertPhotosOutsideStatic,
  ensurePhotosDir,
  newPhotoId,
  photosDirFor,
  processImage,
  readPhoto,
  removePhoto,
  writePhoto,
} from "./photos.js";
import {
  checkPassword,
  clearFailures,
  clearSessionCookie,
  createSession,
  destroySession,
  isSecureRequest,
  ensureCredentials,
  lockState,
  personByToken,
  recordFailure,
  setSessionCookie,
  tokenFromCookie,
} from "./auth.js";

/** 401 时给的话：说清楚密码是什么，而不是冷冰冰一个「错误」。
 *  ⚠️ 文案归 src/copy.js 管（err.server.wrongBirthday）——它会被前端**原样渲染到屏幕上**。
 *     不搬的后果：改了前端那句，服务端这条还是旧的，而这条恰好是平时真正显示的那一条。 */
const HINT = cp("err.server.wrongBirthday");

/** 单条留言正文上限。契约没写长度，这里定一个能挡住误粘贴的线。 */
const MAX_BODY = 5000;

/** 单条约定正文上限。一句话够写，200 字挡住「把信粘进来」。前端输入框同一个数。 */
const MAX_WISH = 200;

const newId = (prefix) => prefix + randomBytes(8).toString("hex");

/** 契约只认「非空字符串」；空、超长、非字符串都当缺字段处理 */
function readBody(input) {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (!t || t.length > MAX_BODY) return null;
  return t;
}

/** 约定正文：同 readBody，单独一条是因为它的上限小得多（MAX_WISH） */
function readWish(input) {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (!t || t.length > MAX_WISH) return null;
  return t;
}

export function createApiRouter({ db, now, publicDir, observerAuth = null }) {
  ensureCredentials(db);
  // 共同层的预编译句柄（工单 04）
  const sharedStore = prepareShared(db);

  const router = express.Router();
  const unlocked = () => isUnlocked(now());

  const q = {
    personByCode: db.prepare("SELECT id, code, role FROM person WHERE code = ?"),
    liveByOwner: db.prepare(
      "SELECT id, kind, body, ord, created FROM entry WHERE owner = ? AND deleted IS NULL ORDER BY ord, created",
    ),
    nextOrd: db.prepare("SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM entry WHERE owner = ?"),
    liveById: db.prepare(
      "SELECT id, kind, body, ord, created FROM entry WHERE id = ? AND owner = ? AND deleted IS NULL",
    ),
    insertEntry: db.prepare(
      "INSERT INTO entry(id, owner, kind, body, ord, created, deleted) VALUES(?,?,?,?,?,?,NULL)",
    ),
    updateBody: db.prepare("UPDATE entry SET body = ? WHERE id = ? AND owner = ? AND deleted IS NULL"),
    /* 硬删（2026-10-03 定）：撤回 = 删掉，不是标记。
       `deleted` 列从此恒为 NULL，**不删列** —— 线上库已经有它，为这一句改动做一次
       ALTER TABLE 迁移属于不可逆动作、收益为零。列留着、恒为 NULL，
       查询里那些 `deleted IS NULL` 也照旧成立，不必满仓库改条件。
       归属检查（`owner = ?`）是这一路由唯一的安全边界，别去掉它。 */
    hardDeleteEntry: db.prepare("DELETE FROM entry WHERE id = ? AND owner = ?"),
    hardDeletePhoto: db.prepare("DELETE FROM photo WHERE entry_id = ?"),
    /* 归属检查单独一条：硬删必须**先**证明这条是自己的，才轮到删 photo 行。
       不把 owner 条件塞进 DELETE 里，是为了让「查不到 → 404」发生在任何删除动作之前。 */
    ownById: db.prepare("SELECT id FROM entry WHERE id = ? AND owner = ?"),
    photoOf: db.prepare("SELECT id, mime, w, h FROM photo WHERE entry_id = ? ORDER BY id"),
    countMine: db.prepare("SELECT COUNT(*) AS n FROM entry WHERE owner = ? AND deleted IS NULL"),
  };

  const noSession = (res) => res.status(401).json({ error: "no_session" });
  const notFound = (res) => res.status(404).json({ error: "not_found" });
  const badRequest = (res) => res.status(400).json({ error: "bad_request" });

  /** 契约里的条目形状；photo 恒为 null 或 {id, mime, w, h}，T04 落盘后自然有值 */
  const toEntry = (row) => ({
    id: row.id,
    kind: row.kind,
    body: row.body,
    ord: row.ord,
    created: row.created,
    photo: plain(q.photoOf.get(row.id)),
  });

  const listOf = (owner) => q.liveByOwner.all(owner).map(toEntry);

  // 会话解析挂在路由链最前：所有 /api/* 都能拿到 req.person（未登录时是 null）
  router.use((req, res, next) => {
    req.token = tokenFromCookie(req.headers.cookie);
    req.person = personByToken(db, req.token);
    next();
  });

  /* ------------------------------ 登录 ------------------------------ */

  router.post("/api/login", (req, res) => {
    const body = req.body ?? {};
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const raw = typeof body.birthday === "string" ? body.birthday.trim() : "";
    if (!code || !raw) return badRequest(res);

    const ip = req.ip || "unknown";
    const lock = lockState(db, ip, now());
    if (lock.locked) {
      return res.status(429).json({ error: "locked", retryAfter: lock.retryAfter });
    }

    // 代号不存在与密码不对返回同一句话：不做代号枚举
    const person = q.personByCode.get(code);
    const ok = person ? checkPassword(db, person.id, raw.replace(/\D/g, "")) : false;
    if (!ok) {
      const after = recordFailure(db, ip, now());
      if (after.locked) {
        return res.status(429).json({ error: "locked", retryAfter: after.retryAfter });
      }
      return res.status(401).json({ error: "bad_credentials", hint: HINT });
    }

    clearFailures(db, ip);
    setSessionCookie(res, createSession(db, person.id, now()), isSecureRequest(req));
    res.json({ id: person.id, code: person.code, role: person.role, unlocked: unlocked() });
  });

  /* ------------------------------ 登出 ------------------------------ */

  router.post("/api/logout", (req, res) => {
    if (req.token) destroySession(db, req.token);
    clearSessionCookie(res, isSecureRequest(req));
    res.status(204).end();
  });

  /* ------------------------------ 身份 ------------------------------ */

  router.get("/api/me", (req, res) => {
    if (!req.person) return noSession(res);
    res.json({
      id: req.person.id,
      code: req.person.code,
      role: req.person.role,
      unlocked: unlocked(),
      count: q.countMine.get(req.person.id).n,
    });
  });

  /* ------------------------------ 留言 ------------------------------ */

  router.get("/api/entry", (req, res) => {
    if (!req.person) return noSession(res);
    res.json({
      mine: listOf(req.person.id),
      // 时间锁的读侧主闸门：未解锁时对方的东西根本不出现在响应体里
      theirs: unlocked() ? listOf(otherId(req.person.id)) : [],
    });
  });

  router.post("/api/entry", (req, res) => {
    if (!req.person) return noSession(res);
    const body = req.body ?? {};
    if (body.kind !== "text") return badRequest(res);
    const text = readBody(body.body);
    if (text === null) return badRequest(res);

    const row = {
      id: newId("e"),
      owner: req.person.id,
      kind: "text",
      body: text,
      ord: q.nextOrd.get(req.person.id).n,
      created: now(),
    };
    q.insertEntry.run(row.id, row.owner, row.kind, row.body, row.ord, row.created);
    res.status(201).json({ entry: toEntry(row) });
  });

  // 动别人的条目一律 404：连「这条存在」都不泄露
  router.patch("/api/entry/:id", (req, res) => {
    if (!req.person) return noSession(res);
    const text = readBody((req.body ?? {}).body);
    if (text === null) return badRequest(res);
    const r = q.updateBody.run(text, req.params.id, req.person.id);
    if (!r.changes) return notFound(res);
    // UPDATE 与 SELECT 之间若这条被软删，回读会拿到 null。
    // toEntry(null) 抛错会把「条目没了」报成 500，那是并发下的假故障。
    const after = plain(q.liveById.get(req.params.id, req.person.id));
    if (!after) return notFound(res);
    res.json({ entry: toEntry(after) });
  });

  /* 硬删：行、photo 行、盘上那个压缩后的 JPEG 一起没。
     「删掉就是删掉」——不留痕、不留文件、不留一个占位行。不可恢复。

     ⚠️ 顺序不是随便定的，photo.entry_id 上有指向 entry(id) 的**外键**：
        先删 entry 行会被数据库当场拒绝（FOREIGN KEY constraint failed → 500）。
        所以必须 photo 行 → entry 行。
        但顺序反过来又有个更危险的坑：还没验归属就删 photo 行，
        会把**别人条目上的照片**删掉。所以第一步永远是归属检查：
        查得到才往下走，查不到（别人的 / 已经没了）一律 404。 */
  router.delete("/api/entry/:id", (req, res) => {
    if (!req.person) return noSession(res);
    // ① 归属检查。这条查不到就 return，下面两步根本不会执行。
    if (!q.ownById.get(req.params.id, req.person.id)) return notFound(res);
    // ② 先把这条名下的照片 id 取出来：photo 行删掉之后就再也拿不到那个文件名，
    //    文件会变成没人认领的孤儿（/api/photo/:id 还能按 id 直接取到它）。
    const photos = q.photoOf.all(req.params.id);
    // ③ 外键：photo 先走
    q.hardDeletePhoto.run(req.params.id);
    // ④ 再走 entry
    q.hardDeleteEntry.run(req.params.id, req.person.id);
    // ⑤ 最后才动盘上文件。文件删不掉不是错误（removePhoto 内部吞掉），
    //    留下的是磁盘垃圾，不是能被读到的内容。
    for (const p of photos) removePhoto(photosDir, p.id);
    res.status(204).end();
  });

  /* ------------------------- 共同层（工单 04）------------------------- */

  // 共同层不属于任何一方。**这里不再自己判一次开门**：
  // app.js 的 LOCKED_PREFIXES 已经把 /api/shared 整条挡在路由之前。
  // 两处都判的话，删掉其中一处测试照样绿——闸门就变得不可证伪了
  // （app.js 哨兵注释里点名的那个坑）。开门那一侧由 scripts/check-boot.mjs
  // 与 test/ticket-04-backend.test.js 一起钉住。
  router.get("/api/shared", (req, res) => {
    // 必须有会话。这是公网 IP + 裸 HTTP，10-5 之后任何扫到端口的人都能打到这里；
    // 漏掉这一行就等于把祝福语正文和 9 个照片 id 公开给全世界。
    if (!req.person) return noSession(res);
    res.json(shapeShared(sharedStore));
  });

  /* ------------------------- 约定（工单 05）------------------------- */

  const wq = {
    get: db.prepare("SELECT text FROM wish WHERE person_id = ?"),
    // 覆盖而不是追加：wish 表以 person_id 为主键，一方永远只有一条约定。
    // 写第二条时她自己改主意是常事，追加会让阅读端出现两份同一个人的答案。
    upsert: db.prepare(
      "INSERT INTO wish(person_id, text) VALUES(?,?) " +
        "ON CONFLICT(person_id) DO UPDATE SET text = excluded.text",
    ),
  };

  /** 契约里的约定形状：只带代号，**不带 role、不带任何真名**（CONSTRAINTS §3） */
  const shapeWish = (id, code, row) => ({
    id,
    code,
    // 还没写的一方给空串而不是不给这一项：并排的两栏位置必须留着，
    // 否则「TA 还没选」和「TA 根本没来过」在界面上分不出来。
    text: row && typeof row.text === "string" ? row.text : "",
  });

  // 未解锁那一下由 app.js 的 LOCKED_PREFIXES 挡住，这里**不再自己判一次**。
  // 与 /api/shared 同一个理由：两处都判的话，删掉其中一处测试照样绿，闸门就不可证伪了。
  router.get("/api/wish", (req, res) => {
    // 必须有会话。公网 IP + 裸 HTTP，开门后扫到端口的任何人都能打到这里；
    // 漏掉这一行，两条约定当场公开——工单 04 复审 HIGH-1 就是同一种形状的泄漏。
    if (!req.person) return noSession(res);
    // 顺序固定（person 表的定义序），前端拿到的两栏不会每次刷新换位置
    res.json({ wishes: PERSONS.map((p) => shapeWish(p.id, p.code, wq.get.get(p.id))) });
  });

  // 写入**允许在未解锁时发生**：她必须能提前折好，10-5 当天才不用手忙脚乱。
  router.post("/api/wish", (req, res) => {
    if (!req.person) return noSession(res);
    const text = readWish((req.body ?? {}).text);
    if (text === null) return badRequest(res);
    wq.upsert.run(req.person.id, text);
    res.json({ wish: shapeWish(req.person.id, req.person.code, { text }) });
  });

  /* ------------------------- 照片：上传与读取（工单 03）------------------------- */

  // 照片目录跟着库走（生产 data/photos，测试临时目录），权限 700，永不在 public/ 下。
  // assertPhotosOutsideStatic 会在它真的落在静态根里时让服务**起不来**：
  // 宁可启动失败，也不能悄悄把照片零鉴权直出。
  const photosDir = ensurePhotosDir(photosDirFor(db));
  assertPhotosOutsideStatic(photosDir, publicDir);

  const pq = {
    photoById: db.prepare(
      "SELECT p.id, p.entry_id, p.mime, p.bytes, p.w, p.h, e.owner, e.deleted " +
        "FROM photo p JOIN entry e ON e.id = p.entry_id WHERE p.id = ?",
    ),
    insertPhoto: db.prepare(
      "INSERT INTO photo(id, entry_id, mime, bytes, w, h) VALUES(?,?,?,?,?,?)",
    ),
  };

  /**
   * 上传是不可信输入面：字段名固定 photo、只收图片 MIME、限原始体积。
   * 内存存储是为了不把**原图**写进任何临时文件 —— 落盘的只有压好的 JPEG。
   */
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 8 },
    fileFilter(req, file, cb) {
      if (acceptsMime(file.mimetype)) return cb(null, true);
      const err = new Error("只收图片");
      err.code = "ONLY_IMAGE";
      cb(err);
    },
  });

  /** 拒收的标记：这是用户输入的问题，不是服务器炸了，该回 400 */
  const rejected = (err) => {
    err.uploadRejected = true;
    return err;
  };

  /** multer 收 multipart：体积超限 / 字段名不对 / MIME 不收，一律回同一句 400 */
  const receive = (req, res) =>
    new Promise((resolve, reject) => {
      upload.single("photo")(req, res, (err) => (err ? reject(rejected(err)) : resolve(req.file)));
    });

  // 契约里非图片与超限共用这一个响应体。文案同样归 src/copy.js（err.server.notImage）。
  const UPLOAD_HINT = cp("err.server.notImage");
  const badUpload = (res) => res.status(400).json({ error: "bad_request", hint: UPLOAD_HINT });

  router.post("/api/upload", (req, res, next) => {
    if (!req.person) return noSession(res);

    receive(req, res)
      .then(async (file) => {
        if (!file) throw rejected(new Error("没有照片字段"));
        // 解不开就是不是图片：改名成 .jpg 骗得过 MIME，骗不过这一关。
        // 这一层只可能是「内容不是可解码的图片」——磁盘写失败发生在后面，走 500。
        let shot;
        try {
          shot = await processImage(file.buffer);
        } catch (err) {
          throw rejected(err);
        }

        const photoId = newPhotoId();
        const row = {
          id: newId("e"),
          owner: req.person.id,
          kind: "photo",
          body: null,
          ord: q.nextOrd.get(req.person.id).n,
          created: now(), // 只从注入的时钟取
        };
        // 先落盘再建行；建行失败就把文件收回去，不留没人认领的孤儿
        writePhoto(photosDir, photoId, shot.data);
        try {
          db.exec("BEGIN");
          q.insertEntry.run(row.id, row.owner, row.kind, row.body, row.ord, row.created);
          pq.insertPhoto.run(photoId, row.id, OUT_MIME, shot.data.length, shot.width, shot.height);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          removePhoto(photosDir, photoId);
          throw err;
        }
        res.status(201).json({ entry: toEntry(row) });
      })
      .catch((err) => {
        if (res.headersSent) return;
        if (err?.uploadRejected) return badUpload(res);
        next(err);
      });
  });

  // 读图只有这一条路径：不映射静态目录、不列目录、不给下载别名。
  // 两种来源共用它：entry 表里某条目的照片，或共同层的合照。
  router.get("/api/photo/:id", (req, res) => {
    // 观察者凭据与本人会话**二选一**，都拿不到才 401。
    //
    // ⚠️ 这是 CONSTRAINTS §2 的一次显式降级（见 CONSTRAINTS.md §2b）。它必须长在这里，
    //    而不是新开一条 /api/observe/photo/:id：取图鉴权如果散在两处，
    //    两处迟早会对「谁能看哪张」得出不同答案，而照片是全站唯一一种「看得见就等于拿到」的数据。
    //    前端也因此不用改 —— photoSrc() 仍是唯一那条路。
    const isObserver = !req.person && !!observerAuth?.fromRequest(req);
    if (!req.person && !isObserver) return noSession(res);

    // 锁住时也标 no-store：否则浏览器会把「未解锁的 404」缓存下来，开门后还读不到
    res.set("Cache-Control", "private, no-store");

    const row = pq.photoById.get(req.params.id);
    // 共同层合照挂在保留 owner 下的哨兵 entry 上（见 shared.js 的 SHARED_OWNER）。
    // 显式认它：它不属于「谁写给谁」里的任何一方，只认开门时刻。
    const isTogether = !!row && row.owner === SHARED_OWNER;
    // 已撤回的一律不给看 —— **观察者也不例外**。它是调试用的旁路，不是全知视角。
    const ok = isObserver
      ? !!row && !row.deleted
      : isTogether
        ? unlocked()
        : !!row && !row.deleted && (row.owner === req.person.id || unlocked());
    // 对方未解锁 / 共同层未解锁 / 已撤回 / id 不存在 / 文件没了 —— 五种都走这一句，
    // 响应体逐字相同，客户端分不出「对方有这张照片」以外的任何信息
    const buf = ok ? readPhoto(photosDir, row?.id) : null;
    if (!buf) return notFound(res);

    res.set("Content-Type", OUT_MIME);
    res.send(buf);
  });

  return router;
}
