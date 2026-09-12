/**
 * 事實庫 —— 用 Node 內建的 node:sqlite，沒有任何外部依賴。
 * 一個檔案就是全部：~/.contextbox/data.db
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_DB = process.env.CONTEXTBOX_DB
  ?? `${homedir()}/.contextbox/data.db`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL,          -- education[0].school
  key_def      TEXT NOT NULL,          -- education[].school
  idx          INTEGER,                -- 可重複欄位的序號
  value        TEXT NOT NULL,          -- JSON
  status       TEXT NOT NULL,          -- candidate|confirmed|rejected|stale|superseded
  confidence   REAL,
  sensitivity  TEXT NOT NULL,          -- 從註冊表來，不信呼叫端
  source_kind  TEXT NOT NULL,
  source_ref   TEXT,
  source_quote TEXT,
  source_page  INTEGER,
  supersedes   TEXT,
  created_at   TEXT NOT NULL,
  confirmed_at TEXT,
  refreshed_at TEXT,
  expires_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_facts_key    ON facts(key, status);
CREATE INDEX IF NOT EXISTS ix_facts_keydef ON facts(key_def, status);
CREATE INDEX IF NOT EXISTS ix_facts_expiry ON facts(expires_at) WHERE expires_at IS NOT NULL;

-- 每一次寫入都留一列。復原就是倒著讀這張表。
CREATE TABLE IF NOT EXISTS journal (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  op      TEXT NOT NULL,               -- fact.propose|fact.confirm|fact.reject|fact.stale
  fact_id TEXT,
  before  TEXT,                        -- 動作前的快照，JSON
  after   TEXT,
  undone  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_journal_undone ON journal(undone, seq);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

export function open(path: string = DEFAULT_DB): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
