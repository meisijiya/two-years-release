/**
 * `/api/photo/:id` 的鉴权边界 —— 专攻「已发布用例没覆盖到」的角度。
 *
 * 观察者旁路把「谁能看哪张」这件事扩了一个维度：以前只有本人会话，
 * 现在多了一种凭据。照片是全站唯一一种「看得见就等于拿到」的数据，
 * 所以这一层值得单独一组用例，而不是顺手塞进别的文件。
 *
 * 这里的每一条都对应一个具体的攻击面，不是「跑一遍看看绿不绿」：
 *   · 路径穿越与畸形 id（id 会进文件路径）
 *   · 同时带 sid 与 obs —— 两条凭据并存时走哪条分支
 *   · 共同层哨兵那条特殊路径（owner 是保留值，不属于任何一方）
 *   · 已撤回 / 取消撤回 的往返（证明「撤回后拿不到」确实是撤回造成的）
 *   · 孤儿 photo 行在 **schema 层**就不可能存在（外键）
 *
 * ⚠️ 造共同层合照时**必须真的把字节落盘**。读图走 readPhoto() 读**文件**；
 * 只插一行库记录的话，观察者拿到 404 是因为「文件不存在」，
 * 而不是因为「时间锁挡住了」—— 两者响应体逐字相同，不落盘就分不出来。
 * 这条已经踩过一次。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { startTestServer, client, JUST_BEFORE, AT_UNLOCK, TEST_SECRET } from "./helpers.js";
import { writePhoto } from "../src/photos.js";

/** PIN 是 OBSERVER_PASSWORD，与两边口令两两不同（见 observer-backend.test.js 同处说明） */
const PIN = TEST_SECRET.OBSERVER_PASSWORD;
const DOOR = { code: "【改这里：doorCode】", birthday: TEST_SECRET.DOOR_PASSWORD };
const HERO = { code: "【改这里：heroCode】", birthday: TEST_SECRET.HERO_PASSWORD };

/** 合照用的 photo id：必须匹配 src/photos.js 的 ID_RE（p + 24 位 hex），
 *  writePhoto 会自己校验，不合规直接抛「照片 id 不合法」。 */
const SHARED_PHOTO = "p0123456789abcdef01234567";
const ORPHAN_PHOTO = "p0123456789abcdef01234568";

async function jpeg() {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: "#3366aa" } }).jpeg().toBuffer();
}

async function upload(c, data) {
  const boundary = "----ob-auth" + randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="photo"; filename="p.jpg"\r\n' +
      "Content-Type: image/jpeg\r\n\r\n",
    "utf8",
  );
  const body = Buffer.concat([head, Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
  const r = await c.raw("/api/upload", {
    method: "POST", body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(r.status, 201, `上传应当成功，实际 ${r.status} ${r.text}`);
  return r.body.entry;
}

async function bytes(base, cookie, p) {
  const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
  return { status: res.status, n: (await res.arrayBuffer()).byteLength };
}

/** 造一整套：她一条文字 + 一张照片，共同层哨兵一张（**含落盘**） */
async function fixture(s) {
  const a = client(s.base);
  await a.post("/api/login", { code: DOOR.code, birthday: DOOR.birthday });
  await a.post("/api/entry", { kind: "text", body: "她写的" });
  const herPhoto = (await upload(a, await jpeg())).photo.id;

  const b = client(s.base);
  await b.post("/api/login", { code: HERO.code, birthday: HERO.birthday });
  await b.post("/api/entry", { kind: "text", body: "他写的" });

  s.db
    .prepare("INSERT INTO entry(id, owner, kind, body, ord, created, deleted) VALUES('@shared-layer','@shared-layer','photo',NULL,0,1,NULL)")
    .run();
  s.db
    .prepare("INSERT INTO photo(id, entry_id, mime, bytes, w, h) VALUES(?, '@shared-layer', 'image/jpeg', 1, 40, 30)")
    .run(SHARED_PHOTO);
  writePhoto(s.photosDir, SHARED_PHOTO, await jpeg());

  const obs = client(s.base);
  await obs.post("/api/observe", { pin: PIN });
  return { a, b, obs, herPhoto };
}

/* ====================================================================== */

test("取图：畸形 id 不出字节也不 500（id 会进文件路径）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const { obs } = await fixture(s);

  for (const bad of [
    "../../../etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    `${SHARED_PHOTO}/../../two-years.db`,
    "undefined",
    "null",
    "0",
    "'; DROP TABLE photo; --",
    "",
  ]) {
    const r = await bytes(s.base, obs.cookie, `/api/photo/${encodeURIComponent(bad)}`);
    // 404 的响应体是 {"error":"not_found"}，21 字节。判据断两样：
    // 状态码，以及**没有真的吐出别的东西**（比如 /etc/passwd 的内容）
    assert.equal(r.status, 404, `id=${bad} 应当 404，实际 ${r.status}`);
    assert.ok(r.n < 200, `id=${bad} 吐出了 ${r.n} 字节，不该有正文`);
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM photo").get().n, 2, "注入尝试没删掉 photo 表");
});

test("取图：两条凭据并存时走 sid 那条，不因 obs 存在就放宽", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const { a, obs } = await fixture(s);

  // 她带着自己的会话 + 一份有效的 obs。共同层锁着，两条路都该 404。
  const both = client(s.base);
  both.setCookie(`${a.cookie}; ${obs.cookie}`);
  const r = await bytes(s.base, both.cookie, `/api/photo/${SHARED_PHOTO}`);
  assert.equal(r.status, 404, `同时带 sid 与 obs 不得放宽：实际 ${r.status}`);
});

test("取图：共同层哨兵那一条特殊路径（owner 是保留值，不属于任何一方）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const { a, obs } = await fixture(s);

  // 匿名 = 401 而不是 404：/api/photo/:id 不在 LOCKED_PREFIXES 里，
  // 闸门不拦它，拦它的是会话检查。写成 404 会把正确的行为判成失败。
  assert.equal((await bytes(s.base, "", `/api/photo/${SHARED_PHOTO}`)).status, 401, "匿名");
  assert.equal((await bytes(s.base, a.cookie, `/api/photo/${SHARED_PHOTO}`)).status, 404, "未解锁的本人");
  assert.equal((await bytes(s.base, obs.cookie, `/api/photo/${SHARED_PHOTO}`)).status, 200, "观察者（旁路绕的就是时间锁）");

  s.setNow(AT_UNLOCK);
  assert.equal((await bytes(s.base, a.cookie, `/api/photo/${SHARED_PHOTO}`)).status, 200, "开门后本人可读");
  const anon = await bytes(s.base, "", `/api/photo/${SHARED_PHOTO}`);
  assert.ok(anon.status === 404 || anon.status === 401, `开门后匿名仍不该读到：${anon.status}`);
});

test("取图：撤回的往返 —— 拿不到确实是撤回造成的，不是别的原因", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  const { obs, herPhoto } = await fixture(s);

  const setDeleted = (v) =>
    s.db.prepare("UPDATE entry SET deleted = ? WHERE id = (SELECT entry_id FROM photo WHERE id = ?)")
      .run(v, herPhoto);

  assert.equal((await bytes(s.base, obs.cookie, `/api/photo/${herPhoto}`)).status, 200, "对照组：先看得到");

  setDeleted(JUST_BEFORE + 1);
  assert.equal((await bytes(s.base, obs.cookie, `/api/photo/${herPhoto}`)).status, 404, "撤回后观察者也不给");

  setDeleted(null);
  assert.equal((await bytes(s.base, obs.cookie, `/api/photo/${herPhoto}`)).status, 200,
    "取消撤回又能拿到 —— 这条证明上一条确实是撤回造成的，而不是环境里别的什么在挡");
});

test("取图：孤儿 photo 行在 schema 层就不可能存在（外键）", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  s.setNow(JUST_BEFORE);
  await fixture(s);

  // 与其测一个不可能发生的状态，不如把「它确实不可能」钉住：
  // 哪天有人为图省事去掉外键，这条立刻就红，而那时读图那边的
  // JOIN 保护就成了唯一一道。
  assert.throws(
    () => s.db.prepare("INSERT INTO photo(id, entry_id, mime, bytes, w, h) VALUES(?, 'e-nonexistent', 'image/jpeg', 1, 1, 1)").run(ORPHAN_PHOTO),
    /FOREIGN KEY/i,
    "photo.entry_id 应当有外键指向 entry —— 没有它就能造出指向不存在条目的照片",
  );
});
