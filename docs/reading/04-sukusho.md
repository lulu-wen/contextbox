# Sukusho

<https://github.com/ssut/sukusho>　**沒有 LICENSE**　14★　最後更新 2026-01-04

> A powerful screenshot manager for Windows.

---

## ⚠️ 授權：一行碼都不能抄

之前的筆記把它記成 MIT。**那是錯的。**

2026-09-13 實際查 GitHub API 與 repo 檔案列表：**沒有 LICENSE 檔、API 回 `null`**。

沒有宣告授權 = **保留一切權利**。可以看、可以學它的產品決策，
但**不可以把任何一段碼複製進這個 repo**，即使只是幾行。

---

## 它做到哪

系統匣常駐的 Windows 截圖管理器。

```
監看 %USERPROFILE%\Pictures\Screenshots  →  自動索引  →  自然語言搜尋
```

| | |
|---|---|
| 語言 | Rust |
| UI | GPUI（Zed 那套） |
| 監看 | `notify` crate |
| 向量庫 | **LanceDB** |
| 模型 | 本機下載約 150MB，**沒有說明是哪個架構** |
| 設定 | `%APPDATA%\sukusho\settings.json` |

搜尋是打一句自然語言（「貓」「日落」），比對向量，**不送任何東西到外面**。

---

## 我們借了什麼（借的是決策，不是碼）

### 1. 只看 Screenshots 資料夾

不是掃整個硬碟、也不是連續錄製。**使用者按下截圖鍵的那個動作，就是授權。**

→ 我們的 `config.watch` 預設就是 `Pictures/Screenshots` 與 `Downloads`。

### 2. 系統匣常駐 ＋ 右鍵整合

它不是一個你要「打開」的 app，是一個一直在那裡的東西。

→ 我們的 `cli.mjs watch` ＋ 三個作業系統的右鍵選單（D 負責）。

### 3. 本機推論，資料不出去

→ 我們也是，只是模型跑在自己的內網閘道而不是本機。

---

## 它沒做的（也就是我們要做的）

不會執行任何動作。找得到，但不會幫你搬、不會幫你改名、不會告訴你有什麼待辦。
