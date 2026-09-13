# Pensieve（memos）

<https://github.com/arkohut/pensieve>　**Apache-2.0**　1387★　最後更新 2026-07-19

> A passive recording project allows you to have complete control over your data

截圖管線這一類裡**最成熟、而且授權可以安全抄**的一份。

---

## 它做到哪

```
每 5 秒截一張 → OCR → VLM（選配）→ 嵌入向量 → SQLite → 混合檢索
```

| 模組 | 做什麼 |
|---|---|
| `memos record` | 常駐截圖，存 `~/.memos/screenshots`，連續相同畫面會去重 |
| `memos watch` | 監看圖檔事件，依照處理速度動態送出索引請求 |
| `screen_recorder/` | 截圖 |
| `plugins/`（`builtin_ocr`、`builtin_vlm`） | OCR 與視覺理解，可擴充 |
| `web/` | 網頁介面，port 8839 |

三種運算分開：**OCR 走 CPU**（依作業系統挑引擎）、**VLM 走 Ollama 或 OpenAI 相容端點**、
**嵌入向量走 GPU**（NVIDIA／Metal，沒有就退回 CPU）。

儲存預設 SQLite，可以換 PostgreSQL + pgvector。**索引十萬張截圖大約 2.2GB。**

設定長這樣（`~/.memos/config.yaml`）：

```yaml
embedding: { use_local, model, num_dim, use_modelscope }
vlm:       { endpoint, modelname, force_jpeg, prompt }
watch:     { idle_timeout, idle_process_interval, sparsity_factor }
```

---

## 我們抄了什麼（Apache-2.0，可以抄）

**管線的形狀**：watch 資料夾 → 看懂 → SQLite → 全文＋metadata 混合搜尋。
VLM 走 OpenAI 相容端點（我們打自己的內網閘道）。
`watch` 的閒置節流概念 → 我們的 `settleMs` 與保底輪詢。

---

## 我們**刻意不抄**的兩件事

### 1. 不裝 OCR

它是 **OCR ＋ VLM 兩段**。我們直接讓看得懂圖的模型把字抄出來，**少一個元件**。

代價：模型的 OCR 品質就是天花板。2026-09-13 實測繁中公告全對，
所以這個賭注目前是划算的（見 [06-視覺模型](06-視覺模型.md)）。

### 2. **不做每 5 秒截一張**

這是整份調查裡最重要的一個分歧。

Pensieve 是 passive recording —— Rewind 那一類。它會把你螢幕上的**每一件事**
都記下來，包含你沒打算留下的東西。

**我們只看使用者自己按下截圖鍵存下來的檔案。**
差別不是技術，是「這台電腦上有多少東西被記錄」這個問題的答案。
連續錄製的隱私成本我們不接受。

---

## 值得記住的一個數字

十萬張截圖 ≈ 2.2GB。我們的量級小得多（一天二十張、一年約 60MB），
但 trigram 索引大約是原文的三倍 —— 這是要在 README 裡對使用者講清楚的事。
