# FilePilot AI

<https://github.com/cuiheng511/filepilot-ai>　**MIT**　16★　最後更新 2026-07-27

> Local-first file intelligence: desktop app, CLI, and MCP server

**這次調查最有價值的一個發現。** 星星不多，但它把「agent 動使用者的檔案」
這件事的安全架構想得最清楚。

---

## 它做到哪

檔案理解 → 提案 → 批准 → 執行。**但只做搬移與改名**，
沒有意圖抽取（沒有事件、待辦、缺件提醒），也不寫進行事曆或待辦系統。

索引用 **Whoosh 全文 ＋ SQLite metadata ＋ 增量索引**，語意重排是選配。

對外是一個 MCP server，23 個工具：

```
server_status, scan_files, search_files, index_folder, search_index,
read_file, extract_file_text, summarize_file, suggest_tags, add_tags,
find_duplicates, propose_organization_plan, list_plans,
cleanup_plans, apply_organization_plan, undo_organization_plan,
list_workflow_templates, get_workflow_template, mcp_client_config
```

---

## 我們抄了什麼（MIT，可以直接抄）

### 1. 雙重同意

MCP server **預設唯讀開機**。寫入類工具要同時滿足兩個條件才動得了：

- 啟動時帶 `--write` 旗標
- 呼叫時傳 `confirm=True`

一個在**部署者**手上，一個在**呼叫端**手上。少任何一個都不會寫。

→ 進到我們的 `config.readonly`，每個執行器第一行檢查。

### 2. propose / apply / undo 三個動詞

不是直接搬檔，而是：

| 工具 | 做什麼 |
|---|---|
| `propose_organization_plan` | 乾跑，產出一份有 ID 的計畫，**不碰硬碟** |
| `list_plans` | 用 ID 查得到 |
| `apply_organization_plan` | 執行前**重新驗證目錄白名單** |
| `undo_organization_plan` | 反向重播 |

計畫物件裡有：來源資料夾、目標結構、檔案分組、搬移動作。

→ 動詞名稱**直接沿用**，進到我們的 `core/plans.ts` 與 `plans` 表。

### 3. JSONL 稽核

每一次變更都記成一列 JSONL 事件，可以查「誰在什麼時候做了什麼」。

→ 我們放進 SQLite 的 `file_journal` 表，一列一件事，復原就是倒著讀。
（用資料表不用檔案，因為我們本來就有 SQLite，少一個要管的東西。）

### 4. `--allow` 資料夾白名單

只有明確用 `--allow` 傳進來的目錄碰得到。要同時讀來源與寫目標，就傳兩個。

→ 我們的 `config.watch` ＋ `config.filed`，在 `guard.admit()` 裡比對。

### 5. 便宜的基礎建設選擇

Whoosh ＋ SQLite ＋ 增量索引，**零基礎建設，幾分鐘就站得起來**，
而不是花一小時去架向量資料庫。

→ 我們更省：`node:sqlite` 內建的 **FTS5 ＋ trigram 分詞**，連 Whoosh 都不用裝。
中文不用斷詞就搜得到（三個字以上）。

---

## 我們沒抄什麼

- **MCP server 本身。** 這一版不對外開放 MCP，先做自己用得到的。
- **Python 那一整套。** 我們零依賴，碼進不來，抄的是形狀。
