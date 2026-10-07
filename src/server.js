/**
 * 生产入口。
 * 库与照片目录都在 data/ 下，photos 目录权限 700 —— 照片绝不进静态资源目录。
 */
import fs from "node:fs";
import path from "node:path";
import { createApp, ROOT } from "./app.js";
import { openDb } from "./db.js";
import { systemClock } from "./clock.js";
import { createLogWriter, loadOrCreateSalt, DEFAULT_KEEP_DAYS, DEFAULT_MAX_BYTES } from "./logging.js";

const PORT = Number(process.env.PORT || 8300);

/**
 * 绑定地址：**默认只绑回环**。
 *
 * 部署形态是 nginx 在同一台机器上反代，走 127.0.0.1 就够。绑 0.0.0.0 等于在公网 IP 上
 * 另开一个裸 HTTP 入口：浏览器可以直接打 http://<公网IP>:8300，绕开 nginx 与证书。
 * 那样连过来的请求在 src/auth.js 的 isSecureRequest 眼里就是明文，cookie 不带 Secure，
 * 凭据明文发一次 —— 而用户以为自己在用 HTTPS。
 *
 * 真的要让外部直连（自测、局域网），显式 HOST=0.0.0.0。
 * 门禁 scripts/check-boot.mjs 会真去连非回环地址，连上了就红。
 */
const HOST = process.env.HOST || "127.0.0.1";

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PHOTOS_DIR = path.join(DATA_DIR, "photos");

fs.mkdirSync(PHOTOS_DIR, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(PHOTOS_DIR, 0o700);

const db = openDb(path.join(DATA_DIR, "two-years.db"));

/**
 * 运维访问日志（2026-10-06 加）。
 *
 * 落 `<DATA_DIR>/logs/`，权限 700/600，与 photos 同级 —— 都在 `ReadWritePaths` 里，
 * 也都被 `.gitignore` 的 `data/` 挡在版本库之外。日志**默认开着**：
 * 它要回答的正是「三个月后回来查一眼服务还好不好」，默认关掉等于没有。
 *
 * `LOG_KEEP_DAYS` / `LOG_MAX_BYTES` 可用环境变量覆盖，是为了让**调容量不用发版**。
 * 这两个键只控制保留策略，不参与任何鉴权，**补它们不会顶掉任何凭据**
 * （那是 `OBSERVER_PASSWORD` 那类键的性质，见 CONSTRAINTS §2b 与 AGENTS 工作规则）。
 * 解析用 `??` 而不是 `||`：写成 `|| ` 时 `LOG_MAX_BYTES=0` 会被吞成缺省值，
 * 而 0 是一个有意义的值（只留当天）。
 */
const KEEP_DAYS = Number(process.env.LOG_KEEP_DAYS ?? DEFAULT_KEEP_DAYS);
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES ?? DEFAULT_MAX_BYTES);
if (!Number.isFinite(KEEP_DAYS) || KEEP_DAYS < 1) {
  throw new Error(`LOG_KEEP_DAYS 非法：${process.env.LOG_KEEP_DAYS}（要 ≥1 的天数）`);
}
if (!Number.isFinite(MAX_BYTES) || MAX_BYTES < 0) {
  throw new Error(`LOG_MAX_BYTES 非法：${process.env.LOG_MAX_BYTES}（要 ≥0 的字节数）`);
}
const logWriter = createLogWriter({
  dir: path.join(DATA_DIR, "logs"),
  now: systemClock,
  keepDays: KEEP_DAYS,
  maxBytes: MAX_BYTES,
  salt: loadOrCreateSalt(DATA_DIR),
});
// bindHost 传的是**这里实际要 listen 的那个地址**，也就是 env 文件里生效的那个。
// 它决定应用采不采信 X-Forwarded-For（见 app.js 里的说明），所以必须传真实值，
// 不能让 app.js 自己猜默认值 —— 猜默认值就等于「生产绑定没人看守」。
// dataDir 同理：观察者的签名密钥落在它里面（见 observer-auth.js），
// 让 app.js 猜默认值会让密钥跑到仓库的 data/ 下去，而生产库在 /opt/two-years/data。
const app = createApp({ db, now: systemClock, bindHost: HOST, dataDir: DATA_DIR, logWriter });

app.listen(PORT, HOST, () => {
  console.log(`[two-years] listening on ${HOST}:${PORT}`);
  console.log(`[two-years] data dir  ${DATA_DIR}`);
  // 日志开在哪、留多久、封顶多少：启动时打一行。运维三个月后回来看，
  // 第一个问题就是「日志到底还留着吗」—— 答案不该只存在于某篇文档里。
  console.log(
    `[two-years] access log ${logWriter.dir}（保留 ${KEEP_DAYS} 天，上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
