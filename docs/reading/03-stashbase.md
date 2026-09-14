# StashBase

<https://github.com/liliu-z/stashbase>　**Apache-2.0**　634★　最後更新 2026-09-12

> Turn your local files into a Wiki for your agents.

**索引與檢索這一塊完勝我們**，而且今天還在 commit。所以我們不重做這一塊。

> ⚠️ 之前筆記裡寫的 `stashbase/stashbase` 是**錯的網址**（404）。
> 正確的是 `liliu-z/stashbase`。另有一個 `PPRAMANIK62/stashbase`（1★）是分支或同名。

---

## 它做到哪

資料夾匯入 → OCR ＋ 轉錄 → 嵌入 → 混合檢索 → **MCP 對外**。

架構是一個 Electron 桌面應用，三層同時跑：

| 層 | 技術 | 負責 |
|---|---|---|
| 後端 | TypeScript / Node.js | 協調、檔案、MCP server |
| 索引 daemon | Python | 嵌入、OCR 這些重運算 |
| 前端 | React | 畫面 |

向量用 **Milvus Lite**。MCP 是它跟 agent 之間的主要介面 ——
Claude Desktop、ChatGPT、Codex 都可以連進來讀同一個知識庫。

**它不會執行動作。** 沒有 watcher、沒有意圖抽取、沒有批准閘。它是一個給 agent 讀的知識庫。

---

## 我們借了什麼

**「原檔不動、旁邊寫衍生文字」的模式。**

它從來不改你的原始檔案，所有 OCR 出來的文字、嵌入向量、metadata 都存在別的地方。

→ 我們的 `understanding` 表就是這個。`items` 只記「這個檔案存在」這件事實，
對內容的理解全部在 `understanding` 裡 —— 因為理解會重做（換模型、重新問一次），
但「這個檔案存在」不會。

**把重運算跟 UI 分開。**

→ 我們的版本是 `cli.mjs watch`（常駐收檔）與 `cli.mjs understand`（跑模型）分成兩個指令，
server 只負責畫面。UI 不會被 44 秒的模型呼叫卡住。

---

## 我們沒借什麼

- **Milvus Lite 與向量檢索。** 我們的量級（幾千列）用 FTS5 就夠，
  加一個向量資料庫是純設定成本、零收益。
- **Electron。** 我們的 UI 是本機 server 端出來的一頁 HTML，沒有打包負擔。
- **MCP 對外。** 這一版不做。
