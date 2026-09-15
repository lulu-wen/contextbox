# Smoke：真的在 Downloads 放垃圾，清掉，再救回來

**D 的 owner file。** 每晚跑一次，M3 之前在 Windows 與 macOS 各跑一次留紀錄。

自動化測試驗的是「每個零件對不對」。這一份驗的是**「使用者真的做一遍會不會壞」**——
真的檔案、真的 Downloads、真的搬移、真的復原。

---

## 0 ・ 開始之前

> ⚠️ **這份 smoke 會動你真的 Downloads 資料夾。**
> 第一次跑、或在不熟的機器上跑，先開唯讀模式確認它只說不做：
>
> ```bash
> CONTEXTBOX_READONLY=1 node cli.mjs cleanup apply
> ```
>
> 唯讀模式下應該印出「會清掉 N 個」但**一個檔案都不動**。

準備一個乾淨的起點：

```bash
node cli.mjs doctor
```

三行要對：**Downloads 指到你真的在用的那個**、**隔離區存在**、**測試能跑**。

記下 Downloads 現在有幾個檔 —— 最後要對得回來。

---

## 1 ・ 放七種垃圾進去

每一種對應 spec 第 5 節的一條規則。**七種都要放**，因為每一條規則都要被走過一次。

```bash
cd ~/Downloads

# duplicate —— 同 sha256 兩份，另一份還在
printf 'SMOKE 這是一份報告的內容\n' > smoke-report.pdf
cp smoke-report.pdf 'smoke-report (1).pdf'

# partial —— 下載到一半，而且 24 小時沒變
printf 'SMOKE 半個檔\n' > smoke-big.iso.crdownload
touch -d '3 days ago' smoke-big.iso.crdownload

# empty —— 0 byte，24 小時沒變
: > smoke-empty.txt
touch -d '3 days ago' smoke-empty.txt

# installer —— 14 天沒變
printf 'SMOKE 假安裝檔\n' > smoke-setup.msi
touch -d '30 days ago' smoke-setup.msi

# archive —— 30 天沒變
printf 'SMOKE 假壓縮檔\n' > smoke-assets.zip
touch -d '60 days ago' smoke-assets.zip

# old-download —— 90 天沒變，不在保護副檔名
printf 'SMOKE 很舊的東西\n' > smoke-old.bin
touch -d '200 days ago' smoke-old.bin

# screenshot-noise —— Screenshot 開頭，30 天沒變
printf 'SMOKE 假截圖\n' > 'Screenshot 2026-01-02 141203.png'
touch -d '120 days ago' 'Screenshot 2026-01-02 141203.png'
```

**Windows（PowerShell）** 的 `touch -d` 對應寫法：

```powershell
cd $env:USERPROFILE\Downloads
"SMOKE 這是一份報告的內容" | Out-File -Encoding utf8 smoke-report.pdf
Copy-Item smoke-report.pdf "smoke-report (1).pdf"
"SMOKE 半個檔" | Out-File -Encoding utf8 smoke-big.iso.crdownload
(Get-Item smoke-big.iso.crdownload).LastWriteTime = (Get-Date).AddDays(-3)
New-Item smoke-empty.txt -ItemType File -Force | Out-Null
(Get-Item smoke-empty.txt).LastWriteTime = (Get-Date).AddDays(-3)
"SMOKE 假安裝檔" | Out-File -Encoding utf8 smoke-setup.msi
(Get-Item smoke-setup.msi).LastWriteTime = (Get-Date).AddDays(-30)
"SMOKE 假壓縮檔" | Out-File -Encoding utf8 smoke-assets.zip
(Get-Item smoke-assets.zip).LastWriteTime = (Get-Date).AddDays(-60)
"SMOKE 很舊的東西" | Out-File -Encoding utf8 smoke-old.bin
(Get-Item smoke-old.bin).LastWriteTime = (Get-Date).AddDays(-200)
"SMOKE 假截圖" | Out-File -Encoding utf8 "Screenshot 2026-01-02 141203.png"
(Get-Item "Screenshot 2026-01-02 141203.png").LastWriteTime = (Get-Date).AddDays(-120)
```

### 順便放三個**不可以被碰**的

這三個是這份 smoke 最重要的部分 —— **誤刪比漏刪嚴重得多。**

```bash
printf 'SMOKE 我今天還要用\n' > smoke-今天的筆記.md          # 保護副檔名 + 剛剛才改
printf 'SMOKE 重要簡報\n'     > smoke-重要簡報.pptx           # 保護副檔名
printf 'SMOKE 正在下載\n'     > smoke-下載中.zip.crdownload   # 才剛建立，24 小時內
```

---

## 2 ・ 掃描

```bash
node cli.mjs cleanup scan
node cli.mjs cleanup list
```

### 要看到什麼

| 該出現 | kind | 預設打勾 |
|---|---|---|
| `smoke-report (1).pdf`（或 `smoke-report.pdf` 其中一份） | `duplicate` | ✔ |
| `smoke-big.iso.crdownload` | `partial` | ✔ |
| `smoke-empty.txt` | `empty` | ✔ |
| `smoke-setup.msi` | `installer` | ✔ |
| `smoke-assets.zip` | `archive` | ✔ |
| `smoke-old.bin` | `old-download` | ☐ |
| `Screenshot 2026-01-02 141203.png` | `screenshot-noise` | ☐ |

### 一定不可以出現

- `smoke-今天的筆記.md`　← 保護副檔名，而且才剛改
- `smoke-重要簡報.pptx`　← 保護副檔名
- `smoke-下載中.zip.crdownload`　← **24 小時內還在變動**

> **這三個只要有一個出現在清單裡，smoke 就算失敗**，不管其他幾項多漂亮。

### 每一列都要有原因

清單上每一項都要有 `reason` 與 `evidence`。
「某某檔案」後面沒有「為什麼」的，就是 bug（spec 第 6 節：沒有 reason 與 evidence 就不寫入）。

### 重掃不可以長出第二份

```bash
node cli.mjs cleanup scan
node cli.mjs cleanup list | grep -c smoke-empty.txt      # 要是 1，不是 2
```

---

## 3 ・ 清掉

```bash
node cli.mjs cleanup apply
echo "離開碼 = $?"
```

### 要看到什麼

- 印出搬走的清單，**每一項都有 ✔**
- **離開碼 0**（有任何一項 ✘ 的話是 3）
- 印出 plan id，記下來

```bash
ls ~/Downloads | grep smoke                  # 那五個打勾的不見了
ls ~/.contextbox/quarantine/                 # 它們在這裡
ls ~/Downloads | grep -E '今天的筆記|重要簡報|下載中'   # 三個都還在
```

> **`~/Downloads` 裡不可以有任何檔案「消失但也不在隔離區」。**
> 那代表檔案掉在半路 —— 這是整個專案最不能發生的事。

---

## 4 ・ 救回來

```bash
node cli.mjs cleanup undo <plan-id>
ls ~/Downloads | grep smoke
```

五個都要回到原位、原檔名。隔離區要空掉（或少那五個）。

### 同名衝突那一條也要驗

```bash
node cli.mjs cleanup apply                      # 再清一次
printf 'SMOKE 我後來又下載了一個同名的\n' > ~/Downloads/smoke-empty.txt
node cli.mjs cleanup undo <plan-id>
ls ~/Downloads | grep smoke-empty
```

要看到**兩個檔**：

```
smoke-empty.txt              ← 你後來那個，內容沒被動過
smoke-empty.txt.restored     ← 救回來的
```

> **原本那個檔的內容被覆蓋掉的話，smoke 失敗。** 這條是 spec 第 2 節第 9 點。

---

## 5 ・ 重送 apply 不可以搬第二次

```bash
node cli.mjs cleanup apply                  # 建 plan 並套用，記下 plan id
node cli.mjs cleanup apply <同一個 plan-id>
```

第二次要**回同樣的結果、離開碼 0**，而且「搬進隔離區 N 個」的 N **不可以變大** ——
那代表真的搬了第二次。

> 這一份原本寫「第二次回 409 + 離開碼 1」。實作出來是冪等重播，而那是對的：
> CLI 逾時後被腳本重試是正常的，不該算失敗。兩種做法都守住「不可以真的再搬一次」，
> 但冪等對呼叫端友善得多。改文件，不改實作。

---

## 6 ・ 清空隔離區

```bash
node cli.mjs cleanup quarantine
node cli.mjs cleanup quarantine --empty
```

剛剛才放進去的東西**不到七天**，所以要被擋下來，訊息要講得出「還要等幾天」。

滿七天之後 `--empty` 會先印預覽與一個 token，**不會刪任何東西**。
要真的刪得再打一次：

```bash
node cli.mjs cleanup quarantine --empty --yes <token>
```

> 這是整個專案唯一會永久刪檔的路徑，所以一定要打兩次。
> token 五分鐘後失效。

---

## 7 ・ 收尾

```bash
rm -f ~/Downloads/smoke-*
rm -f ~/Downloads/'Screenshot 2026-01-02 141203.png'
node cli.mjs doctor          # Downloads 的檔案數要回到第 0 步記下的數字
```

隔離區裡如果還有 smoke 的殘留，代表前面某一步沒走完 —— 那本身就是一個發現。

---

## 8 ・ 每晚跑完要記什麼

寫進 `docs/smoke-log/YYYY-MM-DD.md`：

```markdown
# Smoke 2026-09-14

機器：Windows 11 / Node 24.6.0 / commit abc1234

| 步驟 | 結果 |
|---|---|
| 1 放垃圾 | ✓ |
| 2 掃描 | ✓ 七種都認出來，三個保護檔沒出現 |
| 3 清掉 | ✓ 五個進隔離區，離開碼 0 |
| 4 救回來 | ✓ 含 .restored 那一條 |
| 5 重送 apply | ✓ 回 409，沒有搬第二次 |
| 6 清空隔離區 | ✓ 被擋下，說還要等 6 天 |
| 7 收尾 | ✓ 檔案數對得回來 |

發現：
- （沒有的話寫「無」）
```

**紅的那一項要開 issue，不要只寫在 log 裡。**

---

## 9 ・ 自動化的邊界

第 1、7 步可以寫成腳本。**第 2、3、4 步不要全自動** ——
這份 smoke 的價值就在「有一雙眼睛真的看過畫面上寫了什麼」。

自動化測試已經在 `test/cleanup-*.test.mjs` 裡了。
這一份是**它們驗不到的那一半**：規則在真實資料上合不合理、
訊息看不看得懂、檔案有沒有真的回到原位。
