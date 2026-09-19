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
  error         TEXT,
  -- 檔名有沒有取名（core/untitled.ts 的三級）。**只是標記**，改名是 P3 的事。
  -- 既有的資料庫靠 migrate() 補這兩欄，所以這裡不可以是 NOT NULL。
  naming        TEXT CHECK (naming IN ('untitled','generic','named')),
  naming_why    TEXT
);
CREATE INDEX IF NOT EXISTS ix_file_items_sha    ON file_items(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_file_items_status ON file_items(status, last_seen_at);
-- **naming 故意不建索引。** 實測（300 個檔的資料夾，一個檔一次 insert、WAL 每次都要落地）
-- 多一個索引就多 12% 的掃描時間；而「列出沒取名的檔」一次最多也就掃幾千列。

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

-- 套用失敗的原因。**file_items.error 會被下一次掃描改寫**（upsert 的 error=excluded.error），
-- 只存在那裡的話，重掃一次，計畫的逐項結果就從「十分鐘內還在變動」變成「原因不明」。
-- 所以 applyPlan 每一項失敗的當下就寫進這張表（cleanup-exec.ts 的 markFailure），
-- 同一份計畫重試成功時刪掉；planOutcomes 先讀它。誰呼叫 applyPlan 都一樣，不靠 route 或 CLI 補記。
-- why 一定是翻過的人話、不帶路徑。
CREATE TABLE IF NOT EXISTS cleanup_item_errors (
  plan_id TEXT NOT NULL REFERENCES cleanup_plans(id),
  item_id TEXT NOT NULL,
  why     TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (plan_id, item_id)
);

-- 「放棄」（release）過的計畫。release 與 dismiss 都讓計畫停在 dismissed，
-- 但意思不一樣：release 是「這份卡住了，我不要它」（候選不動），dismiss 是「我拒絕這些檔」
-- （候選作廢）。只看 status 分不出來的話，先 release 再 dismiss 會變成 no-op，
-- 舊版遷移也會把 release 過的當成「使用者拒絕過」（稽核第二輪 R2-12）。
-- 放在這裡而不是清理的懶建表：掃描器的遷移在任何清理動作之前就會讀它。
CREATE TABLE IF NOT EXISTS cleanup_plan_releases (
  plan_id TEXT PRIMARY KEY REFERENCES cleanup_plans(id),
  at      TEXT NOT NULL
);

-- ── 連拍截圖 ─────────────────────────────────────────────────
-- 長相指紋。**這是快取，不是事實**：算的時候的 size 與 mtime 一起存，
-- 任一個跟現在的檔對不上就作廢重算（mtime 精度只到毫秒，同一秒內改內容而大小一樣時
-- 只看 mtime 會漏掉）。掃描的對帳會把 file_items 已經不在的列一起清掉。
CREATE TABLE IF NOT EXISTS cleanup_image_sigs (
  item_id  TEXT PRIMARY KEY REFERENCES file_items(id),
  width    INTEGER NOT NULL,
  height   INTEGER NOT NULL,
  size     INTEGER NOT NULL,     -- 算的時候的檔案大小
  mtime    TEXT NOT NULL,        -- 算的時候的 mtime
  hash     TEXT NOT NULL,        -- dHash
  fine_w   INTEGER NOT NULL,
  fine_h   INTEGER NOT NULL,
  fine     BLOB NOT NULL,        -- 細比對縮圖
  at       TEXT NOT NULL
);

-- 目前的連拍組。**每一次完整掃描重算**，不是歷史紀錄：組散掉時這裡的列就沒了
-- （候選另外走 skipped）。留下的那張自己也有一列（keep_id = item_id），
-- 它的 level 就是整組的等級，boxes 是空的 —— 縮圖端點只認得這張表，
-- 「現在還在某一組裡」才給圖。boxes 存的是**換算過的 0–1 相對座標**（JSON），
-- 面板照比例畫，後端不外流原圖尺寸以外的東西。
CREATE TABLE IF NOT EXISTS cleanup_burst_members (
  item_id  TEXT PRIMARY KEY REFERENCES file_items(id),
  group_id TEXT NOT NULL,
  keep_id  TEXT NOT NULL REFERENCES file_items(id),
  level    TEXT NOT NULL CHECK (level IN ('same','similar')),
  boxes    TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cleanup_burst_group ON cleanup_burst_members(group_id, item_id);

-- ── 文件的內容 ───────────────────────────────────────────────
-- 掃描時讀出來的文字（.txt／.md／.csv／Word／PowerPoint／PDF 的文字層），給 P2 的模型與之後的改名用。
-- **這是快取，不是事實**（跟 cleanup_image_sigs 同一個規矩）：讀的時候的 size 與 mtime 一起存，
-- 任一個跟現在的檔對不上就重讀。讀不懂的檔也留一列（text 是 NULL、reason 寫原因），
-- 這樣 size／mtime 沒變就不會每一輪都再試一次。
-- **裡面是使用者檔案的內容**（講義、履歷、對帳單…）：這個資料庫的權限要跟家目錄一樣，
-- db.ts 的 lockDown 已經把資料夾 0700、檔案 0600 設好了。
CREATE TABLE IF NOT EXISTS file_texts (
  item_id   TEXT PRIMARY KEY REFERENCES file_items(id),
  kind      TEXT NOT NULL CHECK (kind IN ('text','docx','pptx','pdf')),
  text      TEXT,                 -- 讀得懂才有；最多 4000 字（見 read-text.ts 的 STORE_MAX_CHARS）
  chars     INTEGER NOT NULL,     -- 原本讀到幾個字（截斷前）
  truncated INTEGER NOT NULL,     -- 0／1
  has_text  INTEGER NOT NULL,     -- 有沒有文字層（掃描版 PDF 是 0）
  pages     INTEGER,              -- PDF 才有
  unmapped  REAL,                 -- PDF 解不出來的字形比例，P2 拿來決定要不要改用模型看圖
  reason    TEXT,                 -- 讀不懂的原因（看不懂／太大／逾時／記憶體不足）
  size      INTEGER NOT NULL,     -- 讀的時候的檔案大小
  mtime     TEXT NOT NULL,        -- 讀的時候的 mtime
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_file_texts_at ON file_texts(at);

-- ── 模型看懂內容（P2） ───────────────────────────────────────
-- 模型看過的東西：**快取，也是結果**。鍵是「內容的 sha256 ＋ 提示詞版本」，不是路徑 ——
-- 同一份檔複製兩份只問一次，改過內容的重問。存進來的每一個欄位都是**模型的意見**，
-- 不是事實：畫面要標明是模型說的、信心多少、證據是什麼，不可以因為它說了就自動改名或搬檔。
CREATE TABLE IF NOT EXISTS model_views (
  key        TEXT PRIMARY KEY,   -- sha256(內容) + ':' + 提示詞版本
  item_id    TEXT,               -- 最近一次是哪個檔（只是方便查，不是主鍵）
  source     TEXT NOT NULL,      -- image／text
  course     TEXT, topic TEXT, kind TEXT, suggested_name TEXT,
  evidence   TEXT, confidence TEXT,           -- 高／中／低
  model      TEXT NOT NULL, prompt_version TEXT NOT NULL,
  at         TEXT NOT NULL,
  seeded     INTEGER NOT NULL DEFAULT 0       -- 1 ＝ demo 預先塞的，畫面要標示
);
CREATE INDEX IF NOT EXISTS ix_model_views_item ON model_views(item_id);

-- 每一次真的送出去的紀錄。**不存內容**，只存「送了多少」與「多久」——
-- 使用者查得到「今天送了幾次、平均幾秒」，而帳本本身不可以變成第二份內容外洩管道。
CREATE TABLE IF NOT EXISTS model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, item_id TEXT, source TEXT NOT NULL,
  bytes_sent INTEGER, chars_sent INTEGER, ok INTEGER NOT NULL, ms INTEGER, error TEXT,
  -- 失敗算誰的帳：'answer'（模型有回應但答案不能用）算這個檔的，'transport'（連不上、逾時、5xx）不算
  blame TEXT
);
CREATE INDEX IF NOT EXISTS ix_model_calls_at ON model_calls(at);

-- 沒送出去的與為什麼（看起來像機密、太短、問不到）。一個檔一列。
CREATE TABLE IF NOT EXISTS model_skips (
  item_id TEXT PRIMARY KEY, why TEXT NOT NULL, at TEXT NOT NULL
);

-- ── 改名（P3） ───────────────────────────────────────────────
-- 每一次改名一列。**這是唯一一份「原本叫什麼」的紀錄**：清理有隔離區，改名沒有 ——
-- 沒有這張表，改壞了就只剩使用者自己記得。所以先寫 started 再動檔案，改完才寫 done；
-- 當機之後靠「檔案實際在哪」收尾（core/rename.ts 的 recoverInterruptedRenames）。
--
-- **為什麼不共用 cleanup_journal**：那張表的 op CHECK 只有 quarantine／restore／skip，
-- 動它要遷移，而且改名不是清理（沒有計畫、沒有候選、不搬家）。
--
-- dir 是**真路徑**，只在本機用來組出要動的檔；**不可以回給畫面**（不變量 9）。
-- from_name／to_name 只有檔名，不含資料夾 —— 改名永遠在同一個資料夾裡（不變量 3）。
CREATE TABLE IF NOT EXISTS renames (
  id        TEXT PRIMARY KEY,          -- uuid
  item_id   TEXT NOT NULL REFERENCES file_items(id),
  from_name TEXT NOT NULL,             -- 只有檔名，不含資料夾
  to_name   TEXT NOT NULL,
  dir       TEXT NOT NULL,             -- 所在資料夾（真路徑；只在本機用，不回給畫面）
  source    TEXT NOT NULL,             -- model／manual
  status    TEXT NOT NULL CHECK (status IN ('started','done','reverted','failed')),
  error     TEXT,
  at        TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_renames_item ON renames(item_id, at);
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

/**
 * 既有資料庫要補的欄位。`CREATE TABLE IF NOT EXISTS` 對已經存在的表什麼都不做，
 * 所以**新欄位一定要在這裡再寫一次**，不然舊的資料庫升級之後會在第一次寫入時炸掉。
 * 每一筆是 [表, 欄位, ADD COLUMN 的完整寫法]；欄位不可以是 NOT NULL（舊的列沒有值）。
 */
const ADDED_COLUMNS: [string, string, string][] = [
  ['file_items', 'naming', `naming TEXT CHECK (naming IN ('untitled','generic','named'))`],
  ['file_items', 'naming_why', 'naming_why TEXT'],
  ['model_calls', 'blame', 'blame TEXT'],
]

/**
 * 補欄位。**同一瞬間可能有很多個行程在做同一件事**（右鍵一次選 8 個檔就是 8 個行程），
 * 所以「已經有這一欄」不算錯 —— 檢查跟 ALTER 之間別人加好了，接住那個訊息就好。
 */
function migrate(db: DatabaseSync): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (cols.some(c => c.name === column)) continue
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`) }
    catch (e: any) {
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e
    }
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
  migrate(db)
  if (path !== ':memory:') lockDown(path, created)
  return db
}
