/**
 * SQLite 访问层。
 *
 * 用 Node 自带的 `node:sqlite`（DatabaseSync），不引原生模块：
 * better-sqlite3 在 Node 24 上没有预编译包，本机也没有 VS C++ 工具链，
 * 装不上；而 node:sqlite 是标准库，同步 API，行为与 SPEC §三 的数据模型一致。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/** SPEC §三 数据模型，逐字对齐 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS person (
  id    TEXT PRIMARY KEY,   -- 'door' | 'hero'
  code  TEXT NOT NULL,      -- '【改这里：doorCode】' | '【改这里：heroCode】'
  role  TEXT NOT NULL,
  pw4   TEXT,               -- scrypt 哈希：4 位月日形态
  pw8    TEXT               -- scrypt 哈希：8 位完整生日形态
);

CREATE TABLE IF NOT EXISTS session (
  token     TEXT PRIMARY KEY,  -- 32 字节随机，base64url
  person_id TEXT NOT NULL REFERENCES person(id),
  created   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_fail (
  ip           TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
);

-- 专属层条目：一方写给另一方。owner 决定谁写的
CREATE TABLE IF NOT EXISTS entry (
  id      TEXT PRIMARY KEY,
  owner   TEXT NOT NULL,     -- 'door' | 'hero'
  kind    TEXT NOT NULL,     -- 'photo' | 'text'
  body    TEXT,              -- 留言正文 / 照片配文（可空）
  ord     INTEGER NOT NULL,
  created INTEGER NOT NULL,
  deleted INTEGER            -- 遗留列：2026-10-03 撤回改硬删后恒为 NULL，不删列（见 routes.js 的说明）
);

-- 照片只存元数据，文件在 700 权限目录
CREATE TABLE IF NOT EXISTS photo (
  id      TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entry(id),
  mime    TEXT NOT NULL,
  bytes   INTEGER NOT NULL,
  w       INTEGER NOT NULL,
  h       INTEGER NOT NULL
);

-- 共同层：合照（9 张）+ 祝福语
CREATE TABLE IF NOT EXISTS shared (
  id   TEXT PRIMARY KEY,
  kind TEXT NOT NULL,        -- 'together_photo' | 'blessing'
  body TEXT,
  ord  INTEGER NOT NULL
);

-- 约定：双方各一条
CREATE TABLE IF NOT EXISTS wish (
  person_id TEXT PRIMARY KEY,
  text      TEXT NOT NULL
);
`;

/** 全站只出现代号，不出现真名（design.md §八 硬约束 6） */
export const PERSONS = [
  { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】" },
  { id: "hero", code: "【改这里：heroCode】", role: "【改这里：boyfriend】" },
];

/** 抢不到锁时等多久（毫秒）。SQLite 默认是 0，也就是**不等、立刻抛 database is locked**。 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * 打开（或建库）并确保 schema 存在。
 * @param {string} file SQLite 文件路径，父目录会被创建
 */
export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // **busy_timeout 必须排在 journal_mode 之前**：切 WAL 本身要拿一把短暂的
  // 排他锁，没有超时的话两个进程同时启动（systemd 重启时旧进程还没退干净、
  // 或者本地同时起真机 + 预览两个实例）就会有一个当场死在
  // 「database is locked」——启动失败，且错在启动、看不出跟锁有关。
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  for (const p of PERSONS) {
    db.prepare(
      "INSERT INTO person(id, code, role) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code, role=excluded.role",
    ).run(p.id, p.code, p.role);
  }
  return db;
}

/** node:sqlite 返回 null 原型对象，转成普通对象方便 JSON 序列化与断言 */
export function plain(row) {
  return row ? { ...row } : null;
}

export function plainAll(rows) {
  return rows.map((r) => ({ ...r }));
}

/** 对方是谁 */
export function otherId(id) {
  return id === "door" ? "hero" : "door";
}
