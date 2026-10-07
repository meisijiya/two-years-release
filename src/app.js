/**
 * Express 应用工厂。
 *
 * 依赖全部由外部注入（db / now / 目录），所以测试能起一套真 HTTP + 真 SQLite
 * + 假时钟的实例，生产起一套真时钟的实例，两者跑的是同一份代码。
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isUnlocked, UNLOCK_AT, UNLOCK_LABEL } from "./clock.js";
import { createApiRouter } from "./routes.js";
import { createObserverRouter } from "./observe.js";
import { createObserverAuth } from "./observer-auth.js";
import { isSecureRequest } from "./auth.js";
import { accessLog } from "./logging.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

/** 未解锁时必须 404 的路径前缀：共同层内容与双方约定 */
const LOCKED_PREFIXES = ["/api/shared", "/api/wish"];

/**
 * 闸门只锁**读**。
 *
 * 契约里 `POST /api/wish` 在未解锁时是**允许**的（SPEC §四）：她必须能提前把约定折好，
 * 10-5 当天才不用手忙脚乱。闸门原来不看方法，把写也一起挡成了 404。
 * 写侧自己有会话鉴权（未登录 → 401），不靠这道闸门，所以放行写不放行读。
 */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 回环地址。绑在这之外的任何地址上，X-Forwarded-For 就是客户端自己填的了。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function createApp({
  db,
  now = Date.now,
  publicDir = path.join(ROOT, "public"),
  bindHost = "127.0.0.1",
  dataDir,
  // 运维日志。默认 null = **不记**（测试因此不必在临时目录里多出日志文件，
  // 226 个用例也不用各自清理）。生产由 src/server.js 显式传 writer 打开。
  logWriter = null,
}) {
  // ⚠️ **dataDir 不给默认值**，这是血的教训。
  // 它早先默认 `path.join(ROOT, "data")`，看着无害 —— 直到有人在服务器上以 root
  // 跑了一次门禁：测试里的 createApp 没传 dataDir，于是观察者的签名密钥被以
  // **root 属主**写进了**生产数据目录**。服务随后以 two-years 身份启动，
  // 读不到也写不了那个 600 的文件，**直接起不来**，生产当场停摆。
  //
  // 默认值在这里不是便利，是一颗哑弹：它让「忘了传」和「故意传错」长得一模一样，
  // 而且失败点不在传错的那一行，在几小时后的另一次启动上。
  // 必填之后，漏传会在**当场**炸出来，炸在这行调用上。
  if (typeof dataDir !== "string" || !dataDir) {
    throw new Error("createApp 必须显式传 dataDir（观察者的签名密钥要落在它里面，且它必须是这次实例真正在用的那个数据目录）");
  }
  const app = express();
  app.disable("x-powered-by");

  /**
   * 信任几跳代理，**由实际绑定地址决定**，不由人记得配。
   *
   * 这两件事以前是两个各自要守好的前提，代价是：前提之一被翻掉时整套静默失灵。
   * 独立复审实测过那个后果 —— 把绑定改成 0.0.0.0 再带伪造的 X-Forwarded-For，
   * 8 次登录全部 401，限流**完全归零**（对照组不带该头：第 5 次照锁）。
   * 原因很直白：XFF 只有在「唯一能连到进程的人就是本机 nginx」时才可信；
   * 进程一旦对外暴露，那个头就是客户端自己填的。
   *
   * 所以这里让二者**互斥**，而不是各守各的：
   *   · 绑回环 → 外面只有 nginx 能连 → 采信 1 跳（$proxy_add_x_forwarded_for 的最右项）
   *   · 绑非回环 → 客户端自己直连 → **一个 XFF 都不采信**，req.ip 就是 socket 地址
   *
   * 非回环时仍可用（局域网自测能跑），只是限流退回按直连方算 —— 那时它不可伪造。
   * 「能伪造限流」需要「非回环绑定」且「信任 XFF」，而这两个现在不可能同时成立。
   *
   * ⚠️ 生产真正生效的绑定来自 /etc/two-years/two-years.env，不是这里的默认值。
   *    所以 bindHost 必须由 src/server.js 把**它实际要 listen 的那个地址**传进来。
   */
  const loopback = LOOPBACK_HOSTS.has(String(bindHost));
  app.set("trust proxy", loopback ? 1 : false);
  if (!loopback) {
    console.warn(
      `[two-years] 警告：绑定在 ${bindHost}（非回环），已**不采信** X-Forwarded-For。` +
        `限流按直连方计算（不可伪造），但公网能直连进程、绕开证书。` +
        `生产应当绑 127.0.0.1，由本机 nginx 反代。`,
    );
  }

  app.use(express.json({ limit: "256kb" }));

  // 运维访问日志。**挂在 body 解析之后、所有路由之前**，这样每个请求都有一条，
  // 包括被 404 掉的那条（扫描器打 `/wp-admin/...` 正是运维想看到的信号）。
  //
  // 挂在这里而不是更早/更晚的两个原因：
  //  · 更早（json 解析前）的话，畸形 JSON 会在进中间件前就返回 400，漏记；
  //  · 更晚（路由之后）的话，express.static 与 404 兜底之外的路径拿不到。
  if (logWriter) app.use(accessLog({ writer: logWriter, now }));

  const unlocked = () => isUnlocked(now());

  // ---- 时间锁第一道闸门：先于任何路由，未解锁一律 404，接口里不留后门 ----
  // 比较前先转小写：Express 路由默认大小写不敏感，`/API/shared` 也能命中真实路由，
  // 用大小写敏感的前缀比较会被直接绕过。
  app.use((req, res, next) => {
    if (unlocked()) return next();
    // 归一化成大写再比：Express 4 的路由匹配是大小写不敏感的（会 toLowerCase），
    // 闸门若也大小写敏感，前缀归一化方法名的代理会让它形同虚设。
    // （今天安全只是因为 Node 的 HTTP 解析器会先拒收小写方法——那是兜底，不是保证。）
    if (!READ_METHODS.has(req.method.toUpperCase())) return next(); // 写放行，见上面 READ_METHODS
    const p = req.path.toLowerCase();
    if (LOCKED_PREFIXES.some((x) => p === x || p.startsWith(x + "/"))) {
      return res.status(404).json({ error: "not_found" });
    }
    next();
  });

  // 开门状态是公开的：封印页的倒计时要靠它渲染。
  app.get("/api/status", (req, res) => {
    res.json({ unlocked: unlocked(), unlockAt: UNLOCK_AT, unlockLabel: UNLOCK_LABEL, now: now() });
  });

  // ---- 时间锁的文字层：登录 / 会话 / 留言（工单 02）+ 照片（03）+ 共同层（04）+ 约定（05）----
  // 挂载在闸门之后、静态资源之前：闸门已经先把共同层与约定挡成 404，
  // 这里的读侧再各自判断一次「对方的内容能不能进响应体」。
  //
  // 观察者鉴权句柄建在这里，**同时**交给主路由与观察者路由：
  // 「谁在这次请求里是观察者」因此只有一处判定（见 routes.js 的 /api/photo/:id）。
  const observerAuth = createObserverAuth({ dataDir, now, isSecure: isSecureRequest });
  app.use(createApiRouter({ db, now, publicDir, observerAuth }));

  // 观察者入口（测试专用，CONSTRAINTS §2b）。前缀 /api/observe 不在 LOCKED_PREFIXES 里，
  // 闸门原样放行 —— 闸门与 UNLOCK_AT 一个字没改，10-5 之前两个人走的每条路仍然关着。
  app.use(createObserverRouter({ db, now, observerAuth }));

  // 工单 01 留的 /api/wish 哨兵路由到此为止：真实实现在 routes.js 里接管了它。
  // 哨兵当初存在的唯一目的是让 LOCKED_PREFIXES 那道闸门**可被证伪**；
  // 真实路由上线后它就是多余的一层，留着只会让人以为约定是接口的假身。

  app.use(express.static(publicDir, { index: "index.html" }));

  // 未匹配到的路径一律 JSON。Express 默认错误页会把请求路径回显进 HTML 正文，
  // 与「所有响应均为 application/json」的契约不符，也容易变成信息泄露面。
  app.use((req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // 未捕获错误：内部信息不吐给客户端。
  app.use((err, req, res, next) => {
    // 畸形 JSON 是客户端发错东西，不是服务器炸了 —— 归 400，别归 500。
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "bad_request", hint: "JSON 解析失败" });
    }
    console.error("[unhandled]", err?.message ?? err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "server_error" });
  });

  return app;
}
