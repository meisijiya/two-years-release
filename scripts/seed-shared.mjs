/**
 * 共同层导入：photos/together/ → shared / shared_photo + 700 照片目录。
 *
 * 幂等，可以随便重跑：同一张素材算出同一个照片文件 id，第二次跑直接复用
 * 盘上那份，不重新压缩、不产生重复行。
 *
 * 素材目录不存在或没有图片时**正常退出**并说明原因（退出码 0）：
 * 用户还没放图是常态，不是故障。阅读流的九宫格会走占位块。
 *
 *   node scripts/seed-shared.mjs
 *
 * 环境变量：
 *   DATA_DIR      库与照片目录的位置，默认 <仓库>/data（与 src/server.js 同一个）
 *   DB_FILE       直接指定库文件，优先于 DATA_DIR（测试用）
 *   MATERIAL_DIR  素材目录，默认 <仓库>/photos/together
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { systemClock } from "../src/clock.js";
import { assertPhotosOutsideStatic, ensurePhotosDir, photosDirFor } from "../src/photos.js";
import { BLESSING_ID, importShared } from "../src/shared.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "two-years.db");
const MATERIAL_DIR = process.env.MATERIAL_DIR || path.join(ROOT, "photos", "together");

const db = openDb(DB_FILE);
let exitCode = 0;
try {
  // 照片目录跟着库走；先跑 03 的启动自检，宁可启动失败也不能把照片写进 public/
  const photosDir = ensurePhotosDir(photosDirFor(db));
  assertPhotosOutsideStatic(photosDir, path.join(ROOT, "public"));

  // now 走 clock.js 的 systemClock：与 src/server.js 生产用的是同一个实现。
  // 业务代码不自己取时间，created 一律从注入的 now() 来。
  const r = await importShared({ db, photosDir, materialDir: MATERIAL_DIR, now: systemClock });

  if (!r.ok) {
    console.log(`[seed-shared] 跳过：${r.reason}`);
    console.log("[seed-shared] 共同层是空的——阅读流的九宫格会走占位块，这是预期行为。");
    console.log(`[seed-shared] 放好图之后重跑：${MATERIAL_DIR}`);
  } else {
    console.log(`[seed-shared] 导入 ${r.imported} 张合照（复用 ${r.reused} 张）→ ${photosDir}`);
    console.log(`[seed-shared] 祝福语已写入 shared#${BLESSING_ID}`);
    if (r.blessingOnly) {
      // 这一轮九宫格是空的，但文案是真的写进去了。不单独说一句的话，
      // 「导入 0 张」看起来像什么都没发生。
      console.log("[seed-shared] 注意：素材目录里没有图片，所以九宫格这次是空的——祝福语已经写进去了。");
      console.log(`[seed-shared] 放好合照之后重跑一次即可：${MATERIAL_DIR}`);
    }
    if (r.dropped.length) {
      console.log(`[seed-shared] 注意：九宫格只有 9 格，以下素材未导入：${r.dropped.join("、")}`);
    }
    if (r.stale.length) {
      // 只报不删：删行删文件不可逆，交回用户决定
      console.log(
        `[seed-shared] 注意：shared 里还留着本次没有对应素材的槽位 ${r.stale.join("、")}，` +
          "它们仍会被展示；确认要清掉的话手动删对应行与照片文件。",
      );
    }
  }
} catch (err) {
  // 走到这里是真故障（库写不进去、照片目录落在 public/ 里等），必须红
  console.error(`[seed-shared] 失败：${err?.message ?? err}`);
  exitCode = 1;
} finally {
  db.close();
}

process.exit(exitCode);
