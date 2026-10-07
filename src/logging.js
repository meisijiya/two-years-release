/**
 * 面向运维的访问日志：结构化、按天切分、总量有界、默认脱敏。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────
 * 2026-10-06 实测：应用侧**零访问日志**（journal 里只有启动那两行），
 * 而这台机器的 journal 是全机共享的（还跑着 docker / n8n / opencode），
 * 实测已用 196.5M / SystemMaxUse=200M。也就是说：
 *
 *  · 想判断「服务正不正常」只能去翻 nginx 的 access.log —— 那是 nginx 的日志，
 *    它记的是**字节数与状态码**，不记「谁在什么时候做了什么」，也分不清
 *    「两个人在用」和「扫描器在扫」；
 *  · 而 journal 快满了，继续往里写迟早被 systemd 静默丢弃。
 *
 * 所以这里给应用自己一份**有界**的日志：只回答运维要问的那几个问题
 * （服务在不在、谁在用、有没有 4xx/5xx、有没有人在撞门），
 * 并且**明确不记**任何凭据（见 redactPath / clientTag）。
 *
 * ── 为什么不引第三方日志库 ─────────────────────────────────────────────
 * express / multer / sharp 之外不再加依赖。这份日志要能直接读
 * （`cat` / `jq` / 一次 grep 就够），而「一份 50MB 上限、按天切、
 * 脱敏」的需求用 Node 标准库几十行就够。引 morgan/pino 会让开源版
 * 多一个依赖，而它带来的能力这里一项都用不上。
 *
 * ── 落点 ───────────────────────────────────────────────────────────────
 * `<dataDir>/logs/access-YYYY-MM-DD.jsonl`，权限 700 目录 / 600 文件。
 * 与 photos 同级 —— 都是**运行期数据**，都在 `ReadWritePaths` 里，
 * 也都被 `.gitignore` 的 `data/` 挡在版本库之外。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 保留天数。2026-10-06 用户选定：7 天。 */
export const DEFAULT_KEEP_DAYS = 7;

/** 总量上限。2026-10-06 用户选定：50MB。
 *
 *  为什么要有总量上限而只按天保留不够：日志量由**扫描器**决定，不由两人决定。
 *  实测公网每天约 220 个独立 IP、700 多条请求（其中大半是 wp-admin/.env/phpunit 扫描），
 *  照这个量级 7 天约 5MB —— 远不到 50MB。但扫描器升级、被人拿来做放大攻击时，
 *  一天就能写几百 MB。只按天保留的话，**第二天**就可能把盘写满。
 *
 *  ⚠️ **它挡的是「历史堆积」，不是「当天增量」** —— 见 `prune()` 里那条注释：
 *  今天那份文件正在被追加写，永不删。所以严格地说，
 *  100% 写满仍要「单日请求量 × 单条大小」足够大才会发生；
 *  上限把这件事从「一天」推迟到「很多天」，并让 7 天保留期有个总量边界。
 *  要真正给单日封顶，得在**请求侧**限流（`src/auth.js` 已有登录限流，
 *  但静态资源没有）—— 那不是这份日志的职责，诚实地记在这里而不是假装覆盖了。
 */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

const FILE_RE = /^access-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** 本地日期（不是 UTC）：运维按「哪一天」翻日志，用本地日历最直观。 */
function localDay(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把 `2026-10-06` 变成可比较的天序号，避免依赖时区解析。 */
function dayOrdinal(day) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/**
 * 路径脱敏：**query string 整段丢弃**，路径参数化。
 *
 * ⚠️ 为什么 query 整段丢而不是「挑几个键过滤」：凭据出现在 URL 里的形态
 *    没有穷举 —— `?pin=` / `?password=` / `?key=` / `?token=` / `?d=` …
 *    逐个加进黑名单的那一刻就已经晚了，而加漏一个的后果是**明文口令躺在盘上**。
 *    白名单（只留 `?` 前面的 path）是唯一「加漏了也不会出事」的那一种。
 *    实测线上 nginx 日志里 `?%ADd+allow_url_include%3d1` 这类扫描 payload
 *    正是走 query 的 —— 保留 query 等于替扫描器存了一份攻击面清单。
 *
 * 路径参数化同理：`/api/photo/p<20位>` 里的 id 不可猜测，但**它会随实现变化**，
 *  哪天 id 形态变成自增就变成了顺序泄露。写成 `/api/photo/:id` 则与实现解耦。
 */
export function redactPath(rawPath) {
  const p = String(rawPath || "/");
  const cut = p.indexOf("?");
  const bare = cut === -1 ? p : p.slice(0, cut);
  return bare
    .replace(/\/api\/photo\/[^/]+/g, "/api/photo/:id")
    .replace(/\/api\/entry\/[^/]+/g, "/api/entry/:id");
}

/**
 * 客户端标签：同一实例内稳定、跨实例不可比、**不可逆**的假名。
 *
 * ⚠️ 为什么用每实例随机盐（而不是裸 sha256）：IPv4 只有 2^32，
 *    裸哈希整个地址空间**秒级可穷举** —— 写进日志等于没脱敏，
 *    而日志是要能长期留存、甚至可能给第三方看的。
 *    随机盐让字典攻击失效：同一个人在不同实例上是不同标签（够用——
 *    运维只需要「这是不是同一个人」）。
 *
 * 盐落在 `<dataDir>/.log-salt`（600），与 `.observer-key` 同款做法：
 *  丢了会换一批标签（历史日志不再可比），但**不会**泄露任何地址。
 */
export function clientTag(ip, salt) {
  return "c-" + crypto.createHash("sha256").update(String(salt) + "|" + String(ip)).digest("hex").slice(0, 8);
}

/**
 * 读或建盐（600）。已存在就复用 —— 复用才能让历史日志可比。
 *
 * ⚠️ **照抄同仓 `observer-auth.js` 的 loadKey() 形状，这是有意的。**
 *   那里踩过：静默「重建」密钥 = 一次没人察觉的密钥轮换，
 *   所有已发出的凭据当场失效而日志里什么异常都没有。
 *   同一形状搬到这里的后果是同一种：**换盐会让历史日志的客户端假名全部对不上** ——
 *   「昨天和今天是同一个人吗」这个问题从此答不了，而没人知道为什么。
 *
 *   2026-10-06 独立复审实测：第一版用 `catch {}` + `if (v) return v`，
 *   文件存在但为空时**静默生成新盐并覆盖，无任何报错** ——
 *   方向还与 observer-auth 的注释正相反（那里把 ENOENT 与其它错误分开，
 *   这里用一个空 catch 把「读不到」和「不存在」混成一类）。
 *
 *   所以：**只有 ENOENT 走新建**，其余错误原样抛；短/空文件当损坏报。
 *   报出来的话要说清「删了会怎样」—— 不然下一个人会直接删掉它。
 */
export function loadOrCreateSalt(dataDir) {
  const file = path.join(dataDir, ".log-salt");
  let text = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw new Error(
        `读不到日志假名盐 ${file}（${err?.code || err}）。` +
          `这**不是**「还没有」—— 别去删它重建：` +
          `重建会换一批假名，历史日志与新日志的「同一个客户端」就对不上了。` +
          `多半是属主不对（服务以 two-years 跑，文件却是 root:root 600）。` +
          `修法：chown two-years:two-years ${file}`,
      );
    }
  }
  const v = String(text ?? "").trim();
  if (v) {
    if (v.length < 32) {
      throw new Error(
        `日志假名盐 ${file} 只有 ${v.length} 个字符（应当 ≥32），已损坏。` +
          `删掉它会换一批假名，让新旧日志对不上，需要你确认后手动处理。`,
      );
    }
    return v;
  }
  if (text !== null) {
    // 文件在但内容是空的：那是损坏，不是「还没有」
    throw new Error(
      `日志假名盐 ${file} 是空文件，已损坏。` +
        `删掉它会换一批假名，让新旧日志对不上，需要你确认后手动处理。`,
    );
  }

  const created = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, created, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return created;
}

/**
 * 建一个日志写入器。
 *
 * @param {object}   o
 * @param {string}   o.dir       日志目录（通常是 `<dataDir>/logs`）
 * @param {Function} o.now       可注入时钟（测试用假时钟，让轮转行为可复现）
 * @param {number}   o.keepDays  保留天数
 * @param {number}   o.maxBytes  总量上限
 * @param {string}   o.salt      客户端标签用的盐
 */
export function createLogWriter({ dir, now = Date.now, keepDays = DEFAULT_KEEP_DAYS, maxBytes = DEFAULT_MAX_BYTES, salt = "t" }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);

  let prunedForDay = null;

  function files() {
    return fs
      .readdirSync(dir)
      .filter((f) => FILE_RE.test(f))
      .sort(); // YYYY-MM-DD 定长，字典序 == 时间序
  }

  function totalBytes() {
    let n = 0;
    for (const f of files()) {
      try {
        n += fs.statSync(path.join(dir, f)).size;
      } catch {}
    }
    return n;
  }

  /**
   * 清理：**按天保留** + **总量封顶**。
   *
   *  两条各自独立、缺一不可：
   *  · 只按天：挡不住「一天之内被写爆」（见 DEFAULT_MAX_BYTES 的说明）；
   *  · 只封顶：会让「今天的日志被昨天的挤掉」—— 出问题时最想看的那天正好没了。
   *
   *  两条都以**最旧优先**删：先删超期的，删完还超量就继续往前删。
   *  幂等：同一份目录反复 prune 结果一致。
   */
  function prune() {
    const today = localDay(now());
    const cutoff = dayOrdinal(today) - (keepDays - 1);
    for (const f of files()) {
      if (dayOrdinal(f.slice(7, 17)) < cutoff) {
        try {
          fs.rmSync(path.join(dir, f));
        } catch {}
      }
    }
    let total = totalBytes();
    for (const f of files()) {
      if (total <= maxBytes) break;
      // ⚠️ 今天那份正在被追加写，永不删（2026-10-06 由一条测试逼出来的）。
      // 无差别删最旧的含当天那份，于是单条日志把上限顶穿时，prune 会把
      // **正在写的那个文件**删掉 —— 下一次 write 重建它，当天已写的内容凭空消失，
      // 而容量判据照样「通过」。形态与上面反对的「今天的日志被昨天的挤掉」同一种，
      // 只是方向反过来。所以上限的真实语义是：**历史文件总量 ≤ 上限**，
      // 当天的增量不受它约束（当天无界由请求量决定，实测约 160KB/天，远低于 50MB）。
      if (`access-${today}.jsonl` === f) continue;
      try {
        const size = fs.statSync(path.join(dir, f)).size;
        fs.rmSync(path.join(dir, f));
        total -= size;
      } catch {}
    }
    return total;
  }

  return {
    dir,
    keepDays,
    maxBytes,
    // 中间件要用它算客户端标签，所以必须挂出来 —— 否则 clientTag 会拿 undefined
    // 去哈希，出来的标签全部相同（「所有请求都来自同一个人」），而这恰恰是
    // 这份日志要回答的问题。
    salt,

    /**
     * 写一条事件。**只接受已经脱敏过的字段** —— 这里不做脱敏。
     *
     * 脱敏在调用方（`access()`）做，理由是：脱敏需要 `salt`，
     * 而 salt 属于本模块；把 `clientTag` 导出就是为了让中间件用它。
     * 这里再脱一次会让人误以为「传明文进来也行」。
     *
     * ⚠️ **容量判定在写完之后，不能只在「当天第一次写」时判。**
     *   2026-10-06 独立复审实测：早先只在跨天第一次 write 时 prune，
     *   于是同一个进程、同一天里连续写（cap=1000、30 次请求），
     *   总量从 1026 涨到 **4806，一个文件都没删** ——
     *   「一天之内被写爆」这个场景根本没被挡住，
     *   而 DEFAULT_MAX_BYTES 的注释与那条测试用例的标题都声称挡得住。
     *   **代码注释和测试标题在断言一个代码没有的性质。**
     *
     *   现在每次写完都判一次。代价是每条日志 stat 目录里（≤ keepDays 个）文件 ——
     *   实测量级 700 请求/天 × 8 次 stat，完全可忽略；
     *   而漏判的代价是「扫描器打一天就能把盘写满」。
     */
    write(event) {
      const today = localDay(now());
      if (prunedForDay !== today) {
        prune();
        prunedForDay = today;
      }
      const line = JSON.stringify({ ...event, day: today }) + "\n";
      const file = path.join(dir, `access-${today}.jsonl`);
      fs.appendFileSync(file, line, { mode: 0o600 });
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(file, 0o600);
        } catch {}
      }
      // 写完立刻判容量：这是「一天之内被写爆」的唯一防线
      if (totalBytes() > maxBytes) prune();
      return file;
    },

    prune,
    totalBytes,
    files,
  };
}

/**
 * 访问日志中间件。
 *
 * 只记**这一次请求的元数据**：方法、脱敏后的路径、状态码、耗时、客户端标签。
 * 不记请求体、不记响应体、不记 cookie、不记 query、不记明文 IP、不记错误堆栈 ——
 * 错误堆栈仍然走 journal（那里有完整信息且本来就在被 systemd 管着）。
 *
 * 这样两份日志是**互补**而不是重复：journal 回答「刚才那一秒崩在哪」，
 * 本日志回答「最近七天有没有人在用、有没有人在撞门、有没有 5xx」。
 */
export function accessLog({ writer, now = Date.now }) {
  return (req, res, next) => {
    const t0 = now();
    let recorded = false;
    const done = () => {
      if (recorded) return;
      recorded = true;
      try {
        writer.write({
          t: new Date(now()).toISOString(),
          ev: "access",
          m: req.method,
          p: redactPath(req.path || req.url),
          s: res.statusCode,
          ms: Math.max(0, now() - t0),
          c: clientTag(req.ip || "?", writer.salt),
        });
      } catch {
        // 日志失败绝不能连累请求：磁盘满、权限变了都不该让服务 500。
        // 静默是有意的 —— console.error 在这里会把刷屏的错误灌回 journal。
      }
    };
    res.on("finish", done);
    // 客户端半路断开时 finish 不触发，会漏记；close 补上，且 recorded 保证不重复。
    res.on("close", done);
    next();
  };
}
