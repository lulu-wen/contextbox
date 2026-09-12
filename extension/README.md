# ContextBox 欄位偵測（原型）

驗證一件事：**我們的 key 表認不認得出真實表單的欄位。**
這一版只偵測、只標記，**不填任何值、不連任何網路**。

## 載入

1. Chrome／Edge 開 `chrome://extensions`
2. 右上角打開「開發人員模式」
3. 點「載入未封裝項目」，選這個 `extension/` 資料夾
4. 開啟 `test/resume-form.html`（或任何有表單的網頁）

每個欄位右邊會出現一個徽章，右下角有統計。

| 顏色 | 意思 |
|---|---|
| 藍 | 靠標籤文字認出來的 |
| 綠 | 靠 `autocomplete` 屬性認出來的 |
| 紅 | 認不出來 |
| 🔒 | 敏感欄位，正式版不會自動填 |

## 改了 key 表之後

```bash
node --experimental-strip-types extension/build.mjs
```

`factTable.js` 是自動產生的，不要手改。

## 不用瀏覽器也能量

```bash
node --experimental-strip-types test/measure.mjs
```

## 目前結果

測試表單 48 個欄位（104 式履歷 ＋ 政府表單常見欄位），**48 個全部認出來**。

## 設計筆記

- **標籤優先於 `autocomplete`。** 表單作者的標籤比較精確；`url`／`name`／`tel`
  這種通用 token 在一頁有多個同類欄位時一定會撞。autocomplete 的價值在
  「沒有標籤」的欄位，所以放在保底。兩邊打架時會 log 出來。
- **註冊表裡重複的 `autocomplete` 會直接 throw。** 這個 bug 出現過一次
  （`姓名` 被英文姓名搶走），而且完全沒有警告，所以現在讓它吵。
- **認不出來的 key 一律當最敏感。** 保守失敗，不是開放失敗。
