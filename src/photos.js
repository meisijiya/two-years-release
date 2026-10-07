/**
 * 照片：服务端兜底压缩 + 落盘 —— 时间锁在**文件侧**的那一半。
 *
 * 三条不变量，贯穿整个文件：
 *   1. 照片只落 data/photos（权限 700），**永不进 public/**。
 *      public/ 由 express.static 无鉴权直出，照片进去等于取消时间锁。
 *   2. 文件名用随机 id，不用原始文件名 —— 原始名泄露信息（相机、日期、地点）还会撞名。
 *   3. 长边 ≤ 1600 / JPEG / 单张 < 300KB 由服务端兜底：前端压过也不放过，
 *      有人绕过前端直传原图时这里是最后一道。
 *
 * 本文件不碰时间：created 由路由从注入的时钟取，本文件一个 Date.now 都不写。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 原始体积上限。浏览器端 canvas 已经先压过一道（0.72），所以正常路径远到不了这里；
 * 这个线只用来挡「原图直传」和构造出来的大包。
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 兜底压缩后的规格：SPEC §四 图片处理 */
export const MAX_LONG_EDGE = 1600;
export const MAX_OUT_BYTES = 300 * 1024; // 300KB
export const OUT_MIME = "image/jpeg";

/**
 * 只收这些图片容器。**MIME 是客户端自报的**，能不能解开由 sharp 再判一道 ——
 * 把 .txt 改名成 .jpg 骗得过 fileFilter，骗不过解码。
 * （不收 heic：浏览器 canvas 同样解不开，收到只会在解码那步变成 400。）
 */
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/bmp",
  "image/tiff",
]);

/** 严格 id 形状：路由参数拼路径之前必须过这一关 */
const ID_RE = /^p[0-9a-f]{24}$/;

/** MIME 是不是我们收的（允许 `; charset=` 之类的尾巴，且比大小写） */
export function acceptsMime(mime) {
  if (typeof mime !== "string") return false;
  return ALLOWED_MIME.has(mime.split(";")[0].trim().toLowerCase());
}

/** 文件头（扩展名）写死：落盘的永远是 JPEG，读取时不必再信任何扩展名 */
const EXT = ".jpg";

/** 解码器认出来的格式，只收这些。SVG / PDF / 视频等一律拒收。 */
const RASTER_FORMATS = new Set(["jpeg", "png", "webp", "avif", "gif", "bmp", "tiff", "heif"]);

/* -------------------------------------------------------------------------- *
 * 目录
 * -------------------------------------------------------------------------- */

/**
 * 照片目录跟着数据库文件走：生产是 data/photos，测试是临时库旁边的 photos/。
 * 一个注入参数也不用加，也不会有人把测试文件写进仓库。
 */
export function photosDirFor(db) {
  const rows = db.prepare("PRAGMA database_list").all();
  const file = rows.find((r) => r.name === "main")?.file;
  // 内存库（file 为空）退回仓库下的 data/photos
  return file ? path.join(path.dirname(file), "photos") : path.join(ROOT, "data", "photos");
}

/** 建目录并收紧权限。win32 没有 POSIX 位，chmod 跳过（与 server.js 一致）。 */
export function ensurePhotosDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * `realpathSync` 的软链解析版，路径不存在时给 null 而不是抛。
 *
 * 首次启动时照片目录还没建出来，realpath 必然 ENOENT——那不是「没问题」，
 * 只是「这一遍判不了」，所以调用方必须同时保留字面那一遍。
 */
function realpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** 一条越界判定的正文。字面与解析过软链的两次判定共用它，免得两处说法不一致。 */
function assertOutside(photos, pub, shown) {
  if (photos === pub || photos.startsWith(pub + path.sep)) {
    throw new Error(
      `照片目录 ${shown} 落在静态资源目录 ${pub} 里面：` +
        `照片会被 express.static 零鉴权直出，时间锁当场作废。` +
        `请把 DATA_DIR 指到 public/ 之外，并确认 ${shown} 不是指向 public/ 的软链接。`,
    );
  }
}

/**
 * 照片目录绝不能落在静态根里面。
 *
 * `DATA_DIR` 是环境变量，任何一次指向 `public/` 内的部署或迁移，
 * 都会让 `express.static` 把照片零鉴权直出——时间锁当场作废，而且不报任何错。
 * 这里在启动时硬断言，不满足直接退出，宁可起不来也不能悄悄开门。
 *
 * **判两遍，两遍都要。**
 *   1. 字面（`path.resolve`）：解析 `..`、`.`、重复斜杠。路径还没建出来时
 *      （首次启动）只有这一遍能判，而那正是最该拦的情况。
 *   2. 解析过软链接（`realpathSync`）：`express.static` 走 `fs.stat`，**会跟随链接**。
 *      所以「`data/photos` 是一个指向 `public/evil` 的符号链接」在字面比较下
 *      完全看不出来——实测这种形态下服务照常启动，照片从静态路 200 直出，
 *      带有效会话、门没开也一样拿得到字节。只判字面的话，
 *      CONSTRAINTS §2 写的「不满足直接起不来」是假的。
 *
 * 前提是本机文件系统写权限（运营者本人），不是远程可利用；补这一遍是为了让
 * 断言的覆盖范围和它宣称的保护范围对得上。
 *
 * @param {string} photosDir
 * @param {string} publicDir 静态根
 * @returns {string} 规范化后的 photosDir
 * @throws 当 photosDir 位于 publicDir 之内，或两者相同（字面或软链任一成立）
 */
export function assertPhotosOutsideStatic(photosDir, publicDir) {
  const a = path.resolve(photosDir);
  const b = path.resolve(publicDir);
  assertOutside(a, b, a);

  const ra = realpathOrNull(a);
  const rb = realpathOrNull(b);
  if (ra && rb && (ra !== a || rb !== b)) assertOutside(ra, rb, a);

  return a;
}

/* -------------------------------------------------------------------------- *
 * 标识与路径
 * -------------------------------------------------------------------------- */

/** 随机 id：12 字节 → 24 位十六进制，猜不到也撞不上 */
export function newPhotoId() {
  return "p" + randomBytes(12).toString("hex");
}

export function isPhotoId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/**
 * id → 绝对路径。
 *
 * **不合法直接返回 null**：路由参数是用户输入，`../../etc/passwd`、`.`、`..`
 * 一律在这一步变成「不存在」，永远不参与 path.join。返回 null 的含义是 404。
 */
export function photoPath(dir, id) {
  return isPhotoId(id) ? path.join(dir, id + EXT) : null;
}

/* -------------------------------------------------------------------------- *
 * 压缩
 * -------------------------------------------------------------------------- */

/**
 * 降质阶梯：先按契约值（长边 1600 + q80）出片，超标就一档一档往下走。
 *
 * 降到达标为止，但**有下限**：走到最后一档还不达标也照收——
 * 宁可让最极端的一张到 300KB 出头，也不能把上传整个打回让她重选照片。
 * 前几档足够把正常照片收进 300KB 内（3000×2000 的纯噪声在 q80 下约 750KB，
 * 到 1280/q60 约 230KB）。
 */
const LADDER = [
  { edge: 1600, quality: 80 },
  { edge: 1600, quality: 68 },
  { edge: 1600, quality: 56 },
  { edge: 1280, quality: 56 },
  { edge: 1024, quality: 52 },
  { edge: 800, quality: 48 },
  { edge: 640, quality: 44 },
];

/**
 * 解码 → 按 EXIF 摆正 → 限长边 → 压到体积达标 → 返回 JPEG 字节。
 *
 * @param {Buffer} input 不可信的上传内容
 * @returns {Promise<{data: Buffer, width: number, height: number}>}
 * @throws 解不开（不是图片、文件被截断）时抛错，由路由回 400
 */
export async function processImage(input) {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new Error("空文件不是图片");
  // failOn:"error"：截断、损坏的图宁可拒收，也不放一个半张脸的 JPEG 进库
  const base = sharp(input, { failOn: "error" });

  // MIME 是客户端自报的，说了不算。用解码器自己认出来的格式复核一遍。
  // 少了这一步，谎报 image/jpeg 的 SVG 会被 librsvg 栅格化——脚本不随文件走，
  // 但等于给服务端的图片库开了一个本不该有的解析面。
  const probed = await base.metadata();
  if (!RASTER_FORMATS.has(probed.format)) {
    throw new Error(`只收位图，不收 ${probed.format || "认不出的格式"}`);
  }

  let last = null;
  for (const { edge, quality } of LADDER) {
    const out = await base
      .clone()
      .rotate() // 无参数 = 读 EXIF Orientation 自动摆正，竖拍不会躺着
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });
    last = { data: out.data, width: out.info.width, height: out.info.height };
    if (last.data.length < MAX_OUT_BYTES) return last;
  }
  return last; // 下限保护：最差的一档也交出去
}

/* -------------------------------------------------------------------------- *
 * 读写
 * -------------------------------------------------------------------------- */

/** 落盘：只写压好的 JPEG，**原图不落盘**（不给人留一份没压过的）。 */
export function writePhoto(dir, id, data) {
  const p = photoPath(dir, id);
  if (!p) throw new Error("照片 id 不合法");
  fs.writeFileSync(p, data, { mode: 0o600 });
  // writeFileSync 的 mode **只在创建时生效**。已存在且被改宽的文件会被原样保留，
  // 所以显式再 chmod 一次，把权限钉死在 600。
  if (process.platform !== "win32") fs.chmodSync(p, 0o600);
  return p;
}

/** 读盘：文件不在（被手工删了）返回 null，调用方回 404。 */
export function readPhoto(dir, id) {
  const p = photoPath(dir, id);
  if (!p) return null;
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/** 建行成功但库里没落成时回滚文件，避免留下没人认领的孤儿 */
export function removePhoto(dir, id) {
  const p = photoPath(dir, id);
  if (p) try { fs.rmSync(p, { force: true }); } catch {}
}
