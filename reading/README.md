# ContextBox 參考過的專案

這個資料夾記的是 **ContextBox 實際看過、而且做了取捨的開源專案**。
每一份都要寫清楚三件事：**它做到哪、授權是什麼、我們拿了什麼或為什麼不拿。**

寫這些的原因：`SPEC-檔案與截圖.md` 第 1 節說「不 fork、只抄形狀」，
那個決定的依據在這裡。以後有人問「為什麼不直接用 X」，答案不用重查一次。

**所有數字都在 2026-09-13 用 GitHub API 驗證過。**

---

## 索引

| | 專案 | 我們的處理 |
|---|---|---|
| [01](01-filepilot-ai.md) | **FilePilot AI** | **抄安全架構**（這次調查最有價值的發現） |
| [02](02-pensieve.md) | **Pensieve（memos）** | **抄管線形狀**，但不抄它的連續錄製 |
| [03](03-stashbase.md) | StashBase | 借「原檔不動、旁邊寫衍生文字」的模式 |
| [04](04-sukusho.md) | Sukusho | 借 UX。**無授權，碼一行都不能抄** |
| [05](05-看過但沒採用.md) | 其餘七個 | 授權有毒、方向不同、或已經沒人維護 |
| [06](06-視覺模型.md) | 視覺模型 | P1 要用的，含自家叢集實測 |

---

## 結論先講

**「找檔案／整理檔案」這一半是紅海，而且已經被做爛了。**
五個公開 repo 在做同一件事（其中 `ai-file-sorter` 有 1717★、`organize` 有 3143★），
微軟已經把 AI 放進檔案總管，iOS 26 已經做到截圖變行事曆。

**「一份檔案 → 一整組異質行動 → 一鍵同意 → 一鍵復原」這一半，查不到有人做。**

所以：**索引與檢索不重做**，力氣全放在**同意閘與復原**。

### 為什麼一個都不 fork

1. 我們的賣點正好是那些專案**沒有**的那一半
2. 這個 repo 是**零外部依賴的 Node**。Python（FilePilot、StashBase、Local File Organizer）
   與 Rust（Sukusho）的碼進不來
3. 使用者會點開 repo。「我們 fork 了 X 改 prompt」跟「我們做了同意閘與復原」是兩個故事

---

## 授權速查

做決定前先看這張表。**AGPL 一律只讀不抄**；沒宣告 LICENSE 的一律當「保留一切權利」。

| 授權 | 可以抄碼進這個 repo 嗎 | 誰是這一類 |
|---|---|---|
| MIT | ✅ | FilePilot AI、Local File Organizer、organize、DeepSeek-OCR、dots.ocr |
| Apache-2.0 | ✅ | Pensieve、StashBase、Qwen3-VL、PaddleOCR、GLM-V |
| AGPL-3.0 | ❌ **會傳染整包** | AI File Sorter、OpenRecall、Khoj |
| NOASSERTION（自訂） | ⚠️ 要逐條讀 | Screenpipe、Onyx、HunyuanOCR |
| **沒有 LICENSE** | ❌ **等於保留一切權利** | **Sukusho**、AI-File-Organizer-Agent |

> ⚠️ **Sukusho 之前被誤記成 MIT。** 2026-09-13 實際查 GitHub API 與檔案列表，
> 它**沒有 LICENSE 檔**。可以看、可以學它的做法，但**一行碼都不能複製**。

---

## 想 fork 之前先過這三題

1. 我 10 分鐘內跑得起來嗎？
2. 它省下的是**我不會寫**的東西，還是我 20 分鐘就能寫的東西？
3. 授權是 MIT 或 Apache 嗎？

三題有一題答不出來就別碰。

這次的答案：核心不 fork，只偷兩樣 —— FilePilot AI 的 journal 格式（看 10 分鐘、抄 30 行），
以及之後如果真的要做桌面寵物，那個透明置頂視窗的 Electron 外殼確實值得 fork。
