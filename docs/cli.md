# CLI 指令草稿

**D 的第一天交付。** 這是**介面契約**，不是說明書 —— 先定死長什麼樣，
A／B 才知道自己的模組會被怎麼呼叫。

實作在 M1，這份先定。

---

## 全部指令

```bash
node cli.mjs doctor                      # 現在什麼狀況
node cli.mjs pet                         # 啟動 server 並印出寵物網址

node cli.mjs cleanup scan                # 手動掃一次 Downloads
node cli.mjs cleanup list                # 看清理候選
node cli.mjs cleanup apply [--skip a,b]  # 用目前候選建 plan 並套用
node cli.mjs cleanup undo [plan-id]      # 復原（不給 id 就是最近一次）
node cli.mjs cleanup quarantine          # 看隔離區
node cli.mjs cleanup quarantine --empty  # 清空（要七天、要二次確認）

node cli.mjs watch                       # 常駐監看（既有）
```

---

## 離開碼是契約

`propose` 那一輪學到的教訓：**右鍵選單與腳本靠離開碼判斷成敗**，
畫面上印 ✓ 卻回非零，Windows 會跳錯誤視窗。

| 碼 | 意思 |
|---|---|
| 0 | 成功，**包含「沒有東西要清」** |
| 1 | 使用者輸入錯（沒有這個 plan、參數看不懂） |
| 2 | 後端錯（資料庫打不開、watcher 掛了） |
| 3 | **有檔案沒搬成功**（含一個都沒成功） |

判準：**2 ＝ 這個動作根本沒執行；3 ＝ 執行了但沒有全部成功。**
呼叫端據此決定要不要自動重試 —— 2 通常重試會過（資料庫鎖住、另一個行程在跑），
3 要人去看那幾個檔。

原本第 3 列寫「有些搬成功、有些沒有」，沒有涵蓋「全部都沒搬成」。
那種情況不是 2：動作跑起來了、每個檔都有各自的原因，盲目重試只會再紅一次。

「沒有候選」是成功不是失敗 —— 那代表 Downloads 很乾淨。

---

## 畫面長什麼樣

### `cleanup list`

```
Downloads 裡有 6 個可以清掉的東西，大概 1.8 GB

  [c_7Qa] ✔ report (1).pdf                     2.3 MB   重複
          這份跟另一個檔案內容一模一樣
          同 sha256 還有 1 份：report.pdf（2026-08-12 下載）

  [c_8Bz] ✔ ubuntu-26.04.iso.crdownload        1.0 GB   沒下載完
          下載到一半就停了
          副檔名 .crdownload，12 天沒有變動

  [c_3Fv] ☐ Screenshot 2026-06-02 141203.png   471 KB   舊截圖
          很久沒看的截圖
          檔名以 Screenshot 開頭，103 天沒有變動

  ☐ 的預設不清。要清的話：cleanup apply --also c_3Fv

另外 1 個需要你自己看一眼：
  備份.tar  8.0 GB  —— 超過 5GB，沒有算 sha256

  cleanup apply            清掉打勾的 5 個
  cleanup apply --skip c_2Ew   跳過素材包.zip
```

**每一列都要有 reason 與 evidence。** 沒有原因就不該出現在清單裡 ——
這是 spec §6「沒有 reason 與 evidence 就不寫入」在 UI 上的樣子。

### `cleanup apply`

```
搬到隔離區 5 個，空出 1.8 GB。

  ✔ report (1).pdf
  ✔ ubuntu-26.04.iso.crdownload
  ✔ 新增文字文件.txt
  ✔ NodeSetup-24.6.0.msi
  ✘ 素材包.zip —— 檔案正在被別的程式使用，這次沒搬成功

檔案沒有被刪掉，在 ~/.contextbox/quarantine/。
後悔的話：cleanup undo p_2026091301
```

有 ✘ 的時候**離開碼是 3**，而且已經搬成功的**仍然可以 undo**。

### `cleanup undo`

```
搬回去 5 個。

  ✔ report (1).pdf
  ⚠ 素材包.zip → 素材包.zip.restored
      原本的位置已經有一個新的同名檔案，所以沒有覆蓋它
```

### `doctor`（在既有的輸出上加三段）

```
Downloads   ✓  /home/lulumi/Downloads（412 個檔）
隔離區      ✓  ~/.contextbox/quarantine（12 個檔，458 MB）
               最舊的是 7 天前，現在可以清空
待清候選    6 個，大概 1.8 GB
```

---

## 給 A／B 的兩個約定

**1. `--skip` 收的是 candidate id，不是檔名。** 檔名會重複，id 不會。

**2. `cleanup apply` 不給 plan-id 的話，行為是「用目前候選建一個新 plan 再套用」**，
不是「套用最近那個 plan」。要重送既有 plan 請明確給 id ——
而重送已套用的 plan 會回 `409 PLAN_ALREADY_APPLIED`，不會搬第二次。
