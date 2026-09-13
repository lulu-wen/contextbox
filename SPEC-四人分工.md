# ContextBox — 四人分工 spec

2026-09-13　目標：把「檔案與截圖管線」的 P1～P5 拆成四份可以**同時動工**、**不互相踩**的工作。

搭配閱讀：[SPEC-檔案與截圖.md](SPEC-檔案與截圖.md)（管線設計）、
[contextbox-稽核-20260912.md](../contextbox-稽核-20260912.md)（P0 的稽核紀錄，裡面每一條都是踩過的坑）。

---

## 0 ・ 現況

**已完成、不要改**（除非你是那個檔案的 owner）：

| 區塊 | 內容 | 狀態 |
|---|---|---|
| 事實庫 | `schema/factKeys.ts`（75 個 key）、`core/facts.ts`、`core/validate.ts`、`core/db.ts` | 上線，跑過兩輪稽核 |
| 本機 server | `core/server.ts`（三道鎖）、`core/ui.html`（手填頁） | 上線 |
| 擴充套件 | `extension/`（認欄位、填值、敏感欄位要人再點） | 上線，2 個已知 todo |
| **管線地基** | `core/config.ts`、`guard.ts`、`watcher.ts`、`items.ts`、`cli.mjs` | **上線**，194 tests / 0 fail |

**這一輪要做**：P1 看懂 → P2 卡片與同意 → P3 接回事實庫 → P4 檔案總管 → P5 搜尋。

**模型現況（已實測，2026-09-13）**：
- porin 上唯一能看圖的是 `google/gemma-4-E4B-it`。`Qwen/Qwen2.5-Omni-7B` 帶圖一律 400。
- 繁中 OCR 品質很好（民國年換算也正確）。
- **但 `json_schema` strict／`json_object`／`guided_json` 三種強制格式全部無效** ——
  永遠包在 ` ```json ` 圍欄裡，而且會違反 enum。
- **而且會幻覺**：同一張圖短 prompt 時把「國立臺灣大學」讀成「國立嘉義大學」。
- 速度：長 prompt 約 44 秒，短 prompt 約 5 秒。

這三件事直接決定了 A 的工作內容，見下。

---

## 1 ・ 四個人負責什麼

| | 角色 | 一句話 | 對外介面 |
|---|---|---|---|
| **A** | 理解層 | 把一張圖變成一份**可信的** Proposal | `understand(item, cfg) → Result<Proposal>` |
| **B** | 行動層 | 把 Proposal 變成 Ops，執行、記錄、復原 | `planFor()` / `apply()` / `undo()` |
| **C** | 介面層 | 收件匣與搜尋：人在哪裡按同意 | HTTP 路由 ＋ `ui.html` 分頁 |
| **D** | 落地層 | 讓它變成一個裝得起來的東西 | 右鍵選單、打包、接回事實庫 |

### 檔案所有權（**一個檔案只有一個 owner**）

```
A  core/understand.ts        新   模型呼叫、容錯解析、證據查核
   core/proposal.ts          新   Proposal 型別 ＋ 驗證器 ＋ JSON schema
   core/prompt.ts            新   prompt 組裝（含 PDF 轉圖）
   test/understand.test.mjs  新
   test/proposal.test.mjs    新

B  core/plans.ts             新   Proposal → Ops、plan 的生命週期
   core/exec.ts              新   四個執行器（move／rename／fact／event）
   core/journal.ts           新   file_journal 的讀寫與反向重播
   test/plans.test.mjs       新
   test/exec.test.mjs        新

C  core/server.ts            改   §4 的新路由
   core/ui.html              改   收件匣分頁、搜尋分頁
   core/search.ts            新   FTS 寫入與查詢（含短詞分流）
   test/server.test.mjs      改
   test/search.test.mjs      新

D  core/facts-bridge.ts      新   fact op → Facts.propose，來源標記
   os/windows/*              新   右鍵選單 .reg ＋ 安裝說明
   os/linux/*  os/macos/*    新
   package.json              新   engines、scripts（**不加任何 dependency**）
   README.md                 改   換成真正的專案說明（現在是黑克松筆記）
   INSTALL.md                新
   extension/（2 個 todo）    改
   test/facts-bridge.test.mjs 新
```

**共用但凍結的檔案**：`core/db.ts` 的 schema 已經定好（`items`／`understanding`／
`items_fts`／`plans`／`file_journal`）。**要改 schema 一律先在群組講**，因為四個人都靠它。
`core/guard.ts`／`watcher.ts`／`items.ts`／`config.ts` 同理 —— 有需求開 issue，不要直接改。

---

## 2 ・ 契約（**第一天就凍結，所有人照這個寫**）

這一節是整份 spec 最重要的部分。契約定好，四個人可以完全平行動工，不用等彼此。

### 2.1　`core/proposal.ts`（A 寫，第一天就要 merge）

```ts
/** 模型的輸出。**沒有任何路徑欄位，這是刻意的。** */
export type Proposal = {
  doc_type: 'scholarship' | 'invoice' | 'receipt' | 'paper' | 'ticket'
          | 'chat' | 'code' | 'webpage' | 'form' | 'certificate' | 'other'
  category: (typeof CATEGORIES)[number]        // 來自 guard.ts，enum
  summary: string                              // 一句話，人看的
  text: string                                 // 畫面上看得到的字（contains_secret 時為空）
  tags: string[]
  suggested_name: string                       // 不含副檔名，會被 guard.safeName 洗
  contains_secret: boolean
  events:       { title: string; date: string; time?: string; evidence: string }[]
  tasks:        { title: string; due?: string; evidence: string }[]
  missing_docs: { what: string; why: string; evidence: string }[]
  facts:        { key: string; value: string; evidence: string }[]
}

/** 成功與失敗都要講得出原因。不要用丟例外表示「模型講不清楚」。 */
export type Result<T> =
  | { ok: true; value: T; meta: { model: string; ms: number; tokens: number; repaired: boolean } }
  | { ok: false; why: string; raw?: string }

/** 驗證器。B、C 都可以直接用來擋壞資料。 */
export function vetProposal(raw: unknown, ocrText: string): Result<Proposal>
```

### 2.2　`core/plans.ts`（B 寫，第一天就要 merge 型別）

```ts
export type Op =
  | { op: 'move';   from: string; to: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'fact';   key: string; value: string; evidence: string }   // 只 propose，不 confirm
  | { op: 'event';  title: string; date: string; ics: string }       // 只產 .ics，不碰行事曆
  | { op: 'task';   title: string; due?: string }                    // 這一版只顯示

export type Plan = {
  id: string; itemId: string; proposal: Proposal
  ops: Op[]                       // **由程式從 proposal 組出來，模型碰不到**
  status: 'proposed' | 'applied' | 'reverted' | 'dismissed'
  createdAt: string; appliedAt?: string
}

export function planFor(item: Item, p: Proposal, cfg: Config): Plan
export function apply(db, planId: string, skip: number[]): { done: number; skipped: number; failed: string[] }
export function undo(db, planId: string): { reverted: number }
```

### 2.3　HTTP（C 寫，B 與 D 依賴）

| 路由 | 方法 | 進 | 出 |
|---|---|---|---|
| `/inbox` | GET | `?status=proposed` | `{ items: [{ item, understanding, plan }] }` |
| `/items/:id/file` | GET | — | 原檔（只服務 `items` 表裡的路徑，送出前再過一次 guard） |
| `/items/:id/understand` | POST | — | 重新問一次模型 |
| `/plans/:id/apply` | POST | `{ skip: number[] }` | `{ done, skipped, failed }` |
| `/plans/:id/undo` | POST | — | `{ reverted }` |
| `/plans/:id/dismiss` | POST | — | `{ ok: true }` |
| `/search` | GET | `?q=&from=&to=` | `{ hits: [...] }` |
| `/health` | GET | — | 加 `watching[]`、`pending`、`model`、`lastSeen` |

### 2.4　假資料（**第一天就要有**，讓大家不用等彼此）

A 負責在 `test/fixtures/` 放三份：

```
test/fixtures/獎學金公告.png        真的截圖
test/fixtures/獎學金公告.proposal.json   對應的正確 Proposal
test/fixtures/發票.png / .proposal.json
test/fixtures/亂七八糟.png / .proposal.json   模型會答錯的那種
```

B、C、D 一律吃 fixture，不要等 A 的模型串好。

---

## 3 ・ 每個人的工作與驗收

### A — 理解層

**為什麼這份最難**：實測顯示模型**不遵守 schema、而且會幻覺**。所以這一層的價值不在
「呼叫 API」，在**「把不可信的輸出變成可信的資料」**。

要做的：
1. `core/prompt.ts` — 組 prompt；PDF 用 `pdftoppm` 轉前 N 頁 PNG（沒裝就標 `error`，不要硬撐）
2. `core/understand.ts` — 一次 `fetch`，零依賴，逾時 60 秒，同 `sha256` 不重問
3. **容錯解析** — 剝 ` ```json ` 圍欄、抓第一個平衡的 `{...}`、修尾逗號
4. **程式驗 schema** — enum 比對、key 白名單（`facts[].key` 不在 `factKeys.ts` 就丟掉那一項）、字串長度
5. **證據查核（這條最重要）** — 每一個 `events`／`tasks`／`missing_docs`／`facts` 的
   `evidence` 字串，**必須真的出現在 `text` 裡**（正規化後比對），對不上就丟掉那一項並記下來。
   這是唯一擋得住幻覺的機制，而且免費。
6. 驗不過就**重問一次**（把錯誤訊息帶回去），還是不行就 `error`，不要無限重試

**驗收**：
- 拿 `test/fixtures/` 的三張圖跑，第三張（會答錯的那張）**必須被擋下來**，不可以入庫
- 故意餵一個 `evidence` 對不上的假回應，那一項要消失
- 故意餵 ` ```json ` 圍欄、尾逗號、違反 enum 的值，三種都要救得回來或明確失敗
- 零外部依賴；`node --test` 全綠

### B — 行動層

要做的：
1. `planFor()` — **目的地由程式組**。模型只給 `category` 與 `suggested_name`，
   路徑是 `guard.destFor(category, safeName(...))` 算出來的。這條不可以妥協。
2. 四個執行器，每個第一行檢查 `config.readonly`
3. `journal.ts` — **先寫 journal 再動作**；復原是倒序重播
4. 同名不覆蓋（`(2)`、`(3)`）；**整個專案不准出現 `unlink`／`rm`／`rmdir`**
   （`test/repo.test.mjs` 會擋你）
5. 搬完要 `items.setPath()`，不然資料庫指向不存在的路徑

**驗收**：
- 同意後檔案真的搬了、名字改了；**復原退回原位原名**
- `CONTEXTBOX_READONLY=1` 跑一次，**一個檔案都沒動**（測試要斷言 mtime 沒變）
- 目的地已經有同名檔 → 變成 `(2)`，舊的不被覆蓋
- 執行到一半丟例外 → 已完成的那幾步仍然可以復原
- 餵一個 `suggested_name` 是 `../../.ssh/authorized_keys` 的 Proposal → 檔案落在 `Filed/其他/` 底下

### C — 介面層

要做的：
1. `server.ts` 的新路由（§2.3）。`/items/:id/file` 是新的攻擊面 —— **只認 item id，不接路徑**，送出前再過一次 `admit()`
2. `ui.html` 收件匣分頁：縮圖 ＋ 摘要 ＋ 逐列可取消的 ops ＋ `[全部同意]` `[略過]` ＋ 同意後變 `[復原]`
3. **健康列**：正在看哪幾個資料夾、模型連不連得到、幾張待處理、監看有沒有在跑。
   靜默失敗是這種工具最大的敵人。
4. `search.ts` ＋ 搜尋分頁。**短詞（< 3 字）要走 LIKE** —— trigram 索引至少要三個字元，
   不處理的話「發票」「收據」永遠搜不到。`LIKE` 記得 `ESCAPE`，不然打一個 `%` 會把整個資料庫倒出來。
5. `items_fts` 的寫入要收斂成一個 `upsert`（先 DELETE 再 INSERT），現在沒有人負責寫

**驗收**：
- 端到端：開網頁 → 看到卡片 → 按同意 → 檔案真的動了 → 按復原 → 退回去
- `/items/:id/file` 餵一個不在 `items` 裡的 id、餵路徑當 id，都要 403／404
- 搜尋「發票」找得到；搜尋 `%`、`_`、`a-b`、`2026/09` 都不可以崩、不可以倒資料
- 重跑一次理解，`items_fts` 不可以變成兩列

### D — 落地層

要做的：
1. `facts-bridge.ts` — `fact` op → `Facts.propose()`，`source_kind` 用一個**獨立的值**
   （建議 `screenshot`），跟手填、履歷解析區隔開。手填頁要顯示「來自 xxx.png」。
   **這條路的終點是擴充套件會把值填進真的網頁表單**，所以 UI 上不可以批次確認。
2. 三個 OS 的薄層（右鍵「用 ContextBox 整理」→ `node cli.mjs propose "%1"`；
   「在檔案總管顯示」）。**Windows 優先**，那是使用者真的在用的機器。
3. `package.json`：`engines.node >= 24`、`scripts.test`。**不准加任何 dependency。**
4. `README.md` 重寫（現在是黑克松筆記）＋ `INSTALL.md`
5. 既有的 2 個擴充套件 todo：敏感欄位空值洩漏「我沒有這筆」、「成績」別名撞 key

**驗收**：
- 一張在職證明截圖 → `work[].company` 候選 → 在手填頁按確認 → **擴充套件在測試表單填得出來**
- Windows 上右鍵一個檔 → 收件匣出現卡片；搜尋結果按「顯示」→ 檔案總管跳出來選中它
- 照 `INSTALL.md` 在一台乾淨的機器上裝起來，不用問任何人
- `node --test test/*.test.mjs` 的 2 個 todo 變成 0

---

## 4 ・ 依賴與順序

```
第 1 天   ── 所有人一起 ──
          凍結契約：A 的 proposal.ts 型別、B 的 plans.ts 型別、C 的路由表
          A 產出 test/fixtures/（三張圖 ＋ 三份正確答案）
          ↓  之後完全平行

A ─────────────────────────────────▶ 理解層
B ──── 吃 fixture ─────────────────▶ 行動層          兩者不需要等彼此
C ──── 吃 fixture ＋ 假的 plans ───▶ 介面層
D ──── 吃 fixture ─────────────────▶ 落地層

          ── 整合點 1（約第 4 天）──  A×B：真的 Proposal 進 planFor
          ── 整合點 2（約第 6 天）──  B×C：真的 plan 進 UI
          ── 整合點 3（約第 8 天）──  D×全部：裝起來，端到端一次
```

**誰都不要等模型。** 模型那條線只有 A 碰，其他人一律吃 fixture。

---

## 5 ・ 怎麼協作

- **分支**：`feat/understand`、`feat/plans`、`feat/ui`、`feat/os`，從 `main` 開，PR 回 `main`
- **一個 PR 只動自己 owner 的檔案。** 要動別人的，先在 PR 裡 @ 他
- **每個 PR 都要有測試**，而且測試要**驗過會失敗**（把修法拿掉，測試要變紅）
- **merge 前跑 `audit-round`**（`.claude/skills/audit-round`）。這個 repo 的歷史證明
  「我覺得修好了」有一半會被推翻 —— P0 那一輪 59 條發現裡，有 2 條是**修正自己引進的新問題**
- 中文全形標點；註解寫「為什麼」不寫「做了什麼」

---

## 6 ・ 已知地雷（P0 踩過，不要再踩一次）

| 地雷 | 會怎樣 |
|---|---|
| `busy_timeout` 不是第一個 pragma | 全新資料庫 12 個行程同時開，只有 1 個活下來 |
| 以路徑當快取鍵 | 同名覆蓋、暫時失敗的檔案**永遠**消失 |
| 子字串比對黑名單 | `Secretariat`、`OneDrive - Secret Project` 整個資料夾被擋掉 |
| 只看 `lstat` | 硬鏈結（`ln` 不是 `ln -s`）整個繞過捷徑防線 |
| 檢查完才讀檔 | 中間可以被換成指向 `~/.ssh` 的捷徑 |
| 原始碼裡寫真的 NUL 位元組 | git 當二進位檔，diff 看不到、grep 掃不到 |
| 安全開關型別寫錯 fail-open | `readonly: "true"` 靜靜變成 false |
| `LIKE` 沒有 `ESCAPE` | 打一個 `%` 把整個資料庫倒出來 |
| 註解說有做、程式沒做 | 這個 repo 出過三次 |

---

## 7 ・ 不在這一輪（想做先講）

桌面寵物、事件／任務真的外送到行事曆與 Todoist、向量語意搜尋、docx／pptx、
多機同步、對外開放的 MCP server。
