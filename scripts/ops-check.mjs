/**
 * 运维只读体检。**一个命令回答「服务还好不好」**。
 *
 * 2026-10-06 的起因：那天要判断线上状态，我写了 5 个探查脚本才查全。
 * 「运维时时不时查一下」这件事如果每次都要 SSH 上去手敲十几行，
 * 它就不会被做 —— 所以本脚本的价值不是覆盖得多，是**一次跑完、退出码可判**。
 *
 * ── 硬约束：只读 ───────────────────────────────────────────────────────
 * 全文没有一个写操作：不开文件写、不改库、不重启服务、不改配置。
 * 库用 `readOnly: true` 打开（`node:sqlite` 在这一模式下拒绝写）。
 * 理由不是洁癖 —— 它是**权限边界**。这个脚本将来的使用者不一定是当初
 * 部署它的人，而「一个体检脚本能删生产库」是任何时候都不该存在的东西。
 *
 * ── 怎么用 ─────────────────────────────────────────────────────────────
 *   本机跑（推荐，脚本从本机出发，服务器上什么都不留）：
 *     node scripts/ops-check.mjs --base http://127.0.0.1:8300 \
 *                               --db /opt/two-years/data/two-years.db
 *   走 SSH（在服务器上跑，库路径就是生产路径）：
 *     ssh <host> 'sudo -u two-years /opt/node24/bin/node ... scripts/ops-check.mjs --base http://127.0.0.1:8300'
 *
 *   退出码：0 = 全绿；1 = 有 FAIL（逐条打印）；2 = 自身跑不起来（配置/依赖问题）。
 *   2 与 1 分开，是因为「体检脚本自己坏了」和「服务坏了」要能区分开。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** 从命令行读参数。**`--key=value` 与 `--key value` 两种写法都认。**
 *
 * 只认等号那一种时，`--base http://127.0.0.1:8300` 会把 `BASE` 变成字符串
 * `"true"` —— 而 `ops/LOGGING.md` 里给的就是空格形式。
 * 报告出来的错会是「服务没起」，指向一个完全不对的方向。
 * 判据是：**文档与提示里怎么写，就怎么支持**。
 *
 * 故意不引 yargs/commander：为一个只读体检脚本解析 6 个参数引入依赖，
 * 会让开源版的安装步骤变长，而它完全没必要。 */
function parseArgs(argv) {
  const out = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(rest[i]);
    if (!m) continue;
    const key = m[1];
    if (m[2] !== undefined) out[key] = m[2];
    else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) out[key] = rest[++i];
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const BASE = String(args.base || "http://127.0.0.1:8300");
const DB = args.db ? String(args.db) : null;
const LOG_DIR = args["log-dir"] ? String(args["log-dir"]) : null;
const PHOTOS_DIR = args["photos-dir"] ? String(args["photos-dir"]) : null;
const EXPECT_UNLOCKED = args["expect-unlocked"] === undefined ? null : args["expect-unlocked"] === "true";

const checks = [];
function ok(name, detail) {
  checks.push({ name, level: "OK", detail });
  console.log(`  \x1b[32mOK  \x1b[0m ${name}${detail ? "  — " + detail : ""}`);
}
function warn(name, detail) {
  checks.push({ name, level: "WARN", detail });
  console.log(`  \x1b[33mWARN\x1b[0m ${name}${detail ? "  — " + detail : ""}`);
}
function fail(name, detail) {
  checks.push({ name, level: "FAIL", detail });
  console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? "  — " + detail : ""}`);
}
function head(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

async function main() {
  console.log(`运维体检  base=${BASE}${DB ? "  db=" + DB : ""}`);
  console.log(`只读：不改任何配置、不写库、不重启服务。`);

  // ---- 1. 服务在不在、答不答话 ----
  head("1. 服务");
  let status = null;
  try {
    const r = await fetch(BASE + "/api/status", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    status = await r.json();
    ok("进程答话", `HTTP 200`);
  } catch (e) {
    fail("进程答话", `${BASE}/api/status → ${e.message}（服务没起、或绑的不是这个地址）`);
  }

  // ---- 2. 绑定与时间锁 ----
  head("2. 时间锁与绑定");
  if (status) {
    ok("开门状态", `unlocked=${status.unlocked}  开门时刻=${status.unlockLabel}`);
    if (EXPECT_UNLOCKED !== null) {
      if (status.unlocked === EXPECT_UNLOCKED) ok("开门状态符合预期", `期望 ${EXPECT_UNLOCKED}`);
      else fail("开门状态符合预期", `期望 ${EXPECT_UNLOCKED}，实际 ${status.unlocked}`);
    }
    // 闸门：共同层在**未开门**时必须 404，**开门后**匿名也必须 401。
    // 两个方向都查 —— 只查一个的话，把闸门整个删掉也照样「通过」。
    try {
      const g = await fetch(BASE + "/api/shared", { signal: AbortSignal.timeout(8000) });
      const want = status.unlocked ? 401 : 404;
      if (g.status === want) ok("共同层闸门", `匿名 ${g.status}（期望 ${want}）`);
      else fail("共同层闸门", `匿名 ${g.status}，期望 ${want} —— 闸门可能被翻掉了`);
    } catch (e) {
      fail("共同层闸门", e.message);
    }
  }

  // ---- 3. 静态泄露面 ----
  head("3. 照片未被静态直出");
  for (const p of ["/photos/x.jpg", "/data/photos/x.jpg", "/uploads/x.jpg", "/public/x.jpg"]) {
    try {
      const r = await fetch(BASE + p, { signal: AbortSignal.timeout(5000) });
      // express.static 对不存在的文件也会走 404 兜底，所以「200」才是问题。
      if (r.status === 200) fail("猜路径 " + p, "返回 200 —— 有东西被零鉴权直出了");
      else ok("猜路径 " + p, String(r.status));
    } catch (e) {
      warn("猜路径 " + p, e.message);
    }
  }

  // ---- 4. 库的不变量 ----
  head("4. 数据不变量");
  if (!DB) {
    warn("库不变量", "未传 --db，跳过（生产库在 /opt/two-years/data/two-years.db）");
  } else if (!existsSync(DB)) {
    fail("库文件存在", `${DB} 不存在 —— 路径不对，或服务根本没建库`);
  } else {
    let db;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(DB, { readOnly: true });
    } catch (e) {
      fail("只读打开库", e.message + "（node:sqlite 要 Node ≥22.5；这台机器要用 /opt/node24/bin/node）");
    }
    if (db) {
      const n = (sql, ...p) => Object.values(db.prepare(sql).get(...p))[0];
      const now = () => Date.now();
      try {
      // login_fail 是限流表，两个账号共用。判据**不是**「行数必须为 0」——
      // 那是初版写法，2026-10-06 被独立复审推翻：一次「故意给错 PIN 验观察者入口
      // 是否真的起不来」的**审计探测**就会写一行 `fails=1, locked_until=0`，
      // 而那是**无害**的。把它判成 FAIL 会让人去查一个不存在的攻击。
      //
      // 真正的风险是**有人被锁**（locked_until > now）或**快到锁的阈值**（fails 逼近 5）。
      let lf = [];
      try {
        lf = db.prepare("SELECT ip, fails, locked_until FROM login_fail").all();
      } catch {}
      const t = now();
      const locked = lf.filter((r) => r.locked_until > t);
      const nearLock = lf.filter((r) => r.locked_until <= t && r.fails >= 3);
      if (locked.length) {
        fail(
          "没有人被锁在门外",
          `${locked.length} 行 locked_until 仍在未来（如 ${JSON.stringify(locked[0])}）` +
            `—— 有人连错口令把两个人一起锁了。查 ops/TROUBLESHOOTING.md §5`,
        );
      } else if (nearLock.length) {
        fail(
          "没有人快被锁",
          `${nearLock.length} 行 fails 已 ≥3（如 ${JSON.stringify(nearLock[0])}）` +
            `—— 再错 2 次就锁 10 分钟。查 ops/TROUBLESHOOTING.md §5`,
        );
      } else if (lf.length) {
        warn(
          "login_fail 有残留行但无害",
          `${lf.length} 行，全部 fails<3 且未锁定（如 ${JSON.stringify(lf[0])}）。` +
            `常见来源是一次「故意错 PIN 验拒绝路径」的审计探测 —— 无害，不用处理。`,
        );
      } else {
        ok("没有人被锁在门外", "login_fail 为空");
      }

        // @shared-layer 哨兵：共同层 9 张合照都指它，删了就读不出图。
        const sentinel = n("SELECT count(*) FROM entry WHERE id = ?", "@shared-layer");
        if (sentinel === 1) ok("@shared-layer 哨兵在", "共同层合照的外键没断");
        else fail("@shared-layer 哨兵在", `${sentinel} 行（期望 1）—— 共同层九宫格会读不出图，别删`);

        // MK 标记：e2e 播种的每条内容都带一个只属于它的标记。
        // 生产库里必须零命中 —— 有命中就是 e2e 的写操作污染了真数据。
        let mk = 0;
        for (const t of ["entry", "photo", "shared", "wish"]) {
          let cols = [];
          try {
            cols = db.prepare("SELECT name FROM pragma_table_info(?)").all(t).map((r) => r.name);
          } catch {
            continue;
          }
          for (const c of cols) {
            try {
              mk += n(`SELECT count(*) FROM ${t} WHERE CAST(${c} AS TEXT) LIKE ?`, "MK-%");
            } catch {}
          }
        }
        if (mk === 0) ok("零 MK 测试标记", "e2e 没有污染真数据");
        else fail("零 MK 测试标记", `${mk} 处命中 —— 生产库混进了 e2e 的测试内容`);

        // 观测值（不是不变量，只报出来给��对基线）
        const row = {
          entry: n("SELECT count(*) FROM entry"),
          photo: n("SELECT count(*) FROM photo"),
          shared: n("SELECT count(*) FROM shared"),
          wish: n("SELECT count(*) FROM wish"),
          session: n("SELECT count(*) FROM session"),
        };
        console.log(`  INFO 观测值 entry=${row.entry} photo=${row.photo} shared=${row.shared} wish=${row.wish} session=${row.session}`);
        console.log(`        session 只涨不跌（每跑一次线上冒烟就多几行），别当不变量。`);
      } finally {
        db.close();
      }
    }
  }

  // ---- 5. 照片目录权限 ----
  head("5. 照片目录权限");
  if (!PHOTOS_DIR) {
    warn("照片目录", "未传 --photos-dir，跳过（生产在 /opt/two-years/data/photos）");
  } else {
    try {
      const st = statSync(PHOTOS_DIR);
      const mode = st.mode & 0o777;
      const n = readdirSync(PHOTOS_DIR).length;
      if (mode === 0o700) ok("目录 700", `${PHOTOS_DIR}（${n} 个文件）`);
      else fail("目录 700", `${PHOTOS_DIR} 实测 ${mode.toString(8)} —— 同机任何账号都能读走照片`);
    } catch (e) {
      warn("照片目录", e.message);
    }
  }

  // ---- 6. 日志 ----
  head("6. 运维日志");
  if (!LOG_DIR) {
    warn("日志目录", "未传 --log-dir，跳过（生产在 /opt/two-years/data/logs）");
  } else if (!existsSync(LOG_DIR)) {
    warn("日志目录", `${LOG_DIR} 不存在 —— 2026-10-06 那版线上还没部署，日志未生效（属预期）`);
  } else {
    try {
      const names = readdirSync(LOG_DIR).filter((f) => /^access-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      let bytes = 0;
      for (const f of names) bytes += statSync(path.join(LOG_DIR, f)).size;
      // ⚠️ `names.sort()` 与 `names.pop()` **都原地改这个数组**。
      //   第一版写成 `fs2.sort().pop()` 之后紧接一行 `fs2.length` ——
      //   报出来是「0 个文件 / 0.9KB」而目录里明明有 1 个。
      //   2026-10-06 独立复审实测逮到。复制一份再排序/取尾，两个读法各拿一份。
      const sorted = [...names].sort();
      const newest = sorted.length ? sorted[sorted.length - 1] : "（无）";
      ok("日志目录", `${sorted.length} 个文件 / ${(bytes / 1024).toFixed(1)}KB，最新 ${newest}`);
    } catch (e) {
      warn("日志目录", e.message);
    }
  }

  // ---- 汇总 ----
  const bad = checks.filter((c) => c.level === "FAIL").length;
  const wrn = checks.filter((c) => c.level === "WARN").length;
  console.log("");
  if (bad) {
    console.log(`\x1b[31m结论：${bad} 项 FAIL、${wrn} 项 WARN —— 服务有问题，先看上面 FAIL 的行。\x1b[0m`);
    process.exit(1);
  }
  if (wrn) {
    console.log(`\x1b[33m结论：0 项 FAIL、${wrn} 项 WARN —— 服务正常，有跳过的项（多为没传参数）。\x1b[0m`);
    process.exit(0);
  }
  console.log("\x1b[32m结论：全绿，服务正常。\x1b[0m");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\x1b[31m体检脚本自身跑不起来：${e.message}\x1b[0m`);
  console.error("这与服务状态无关 —— 退出码 2 就是给这种情况的，别当成服务坏了。");
  process.exit(2);
});
