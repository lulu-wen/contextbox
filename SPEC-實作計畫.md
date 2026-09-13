# 實作計畫 — 先做完檔案總管與截圖整理

2026-09-13　**這一輪的範圍收斂成一件事：讓使用者在自己的 Windows 筆電上，
真的用它整理截圖。**

表單填入那半邊已經可以用了（擴充套件、事實庫、手填頁），這一輪**不動它**。
把截圖接回事實庫（原本的 P3）也暫緩 —— 那是兩條線的橋，等這一條先站穩。

---

## 0 ・ 判斷標準：每一階段結束，使用者能做什麼

不用「完成 P1」當里程碑，那是我們的視角。用**使用者能做什麼**當里程碑。

| | 結束時使用者能做什麼 | 大小 |
|---|---|---|
| **M0** | 在**自己的 Windows 筆電**上跑起 `doctor` 與 `watch`，截圖落地會被收進資料庫 | 半天 |
| **M1** | 截圖落地 → 看懂 → **在終端機按同意** → 檔案真的歸檔了 → 可以復原 | 4～5 天 |
| **M2** | 同一件事**在網頁上做**：縮圖、摘要、逐列取消、一鍵同意、一鍵復原 | 3～4 天 |
| **M3** | 在檔案總管**右鍵**「用 ContextBox 整理」；搜尋結果按「在檔案總管顯示」 | 2～3 天 |
| **M4** | 「上週那張有 wifi 密碼的截圖」找得到 | 2 天 |

**M1 結束就可以每天用了。** 網頁介面是讓它好用，不是讓它能用 ——
所以先把「能用」做完，早五天開始吃自己的狗食。

---

## M0 ・ Windows 落地驗證（**先做這個**）

### 為什麼排第一

P0 寫了 194 個測試、跑過三輪稽查，**但全部在 Linux 上**。
而 `core/config.ts`、`guard.ts` 裡有一整批 Windows 專用的分支從來沒被執行過：

- `fold()` 的大小寫折疊（只在 `platform() === 'win32'` 生效）
- OneDrive 已知資料夾移轉的路徑候選
- `O_NOFOLLOW` 在 Windows 上是 `undefined`，會退回 `?? 0`
- `chmodSync` 在 Windows 上幾乎沒作用
- `fs.watch({recursive:true})` 在 NTFS 與 OneDrive 檔案隨選上的行為

**在這裡發現問題只花半天；在 M2 才發現要重做兩天。**

### 做什麼

1. Windows 筆電裝 Node 24，`git clone`，**不用 `npm install`**
2. `node --test test/*.test.mjs` —— 194 個測試在 Windows 上跑一次，記下哪些紅
3. `node cli.mjs doctor` —— 監看資料夾路徑對不對？OneDrive 那條抓對了嗎？
4. `node cli.mjs watch`，然後按 `Win + Shift + S` 截一張圖
5. `node cli.mjs list` —— 它進來了嗎？
6. 確認 **Tailscale 通**，`doctor` 的「連線」那行要是 ✓

### 驗收

- `list` 看得到剛剛截的圖
- **`Pictures` 沒有被整個從 OneDrive 拉回本機**（開機 seed 只記指紋不讀檔，要驗這件事真的成立）
- 測試在 Windows 上的紅燈清單寫進 issue

### 會不會有雷

會。預期至少一個路徑或大小寫的問題。那正是做這一步的原因。

---

## M1 ・ 看懂 ＋ 終端機同意

**這一階段結束就能每天用。**

```bash
node cli.mjs watch          # 一邊開著
node cli.mjs understand     # 把 new 的都送去看懂
node cli.mjs inbox          # 看提案
node cli.mjs approve <id>   # 同意
node cli.mjs undo <id>      # 後悔
```

### A：看懂（`understand.ts`、`prompt.ts`）

模型**不遵守 schema、而且會幻覺**（實測見 [reading/06](reading/06-視覺模型.md)）。
所以這一層的價值不在呼叫 API，在**把不可信的輸出變成可信的資料**：

1. 組 prompt；PDF 用 `pdftoppm` 轉前 N 頁（**Windows 上沒有這個工具**，
   標 `error: 需要 poppler`，不要硬撐 —— 截圖那條線不受影響）
2. 一次 `fetch`，逾時 60 秒，同 `sha256` 不重問
3. 剝 ` ```json ` 圍欄、抓第一個平衡的 `{...}`、修尾逗號
4. 程式驗 schema：enum 比對、`facts[].key` 不在註冊表就丟掉那一項
5. **證據查核** —— 每個 `evidence` 必須真的出現在 `text` 裡。**這是唯一擋得住幻覺的機制，而且免費**
6. 驗不過就重問一次，還是不行就 `items.status='error'`

### B：動作（`plans.ts`、`exec.ts`、`journal.ts`）

1. 從 `understanding.raw` 組 Ops。**目的地由程式算**：`guard.destFor(category, safeName(...))`
2. 四個執行器，每個第一行檢查 `config.readonly`
3. **先寫 journal 再動作**；復原是倒序重播
4. 同名不覆蓋（`(2)`、`(3)`）；**不准出現 `unlink`／`rm`／`rmdir`**
5. 搬完 `items.setPath()`

### C：終端機介面（`cli.mjs` 的四個新子指令）

M1 的 C **不做網頁**，做四個文字指令。`inbox` 印成這樣：

```
[a1b2]  獎學金公告.png                              獎學金
        台大 115 學年度弱勢學生助學金申請公告
        1. 搬到  Filed/獎學金/台大弱勢助學金公告.png
        2. 改名  台大弱勢助學金公告.png
        3. 待辦  備妥成績單（2026-09-30 前）
        4. 缺件  戶籍謄本
        approve a1b2          全部同意
        approve a1b2 --skip 3 跳過第 3 項
```

### D：M0 的修正 ＋ 打包

把 M0 抓到的 Windows 問題修掉，加 `package.json`（`engines.node >= 24`，**不加任何 dependency**），
寫 `INSTALL.md`。

### 驗收（端到端，在 Windows 上）

按 `Win + Shift + S` 截一張真的公告 → 十秒內 `inbox` 看得到提案 →
`approve` → 檔案真的出現在 `Documents/Filed/獎學金/` → `undo` → 回到原位原名。

---

## M2 ・ 網頁收件匣

M1 能用了，M2 讓它好用。

- `routes-read.ts`（C）：`/inbox`、`/items/:id/file`
- `routes-write.ts`（B）：`/plans/:id/{apply,undo,dismiss}`
- `ui.html` 收件匣分頁（C）：縮圖 ＋ 摘要 ＋ 逐列可取消 ＋ `[全部同意]` `[略過]` ＋ 同意後變 `[復原]`
- **健康列**（C）：看哪幾個資料夾、模型連不連得到、幾張待處理、監看有沒有在跑

`/items/:id/file` 是新的攻擊面：**只認 item id，不接路徑**，送出前再過一次 `admit()`。

---

## M3 ・ 檔案總管整合

**Windows 優先**，其他兩個作業系統之後再說。

| | 右鍵「用 ContextBox 整理」 | 「在檔案總管顯示」 |
|---|---|---|
| Windows | `HKCU\\Software\\Classes\\*\\shell\\ContextBox\\command` → `node cli.mjs propose "%1"` | `explorer.exe /select,"<path>"` |
| macOS | 捷徑 App 的快速動作 | `open -R "<path>"` |
| Linux | `~/.local/share/nautilus/scripts/` | `nautilus --select` |

**一次選 N 個檔 = N 個行程同時開資料庫。** P0 的 `busy_timeout` 已經處理了
（那是稽核抓到的 blocker），但要在真的 Windows 上再驗一次。

---

## M4 ・ 搜尋

- `search.ts` ＋ 搜尋分頁
- **短詞（< 3 字）走 LIKE** —— trigram 至少要三個字元，不然「發票」「收據」永遠搜不到
- `LIKE` 記得 `ESCAPE`，不然打一個 `%` 會把整個資料庫倒出來
- `items_fts` 的寫入收斂成一個 upsert —— **現在沒有人負責寫**

---

## 暫緩（想提前先講）

| | 為什麼緩 |
|---|---|
| **截圖 → 事實庫**（原 P3） | 兩條線的橋。等檔案這條先站穩，而且那條路的終點是「自動填進真的網頁表單」，要更小心 |
| macOS／Linux 右鍵 | 使用者的機器是 Windows |
| 桌面寵物 | 加分項，不是及格項 |
| 事件／待辦真的寫進行事曆 | 這一版只產 `.ics` 讓人自己匯入 —— **agent 不該偷偷動你的行事曆** |
| 向量語意搜尋 | FTS5 夠用，紅海而且贏不了 |

---

## 風險

| 風險 | 怎麼辦 |
|---|---|
| **Windows 上沒跑過** | M0 就是為了這個，半天 |
| **模型不遵守 schema** | 已知，A 的容錯解析 ＋ 證據查核就是答案 |
| **模型會幻覺** | 證據查核。對不上的那一項直接丟掉 |
| 44 秒太慢 | 背景管線可以接受。真的太慢就換 Qwen3-VL-8B（`config.model` 改一行） |
| OneDrive 檔案隨選被整包拉回本機 | P0 的 seed 已經改成只記指紋不讀檔，**M0 要驗這件事真的成立** |
| 場館／外出時 Tailscale 不通 | 收檔不受影響（那是本機的），只有 `understand` 會排隊。可以接受 |
