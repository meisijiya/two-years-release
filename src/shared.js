/**
 * 共同层：「我们的两年」的九张合照 + 一句祝福 + 纪念日区间。
 *
 * 三条不变量，贯穿整个文件：
 *   1. 共同层不认「谁写给谁」。合照挂在保留 owner 下，只认开门时刻：
 *      未解锁时 `GET /api/photo/:id` 对它**对谁都是 404**，登录了也一样。
 *   2. 素材只有一条来路：`photos/together/`，由 `scripts/seed-shared.mjs` 导入，
 *      导入走与上传**同一条**压缩管线（photos.js 的 processImage + writePhoto），
 *      文件落同一个 700 目录，读图仍然只有 `GET /api/photo/:id` 一条路径。
 *   3. 本文件不碰时间：created 由调用方从注入的 now() 取，
 *      业务代码里一个 `Date.now()` 都不写。
 *
 * ⚠️ 一处契约与既有 schema 的冲突，工单 04 的取舍（db.js 不在本工单改动范围内）：
 *   工单写「共同层合照不放进 `entry` 表——那张表的 owner 语义是『谁写给谁』」。
 *   但 `photo.entry_id TEXT NOT NULL REFERENCES entry(id)` 是 NOT NULL 外键，
 *   合照的尺寸/字节数要落库就必须有一条 entry 行可指；db.js 改不了
 *   （而且 `test/ticket-01-skeleton.test.js` 把库表数钉死在七张，加表直接撞门禁）。
 *   折中：只放**一条**哨兵 entry 行，owner 取保留值 SHARED_OWNER，
 *   跟「【改这里：doorCode】/【改这里：heroCode】写的」在语义上彻底分开。
 *   它对 HTTP 完全不可见 —— routes.js 里每条按 owner 过滤的查询都取不到它
 *   （liveByOwner / nextOrd / liveById / countMine 全部带 owner 条件），
 *   所以 `/api/entry` 的 mine 与 theirs 都不会出现它。
 *   代价：直开数据库能看到这一行。这是「语义上的让」换「不改别人文件 + 不新增表」，
 *   已记在工单 04 的交付报告里。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { UNLOCK_AT } from "./clock.js";
import { OUT_MIME, ensurePhotosDir, photoPath, processImage, writePhoto } from "./photos.js";
import { plain, plainAll } from "./db.js";

/* -------------------------------------------------------------------------- *
 * 固定值
 * -------------------------------------------------------------------------- */

/** 九宫格固定 3×3 = 9 张。素材多于 9 张时多的不导，SPEC §七 的格子数是死的 */
export const SHARED_PHOTO_SLOTS = 9;

/**
 * 两整年一共**多少天**（**含首尾两天**）：2024-10-05 记作第 1 天，2026-10-05 是第 **731** 天。
 *
 * ⚠️ 这个数是**给人看的**，不是用来推日期的。界面上「这 731 个日夜」「一共 731 天」都用它。
 * 想推纪念日起点请用下面的 SPAN_DAYS —— **直接拿这个数去减会差一天**，
 * 起点会落到 2024-10-04（一个不在两年里的日子，界面上完全看不出来）。
 */
export const ANNIVERSARY_DAYS = 731;

/**
 * 两个日期之间**隔了多少天**（不含首尾）= 731 - 1 = 730。
 *
 * 存在的唯一理由：把「算出来的天数」和「数出来的天数」分开。
 * 2024-10-05 → 2026-10-05 是两个平年（2025 不是闰年），相隔 730 天；
 * 但从第一天数到最后一天是 731 天。两者差 1，混用就差一天。
 */
export const SPAN_DAYS = ANNIVERSARY_DAYS - 1;

/** 祝福语行的稳定 id：重复跑 seed 靠它幂等，不靠「先查有没有再插」 */
export const BLESSING_ID = "blessing";

/**
 * 共同层合照的保留 owner。
 *
 * 取一个 person 表里绝不会出现的值：没人叫「@shared-layer」，
 * 于是 routes.js 里所有 `WHERE owner = ?` 的查询天然取不到它，
 * 共同层不会顺着某一个人的条目列表漏出去。读图判定也显式认它。
 */
export const SHARED_OWNER = "@shared-layer";

/** 哨兵 entry 行的 id：全部合照的 photo.entry_id 都指它 */
export const SHARED_ENTRY_ID = SHARED_OWNER;

/** 素材目录里这个文件是祝福语正文，不是一张照片 */
const BLESSING_FILE = "blessing.txt";

const DAY_MS = 24 * 3600 * 1000;

/**
 * 纪念日起点 = 开门时刻往前推 **SPAN_DAYS（730）** 天 = 2024-10-05T00:00:00+08:00。
 *
 * 从 UNLOCK_AT 推而不是再写一个日期字面量：开门时刻只由 clock.js 一处说了算，
 * 这里再抄一份，改了那边忘了这边，纪念日区间就会悄悄漂一年。
 *
 * ⚠️ 减的是 SPAN_DAYS 不是 ANNIVERSARY_DAYS：后者是 731（**含首尾**），
 * 拿它减，起点会变成 2024-10-04 —— 而界面上那个「731 个日夜」仍然显示得好好的，
 * 看不出起点错了一天。这条断言在 test/ticket-04-backend.test.js。
 */
export const START_AT = UNLOCK_AT - SPAN_DAYS * DAY_MS;

/**
 * 素材目录里没有 blessing.txt 时用的默认祝福语。
 *
 * 2026-10-03 定稿：本人从三稿里选「轻 · 往前看」那一稿，随后要求
 * ① 改成**「我们」视角** —— 这段话挂在共同层上，**两个人都看得到**，
 *    原来那版是「我…你」的口吻，是一个人对另一个人说话；位置不对。
 * ② 上面那个小标题删掉 —— 共同层的抬头不该替他们先开口。
 *
 * 与 `photos/together/blessing.txt` 的内容保持逐字一致 —— 那个文件才是她真正读到的，
 * 这句只是她没收到文件时的兜底；两处语气不同的话，兜底会先露馅。
 *
 * 换行位置有意义：正式站 `.rd-blessing` 是 `white-space: pre-wrap`，
 * 应急页 `paragraphs()` 按它拆 `<p>`，两边的断行都由这个 `\n` 决定。
 */
export const DEFAULT_BLESSING =
  "（占位文案：请把这里换成你想让对方读到的那段话。\n" +
  "正式内容以 photos/together/blessing.txt 为准 —— 那个文件才是对方真正读到的。）";

/**
 * epoch 毫秒 → "YYYY-MM-DD"，**按东八区**。
 *
 * 先把时刻平移 +8h 再取 UTC 日期，得到的就是东八区那天的日历日。
 * 不用 `toLocaleString` / `getFullYear`：那些读设备时区，换一台机器结论就变了
 * （CONSTRAINTS §1 的禁项）。`toISOString` 走 UTC，与机器时区无关。
 *
 * @param {number} t
 * @returns {string}
 */
export function ymd(t) {
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- *
 * 库
 * -------------------------------------------------------------------------- */

/**
 * 共同层的全部预编译语句。句柄在路由构造时建一次，seed 另开一份。
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function prepareShared(db) {
  return {
    // 契约里的 photos 数组：ord 升序。INNER JOIN 哨兵 entry：
    // 没有 photo 元数据的行渲染不出来，直接不出现
    together: db.prepare(
      "SELECT s.id, s.ord, p.id AS photo_id, p.w, p.h FROM shared s " +
        `JOIN photo p ON p.id = s.body AND p.entry_id = '${SHARED_ENTRY_ID}' ` +
        "WHERE s.kind = 'together_photo' ORDER BY s.ord",
    ),
    blessing: db.prepare("SELECT body FROM shared WHERE kind = 'blessing' ORDER BY ord LIMIT 1"),
    slot: db.prepare("SELECT id, body FROM shared WHERE id = ?"),
    photoMeta: db.prepare("SELECT id, entry_id FROM photo WHERE id = ?"),
    ensureSharedEntry: db.prepare(
      "INSERT INTO entry(id, owner, kind, body, ord, created, deleted) " +
        "VALUES(?, ?, 'photo', NULL, 0, ?, NULL) " +
        "ON CONFLICT(id) DO UPDATE SET owner=excluded.owner",
    ),
    upsertSlot: db.prepare(
      "INSERT INTO shared(id, kind, body, ord) VALUES(?, 'together_photo', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET body=excluded.body, ord=excluded.ord",
    ),
    upsertPhoto: db.prepare(
      "INSERT INTO photo(id, entry_id, mime, bytes, w, h) VALUES(?,?,?,?,?,?) " +
        "ON CONFLICT(id) DO UPDATE SET entry_id=excluded.entry_id, mime=excluded.mime, " +
        "bytes=excluded.bytes, w=excluded.w, h=excluded.h",
    ),
    upsertBlessing: db.prepare(
      "INSERT INTO shared(id, kind, body, ord) VALUES(?, 'blessing', ?, 0) " +
        "ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    ),
    allSlots: db.prepare("SELECT id, body FROM shared WHERE kind = 'together_photo' ORDER BY ord"),
    // 清掉陈旧槽位：只删行，**不删盘上文件**。
    // 用户从 9 张减到 3 张还继续在九宫格里看到旧的 6 张，是「以为换掉了其实没换」，
    // 比报个警更糟。文件留着，素材放回来重跑 seed 就能复原。
    dropSlot: db.prepare("DELETE FROM shared WHERE id = ? AND kind = 'together_photo'"),
    dropPhoto: db.prepare("DELETE FROM photo WHERE id = ?"),
  };
}

/**
 * `GET /api/shared` 的响应体，形状与工单契约逐字对齐。
 * 素材没导进来时 photos 是空数组（前端走占位块），blessing 是空串而不是 null。
 *
 * @param {ReturnType<typeof prepareShared>} store
 */
export function shapeShared(store) {
  const bless = store.blessing.get();
  return {
    photos: plainAll(store.together.all()).map((r) => ({
      id: r.id,
      photoId: r.photo_id,
      w: r.w,
      h: r.h,
    })),
    blessing: bless && typeof bless.body === "string" ? bless.body : "",
    from: ymd(START_AT),
    to: ymd(UNLOCK_AT),
    days: ANNIVERSARY_DAYS,
  };
}

/* -------------------------------------------------------------------------- *
 * 写（seed）
 * -------------------------------------------------------------------------- */

const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

/** 自然序：`2.jpg` 排在 `10.jpg` 前面，字典序会反过来 */
function naturalCompare(a, b) {
  const as = a.match(/(\d+|\D+)/g) ?? [];
  const bs = b.match(/(\d+|\D+)/g) ?? [];
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 合照的文件 id：由「素材文件名 + 素材字节」定出来，不含随机数。
 *
 * 随机 id 的后果是每跑一次 seed 就重新压一遍 9 张图，顺带多出 9 个
 * 没人认领的孤儿文件。内容定出来的 id 让同一张素材永远落在同一个文件名上：
 * 第二遍 seed 算出同一个 id，发现行和文件都在，直接跳过压缩。
 * 形状与 `newPhotoId()` 一致（p + 24 位十六进制），所以读图那条路上
 * 合照不需要任何特例。
 *
 * @param {string} name 素材文件名
 * @param {Buffer} bytes 素材原始字节
 * @returns {string}
 */
export function photoIdFor(name, bytes) {
  const h = createHash("sha256").update(Buffer.from(name, "utf8")).update(bytes).digest("hex");
  return "p" + h.slice(0, 24);
}

/**
 * 素材目录里 `blessing.txt` 的**原文**，没有或读空就是空串。
 *
 * 与 `readBlessing` 分开是因为调用方要能区分两件不同的事：
 * 「用户自己放了文案」和「我们兜底给一句」。素材目录空着的时候，
 * 拿兜底文案去判断「用户是不是放了文案」会永远为真。
 *
 * **换行一律归一成 LF。** 记事本存出来的就是 CRLF，不归一的话库里会躺着一个
 * 裸的 \r：网页上 HTML 会把它归一掉、看不出差别，但应急页产物里会变成
 * `两年了。\r<br>`——一个躺在交付文件里的控制字符。归一在源头做一次，
 * 后面读库、导出、幂等比较拿到的都是同一份干净文本。
 */
function readBlessingFile(materialDir) {
  try {
    return fs.readFileSync(path.join(materialDir, BLESSING_FILE), "utf8").replace(/\r\n?/g, "\n").trim();
  } catch {
    // 没有这个文件是正常情况，不是错误
    return "";
  }
}

/**
 * 祝福语正文：素材目录里有 `blessing.txt` 就用它（用户能自己改文案），
 * 没有或读空了退回 DEFAULT_BLESSING。
 */
function readBlessing(materialDir) {
  return readBlessingFile(materialDir) || DEFAULT_BLESSING;
}

/**
 * 扫素材目录。
 * @returns {{ok: true, files: string[]} | {ok: false, reason: string}}
 */
export function readMaterial(materialDir) {
  let dirents;
  try {
    dirents = fs.readdirSync(materialDir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: `素材目录 ${materialDir} 不存在` };
  }
  const files = dirents
    .filter((d) => d.isFile() && IMAGE_EXT.has(path.extname(d.name).toLowerCase()))
    .map((d) => d.name)
    .sort(naturalCompare);
  if (files.length === 0) {
    return { ok: false, reason: `素材目录 ${materialDir} 里没有图片` };
  }
  return { ok: true, files };
}

/**
 * 把 `photos/together/` 导入共同层。**幂等**：重复跑不产生重复行，
 * 同一张素材不会重新压缩。
 *
 * 素材目录不存在或没有图片时**正常返回**（ok:false + 原因），不动库一个字节——
 * 用户还没放图是常态，不是故障。
 *
 * @param {object} args
 * @param {import("node:sqlite").DatabaseSync} args.db
 * @param {string} args.photosDir 700 照片目录（与上传同一个）
 * @param {string} args.materialDir 素材目录 photos/together/
 * @param {() => number} args.now 注入的时钟，取 created 用；业务代码不自己取时间
 * @returns {Promise<{ok: false, reason: string} | {
 *   ok: true, imported: number, reused: number, dropped: string[], stale: string[],
 *   failed?: string[], blessingOnly?: true
 * }>}
 */
export async function importShared({ db, photosDir, materialDir, now }) {
  if (typeof now !== "function") throw new Error("importShared 需要注入的 now()");
  const material = readMaterial(materialDir);
  if (!material.ok) {
    // 祝福语与合照是**两件事**，不能被同一条早退一起跳过。
    // 早先这里直接 return：于是「只改了文案、还没放图」会安静地丢掉祝福语，
    // 界面上读到的还是缺省那句，而 seed 只报「没有图片」——看起来一切正常。
    //
    // 只认**文件本身**：没有 blessing.txt 就照旧什么都不写，
    // 否则空目录跑一次 seed 就会把兜底文案写进库，把「还没折」变成「已折」。
    const b = readBlessingFile(materialDir);
    if (b) {
      prepareShared(db).upsertBlessing.run(BLESSING_ID, b);
      return { ok: true, imported: 0, reused: 0, dropped: [], stale: [], failed: [], blessingOnly: true };
    }
    return material;
  }

  const store = prepareShared(db);
  const dir = ensurePhotosDir(photosDir);
  const used = material.files.slice(0, SHARED_PHOTO_SLOTS);
  let reused = 0;
  const failed = [];

  db.exec("BEGIN");
  try {
    // 唯一那一条哨兵 entry 行：全部合照的 photo.entry_id 都指它
    store.ensureSharedEntry.run(SHARED_ENTRY_ID, SHARED_OWNER, now());

    for (const [i, name] of used.entries()) {
      // 逐张隔离：一张坏图（截断、0 字节、伪装成图片的东西）只该废掉它自己那一格，
      // 不该把已经压好的前两张一起拖下水。坏文件名记下来，结束时一起报。
      try {
        const slot = `sh${i + 1}`;
        const raw = fs.readFileSync(path.join(materialDir, name));
        const photoId = photoIdFor(name, raw);
        const file = photoPath(dir, photoId);
        if (!file) throw new Error(`合照 id 形状不合法：${photoId}`);

        // 同一张素材：行、元数据、文件都在 → 原地复用，不重压也不重写盘
        const cur = store.slot.get(slot);
        const meta = store.photoMeta.get(photoId);
        if (cur && cur.body === photoId && meta && meta.entry_id === SHARED_ENTRY_ID && fs.existsSync(file)) {
          reused++;
          continue;
        }

        // 与上传同一条管线：服务端兜底压缩、只落压好的 JPEG、原图不落盘
        const shot = await processImage(raw);
        writePhoto(dir, photoId, shot.data);
        store.upsertSlot.run(slot, photoId, i + 1);
        store.upsertPhoto.run(photoId, SHARED_ENTRY_ID, OUT_MIME, shot.data.length, shot.width, shot.height);
      } catch (err) {
        failed.push({ name, reason: err?.message ?? String(err) });
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    // 这里**不**删文件：id 是内容定出来的，同一个 id 可能正挂着上一轮的好数据。
    // 宁可盘上多一个没人引用的文件，也不要把已经能读的照片删了。
    throw err;
  }

  // 祝福语：稳定 id + UPSERT，与合照分开的事务
  store.upsertBlessing.run(BLESSING_ID, readBlessing(materialDir));

  // 陈旧槽位：这一轮没有对应素材的。删行让它们从九宫格上退下去，
  // 但**不删盘上文件**——素材放回来重跑 seed 就复原，可逆。
  const kept = new Set(used.map((_, i) => `sh${i + 1}`));
  const stale = plainAll(store.allSlots.all())
    .map((r) => r.id)
    .filter((id) => !kept.has(id));
  for (const id of stale) {
    const cur = store.slot.get(id);
    store.dropSlot.run(id);
    if (cur?.body) store.dropPhoto.run(cur.body);
  }

  return {
    ok: true,
    imported: used.length,
    reused,
    // 九宫格只有 9 格，多出来的素材不导：让用户知道有图被丢下了
    dropped: material.files.slice(SHARED_PHOTO_SLOTS),
    // 这一轮因解码失败被跳过的素材，名字与原因都报出来，别让用户对不上数
    failed,
    // 已从九宫格上清掉的上一轮槽位（盘上文件仍在，可复原）
    stale,
  };
}
