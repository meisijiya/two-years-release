/**
 * 工单 06 · 部署脚本（不连服务器）
 *
 * 这个测试**真的把脚本跑起来**（bash），断言的是它的外部行为：
 * 退出码与输出。内容断言只钉三件要紧的事：Restart=always、密码不在仓库里、
 * 两个脚本都不连任何远端。
 *
 * ⚠️ 工单 06 全程没有访问过 <公网IP> 或任何服务器：这里跑的
 *    deploy.sh 默认就是 dry-run，probe-8300.sh 只读且只连 127.0.0.1。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { TEST_SECRET } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY = path.join(ROOT, "deploy");
const read = (f) => fs.readFileSync(path.join(DEPLOY, f), "utf8");

/** 找 bash：有 Git Bash 的 Windows、Linux、macOS 都能跑。找不到就如实跳过执行类断言。 */
function findBash() {
  const cands = [
    process.env.BASH,
    ...(process.platform === "win32"
      ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]
      : []),
    "bash",
  ].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}
const BASH = findBash();

/**
 * 跑一个 deploy/ 下的脚本。env 里不传密码 = 没有注入。cwd 默认仓库根。
 *
 * ⚠️ 观察者 PIN 必须**每次都给一个合规值**（≥6 位、且与两边口令两两不同）：
 *    deploy.sh 的第 3 条硬检查就是它，不给就在那里 exit 1，
 *    后面关于 DATA_DIR、链接目录、密码格式的检查**一条都跑不到**。
 *    （这条以前没人给，于是这半个文件是红的。）
 */
function run(script, args = [], env = {}, cwd = ROOT) {
  const merged = { ...process.env };
  for (const k of ["DOOR_PASSWORD", "HERO_PASSWORD", "OBSERVER_PASSWORD"]) delete merged[k];
  merged.OBSERVER_PASSWORD = TEST_SECRET.OBSERVER_PASSWORD;
  for (const [k, v] of Object.entries(env)) merged[k] = v;
  const r = spawnSync(BASH, [path.join(DEPLOY, script), ...args], {
    cwd, encoding: "utf8", env: merged, timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/**
 * 喂给 deploy.sh 的口令。**必须是纯数字的 4 位月日或 8 位完整生日**
 * （deploy.sh: ^[0-9]{4}$|^[0-9]{8}$），且两个值**必须不相同** ——
 * 同值等于一把钥匙开两个门，脚本自己也会因此 die。
 * 这里用的是 test/helpers.js 的人造测试口令，不是真人生日。
 */
const GOOD = { DOOR_PASSWORD: TEST_SECRET.DOOR_PASSWORD, HERO_PASSWORD: TEST_SECRET.HERO_PASSWORD };
/** 4 位月日形态：同一个测试口令的月日切法（birthdayForms 的 4 位分支） */
const SHORT = { door: "0101", hero: "0202" };

/* ══════════════════════════════════════════════════════════════════ */

test("systemd unit：Restart=always，且密码不在仓库里", () => {
  const unit = read("two-years.service");
  assert.match(unit, /^Restart=always$/m, "unit 里没有 Restart=always —— 10-5 当天宕机会毁掉整个礼物");
  assert.match(unit, /^EnvironmentFile=/m, "unit 没有从环境文件读配置");
  assert.match(unit, /^ExecStart=.*node.*src\/server\.js/m, "unit 的 ExecStart 起错了东西");
  assert.match(unit, /ReadWritePaths=.*data/, "unit 没有限定唯一可写目录");
  // 任何已知口令值都不许出现在 unit 里（今天已知的是三个测试口令）
  assert.ok(!/\b00010101\b|\b00020202\b|\b00030303\b/.test(unit), "unit 里出现了口令字面量");
  assert.ok(!/DOOR_PASSWORD\s*=\s*\S/.test(unit), "unit 里直接写了密码（应该走 EnvironmentFile）");
});

/** 剥掉整行注释再查内容：脚本头部注释里**应该**写清"没连过哪台服务器"，
 *  那是给人看的证据，不该被"脚本里不许出现地址"这条自己撞响。 */
const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("两个脚本都不连任何远端：没有 ssh / scp / 服务器地址", () => {
  for (const f of ["deploy.sh", "probe-8300.sh"]) {
    const src = codeOnly(read(f));
    assert.ok(!/42\.193\.183\.187|42\.194\.251\.211|119\.29\.52\.111/.test(src), `${f} 的可执行部分写了服务器地址`);
    // 只查**行首的调用**：脚本文案里那句「不 ssh/scp 任何主机」不算，
    // 真有一条远程命令的话，它必然出现在行首（或紧跟 ; && | 之后）。
    assert.ok(!/(^|[;&|]\s*)(ssh|scp|rsync|sftp)\s/m.test(src), `${f} 里出现了远程传输命令`);
    // 允许出现的网络命令只有本机自检的 curl，且目标必须是回环地址
    // （只看真正带参数的调用：`has curl` 那种存在性判断不算）
    for (const m of src.matchAll(/[^\n]*curl\s+-[^\n]*/g)) {
      assert.match(m[0], /127\.0\.0\.1|localhost/, `${f} 的 curl 没打回环地址：${m[0]}`);
    }
  }
  // 注释里必须留下"本票没连过服务器"这句话。
  // ⚠️ 这里断言的是**这句话在**，不是**某个具体 IP 在**：仓库已做脱敏，
  //    deploy.sh 头注释里写的是 `<公网IP>` 占位符。曾经这里写死
  //    /从未连过 42\.193\.183\.187/，于是「脱敏」本身会把断言打红——
  //    判据钉在了证据的**具体值**上，而不是它要证明的那件事上。
  assert.match(read("deploy.sh"), /从未连过 .*或任何服务器/, "deploy.sh 头注释里没有留下未连接任何服务器的记录");
});

test("probe-8300.sh 是只读的：没有启停、没有改防火墙", () => {
  const src = codeOnly(read("probe-8300.sh"));
  for (const danger of [
    /\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
    /\bufw\s+(allow|deny|enable|disable)\b/,
    /\bfirewall-cmd\s+(--add|--remove|--set)\b/,
    /\biptables\s+-[AID]\b/,
    /\b(rm|mv|dd|truncate|kill)\b/,
  ]) {
    assert.ok(!danger.test(src), `probe-8300.sh 里有会改东西的命令：${danger}`);
  }
  assert.match(src, /只读/, "脚本没有声明自己是只读的");
});

/* ══════════════════════════════════════════════════════════════════
 * 门禁的自我保护
 * ══════════════════════════════════════════════════════════════════
 *
 * 独立复审实测：这三条门禁**整段删掉，全套仍然绿**。
 *   · 删掉 check-boot 里的非回环探针 → npm run boot 退出 0，ticket-06 12/12
 *   · 删掉 check-syntax 里的 CR 检查   → npm run check 退出 0
 *   · selfcheck() 改回单次 curl        → ticket-06 12/12（自检没有任何回归保护）
 *
 * 行为型断言防不住「把断言本身删了」——这是自指的空缺，只能用一条源码内容断言兜住。
 * 它证明力有限（发现得了整段删除，发现不了改写），但少一条时红的是这里，
 * 而不是「什么都不响」。
 */

test("门禁本身不能被整段删掉", () => {
  const rootFile = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  const boot = rootFile("scripts/check-boot.mjs");
  assert.match(boot, /lanIPv4/, "check-boot 里的非回环探针没了 —— 绑定改回 0.0.0.0 将无人报警");
  assert.match(boot, /非回环地址 .* 连不上/, "check-boot 的探针名不在了，确认那条断言真的还在");

  const syntax = rootFile("scripts/check-syntax.mjs");
  assert.match(
    syntax,
    /0x0D/,
    "check-syntax 里的 CR 字节检查没了 —— CRLF 的 .sh 到 Linux 上会直接执行失败",
  );
  assert.match(
    syntax,
    /部署文件行尾为 LF/,
    "check-syntax 不再汇报行尾检查的结果，确认那条检查真的还在",
  );

  // 自检轮询：没有行为型断言，只能钉住「有轮询」这个形状。
  const sh = read("deploy.sh");
  assert.match(sh, /selfcheck\(\)/, "deploy.sh 里没有 selfcheck 函数");
  assert.match(
    sh,
    /SECONDS \+ 20/,
    "selfcheck 不再是轮询 —— 单次 curl 在 Type=simple 下是抛硬币（进程约 0.4s 后才 bind）",
  );
  assert.ok(
    !/is-active --quiet \S+ && curl -fsS -m 5/.test(sh),
    "自检又变回「restart 完立刻 curl 一次」了",
  );
});

test("deploy.sh 默认 dry-run：先打印将要做什么，且一个字都不改", { skip: BASH ? false : "本机没有 bash" }, (t) => {
  const r = run("deploy.sh", [], GOOD);
  assert.equal(r.status, 0, `dry-run 应当正常退出。实际 ${r.status}：\n${r.out}`);
  // 计划先打出来，命令逐条可见
  assert.match(r.out, /将要做的 \d+ 步/, "没有打印计划");
  assert.match(r.out, /systemctl (enable|restart) two-years/, "计划里看不到要执行的动作");
  assert.match(r.out, /dry-run：以上都\*\*没有\*\*执行/, "没有明说这次没有执行");
  // 「明确不做」也要写出来：防火墙是人工步骤
  assert.match(r.out, /不改防火墙/, "没有声明不改防火墙");
  t.diagnostic(`deploy.sh dry-run 退出码 0，计划 ${/将要做的 (\d+) 步/.exec(r.out)[1]} 步`);
});

test("密码没注入：硬失败，且不是在注释里", { skip: BASH ? false : "本机没有 bash" }, (t) => {
  const a = run("deploy.sh", [], { HERO_PASSWORD: TEST_SECRET.HERO_PASSWORD });
  assert.notEqual(a.status, 0, "DOOR_PASSWORD 缺省时脚本仍然往下走了");
  assert.match(a.out, /DOOR_PASSWORD/, "失败原因里没提 DOOR_PASSWORD");
  assert.ok(!/将要做的/.test(a.out), "密码没注入却还在打印计划 —— 那是先跑起来再说的做法");

  const b = run("deploy.sh", [], { DOOR_PASSWORD: TEST_SECRET.DOOR_PASSWORD });
  assert.notEqual(b.status, 0, "HERO_PASSWORD 缺省时脚本仍然往下走了");
  assert.match(b.out, /HERO_PASSWORD/, "失败原因里没提 HERO_PASSWORD");
  t.diagnostic("两个变量各缺一个都是 exit≠0，且不打计划");
});

test("密码就是生日（4 位月日 / 8 位完整生日）：放行 —— 生日是产品定义，不是「没换掉的缺省值」", { skip: BASH ? false : "本机没有 bash" }, (t) => {
  // CONSTRAINTS.md §3：「密码 = 对方的生日」。所以 4 位月日就是【改这里：doorCode】该用的那个值，
  // 拿它部署不是「忘了改」，是照规格来。（这里喂的是人造测试口令，形态与真值一致。）
  //
  // 早先这里是一条硬失败，理由是「部署形态是公网 IP + 裸 HTTP，缺省值等于把内容挂在
  // 全网扫得到的地方」。那个前提已经不成立：主域名 + 有效 HTTPS、应用只绑回环、
  // 爆破按真实客户端 5 次锁 10 分钟。生日只有 4 位这件事靠的是那几条，不是换密码 ——
  // 8 位完整生日和 4 位月日是同一个生日，容错逻辑两者都收，一位熵都不多。
  //
  // 两种形态**混着**喂，是刻意要那条 "4 位月日" 与 "8 位" 都在正则里被走到；
  // 两个值必须不相同，否则撞上「一把钥匙开两个门」那条 die，测的就不是格式了。
  const a = run("deploy.sh", [], { DOOR_PASSWORD: SHORT.door, HERO_PASSWORD: TEST_SECRET.HERO_PASSWORD });
  assert.equal(a.status, 0, `4 位月日作为密码应当被接受。实际 exit=${a.status}：${a.out.slice(0, 300)}`);
  assert.match(a.out, /dry-run/, "应当正常打印计划");

  const b = run("deploy.sh", [], { DOOR_PASSWORD: TEST_SECRET.DOOR_PASSWORD, HERO_PASSWORD: SHORT.hero });
  assert.equal(b.status, 0, `8 位完整 + 4 位月日混用也应当被接受。实际 exit=${b.status}`);

  t.diagnostic("4 位月日与 8 位完整生日都放行，且都正常打印计划");
});

test("生日只有 4 位：补偿控制必须是硬的（默认绑回环，部署期就拦）", (t) => {
  // 上面那条把「不得等于某个生日值」放开了，就必须把替代它的护栏钉住，
  // 否则等于为了部署方便把唯一的部署期检查删掉了。
  //
  // 补偿控制之一：应用默认只绑回环。有人把默认值改回 0.0.0.0，公网就能直连进程，
  // HTTPS 和按 IP 限流一起绕过去 —— 那时 4 位生日才真的成了问题。
  const server = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
  assert.match(
    server,
    /HOST \|\| "127\.0\.0\.1"/,
    "src/server.js 的默认绑定不是回环 —— 公网可直连进程，HTTPS 与限流都绕得过去",
  );

  // 部署期也要拦一次：光靠运行时默认值，源码被改错了要等到线上才发现。
  assert.match(
    read("deploy.sh"),
    /默认绑定不是 127\.0\.0\.1/,
    "deploy.sh 里没有「默认绑定必须是回环」这条部署期硬检查",
  );
  assert.match(read("deploy.sh"), /HOST=127\.0\.0\.1/, "deploy.sh 写进 env 的 HOST 不是回环");

  // 按真实客户端限流是第二条补偿控制。它以前是「trust proxy 恰好等于 1」这一条
  // 硬编码的断言 —— 独立复审指出那不够：绑定一旦不是回环，XFF 就是客户端自己填的，
  // 8 次伪造登录全部 401、限流归零（对照组第 5 次照锁）。所以现在是**耦合**：
  // 信任几跳由 bindHost 算出来，两者不可能同时「对外暴露 + 信 XFF」。
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  assert.match(
    app,
    /trust proxy",\s*loopback \? 1 : false/,
    "trust proxy 不是由 bindHost 决定的 —— 绑定翻成 0.0.0.0 时会照旧采信 XFF，限流可被伪造绕过",
  );
  assert.match(app, /LOOPBACK_HOSTS/, "app.js 里没有回环地址集合，耦合无从判断");
  const srv = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
  assert.match(
    srv,
    /bindHost: HOST/,
    "server.js 没把实际绑定传给 createApp —— app.js 只能猜默认值，生产绑定就没人看守",
  );
});

test("密码格式不对：硬失败（不是随便一串都写进 env 文件）", { skip: BASH ? false : "本机没有 bash" }, () => {
  // 反例的形状是「4 位月日后面粘了字母」—— 必须仍然含非数字，
  // 否则它就不是反例了。HERO 那边给**合规**值，这样失败只可能由 DOOR 的格式引起。
  const r = run("deploy.sh", [], { DOOR_PASSWORD: "0101abc", HERO_PASSWORD: TEST_SECRET.HERO_PASSWORD });
  assert.notEqual(r.status, 0, "非数字密码竟然放行了");
  assert.match(r.out, /4 位月日|8 位/, "失败原因没说明密码格式");
});

test("DATA_DIR 落在 public/ 里：硬失败（照片会被零鉴权直出）", { skip: BASH ? false : "本机没有 bash" }, () => {
  // 最常犯的一错：人在仓库里敲一个相对路径
  const rel = run("deploy.sh", [], { ...GOOD, DATA_DIR: "public/data" });
  assert.notEqual(rel.status, 0, "DATA_DIR=public/data 竟然放行了");
  assert.match(rel.out, /public/, "失败原因没提到 public/");
  const abs = run("deploy.sh", [], { ...GOOD, DATA_DIR: "/opt/two-years/public" });
  assert.notEqual(abs.status, 0, "DATA_DIR 指向 public/ 竟然放行了");
});

test("DATA_DIR 本身合规、但 photos 子目录是指向 public/ 的链接：同样硬失败", { skip: BASH ? false : "本机没有 bash" }, (t) => {
  // 只查 $DATA_DIR 本身是个真实的缺口：realpath -m 只解析 $DATA_DIR 这条路径上的
  // 软链，而照片落在 $DATA_DIR/photos（src/photos.js 的 photosDirFor）。
  // 于是「data/photos 是指向 public/ 的链接」在部署期也完全看不出来，
  // 而这正是运行时那条断言同样判不出的形态——两层守卫同时漏。
  //
  // 守卫比的是三个真实静态根（$REPO_DIR/public、$PWD/public、$APP_DIR/public），
  // 所以这里的 cwd 必须指到临时目录：$PWD/public 才是那条链接要指的目标。
  // 指到别处的话，守卫根本没把那条路径当静态根，放行是**正确行为**，
  // 测出来的红是测试写错了，不是守卫有洞。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-link-"));
  const dataDir = path.join(dir, "data");
  const pub = path.join(dir, "public", "evil");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(pub, { recursive: true });
  t.after(() => {
    try {
      fs.unlinkSync(path.join(dataDir, "photos")); // 摘链接，不动它指的目标
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let kind = null;
  for (const type of ["junction", "dir"]) {
    try {
      fs.symlinkSync(pub, path.join(dataDir, "photos"), type);
      kind = type;
      break;
    } catch {
      /* 换下一种 */
    }
  }
  if (!kind) return t.skip(`本机建不出目录链接（${process.platform}），这条没验成`);

  // DATA_DIR 必须传 bash 看得懂的形态（相对 cwd 的 "data"）。
  // 传 Windows 绝对路径 C:\... 时它不以 / 开头，脚本会走 `*) DATA_DIR="$PWD/$DATA_DIR"`
  // 拼成一条垃圾路径，守卫拿垃圾比垃圾自然放行——那是测试写错了，不是守卫有洞。
  const r = run("deploy.sh", [], { ...GOOD, DATA_DIR: "data" }, dir);
  assert.notEqual(r.status, 0, `photos 子目录是${kind}指向 $PWD/public，部署却放行了——照片会被零鉴权直出`);
  assert.match(r.out, /public/, `失败原因没提到 public/：${r.out}`);
  t.diagnostic(`${kind} → public/evil：部署期硬失败`);
});

test("probe-8300.sh 本机跑得通，且如实说明查不到什么", { skip: BASH ? false : "本机没有 bash" }, (t) => {
  const r = run("probe-8300.sh", []);
  assert.equal(r.status, 0, `探测脚本应当正常退出。实际 ${r.status}：\n${r.out}`);
  assert.match(r.out, /8300/, "报告里没有端口号");
  assert.match(r.out, /只读/, "报告里没有只读声明");
  assert.match(r.out, /防火墙/, "报告里没有防火墙这一项");
  assert.match(r.out, /结论/, "报告没有结论");
  t.diagnostic(`probe 退出码 0；结论行：${/结论：.*/.exec(r.out)[0].slice(0, 60)}`);
});

test("probe-8300.sh 拒绝乱参数：门禁不能什么都放行", { skip: BASH ? false : "本机没有 bash" }, () => {
  assert.equal(run("probe-8300.sh", ["--wat"]).status, 1, "乱参数竟然没有报错");
  assert.equal(run("probe-8300.sh", ["--port", "abc"]).status, 1, "非数字端口竟然没有报错");
});
