# 五分鐘跑一次 ContextBox

這份是**照著貼就會動**的走法。全程在一個沙盒資料夾裡，**不會碰你自己的 Downloads，也不會碰 `~/.contextbox`**。

需要的東西只有 **Node 24 以上**。沒有任何要安裝的套件。

```bash
node --version      # 要 v24 以上
```

---

## 1. 做一個沙盒

```bash
cd <這個 repo>
node tools/demo-setup.mjs --dir /tmp/contextbox-demo
```

它會在 `/tmp/contextbox-demo` 做一個假的家目錄，Downloads 裡放 13 個看起來像真的的檔：舊安裝檔、兩份一模一樣的壓縮檔、下載到一半的影片、空檔、暫存檔、三張連拍截圖、一張版面一樣但內容不同的截圖，還有三份課程講義（有的取好名字，有的叫「未命名文件 (3)」）。

檔案的時間是**往回撥**的，所以一建好就有東西可以清。

最後它會把要貼的環境變數印出來。**把那幾行貼進同一個終端機**：

```bash
export HOME="/tmp/contextbox-demo/home"
export CONTEXTBOX_CONFIG="/tmp/contextbox-demo/config.json"
export CONTEXTBOX_DB="/tmp/contextbox-demo/data.db"
export CONTEXTBOX_QUARANTINE="/tmp/contextbox-demo/quarantine"
export CONTEXTBOX_TOKEN_PATH="/tmp/contextbox-demo/token"
export CONTEXTBOX_PORT=0
```

這幾行只影響這個視窗。關掉視窗就沒了。

---

## 2. 掃一遍，看它找到什麼

```bash
node cli.mjs cleanup scan
node cli.mjs cleanup list
```

清單長這樣（節錄）：

```
有 6 個可以清掉的東西，大概 12.1 MB

  [b0be] ✔ 資料結構_lab3 (1).zip
            23 KB  duplicate  Downloads
         · 同內容的重複檔案（同一個 sha256 還有 1 份檔案存在，會留著「資料結構_lab3.zip」）
         · 舊壓縮檔通常是一次性下載（.zip 壓縮檔，而且 60 天沒有變動）
```

**要看的重點**：

- 每一條都講得出**為什麼**，而且講的是證據（同一個 sha256、幾天沒動），不是「AI 覺得」。
- `✔` 是預設會清的，`☐` 不會。信心不到一半的不預設勾，但你可以自己加。
- 沒有出現的：三張截圖、課程講義、還有那個跟「不見的檔」有關的都不在清單上 —— 規則看不懂的東西就不碰。

---

## 3. 清理，然後反悔

```bash
node cli.mjs cleanup apply      # 搬進隔離區
ls "$HOME/Downloads"            # 那 6 個不見了
node cli.mjs cleanup quarantine # 隔離區裡有什麼、幾天後可以永久清空
node cli.mjs cleanup undo       # 全部放回原位
ls "$HOME/Downloads"            # 回來了
```

**要看的重點**：

- **只搬不刪**。清理＝搬進隔離區，**七天內都放得回來**；唯一會真的刪檔的是「清空隔離區」，而且要兩段確認（先預覽拿到一組確認碼，再帶著它送一次）。
- 每一個檔逐一報結果，不是一排 ✔。沒搬成的會講原因。
- 離開碼有契約：0 成功、1 你要換個做法、2 後端出錯（沒動到檔）、3 有檔沒搬成（動作做了一半）。

想再玩一次（放回原位的檔不會再被自動提議，這是刻意的）：

```bash
node tools/demo-setup.mjs --dir /tmp/contextbox-demo --reset
```

---

## 4. 打開寵物與面板

```bash
node cli.mjs pet
```

它會印出一個網址，像 `http://127.0.0.1:34445/?k=…`。打開它。

```
ContextBox 開在 127.0.0.1 的 34445 埠。
寵物與清理面板：http://127.0.0.1:34445/?k=9dt7…
清理範圍：Downloads
```

**要看的重點**：

- 頁面完全跑在你自己的電腦上，沒有任何對外連線。網址上那把鑰匙是啟動時產生的，**沒有鑰匙的請求一律 401**。
- 面板上可以勾選、清理、復原，跟 CLI 是同一套後端、同一份結果算法。
- 寵物的表情跟著後端狀態走（在看、找到東西、出事了）。
- 開機掃描跑在另一個行程，所以掃描期間面板照樣有反應。

按 Ctrl+C 停掉。

---

## 5. 想自己驗證的話

```bash
node --test test/*.test.mjs
```

約三分鐘，**990 條測試、0 紅**（兩條 todo 是刻意留著的已知題目）。

測試本身守著這些不變量，可以直接去讀：

| 不變量 | 守在哪 |
|---|---|
| 沒勾的檔絕對不會被搬 | `test/cleanup-wire.test.mjs`、`test/audit-0919-routes.test.mjs` |
| 只搬不刪：整個 core 只有清空隔離區那一處會刪檔 | `test/repo.test.mjs` |
| 回給畫面的東西不可以有絕對路徑 | `test/repo.test.mjs`、`test/cleanup-routes.test.mjs` |
| 中斷（Ctrl+C、當機）之後狀態要收得回來 | `test/audit-0919-r2exec.test.mjs`、`test/audit-0919-interrupt.test.mjs` |
| 鑰匙不會交給不是 pet 的程式 | `test/audit-0919-r2cli.test.mjs` |
| 測試自己不可以碰到真的家目錄 | `test/helpers/isolate-home.mjs`、`test/repo.test.mjs` |

程式碼經過**兩輪對抗式稽核**：每一輪都是三個沒參與實作的稽查員各自找問題，再由另一個人試著推翻每一條，站得住的才修，每一個修正都要有一個會失敗的測試釘住。紀錄在 `~/contextbox-稽核-20260919.md`。

---

## 現在做到哪、接下來做什麼

已經會的：**看得懂檔名與檔案本身的清理助手**。

正在做的（讓它真的「看得懂內容」）：

1. 連拍截圖主動詢問：發現你連拍了幾張差不多的，主動問要不要留最新的就好，畫面會框出差異處。
2. 讀出內容：Word、PowerPoint、PDF 的文字層，全部零依賴自己解，跑在有記憶體與時間上限的 worker 裡。
3. 看懂內容：本地／自架的視覺語言模型看截圖與文件，說得出這是哪一堂課、什麼主題。
4. 替沒取名的檔想名字、把同一堂課的檔歸成結構化資料夾 —— 全部可復原。
