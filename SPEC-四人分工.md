# ContextBox — 四人分工 spec

2026-09-13　目標：四個人平行做，但交付順序跟 [SPEC-實作計畫.md](SPEC-實作計畫.md) 對齊：

1. 先在 Windows 與 macOS 上確認 P0 地基真的能跑。
2. 先做出 CLI 端到端：截圖進來 → 看懂 → `inbox` → `approve` → `undo`。
3. 再做網頁、右鍵選單、搜尋。

舊分法最大的問題是把 C 太早丟去做網頁、把 D 丟去做一堆平台薄層，結果 M1 的「能每天用」沒有人完整收口。這版改成：**每個人都有自己的主線，但第一個共同終點是 M1 CLI E2E。**

搭配閱讀：

- [SPEC-實作計畫.md](SPEC-實作計畫.md) — 現行里程碑，M0～M4
- [SPEC-檔案與截圖.md](SPEC-檔案與截圖.md) — 管線設計
- [reading/06-視覺模型.md](reading/06-視覺模型.md) — 模型風險與實測

---

## 0 ・ 這一版怎麼切

不要用「前端、後端、平台」切。這會讓前端等後端、平台等產品形狀、最後才發現使用者機器不能跑。

這版用四條可獨立驗收的線：

| 人 | 主線 | 第一個可驗收結果 | 後續 |
|---|---|---|---|
| **A** | 收檔 ＋ 看懂 | `node cli.mjs understand` 讓 `new` 變 `proposed` | fixture、模型容錯、證據查核 |
| **B** | 提案 ＋ 執行 ＋ 復原 | `approve <id>` 搬檔，`undo <id>` 搬回來 | journal、write routes |
| **C** | 人看的操作面 ＋ macOS smoke | `inbox` 印出可同意的提案；macOS 跑通 `doctor/watch/list` | 網頁收件匣、搜尋、Finder Quick Action |
| **D** | Windows 可用性 ＋ 發行收斂 | 乾淨 Windows 機器跑通 `doctor/watch/list` | Windows 右鍵選單、INSTALL、release QA |

共同原則：**邊界是資料表、CLI 輸出與 HTTP，不是互相 import 函式。**

A 可以先寫 fixture，B/C 可以直接吃 fixture 開工；D 從第一小時在 Windows 上找雷，C 同步在 macOS 上跑 smoke。D 收斂發行文件與最後驗收，不一個人扛兩個 OS。

---

## 1 ・ 共用契約，只凍結四個

### 1.1 `understanding.raw`

A 寫入、B/C 讀取。兩邊可以各自定義型別，不共用檔案。

```jsonc
{
  "doc_type": "scholarship",
  "category": "獎學金",
  "summary": "台大 115 學年度弱勢學生助學金申請公告",
  "text": "畫面上看得到的字；contains_secret 為 true 時是空字串",
  "tags": ["獎學金", "台大"],
  "suggested_name": "台大弱勢助學金公告",
  "contains_secret": false,
  "events": [{ "title": "說明會", "date": "2026-09-18", "time": "14:00", "evidence": "說明會：115 年 9 月 18 日" }],
  "tasks": [{ "title": "備妥成績單", "due": "2026-09-30", "evidence": "最近一學期成績單正本" }],
  "missing_docs": [{ "what": "戶籍謄本", "why": "應繳文件第 1 項", "evidence": "全戶戶籍謄本" }],
  "facts": [{ "key": "education[0].school", "value": "國立臺灣大學", "evidence": "國立臺灣大學" }]
}
```

A 保證：

- enum 合法。
- `facts[].key` 在 `schema/factKeys.ts` 裡。
- 每個 `evidence` 都真的出現在 `text` 裡；對不上就丟掉那一項。
- `contains_secret: true` 時不存完整 `text`。

B/C 仍然要防禦性檢查，但可以用 fixture 先做完整流程。

### 1.2 `Plan.ops`

B 產出、C 顯示、B 執行。

```ts
type Op =
  | { op: 'move'; from: string; to: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'fact'; key: string; value: string; evidence: string }
  | { op: 'event'; title: string; date: string; ics: string }
  | { op: 'task'; title: string; due?: string }
```

模型永遠不能提供目的地路徑。目的地一律由 B 用 `guard.destFor(category, safeName(...))` 算。

### 1.3 CLI 格式

C 先定 `inbox` 的輸出，B 照這個讓 `approve/undo` 能接。

```text
[a1b2]  獎學金公告.png                              獎學金
        台大 115 學年度弱勢學生助學金申請公告
        1. 搬到  Filed/獎學金/台大弱勢助學金公告.png
        2. 待辦  備妥成績單（2026-09-30 前）
        3. 事實  education[0].school = 國立臺灣大學
        approve a1b2
        approve a1b2 --skip 2,3
```

### 1.4 HTTP 回應

C 第一天產出 `docs/inbox-example.json`。M2 之前 UI 都吃這份；C 做 `/inbox` 時照它回。

---

## 2 ・ 檔案所有權

一個檔案只放一個 owner。要動別人的檔案，先在 PR 說明原因。

### A — 收檔與看懂

```text
core/understand.ts        新
core/prompt.ts            新
test/understand.test.mjs  新
test/fixtures/            新
```

可動既有檔案：

```text
cli.mjs                   只加 understand 子指令
core/db.ts                只在確定缺表時加 migration；先確認現況
```

### B — 提案、執行、復原

```text
core/plans.ts             新
core/exec.ts              新
core/journal.ts           新
core/routes-write.ts      新
test/plans.test.mjs       新
test/exec.test.mjs        新
test/journal.test.mjs     新
```

可動既有檔案：

```text
cli.mjs                   只加 approve、undo 子指令
```

### C — 操作面、讀取路由、搜尋

```text
core/routes-read.ts       新
core/search.ts            新
docs/inbox-example.json   新
test/routes-read.test.mjs 新
test/search.test.mjs      新
test/macos-smoke.md       新，手動驗收紀錄
os/macos/*                新
```

可動既有檔案：

```text
cli.mjs                   只加 inbox/search；M3 可協助 macOS reveal
core/ui.html              M2 後才改：收件匣分頁、搜尋分頁、健康列
```

### D — Windows、發行收斂、整合驗收

```text
M0-Windows檢查.md         改
os/windows/*              新
INSTALL.md                新
package.json              新
test/windows-smoke.md     新，手動驗收紀錄
```

可動既有檔案：

```text
README.md                 裝法與 demo script
extension/*               只修已知 2 個 todo
core/ui.html              只改手填頁來源顯示；避開 C 的新分頁
cli.mjs                   只加 Windows reveal 子指令或 Windows 顯示檔案輔助
```

暫時凍結：`guard.ts`、`watcher.ts`、`items.ts`、`config.ts`、`facts.ts`、`validate.ts`、`schema/`。除非 M0 在 Windows/macOS 上驗出 bug，否則不要碰。

---

## 3 ・ 第一天安排

### 上午：M0，全員看 Windows/macOS

D 開 Windows 主機或遠端畫面，C 開 macOS 主機或遠端畫面，四個人一起跑：

```bash
node --test test/*.test.mjs
node cli.mjs doctor
node cli.mjs watch
node cli.mjs list
```

驗收寫進 [M0-Windows檢查.md](M0-Windows檢查.md)：

- Node 版本、Windows 版本、是否 OneDrive。
- 測試紅燈清單。
- `Win + Shift + S` 截圖是否進 `items`。
- `Pictures` 是否被 OneDrive 整包拉回本機。
- Tailscale／模型端點是否通。

macOS 驗收由 C 記進 `test/macos-smoke.md`：

- Node 版本、macOS 版本、截圖預設路徑。
- `Cmd + Shift + 5` 或截圖工具產生的檔案是否進 `items`。
- `doctor/watch/list` 是否能跑。
- Tailscale／模型端點是否通。

如果 M0 有 blocker，Windows 由 D 收口，macOS 由 C 收口；A/B 只協助定位，不要全部人卡在修平台。

### 下午：四個人分開產 fixture 與假資料

| 人 | 當天交付 |
|---|---|
| A | `test/fixtures/` 三張圖與三份 `.understanding.json` |
| B | 用 fixture 產出第一份 `plans`，先不用真的搬檔 |
| C | `docs/inbox-example.json`、`node cli.mjs inbox` 的輸出版型、macOS smoke 紀錄 |
| D | `INSTALL.md` 骨架、Windows 右鍵 registry 草稿、Windows M0 修正清單 |

這天下班前要能做到：B/C 不等模型，A 不等 B，D 不等任何後端。

---

## 4 ・ 每個人的工作與驗收

### A — 收檔與看懂

#### 工作

1. `prompt.ts`：組 prompt；PDF 用 `pdftoppm` 轉前 N 頁。Windows 沒裝 poppler 時，PDF 標成明確 error，不影響截圖。
2. `understand.ts`：一次 `fetch`，逾時 60 秒，同 `sha256` 不重問。
3. 容錯解析：剝 ` ```json ` 圍欄、抓第一個平衡 `{...}`、修尾逗號。
4. schema 驗證：doc type、category、facts key、字串長度。
5. 證據查核：每個 `evidence` 必須出現在正規化後的 `text` 裡。
6. `node cli.mjs understand`：把 `items.status='new'` 的列處理成 `proposed` 或 `error`。

#### 驗收

- 三張 fixture 跑過；壞案例不能寫進 `understanding`。
- fake 模型回應有 markdown fence、尾逗號、非法 enum 時，要救得回來或清楚失敗。
- `evidence` 對不上的項目會消失。
- `contains_secret: true` 時 `text` 不落庫。
- 同一個 `sha256` 不重問模型。

---

### B — 提案、執行、復原

#### 工作

1. `plans.ts`：從 `understanding.raw` 組 Ops。檔案目的地只能由程式算。
2. `exec.ts`：執行 move、rename、fact、event/task 的本版行為；每個執行器第一行檢查 `config.readonly`。
3. `journal.ts`：先寫 journal 再動作；復原倒序重播。
4. `node cli.mjs approve <id> [--skip 2,3]`。
5. `node cli.mjs undo <id>`。
6. M2 再補 `routes-write.ts`：`/plans/:id/apply`、`/undo`、`/dismiss`。

#### 驗收

- `approve` 後檔案真的到 `Filed/<category>/`，`undo` 後回原位原名。
- 目的地同名時變 `(2)`、`(3)`，舊檔不被覆蓋。
- `CONTEXTBOX_READONLY=1` 時一個檔案都不動。
- 中途丟例外後，已完成的步驟仍可復原。
- 惡意 `suggested_name: "../../.ssh/authorized_keys"` 最後只會落在安全目的地。
- repo 不能新增 `unlink`、`rm`、`rmdir` 類刪檔呼叫。

---

### C — 操作面、讀取路由、搜尋

#### 工作

1. `docs/inbox-example.json`：先定 UI/CLI 要吃的形狀。
2. `node cli.mjs inbox`：顯示摘要、類別、建議檔名、每一列 op、approve 指令提示。
3. macOS smoke：跑 `doctor/watch/list`、截圖落地、模型連線，記到 `test/macos-smoke.md`。
4. M3 做 macOS Finder Quick Action：把選到的檔案交給 `node cli.mjs propose "$1"`。
5. `routes-read.ts`：M2 時提供 `/inbox`、`/items/:id/file`、`/health`。
6. `core/ui.html`：M2 時做收件匣分頁、逐列取消、全部同意、略過、復原、健康列。
7. `search.ts`：M4 時收斂 FTS upsert 與搜尋。短詞 `< 3` 走 LIKE，LIKE 必須 `ESCAPE`。

#### 驗收

- 不接 A/B 真實程式，只吃 `docs/inbox-example.json` 就能顯示完整 `inbox`。
- macOS 上 `doctor/watch/list` 跑過，截圖會進 `items`。
- macOS Quick Action 丟一個檔案後，`node cli.mjs list` 看得到它。
- `/items/:id/file` 只認 item id，不接路徑；不存在 id 回 404，亂塞路徑回 403/404。
- 網頁上每個 op 可以單獨取消。
- 搜尋「發票」找得到；`%`、`_`、`a-b`、`2026/09` 都不崩、不倒資料。
- 同一個 item 重跑理解，`items_fts` 不會重複列。

---

### D — Windows、發行收斂、整合驗收

#### 工作

1. M0 Windows driver：乾淨 Windows 機器跑測試、doctor、watch、截圖、list。
2. 修 M0 找到的 Windows blocker；如果碰到凍結檔，PR 說清楚是哪個 M0 bug。
3. `package.json`：`engines.node >= 24`、`scripts.test`，不加 dependency。
4. `INSTALL.md`：整合 Windows 與 C 提供的 macOS 步驟，照著做可以在乾淨機器裝起來。
5. Windows 右鍵選單：`HKCU\Software\Classes\*\shell\ContextBox\command` → `node cli.mjs propose "%1"`。
6. 「在檔案總管顯示」：Windows 用 `explorer.exe /select,"<path>"`。
7. 修既有 extension 兩個 todo：敏感欄位空值洩漏、成績別名撞 key。
8. 每晚收斂端到端驗收：自己更新 `test/windows-smoke.md`，確認 C 的 `test/macos-smoke.md` 沒退步。

#### 驗收

- 乾淨 Windows 機器照 `INSTALL.md` 能跑 `doctor/watch/list`。
- Windows 右鍵丟一個檔案後，`node cli.mjs list` 看得到它。
- M1 完成後，在 Windows 上跑完整流程：截圖 → understand → inbox → approve → undo。
- release 前確認 C 的 macOS smoke 是綠的，但 macOS blocker 不歸 D 修。
- `node --test test/*.test.mjs` 的 todo 數量不能增加；能清掉既有 2 個最好。

---

## 5 ・ 里程碑與 merge 順序

### M0：Windows/macOS 地基，半天～一天

Owner：D 收 Windows；C 收 macOS。

Support：全員一起看第一次結果。

完成條件：

- `doctor/watch/list` 在 Windows 與 macOS 上跑過。
- 新截圖會進 `items`。
- blocker 已列出 owner。

### M1：CLI 端到端，4～5 天

Owner：A/B/C 一起，但收口順序固定：

1. A 交 fixture。
2. B 用 fixture 產 plan 與 approve/undo。
3. C 用同一份 plan 做 inbox。
4. A 接真模型。
5. D 在 Windows 上跑端到端，C 在 macOS 上跑端到端。

完成條件：

- `node cli.mjs understand`
- `node cli.mjs inbox`
- `node cli.mjs approve <id>`
- `node cli.mjs undo <id>`

### M2：網頁收件匣，3～4 天

Owner：C。

B 補 write routes，D 做 Windows smoke，C 做 macOS smoke。

完成條件：

- 縮圖、摘要、逐列取消、一鍵同意、略過、復原。
- 健康列清楚顯示模型與 watch 狀態。

### M3：Windows/macOS 右鍵與顯示檔案，2～3 天

Owner：D 收 Windows；C 收 macOS。

C 接網頁按鈕與 macOS Quick Action，B 提供 reveal 所需安全路徑，D 做 Windows 右鍵。

完成條件：

- 右鍵「用 ContextBox 整理」。
- 搜尋或收件匣結果可以在檔案總管/Finder 選中。

### M4：搜尋，2 天

Owner：C。

A 提供文字品質，B 確認 apply/undo 不破壞索引。

完成條件：

- 「發票」「收據」這種兩字詞找得到。
- 特殊字元搜尋不崩、不洩漏全部資料。

---

## 6 ・ 協作規則

- 分支：`feat/understand`、`feat/plans`、`feat/surface-macos`、`feat/windows-release`。
- 每個 PR 只動自己的 owner 檔案；例外要在 PR 開頭講。
- `cli.mjs` 是共用檔，merge 順序固定：A 的 `understand` → B 的 `approve/undo` → C 的 `inbox/search` → D/C 的 `reveal`。
- `core/ui.html` 是共用檔，M2 前只有 D 可以改手填頁小修；M2 開始 C 改新分頁。
- 每個 PR 都要有測試，或在 `test/windows-smoke.md`／`test/macos-smoke.md` 有明確手動驗收。
- 合併前跑 `node --test test/*.test.mjs`。
- 中文文件用全形標點；註解寫「為什麼」，不要重述程式在做什麼。

---

## 7 ・ 已知地雷

| 地雷 | 會怎樣 | Owner |
|---|---|---|
| Windows/macOS 沒先跑 | M2 才發現路徑、OneDrive、Finder、watch 行為壞掉 | C/D |
| C 太早做網頁 | M1 沒有 CLI 可用版本，大家等整合 | C |
| 模型輸出直接信 | 幻覺事件、亂寫個資、錯誤 facts | A |
| 模型提供目的地 | prompt injection 可以叫它搬危險路徑 | B |
| `READONLY` 漏檢查 | 第一次在新機器試跑就真的動檔案 | B |
| `LIKE` 沒有 `ESCAPE` | 搜 `%` 把整個資料庫倒出來 | C |
| 把雙平台都塞給 D | D 變 release、平台、QA 全包，M1 反而沒人收 | C/D |
| 一次做三個 OS | Windows/macOS 使用者還不能用，時間先被平台分散 | D |
| 共用檔亂改 | PR 互相踩，最後沒人敢 merge | 全員 |

---

## 8 ・ 這輪不做

- Linux 右鍵選單。
- 桌面寵物。
- 事件／待辦直接寫進外部行事曆或 Todoist。
- 向量語意搜尋。
- docx／pptx。
- 多機同步。
- 對外開放 MCP server。
