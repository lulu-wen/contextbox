# ContextBox — 四人分工 spec

2026-09-13　目標：把「檔案與截圖管線」的 P1～P5 拆成四份可以**同時動工**、**不互相擋**的工作。

搭配閱讀：[SPEC-檔案與截圖.md](SPEC-檔案與截圖.md)（管線設計）、
[contextbox-稽核-20260912.md](../contextbox-稽核-20260912.md)（P0 的稽核紀錄，每一條都是踩過的坑）、
[reading/10-參考過的開源專案.md](reading/10-參考過的開源專案.md)（為什麼不 fork）。

---

## 0 ・ 這一版的核心決定：**邊界是資料表與 HTTP，不是函式簽章**

第一版的分法是照「層」切的：理解層 → 行動層 → 介面層。
那個分法有一個致命問題 —— **它是一條鏈**。B 要 import A 的型別，C 要 import B 的函式，
D 要等所有人。A 晚一天，三個人一起晚一天。

這一版改成：**每個人讀一張表、寫一張表，誰都不 import 誰。**

```
   items 表          understanding 表         硬碟 ＋ plans ＋ file_journal
  （P0 已上線）  ──A──▶  （JSON 一欄）    ──B──▶   （真的動作）
                              │                      │
                              └──────── C 只用 HTTP 讀 ───┘

   D 完全不碰這條線：OS 整合、打包、文件、擴充套件
```

好處很具體：

- **A 不用知道 `Op` 或 `Plan` 存在。** 它只負責把圖變成一份 JSON，寫進 `understanding.raw`。
- **B 不用 import A 的碼。** 它從資料庫讀那一欄 JSON，用**自己的**型別去解。
  型別在行程邊界兩側各寫一份是好事，不是重複。
- **C 一行後端碼都不用等。** 它吃 HTTP，開發時吃一份靜態 JSON。
- **D 從第一天到最後一天都不會被擋。** 它做的是 P0 與擴充套件（都已上線）上面的東西。

---

## 1 ・ 四個人負責什麼

| | 角色 | 讀什麼 | 寫什麼 | 會被誰擋住 |
|---|---|---|---|---|
| **A** | 看懂 | `items`（status=new） | `understanding` | **沒有人** |
| **B** | 動作 | `understanding` | 硬碟、`plans`、`file_journal` | 只需要**一份**真的理解，而 fixture 就能代替 |
| **C** | 介面 | HTTP | 畫面 | **沒有人**（開發時吃靜態 JSON） |
| **D** | 平台 | 已上線的 P0 與擴充套件 | 安裝包、右鍵選單、文件 | **沒有人** |

### 檔案所有權（**一個檔案只有一個 owner**）

```
A  core/understand.ts        新   模型呼叫、容錯解析、證據查核
   core/prompt.ts            新   prompt 組裝、PDF 轉圖
   test/understand.test.mjs  新
   test/fixtures/            新   三張圖 ＋ 三份正確答案（第一天就要有）

B  core/plans.ts             新   understanding → Ops
   core/exec.ts              新   四個執行器
   core/journal.ts           新   file_journal 的讀寫與反向重播
   core/routes-write.ts      新   /plans/:id/{apply,undo,dismiss}
   test/plans.test.mjs       新
   test/exec.test.mjs        新

C  core/ui.html              改   收件匣分頁、搜尋分頁
   core/routes-read.ts       新   /inbox、/search、/items/:id/file
   core/search.ts            新   FTS 寫入與查詢（含短詞分流）
   test/search.test.mjs      新
   test/routes-read.test.mjs 新

D  os/windows/*              新   右鍵選單 ＋ 安裝說明（**優先**）
   os/linux/*  os/macos/*    新
   package.json              新   engines、scripts（**不加任何 dependency**）
   README.md  INSTALL.md     改／新
   extension/（2 個 todo）    改
   core/ui.html 的手填頁部分   改   ← 唯一與 C 共用的檔案，見 §5
```

**凍結、誰都不要動**：`core/db.ts`、`guard.ts`、`watcher.ts`、`items.ts`、`config.ts`、
`facts.ts`、`validate.ts`、`schema/`。有需求開 issue，不要直接改。

---

## 2 ・ 第一天要凍結的四樣東西（**只有四樣**）

第一版要凍三份 TypeScript 契約。這一版只需要這些，而且都不是程式碼介面：

### 2.1　`understanding.raw` 裡那一包 JSON 的形狀

A 寫進去、B 讀出來。**兩邊各自定義自己的型別，不共用檔案。**

```jsonc
{
  "doc_type": "scholarship",       // enum，11 種，見 SPEC-檔案與截圖.md §6
  "category": "獎學金",             // enum，10 種，來自 guard.ts 的 CATEGORIES
  "summary": "台大 115 學年度弱勢學生助學金申請公告",
  "text": "（畫面上看得到的字。contains_secret 為 true 時是空字串）",
  "tags": ["獎學金", "台大"],
  "suggested_name": "台大弱勢助學金公告",   // 不含副檔名，B 會再過一次 guard.safeName
  "contains_secret": false,
  "events":       [{ "title": "說明會", "date": "2026-09-18", "time": "14:00", "evidence": "說明會：115 年 9 月 18 日…" }],
  "tasks":        [{ "title": "備妥成績單", "due": "2026-09-30", "evidence": "2. 最近一學期成績單正本" }],
  "missing_docs": [{ "what": "戶籍謄本", "why": "應繳文件第 1 項", "evidence": "1. 全戶戶籍謄本（三個月內）" }],
  "facts":        [{ "key": "education[0].school", "value": "國立臺灣大學", "evidence": "國立臺灣大學 學務處生活輔導組" }]
}
```

**A 保證**：寫進去的東西一定通過驗證 —— enum 合法、`facts[].key` 在 `factKeys.ts` 裡、
**每一個 `evidence` 都真的出現在 `text` 裡**。驗不過的那一項會被丟掉，不會寫進去。

**B 可以假設**：讀出來的 JSON 是乾淨的。但仍然要自己擋一次（防禦性，不是不信任 A）。

### 2.2　`/inbox` 回應的樣子

C 出一份 `docs/inbox-example.json`，**半小時的事**。C 整個開發期間都吃這份，
不用等後端。B 與 C 各自照著它做，不用對接。

### 2.3　`test/fixtures/`

A 第一天產出，其他人一律吃這個：

```
test/fixtures/獎學金公告.png  ＋ .understanding.json     正常案例
test/fixtures/發票.png        ＋ .understanding.json     另一種 doc_type
test/fixtures/亂七八糟.png    ＋ .understanding.json     模型會答錯、應該被擋下來的那種
```

### 2.4　`core/server.ts` 掛載兩個 route module

**這是唯一一次改 server.ts**，由 lead 在第一天做完，十行，之後誰都不碰：

```ts
import { readRoutes } from './routes-read.ts'      // C
import { writeRoutes } from './routes-write.ts'    // B
// …在既有的三道鎖之後：
if (await readRoutes(req, res, ctx)) return
if (await writeRoutes(req, res, ctx)) return
```

`ctx` 帶 `{ db, config, items, facts }`。兩個 module 各自處理自己的路徑、
認不得就回 `false` 讓下一個接手。

---

## 3 ・ 每個人的工作與驗收

### A — 看懂

**為什麼這份最難**：實測顯示模型**不遵守 schema、而且會幻覺**
（詳見 [reading/10](reading/10-參考過的開源專案.md) 第四節）。
所以這一層的價值不在呼叫 API，在**把不可信的輸出變成可信的資料**。

1. `prompt.ts` — 組 prompt；PDF 用 `pdftoppm` 轉前 N 頁（沒裝就標 `error`，不要硬撐）
2. `understand.ts` — 一次 `fetch`，零依賴，逾時 60 秒，同 `sha256` 不重問
3. **容錯解析** — 剝 ` ```json ` 圍欄、抓第一個平衡的 `{...}`、修尾逗號
4. **程式驗 schema** — enum 比對、`facts[].key` 不在註冊表就丟掉那一項
5. **證據查核（最重要）** — 每個 `evidence` 必須真的出現在 `text` 裡（正規化後比對），
   對不上就丟掉那一項。**這是唯一擋得住幻覺的機制，而且免費。**
6. 驗不過就**重問一次**（把錯誤帶回去），還是不行就寫 `items.status='error'`

**驗收**
- 三張 fixture 跑過，第三張（會答錯的）**必須被擋下**，不可以寫進 `understanding`
- 餵一個 `evidence` 對不上的假回應 → 那一項消失
- 餵 ` ```json ` 圍欄、尾逗號、違反 enum 的值 → 三種都要救得回來或明確失敗
- `node cli.mjs understand` 跑完，`understanding` 表有資料，`items.status` 變 `proposed`

### B — 動作

1. `plans.ts` — 從 `understanding.raw` 組出 Ops。**目的地由程式算**：
   `guard.destFor(category, safeName(...))`。模型只給分類與檔名，**這條不可以妥協**
2. `exec.ts` — 四個執行器，每個第一行檢查 `config.readonly`
3. `journal.ts` — **先寫 journal 再動作**；復原是倒序重播
4. 同名不覆蓋（`(2)`、`(3)`）；**整個專案不准出現 `unlink`／`rm`／`rmdir`**（`test/repo.test.mjs` 會擋你）
5. 搬完要 `items.setPath()`，不然資料庫指向不存在的路徑
6. `fact` op 直接呼叫既有的 `Facts.propose()`（凍結的碼，不用等 D），
   `source_kind` 用 `'file'`、`source_ref` 填檔名

**驗收**
- 同意後檔案真的搬了、改名了；**復原退回原位原名**
- `CONTEXTBOX_READONLY=1` 跑一次，**一個檔案都沒動**（斷言 mtime 沒變）
- 目的地已有同名檔 → 變成 `(2)`，舊的不被覆蓋
- 執行到一半丟例外 → 已完成的那幾步仍然可以復原
- 餵一個 `suggested_name` 是 `../../.ssh/authorized_keys` 的理解 → 檔案落在 `Filed/其他/` 底下

### C — 介面

1. `routes-read.ts` — `/inbox`、`/search`、`/items/:id/file`。
   最後一個是新的攻擊面：**只認 item id，不接路徑**，送出前再過一次 `admit()`
2. `ui.html` 收件匣分頁：縮圖 ＋ 摘要 ＋ 逐列可取消的 ops ＋ `[全部同意]` `[略過]` ＋ 同意後變 `[復原]`
3. **健康列**：看哪幾個資料夾、模型連不連得到、幾張待處理、監看有沒有在跑。
   靜默失敗是這種工具最大的敵人
4. `search.ts` ＋ 搜尋分頁。**短詞（< 3 字）走 LIKE** —— trigram 至少要三個字元，
   不處理的話「發票」「收據」永遠搜不到。`LIKE` 記得 `ESCAPE`
5. `items_fts` 的寫入收斂成一個 upsert（先 DELETE 再 INSERT）—— 現在沒有人負責寫

**驗收**
- 吃 `docs/inbox-example.json` 就能把整個畫面做完，**過程中不需要 A 或 B 交付任何東西**
- `/items/:id/file` 餵不存在的 id、餵路徑當 id → 403／404
- 搜尋「發票」找得到；`%`、`_`、`a-b`、`2026/09` 都不崩、不倒資料
- 重跑一次理解，`items_fts` 不會變成兩列

### D — 平台

**完全不碰管線。** 做的是把已經上線的東西變成「裝得起來的產品」。

1. **Windows 右鍵選單優先** —— 那是使用者真的在用的機器。
   `HKCU\Software\Classes\*\shell\ContextBox\command` → `node cli.mjs propose "%1"`
2. Linux（Nautilus script）與 macOS（快速動作）
3. 「在檔案總管顯示」：`explorer.exe /select,` ／ `open -R` ／ `nautilus --select`
4. `package.json`：`engines.node >= 24`、`scripts.test`。**不准加任何 dependency**
5. `INSTALL.md` — 一台乾淨的機器照著裝，不用問任何人
6. 既有的 2 個擴充套件 todo：敏感欄位空值洩漏「我沒有這筆」、「成績」別名撞 key
7. 手填頁顯示事實的來源（「來自 xxx.png」）—— 資料是 B 寫進去的，
   但**那是既有的 `facts` 表**，D 不用等 B

**驗收**
- Windows 上右鍵一個檔 → `node cli.mjs list` 看得到它
- 照 `INSTALL.md` 在乾淨機器上裝起來
- `node --test test/*.test.mjs` 的 2 個 todo 變成 0

---

## 4 ・ 依賴圖

```
第 1 天（半天）
  lead   把 server.ts 的兩行掛載做掉
  A      產出 test/fixtures/（三張圖 ＋ 三份答案）
  C      產出 docs/inbox-example.json
  ↓

A ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶   全程不被擋
B ━━━ 吃 fixture ━━━━━━━━━━━━━━━━━━━━━▶   全程不被擋
C ━━━ 吃 inbox-example.json ━━━━━━━━━━▶   全程不被擋
D ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶   全程不被擋

唯一的整合點（最後幾天）
  A×B   B 把 fixture 換成資料庫裡真的 understanding 列
  B×C   C 把靜態 JSON 換成真的 /inbox
  D     把全部裝起來，端到端跑一次
```

**跟第一版比**：整合點從三個（第 4、6、8 天）縮成**全部集中在最後**，
而且任何一個人落後都不會擋住其他三個。

---

## 5 ・ 怎麼協作

- **分支**：`feat/understand`、`feat/plans`、`feat/ui`、`feat/os`，從 `main` 開，PR 回 `main`
- **一個 PR 只動自己 owner 的檔案。** 要動別人的，先在 PR 裡 @ 他
- **唯一的共用檔是 `core/ui.html`**（C 做新分頁、D 改手填頁）。
  兩人各自只碰自己的 `<section>`，先講好誰先 merge
- **每個 PR 都要有測試**，而且測試要**驗過會失敗**（把修法拿掉，測試要變紅）
- **merge 前跑 `audit-round`**。這個 repo 的歷史證明「我覺得修好了」有一半會被推翻 ——
  P0 那一輪 59 條發現裡，有 2 條是**修正自己引進的新問題**
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

桌面寵物、事件與待辦真的寫進行事曆與 Todoist、向量語意搜尋、docx／pptx、
多機同步、對外開放的 MCP server。
