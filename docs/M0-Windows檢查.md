# M0 — 在 Windows 上把地基驗一次

**這份是寫給「在 Windows 筆電上那個新開的 Claude session」看的。**
讀完這份就有足夠背景，不用使用者再講一次。

---

## 0 ・ 你接手的是什麼

ContextBox 是一個本機個人助理。這一輪的目標：**讓使用者在自己的 Windows 筆電上，
真的用它整理截圖。** 完整計畫在 [SPEC-實作計畫.md](specs/實作計畫.md)。

地基（P0）已經寫完了：設定、守門、監看、items 表、CLI。
**194 個測試、0 失敗、跑過三輪獨立稽查。**

**但那 194 個測試全部是在一台 Linux 機器上跑的。**

---

## 1 ・ 你的任務

把 P0 在**真的 Windows** 上驗一次。**這一階段不寫新功能**，只做三件事：

1. 跑起來
2. 記下哪裡壞掉
3. 修掉 Windows 專屬的問題

預期半天。**預期至少會抓到一個雷** —— 那正是做這一步的原因。

---

## 2 ・ 為什麼這一步非做不可

`core/config.ts` 與 `core/guard.ts` 裡有一整批 Windows 專用分支，
**從來沒有被執行過一次**：

| 位置 | 從沒跑過的東西 | 可能怎麼壞 |
|---|---|---|
| `guard.ts` 的 `fold()` | 只在 `platform() === 'win32'` 時折大小寫 | 白名單／黑名單比對在 Windows 上行為不同 |
| `config.ts` 的 `osDefaults('win32')` | OneDrive 已知資料夾移轉的路徑候選 | 監看資料夾指錯地方，什麼都收不到 |
| `items.ts` 的 `NOFOLLOW` | Windows 沒有 `O_NOFOLLOW`，退回 `?? 0` | TOCTOU 那道鎖只剩 `fstat` 比對 |
| `db.ts` 的 `chmodSync` | Windows 上幾乎沒作用 | 資料庫權限不是 0600，但那裡本來就靠 ACL |
| `watcher.ts` 的 `fs.watch` | NTFS 與 **OneDrive 檔案隨選** 上的行為 | 事件不發，只剩 30 秒保底輪詢 |
| `guard.ts` 的 `badName()` | 擋 `:<>"|?*` | 正常檔名被誤殺？ |

在這裡發現問題花半天。在 M2 才發現要重做兩天。

---

## 3 ・ 環境準備

```powershell
winget install OpenJS.NodeJS       # 要 Node 24 以上
node -v                            # 確認 v24 或更新

git clone https://github.com/lulu-wen/contextbox
cd contextbox
```

**不要 `npm install`。** 這個專案是**零外部依賴**的，連 `package.json` 都還沒有。
`.ts` 檔靠 Node 內建的型別剝除直接跑，不用編譯。

模型金鑰（只有第 6 步會用到，前五步不需要）：

```powershell
$env:CONTEXTBOX_MODEL_KEY = "<金鑰>"
```

金鑰在 Linux 那台的 `~/.contextbox/env`（權限 0600，不要貼到任何地方）。
模型閘道的位址與換金鑰的方式看你們自己的部署說明。

打模型要 **內網通得到閘道**。前五步不需要。

---

## 4 ・ 六個步驟與預期結果

### 步驟 1 — 測試

```powershell
node --test test/*.test.mjs
```

**在 Linux 上是 194 tests / 192 pass / 0 fail / 2 todo。**
（那 2 個 todo 是瀏覽器擴充套件的既有問題，跟這一輪無關。）

**把 Windows 上的紅燈全部抄下來**，一條一條記，不要只記數字。

⚠️ 已知**可能**會紅的：
- `test/guard.test.mjs` 裡用 `symlinkSync`／`linkSync` 的案例 ——
  Windows 建 symlink 要管理員權限或開發者模式。**紅在這裡不算 bug**，
  但要確認是「權限不足」而不是「邏輯錯了」
- `test/db.test.mjs` 的權限案例 —— Windows 沒有 POSIX mode

### 步驟 2 — doctor

```powershell
node cli.mjs doctor
```

**重點看「監看資料夾」那兩行指到哪。**

`config.ts` 對 win32 會在這兩組裡挑存在的那一個：

```
%USERPROFILE%\OneDrive\Pictures\Screenshots   ←  已知資料夾移轉開著的話是這個
%USERPROFILE%\Pictures\Screenshots
%USERPROFILE%\OneDrive\Downloads
%USERPROFILE%\Downloads
```

**去檔案總管確認你的截圖真的落在它挑的那個資料夾。** 挑錯的話整條線都不會動。

設定檔在 `%USERPROFILE%\.contextbox\config.json`，第一次跑會自己建。挑錯就手動改 `watch`。

### 步驟 3 — 監看

```powershell
node cli.mjs watch
```

它會先印「開機掃描：記住了 N 個既有檔案」。

> ⚠️ **這一行要特別看 N 是多少、以及跑了多久。**
> 見步驟 5。

然後**按 `Win + Shift + S` 截一張圖**（要按存檔，不是只複製到剪貼簿）。

預期幾秒內看到：

```
＋ 下午 3:42:01  螢幕擷取畫面 2026-09-13 154201.png（screenshot）
```

**沒出現的話**，開另一個視窗跑 `node cli.mjs list` 看有沒有進資料庫 ——
分得出「`fs.watch` 沒發事件」（靠 30 秒輪詢還是會進）跟「守門擋掉了」（`watch` 那邊會印 ⚠）。

### 步驟 4 — 收件匣

```powershell
node cli.mjs list
```

剛剛那張圖要在，而且 `kind` 是 `screenshot` 不是 `image`
（`kindOf()` 靠路徑與檔名認，中文的「螢幕擷取畫面」也在清單裡）。

### 步驟 5 — **OneDrive 檔案隨選（這一步最重要）**

Win11 綁 Microsoft 帳號時，「檔案隨選」預設是開的 ——
`Pictures` 與 `Downloads` 裡很多是**佔位檔**，讀它一下就會從雲端下載整個檔案。

稽核時特地把開機掃描改成**只記指紋（`lstat`）不讀檔內容**，就是為了躲這件事。
**但沒有在真的 OneDrive 上驗過。**

怎麼驗：

1. 步驟 3 跑之前，在檔案總管看 `Pictures\Screenshots`，記下有幾個是**雲朵圖示**（僅線上）
2. 跑 `node cli.mjs watch`，等它印完「開機掃描」
3. 回檔案總管**重新整理**，雲朵圖示還是雲朵嗎？

**如果變成綠色打勾（已下載），那就是 bug**，而且是嚴重的 ——
使用者開一次 watch 就把整個 Downloads 從雲端拉回本機，可能是幾十 GB。

順便記一下「開機掃描」那行跑了多久。超過兩三秒就代表有在讀檔。

### 步驟 6 — 模型（要 Tailscale）

```powershell
$env:CONTEXTBOX_MODEL_KEY = "<金鑰>"
node cli.mjs doctor
```

「連線」那行要是 `✓ 連得到，google/gemma-4-E4B-it 在線上`。

`✗ 連不上` 通常是 Tailscale 沒起來。這不擋 M0 的前五步。

---

## 5 ・ 不要做的事

- **不要改 `core/` 的設計。** 你只修 Windows 專屬的問題（路徑、大小寫、API 差異）。
  覺得設計有問題就記下來，不要動手
- **不要 `npm install` 任何東西。** 零依賴是硬規則
- **不要直接推 `main`。** 開 `fix/windows-m0` 分支
- **不要碰 `extension/`、`schema/`、`core/facts.ts`、`core/validate.ts`** ——
  那是另一條線（表單填入），有人在動
- **每一個修正都要有測試**，而且測試要驗過會失敗（把修法拿掉，測試要變紅）

---

## 6 ・ 做完要交什麼

一份 `M0-結果.md`，四段：

1. **測試**：Windows 上的 pass/fail/todo 數字，紅燈逐條列出，
   每一條註明是「真的 bug」還是「Windows 限制（例如 symlink 權限）」
2. **路徑**：`doctor` 挑到哪兩個監看資料夾，對不對，OneDrive 的情況
3. **OneDrive 檔案隨選**：雲朵有沒有變成打勾，「開機掃描」跑多久
4. **修了什麼**：每一條配一個測試

修完跑一次 `audit-round`（`.claude/skills/audit-round`）再開 PR。

---

## 7 ・ 背景資料在哪

| | |
|---|---|
| [SPEC-實作計畫.md](specs/實作計畫.md) | M0～M4 的完整計畫 |
| [SPEC-檔案與截圖.md](specs/檔案與截圖.md) | 管線怎麼設計的 |
| [SPEC-四人分工.md](specs/四人分工.md) | 第 6 節是 P0 踩過的九個地雷 |
|  | 參考過的開源專案、視覺模型實測 |
| `~/contextbox-稽核-20260912.md`（Linux 那台） | P0 的稽核紀錄，59 條發現 |
