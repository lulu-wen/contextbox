/**
 * 事實庫 —— 用 Node 內建的 node:sqlite，沒有任何外部依賴。
 * 一個檔案就是全部：~/.contextbox/data.db
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
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

-- ── 檔案與截圖管線 ────────────────────────────────────────────
-- items 是「進來的東西」，understanding 是我們對它的理解。
-- 原檔的內容永遠不動，我們只搬、只改名；寫的字全部在 understanding 裡。
CREATE TABLE IF NOT EXISTS items (
  id       TEXT PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,     -- 目前的真路徑，搬了就更新
  sha256   TEXT NOT NULL,
  -- TS 的型別在執行期完全不管事（strip-types 只是把註解拿掉），
  -- 所以合法值要寫在這裡，不然一個打錯的狀態會安靜地躺進資料庫。
  kind     TEXT NOT NULL CHECK (kind IN ('screenshot','image','pdf')),
  mime     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  mtime    TEXT NOT NULL,
  seen_at  TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN
             ('new','understanding','proposed','applied','ignored','error')),
  error    TEXT
);
CREATE INDEX IF NOT EXISTS ix_items_sha    ON items(sha256);
CREATE INDEX IF NOT EXISTS ix_items_status ON items(status, seen_at);

CREATE TABLE IF NOT EXISTS understanding (
  item_id    TEXT PRIMARY KEY REFERENCES items(id),
  model      TEXT NOT NULL,
  doc_type   TEXT,
  category   TEXT,
  summary    TEXT,
  text       TEXT,                   -- 畫面上看得到的字。contains_secret 時留空
  tags       TEXT,                   -- JSON 陣列
  raw        TEXT NOT NULL,          -- 模型的原始輸出，出錯時要查
  created_at TEXT NOT NULL
);

-- trigram：中文不用斷詞也搜得到（node:sqlite 3.53 內建 FTS5）
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id UNINDEXED, name, summary, text, tags, tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items(id),
  proposal   TEXT NOT NULL,          -- 模型講的話，原樣留著
  ops        TEXT NOT NULL,          -- 由程式從 proposal 組出來，模型碰不到
  status     TEXT NOT NULL CHECK (status IN ('proposed','applied','reverted','dismissed')),
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_plans_item ON plans(item_id, status);

-- 檔案動作的稽核。一列一件事，復原就是倒著讀。
CREATE TABLE IF NOT EXISTS file_journal (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  plan_id  TEXT NOT NULL,
  op       TEXT NOT NULL,
  payload  TEXT NOT NULL,
  undo     TEXT,
  undoable INTEGER NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('done','reverted','skipped'))
);
CREATE INDEX IF NOT EXISTS ix_fj_plan ON file_journal(plan_id, seq);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- ── Downloads 清理管線 ───────────────────────────────────────
-- file_items 是「掃到的檔案」，cleanup_candidates 是「可清理候選」。
-- 清理不是刪除：後續執行器只會先移到 quarantine，復原靠 journal。
CREATE TABLE IF NOT EXISTS file_items (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  ext           TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  sha256        TEXT,
  mtime         TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('new','candidate','kept','quarantined','restored','missing','error')),
  error         TEXT
);
CREATE INDEX IF NOT EXISTS ix_file_items_sha    ON file_items(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_file_items_status ON file_items(status, last_seen_at);

CREATE TABLE IF NOT EXISTS cleanup_candidates (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES file_items(id),
  kind         TEXT NOT NULL CHECK (kind IN
               ('duplicate','installer','archive','temp','empty','old-download','partial','screenshot-noise')),
  rule_version TEXT NOT NULL,
  confidence   INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  reason       TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN
               ('proposed','skipped','approved','quarantined','restored','dismissed','error')),
  created_at   TEXT NOT NULL,
  UNIQUE (item_id, kind, rule_version)
);
CREATE INDEX IF NOT EXISTS ix_cleanup_candidates_item   ON cleanup_candidates(item_id, status);
CREATE INDEX IF NOT EXISTS ix_cleanup_candidates_status ON cleanup_candidates(status, created_at);

CREATE TABLE IF NOT EXISTS cleanup_plans (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('proposed','applied','restored','dismissed','partial','error')),
  item_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  error      TEXT
);

CREATE TABLE IF NOT EXISTS cleanup_plan_items (
  plan_id      TEXT NOT NULL REFERENCES cleanup_plans(id),
  candidate_id TEXT NOT NULL REFERENCES cleanup_candidates(id),
  position     INTEGER NOT NULL,
  skipped      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS cleanup_journal (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  plan_id   TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  op        TEXT NOT NULL CHECK (op IN ('quarantine','restore','skip')),
  from_path TEXT,
  to_path   TEXT,
  sha256    TEXT,
  status    TEXT NOT NULL CHECK (status IN ('started','done','failed','reverted')),
  error     TEXT
);
CREATE INDEX IF NOT EXISTS ix_cleanup_journal_plan ON cleanup_journal(plan_id, seq);
`

/**
 * 這個檔案裡會有每一張截圖抄下來的字 —— 等於一份本機的螢幕內容庫，
 * 裡面會有密碼、簡訊驗證碼、銀行畫面、私訊。所以只有自己讀得到。
 * -wal 與 -shm 是 SQLite 自己建的，不會繼承，要各自設一次。
 */
function lockDown(path: string, createdDir: string | undefined) {
  // **只鎖我們自己建出來的資料夾。**
  // 以前是無條件 chmod(dirname(path), 0o700)，所以 CONTEXTBOX_DB 指到哪裡，
  // 哪個資料夾就被改成只有自己讀得到 —— 包含裡面別人的檔案，而且完全沒出聲。
  if (createdDir) { try { chmodSync(createdDir, 0o700) } catch { /* Windows 上沒作用 */ } }
  for (const p of [path, path + '-wal', path + '-shm']) {
    try { chmodSync(p, 0o600) } catch { /* 還沒建出來就算了 */ }
  }
}

export function open(path: string = DEFAULT_DB): DatabaseSync {
  // mkdirSync 回傳「第一個被建出來的路徑」，沒建就是 undefined
  const created = path !== ':memory:'
    ? mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    : undefined
  const db = new DatabaseSync(path)
  // **busy_timeout 一定要是第一個 pragma。**
  // journal_mode = WAL 自己就要拿鎖，設在它後面等於沒設：
  // 實測全新資料庫 12 個 process 同時開，只有 1 個活下來，
  // 其餘 11 個直接丟 database is locked。而 Windows 右鍵選一次選 8 個檔
  // 就是 8 個 process 同時開。
  // 15 秒不是隨便訂的：右鍵一次選 20 個檔就是 20 個行程同時開一個
  // 還不存在的資料庫，每一個都要建 schema。5 秒在慢碟或機器忙的時候
  // 真的會有人被鎖在外面（測試實測過偶發 1/12）。
  db.exec('PRAGMA busy_timeout = 15000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  if (path !== ':memory:') lockDown(path, created)
  return db
}
