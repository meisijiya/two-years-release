/**
 * 观察者入口的**路由**（**测试专用**）。机制在 ./observer-auth.js。
 *
 * ⚠️ 这是 CONSTRAINTS.md §2「应用内不存在『查看对方内容』的后门代码路径」
 *    的一次**显式降级**。理由与撤销方式写在 CONSTRAINTS.md §2b。
 *
 * 它做什么：用一个单独的 PIN 换一条只读凭据，凭据能一次读到
 * **共同层 + 双方的内容 + 双方约定**，且**不受时间锁约束**。
 *
 * 它不做什么（这些是硬边界）：
 *   · **只读**。本文件里没有任何 POST / PUT / DELETE —— 观察者能看，不能写、改、撤。
 *   · **不碰 person / session 两张表**（见 observer-auth.js 的说明）。
 *   · **不碰时间锁本身**。`UNLOCK_AT` 与 LOCKED_PREFIXES 那道闸门一个字没改；
 *     本文件用的是**不在 LOCKED_PREFIXES 里**的前缀，闸门因此原样放行
 *     （见 src/app.js 的 LOCKED_PREFIXES）。10-5 之前两个人走的每条路仍然关着。
 *   · **不新增第二条取图路径**。图片字节仍然只从 /api/photo/:id 出，
 *     只是那条路由多认一种凭据（见 routes.js）。全站取图路径**唯一**这条不变量不变。
 *
 * 时间戳一律由调用方注入（与 createApp({ now }) 同源），本文件不碰 Date.now()。
 */
import express from "express";
import { clearFailures, lockState, recordFailure } from "./auth.js";
import { PERSONS, plain } from "./db.js";
import { prepareShared, shapeShared } from "./shared.js";
import { cp } from "./copy-get.js";
import { pinMatches } from "./observer-auth.js";

const HINT = cp("err.server.wrongObserver");

/**
 * 观察者看到的**双方**条目。
 * 形状与 /api/entry 的 mine/theirs 逐字同构（同一个 toEntry 逻辑）——
 * 前端那套 card(e, i, "read") 因此可以原样复用，不用为观察者另写一套渲染。
 */
export function createObserverRouter({ db, now, observerAuth }) {
  const store = prepareShared(db);

  const liveByOwner = db.prepare(
    "SELECT id, kind, body, ord, created FROM entry WHERE owner = ? AND deleted IS NULL ORDER BY ord, created",
  );
  const photoOf = db.prepare("SELECT id, mime, w, h FROM photo WHERE entry_id = ? ORDER BY id");

  const toEntry = (row) => ({
    id: row.id,
    kind: row.kind,
    body: row.body,
    ord: row.ord,
    created: row.created,
    photo: plain(photoOf.get(row.id)),
  });
  const listOf = (owner) => liveByOwner.all(owner).map(toEntry);

  const allWishes = db.prepare(
    "SELECT w.person_id AS id, p.code AS code, w.text AS text FROM wish w JOIN person p ON p.id = w.person_id ORDER BY w.person_id",
  );

  const router = express.Router();
  const noAuth = (res) => res.status(401).json({ error: "no_observer_session" });

  /* ---- 进门：PIN 换凭据 ---- */
  router.post("/api/observe", (req, res) => {
    // 限流**复用**登录那一套（login_fail 表、同 IP 5 次锁 10 分钟）。
    // 单独造一套限流，等于给这条旁路单开一扇没上锁的门。
    const ip = req.ip || "unknown";
    const lock = lockState(db, ip, now());
    if (lock.locked) {
      return res.status(429).json({ error: "locked", retryAfter: lock.retryAfter });
    }

    if (!pinMatches(req.body?.pin)) {
      const after = recordFailure(db, ip, now());
      if (after.locked) {
        return res.status(429).json({ error: "locked", retryAfter: after.retryAfter });
      }
      return res.status(401).json({ error: "bad_credentials", hint: HINT });
    }

    clearFailures(db, ip);
    observerAuth.setCookie(res, req, observerAuth.issue());
    res.json({ ok: true });
  });

  /* ---- 出门 ---- */
  router.post("/api/observe/logout", (_req, res) => {
    observerAuth.clearCookie(res, _req);
    res.status(204).end();
  });

  /* ---- 看：共同层 + 双方 + 约定。**不受时间锁约束** ---- */
  router.get("/api/observe", (req, res) => {
    if (!observerAuth.fromRequest(req)) return noAuth(res);

    // 白名单化：只拼渲染要用的字段。这里是**唯一一个**能把两边内容放在一起的地方
    // （routes.js 的 /api/entry 仍受时间锁约束，只在解锁后给对侧）。
    const sides = {};
    for (const p of PERSONS) {
      sides[p.id] = { code: p.code, role: p.role, entries: listOf(p.id) };
    }

    const shared = shapeShared(store);

    res.set("Cache-Control", "private, no-store");
    res.json({
      sides,
      shared,
      wishes: allWishes.all().map(plain),
      range: { from: shared.from, to: shared.to, days: shared.days },
    });
  });

  return router;
}
