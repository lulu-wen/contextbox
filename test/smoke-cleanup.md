# Smoke：在沙盒的 Downloads 放垃圾，清掉，再救回來

**D 的 owner file。** 每晚跑一次，M3 之前在 Windows 與 macOS 各跑一次留紀錄。

自動化測試驗的是「每個零件對不對」。這一份驗的是**「使用者真的做一遍會不會壞」**——
真的檔案、真的搬移、真的復原、真的畫面。

> **這份 smoke 全程在沙盒裡跑，不碰你真的 Downloads、也不碰真的 `~/.contextbox`。**
> 以前的版本直接在真的 Downloads 放垃圾、清掉、七天後永久刪除（稽核 RC18）——
> 照著做的人會把自己的檔案交給一份還在開發的工具。
>
> 做法：開一個**新的終端機分頁**，第 0 步把家目錄、設定檔、資料庫、隔離區、鑰匙
> 全部指到一個暫存資料夾，清理範圍（`cleanup.roots`）只有沙盒裡的 Downloads。
> 之後每一個 CLI 指令都透過第 0 步定義的 `cb`，撥檔案時間都透過 `sandbox_touch`；
> 兩個都會先檢查沙盒還在不在，不在就拒絕執行。
> **整份跑完之前不要換分頁**；換了分頁，`cb`、`sandbox_touch` 不存在，指令會直接失敗 —— 那是故意的。

---

## 0 ・ 建沙盒

在 **repo 根目錄**開一個新的終端機分頁（bash 或 zsh）。

**用 zsh 的話，先單獨貼這一行、按 Enter**（bash 貼了也沒事）：

```bash
[ -n "$ZSH_VERSION" ] && setopt interactivecomments
```

zsh 預設不認互動模式的行尾註解：下面每一行後面的 `# …` 會被當成指令的參數 ——
`cb cleanup apply   # …` 會把 `#` 當成 plan id。這一行**要自己一次貼**：跟下面那一大段一起貼的話，
zsh 會把整段讀完才開始執行，同一次貼上的行尾註解還是不認。

然後貼這一段：

```bash
export REPO="$PWD"
export SANDBOX="$(mktemp -d)"
export HOME="$SANDBOX/home"                 # 從這一行開始，~ 指的是沙盒，不是你的家目錄
mkdir -p "$HOME/Downloads"
export CONTEXTBOX_CONFIG="$SANDBOX/config.json"
export CONTEXTBOX_DB="$SANDBOX/data.db"
export CONTEXTBOX_QUARANTINE="$SANDBOX/quarantine"
export CONTEXTBOX_TOKEN_PATH="$SANDBOX/token"
cat > "$CONTEXTBOX_CONFIG" <<EOF
{
  "watch": ["$HOME/Downloads"],
  "filed": "$SANDBOX/Filed",
  "cleanup": { "roots": ["$HOME/Downloads"], "screenshots": false }
}
EOF

# 沙盒守門：環境變數有任何一個不在沙盒裡，就回 1。每一條都是整條路徑一模一樣的比對
sandbox_ok() {
  if [ -z "$SANDBOX" ] || [ "$HOME" != "$SANDBOX/home" ] \
     || [ "$CONTEXTBOX_CONFIG" != "$SANDBOX/config.json" ] \
     || [ "$CONTEXTBOX_DB" != "$SANDBOX/data.db" ] \
     || [ "$CONTEXTBOX_QUARANTINE" != "$SANDBOX/quarantine" ] \
     || [ "$CONTEXTBOX_TOKEN_PATH" != "$SANDBOX/token" ]; then
    echo '⚠ 沙盒沒設定好，這一步不跑。回到第 0 步重新設定。' >&2
    return 1
  fi
}

# 之後每一個 CLI 指令都走 cb
cb() {
  sandbox_ok || return 1
  node "$REPO/cli.mjs" "$@"
}

# 把檔案時間往回撥。寫法跟 GNU touch 一樣：sandbox_touch -d '3 days ago' 檔名…
# 但只撥沙盒 Downloads 裡的檔，有一個不在裡面就一個都不撥。
# 用 node 做：macOS 內建的 touch 看不懂「3 days ago」
sandbox_touch() {
  sandbox_ok || return 1
  node -e '
    const fs = require("node:fs"), { resolve, sep } = require("node:path")
    const [flag, when, ...files] = process.argv.slice(1)
    const m = /^(\d+) (hour|day)s? ago$/.exec(when ?? "")
    if (flag !== "-d" || !m || !files.length) { console.error(`⚠ 用法：sandbox_touch -d "3 days ago" 檔名…`); process.exit(2) }
    const real = p => { try { return fs.realpathSync.native(p) } catch { return null } }
    const dl = real(resolve(process.env.SANDBOX, "home", "Downloads")) + sep
    const outside = files.filter(f => !(real(resolve(f)) ?? "").startsWith(dl))
    if (outside.length) { console.error("⚠ 不在沙盒的 Downloads，一個都不撥：" + outside.join("、")); process.exit(1) }
    const t = new Date(Date.now() - m[1] * (m[2] === "hour" ? 3600e3 : 864e5))
    for (const f of files) fs.utimesSync(f, t, t)
  ' -- "$@"
}

cb doctor
```

`doctor` 印出來的**設定檔、資料庫、監看資料夾、隔離區四行，全部都要在 `$SANDBOX` 底下**
（`echo "$SANDBOX"` 對照）。有任何一行指到你真的家目錄 —— 停下來，關掉這個分頁重來。

**Windows（PowerShell）** 的第 0 步：

```powershell
$env:REPO = (Get-Location).Path
$env:SANDBOX = Join-Path $env:TEMP ("cb-smoke-" + [guid]::NewGuid())
$env:USERPROFILE = Join-Path $env:SANDBOX 'home'     # 從這一行開始，家目錄是沙盒
$env:HOME = $env:USERPROFILE
New-Item -ItemType Directory -Force "$env:USERPROFILE\Downloads" | Out-Null
$env:CONTEXTBOX_CONFIG = "$env:SANDBOX\config.json"
$env:CONTEXTBOX_DB = "$env:SANDBOX\data.db"
$env:CONTEXTBOX_QUARANTINE = "$env:SANDBOX\quarantine"
$env:CONTEXTBOX_TOKEN_PATH = "$env:SANDBOX\token"
$cfg = @{ watch = @("$env:USERPROFILE\Downloads"); filed = "$env:SANDBOX\Filed"
          cleanup = @{ roots = @("$env:USERPROFILE\Downloads"); screenshots = $false } } | ConvertTo-Json -Depth 5
# 不用 Set-Content：Windows PowerShell 5 會加 BOM，設定檔就讀不懂了
[IO.File]::WriteAllText($env:CONTEXTBOX_CONFIG, $cfg)

# 沙盒守門：環境變數有任何一個不在沙盒裡，就回 $false
function sandbox_ok {
  $ok = $env:SANDBOX -and $env:USERPROFILE -eq "$env:SANDBOX\home" `
    -and $env:CONTEXTBOX_CONFIG -eq "$env:SANDBOX\config.json" -and $env:CONTEXTBOX_DB -eq "$env:SANDBOX\data.db" `
    -and $env:CONTEXTBOX_QUARANTINE -eq "$env:SANDBOX\quarantine" -and $env:CONTEXTBOX_TOKEN_PATH -eq "$env:SANDBOX\token"
  if (-not $ok) { Write-Warning '沙盒沒設定好，這一步不跑。回到第 0 步重新設定。' }
  return [bool]$ok
}

function cb {
  if (-not (sandbox_ok)) { return }
  node "$env:REPO\cli.mjs" @args
}

# 把檔案時間往回撥，寫法跟 bash 那邊一樣：sandbox_touch -d '3 days ago' 檔名…
# 只撥沙盒 Downloads 裡的檔，有一個找不到或不在裡面就一個都不撥
function sandbox_touch([string]$d) {
  if (-not (sandbox_ok)) { return }
  if (-not ($d -match '^(\d+) (hour|day)s? ago$')) { Write-Warning '用法：sandbox_touch -d ''3 days ago'' 檔名…'; return }
  $span = if ($Matches[2] -eq 'hour') { [TimeSpan]::FromHours([double]$Matches[1]) } else { [TimeSpan]::FromDays([double]$Matches[1]) }
  $dl = (Get-Item -LiteralPath "$env:USERPROFILE\Downloads").FullName + [IO.Path]::DirectorySeparatorChar
  $files = @(foreach ($f in $args) { Get-Item -LiteralPath $f })
  $outside = @($files | Where-Object { -not $_.FullName.StartsWith($dl, [StringComparison]::OrdinalIgnoreCase) })
  if ($files.Count -ne $args.Count -or $outside.Count) { Write-Warning '有檔案找不到或不在沙盒的 Downloads，一個都不撥'; return }
  foreach ($f in $files) { $f.LastWriteTime = (Get-Date) - $span }
}

cb doctor
```

**PowerShell 跑不了第 4–6 步**（含 6.5）：那幾步的指令用到 bash 的 `printf`、`cat`、`if … fi`、
`變數=值 指令` 這種寫法，這份文件沒有 PowerShell 版，**不要把 bash 指令硬貼進 PowerShell**。
Windows 上跑第 0–3 步，第 3 步之後用 `cb cleanup undo` 把那五個救回來（第 4 步的第一個指令），
然後直接跳到第 7 步。紀錄上第 4 步寫「只跑了 `cb cleanup undo`」，第 5、6、6.5 步寫「PowerShell 版還沒有，沒跑」。

第 2、3 步在 PowerShell 裡這樣換：

- `cb …` 照打。`ls ~/Downloads | grep smoke` 換成 `(Get-ChildItem "$env:USERPROFILE\Downloads").Name | Select-String smoke`，
  `grep -c` 再接 `| Measure-Object`（`cb cleanup list | grep -c …` 同理）
- `CONTEXTBOX_READONLY=1 cb cleanup apply` 拆成三行：`$env:CONTEXTBOX_READONLY = '1'`、`cb cleanup apply`、`$env:CONTEXTBOX_READONLY = $null`
- 離開碼看 `$LASTEXITCODE`，不是 `$?`（PowerShell 的 `$?` 只有 True／False）

> **PowerShell 裡不要用 `~`。** PowerShell 的 `~` 是分頁**開啟時**的家目錄，不會跟著上面改過的
> `$env:USERPROFILE` 走 —— `cd ~\Downloads` 會進到你真的 Downloads。一律寫 `$env:USERPROFILE`。

---

## 1 ・ 放七種垃圾進去

每一種對應 spec 第 5 節的一條規則。**七種都要放**，因為每一條規則都要被走過一次。
`~` 已經是沙盒了，下面的 `cd ~/Downloads` 進的是沙盒裡的 Downloads。

```bash
cd ~/Downloads
pwd                                      # 要印出 $SANDBOX/home/Downloads

# duplicate —— 同 sha256 兩份，另一份還在
# **兩個都要往回撥時間。** 十分鐘內動過的檔一律不搬（防「還在寫入」），
# 不撥的話這一步一定失敗，而且錯不在程式。
printf 'SMOKE 這是一份報告的內容\n' > smoke-report.pdf
cp smoke-report.pdf 'smoke-report (1).pdf'
sandbox_touch -d '2 hours ago' smoke-report.pdf 'smoke-report (1).pdf'

# partial —— 下載到一半，而且 24 小時沒變
printf 'SMOKE 半個檔\n' > smoke-big.iso.crdownload
sandbox_touch -d '3 days ago' smoke-big.iso.crdownload

# empty —— 0 byte，24 小時沒變
: > smoke-empty.txt
sandbox_touch -d '3 days ago' smoke-empty.txt

# installer —— 14 天沒變
printf 'SMOKE 假安裝檔\n' > smoke-setup.msi
sandbox_touch -d '30 days ago' smoke-setup.msi

# archive —— 30 天沒變（但不到 90 天，免得同時算成 old-download）
printf 'SMOKE 假壓縮檔\n' > smoke-assets.zip
sandbox_touch -d '60 days ago' smoke-assets.zip

# old-download —— 90 天沒變，不在保護副檔名
printf 'SMOKE 很舊的東西\n' > smoke-old.bin
sandbox_touch -d '200 days ago' smoke-old.bin

# screenshot-noise —— Screenshot 開頭，30 天沒變（不到 90 天，免得 kind 變成 old-download）
printf 'SMOKE 假截圖\n' > 'Screenshot 2026-01-02 141203.png'
sandbox_touch -d '45 days ago' 'Screenshot 2026-01-02 141203.png'
```

> **為什麼每一個垃圾檔都要往回撥時間？**
> 搬檔前會檢查「這個檔十分鐘內有沒有被動過」—— 有的話就不搬，因為下載器、
> 解壓縮、編輯器的暫存寫入都會在幾秒內連續改同一個檔，搬一個正在被寫的檔
> 會讓那個程式的 fd 指向舊 inode，資料靜靜消失。
> 所以**剛建立的檔一定搬不動**，那是對的行為，不是 bug。
> 訊息會說「這個檔案十分鐘內還在變動，先不搬」。

**Windows（PowerShell）**：

```powershell
cd "$env:USERPROFILE\Downloads"     # 第 0 步換過 USERPROFILE，這裡是沙盒（不要寫 ~，見上）
"SMOKE 這是一份報告的內容" | Out-File -Encoding utf8 smoke-report.pdf
Copy-Item smoke-report.pdf "smoke-report (1).pdf"
sandbox_touch -d '2 hours ago' smoke-report.pdf "smoke-report (1).pdf"
"SMOKE 半個檔" | Out-File -Encoding utf8 smoke-big.iso.crdownload
sandbox_touch -d '3 days ago' smoke-big.iso.crdownload
New-Item smoke-empty.txt -ItemType File -Force | Out-Null
sandbox_touch -d '3 days ago' smoke-empty.txt
"SMOKE 假安裝檔" | Out-File -Encoding utf8 smoke-setup.msi
sandbox_touch -d '30 days ago' smoke-setup.msi
"SMOKE 假壓縮檔" | Out-File -Encoding utf8 smoke-assets.zip
sandbox_touch -d '60 days ago' smoke-assets.zip
"SMOKE 很舊的東西" | Out-File -Encoding utf8 smoke-old.bin
sandbox_touch -d '200 days ago' smoke-old.bin
"SMOKE 假截圖" | Out-File -Encoding utf8 "Screenshot 2026-01-02 141203.png"
sandbox_touch -d '45 days ago' "Screenshot 2026-01-02 141203.png"
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
cb cleanup scan
cb cleanup list
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

清單頁尾說「會清掉打勾的 N 個」，N 要是 **5**。

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
cb cleanup scan
cb cleanup list | grep -c smoke-empty.txt      # 要是 1，不是 2
```

---

## 3 ・ 清掉

先唯讀試跑一次，確認它只說不做：

```bash
CONTEXTBOX_READONLY=1 cb cleanup apply
ls ~/Downloads | grep -c smoke                 # 還是 10 個，一個都沒少
```

唯讀模式要印出「會清掉 5 個」、**一個檔案都不動**，也不留下任何計畫。

然後真的清：

```bash
cb cleanup apply
echo "離開碼 = $?"
```

### 要看到什麼

- 印出搬走的清單，**每一項都有 ✔**
- **離開碼 0**（有任何一項 ✘ 的話是 3）
- 印出 plan id，記下來

```bash
ls ~/Downloads | grep smoke                          # 那五個打勾的不見了
find "$CONTEXTBOX_QUARANTINE" -type f                # 它們在沙盒的隔離區裡（一行一個）
ls ~/Downloads | grep -E '今天的筆記|重要簡報|下載中'   # 三個都還在
```

> **Downloads 裡不可以有任何檔案「消失但也不在隔離區」。**
> 那代表檔案掉在半路 —— 這是整個專案最不能發生的事。

---

## 4 ・ 救回來

```bash
cb cleanup undo <plan-id>
ls ~/Downloads | grep smoke
find "$CONTEXTBOX_QUARANTINE" -type f                # 要沒有輸出
```

五個都要回到原位、原檔名。隔離區要空掉：`find` 要**沒有輸出**。
復原之後隔離區會留下空資料夾，那不算東西 —— 所以不用 `ls -R`，它連空資料夾都會印，永遠「還有東西」。
（`cb cleanup undo` 不給 id 的話，復原的是最近一份還能復原的計畫 —— 結果要一樣。）

復原過的檔，**同樣的理由不會再被提議**（復原就代表想留著），所以重掃之後它們不在清單上。
那是對的，不是 bug。訊息**不可以**說「之後不會再被提議」：之後符合新的理由還是會再出現。

### 同名衝突那一條也要驗

剛剛復原的那五個不會再被提議，所以**用一個新檔**來做：

```bash
printf 'SMOKE 同名衝突用的舊檔\n' > ~/Downloads/smoke-同名.zip
sandbox_touch -d '60 days ago' ~/Downloads/smoke-同名.zip
cb cleanup scan
cb cleanup apply                                    # 只會清掉 smoke-同名.zip，記下 plan id
printf 'SMOKE 我後來又下載了一個同名的\n' > ~/Downloads/smoke-同名.zip
cb cleanup undo <plan-id>
ls ~/Downloads | grep smoke-同名
cat ~/Downloads/smoke-同名.zip                      # 要是「我後來又下載了一個同名的」
```

要看到**兩個檔**：

```
smoke-同名.zip              ← 你後來那個，內容沒被動過
smoke-同名.zip.restored     ← 救回來的
```

復原的訊息要講出「放回來的這份叫 smoke-同名.zip.restored」。

> **後來那個檔的內容被覆蓋掉的話，smoke 失敗。** 這條是 spec 第 2 節第 9 點。

---

## 5 ・ 重送 apply 不可以搬第二次

一樣用一個新檔（前面的都已經復原過了）：

```bash
printf 'SMOKE 重送用的舊檔\n' > ~/Downloads/smoke-重送.zip
sandbox_touch -d '60 days ago' ~/Downloads/smoke-重送.zip
cb cleanup scan
cb cleanup apply                                    # 建 plan 並套用，記下 plan id
find "$CONTEXTBOX_QUARANTINE" -type f | wc -l       # 記下這個數字（應該是 1）
cb cleanup apply <同一個 plan-id>
echo "離開碼 = $?"
find "$CONTEXTBOX_QUARANTINE" -type f | wc -l       # 跟上面一樣
```

第二次要**印出同樣的結果、離開碼 0**，而且「搬進隔離區 N 個」的 N、隔離區裡的檔數都**不可以變**
—— 變了代表真的搬了第二次。重送是冪等的：CLI 逾時後被腳本重試是正常的，不該算失敗。

---

## 6 ・ 清空隔離區

```bash
cb cleanup quarantine
cb cleanup quarantine --empty
```

剛剛才放進去的東西**不到七天**，所以要被擋下來，訊息要講得出「還要等幾天」。

七天不用真的等：**在沙盒裡**把隔離時間撥回八天前（只能對沙盒的資料庫這樣做）：

```bash
if sandbox_ok && [ "$CONTEXTBOX_DB" = "$SANDBOX/data.db" ]; then
  node -e 'const { DatabaseSync } = require("node:sqlite");
    new DatabaseSync(process.env.CONTEXTBOX_DB).prepare("UPDATE cleanup_move_details SET completed_at = ?")
      .run(new Date(Date.now() - 8 * 864e5).toISOString())'
else
  echo '⚠ 資料庫不在沙盒裡，不撥'
fi
cb cleanup quarantine --empty
```

> **守門是整條路徑一模一樣的比對。** 以前寫的是 `case "$CONTEXTBOX_DB" in "$SANDBOX"/*)`：
> `SANDBOX` 是空字串的時候樣式變成 `"/"*`，任何絕對路徑都放行 —— 真的資料庫會被撥成八天前，
> 真的隔離區可以馬上永久清空。`test/repo.test.mjs` 會真的用 bash 跑這一段，餵空的 `SANDBOX` 看它擋不擋。

這次 `--empty` 會先印預覽與一個 token，**不會刪任何東西**。要真的刪得再打一次：

```bash
cb cleanup quarantine --empty --yes              # 沒給 token：離開碼 1，什麼都不刪
cb cleanup quarantine --empty --yes 亂打的        # token 不對：離開碼 1，什麼都不刪
cb cleanup quarantine --empty --yes <token>      # 刪掉預覽裡的那些
cb cleanup quarantine                            # 隔離區是空的
```

帶 `--yes <token>` 的那一次**不可以再印一個新的預覽**，直接確認那一個。

> 這是整個專案唯一會永久刪檔的路徑，所以一定要打兩次。
> token 五分鐘後失效。

---

## 6.5 ・ 在畫面上走一次

CLI 那幾步走完之後，用畫面再走一次同樣的流程。**這一段一定要真的用滑鼠點**，
自動化測試驗得到資料對不對，驗不到「使用者看了會不會誤會」。

在**同一個分頁**、同一組環境變數下，在背景起沙盒的 server。`CONTEXTBOX_PORT=0` 讓系統挑一個空的 port ——
你平常在跑的 ContextBox（7391）**不用關**，兩個不會撞：

```bash
printf 'SMOKE 畫面用的舊檔\n' > ~/Downloads/smoke-畫面.zip
printf 'SMOKE 畫面用的安裝檔\n' > ~/Downloads/smoke-畫面.msi
sandbox_touch -d '60 days ago' ~/Downloads/smoke-畫面.zip ~/Downloads/smoke-畫面.msi
cb cleanup scan
CONTEXTBOX_PORT=0 cb pet &   # 背景跑；印出一個帶 ?k= 的網址，port 是系統挑的
```

打開它印出來、**帶 `?k=…` 的網址**（或另外跑 `cb open`：pet 把實際的 port 記在沙盒的資料庫裡，
`open` 讀得到）。那把鑰匙是沙盒的：拿去開你平常那一個 server 會回 401，開錯了也不會動到真的檔。

> `CONTEXTBOX_PORT=0` 只寫在 pet 那一行，**不要 export**：export 的話之後的 `cb open` 也拿到 0，
> 就找不到沙盒的 pet 了。

1. 右下角的可頌貓旁邊要有垃圾桶，**數字跟 `cb cleanup list` 的檔案數一樣**。
2. 點垃圾桶。面板上方要寫「**本機模式**」—— 寫「示範模式」的話你開到 demo 了，按 D 切回來。
3. 取消一個預設勾的（`smoke-畫面.zip`）、勾起一個預設沒勾的（`smoke-old.bin`）。按鈕上的數字要跟著變。
4. 按清理。訊息要說「搬進隔離區 N 個」，**N 要等於沙盒 Downloads 真的少掉的數量**
   （`ls ~/Downloads | grep -c smoke` 前後比）。取消的那個要還在。
5. 按「復原這次清理」。檔案要回到 Downloads，而且它們**不會**再出現在這次的面板清單上 ——
   那是對的，不是 bug（復原過就代表想留著，同樣的理由不再提醒）。
   訊息**不可以**說「之後不會再被提議」：之後符合新的理由還是會再出現。
6. 再測一次同名衝突。剛復原的不會再被提議，所以**用一個新檔**：

   ```bash
   printf 'SMOKE 畫面同名\n' > ~/Downloads/smoke-畫面同名.zip
   sandbox_touch -d '60 days ago' ~/Downloads/smoke-畫面同名.zip
   cb cleanup scan
   ```

   重新整理面板、只清這一個，然後在原位置放一個同名的新檔
   （`printf 'SMOKE 新的\n' > ~/Downloads/smoke-畫面同名.zip`），再按復原。
   訊息要講出「放回來的這份叫 smoke-畫面同名.zip.restored」—— 不講的話使用者會以為放回原位了。
7. 再清一次（第 3 步取消的 `smoke-畫面.zip` 還在清單上），關掉面板，點「復原最近動作」。
   要列出剛剛那一次，勾起來復原。
8. 按 D 切到示範模式、按清理。**沙盒的 Downloads 一個檔都不可以動**（`ls ~/Downloads` 前後一樣）。

> 第 4 步如果訊息說搬了 N 個，但 Downloads 少的數量不是 N —— 那是整個專案最不能發生的事。

走完之後把背景的 server 停掉：

```bash
kill %1
```

---

## 7 ・ 收尾

```bash
ls ~/Downloads                          # 只剩這份 smoke 放的檔（含 .restored），沒有別的東西
find "$CONTEXTBOX_QUARANTINE" -type f   # 要沒有輸出。有的話，代表前面某一步沒走完 —— 那本身就是一個發現
cd "$REPO"
sandbox_ok && rm -rf "$SANDBOX"
exit                                    # 關掉這個分頁：這個分頁的 HOME 還指著剛刪掉的沙盒
```

隔離區只剩空資料夾是正常的（復原、清空都不刪資料夾），`find -type f` 只列檔案。
以前這裡用 `ls -R`，空資料夾也會印出來，每晚都記一條假的發現。

**Windows（PowerShell）**：

```powershell
Get-ChildItem "$env:USERPROFILE\Downloads"                  # 只剩這份 smoke 放的檔
Get-ChildItem -Recurse -File "$env:CONTEXTBOX_QUARANTINE"   # 要沒有輸出
cd $env:REPO
if (sandbox_ok) { Remove-Item -Recurse -Force $env:SANDBOX }
exit
```

---

## 8 ・ 每晚跑完要記什麼

寫進 `docs/smoke-log/YYYY-MM-DD.md`：

```markdown
# Smoke 2026-09-14

機器：macOS 15 / Node 24.6.0 / commit abc1234

| 步驟 | 結果 |
|---|---|
| 0 沙盒 | ✓ doctor 四行都在沙盒裡 |
| 1 放垃圾 | ✓ |
| 2 掃描 | ✓ 七種都認出來，三個保護檔沒出現 |
| 3 清掉 | ✓ 唯讀試跑沒動檔；五個進隔離區，離開碼 0 |
| 4 救回來 | ✓ 含 .restored 那一條 |
| 5 重送 apply | ✓ 同樣的結果、離開碼 0，隔離區檔數沒變 |
| 6 清空隔離區 | ✓ 不滿七天被擋下；撥回八天後兩段確認刪掉 |
| 6.5 畫面 | ✓ |
| 7 收尾 | ✓ 隔離區沒有殘留 |

發現：
- （沒有的話寫「無」）
```

Windows 的紀錄照第 0 步說的寫：第 4 步「只跑了 `cb cleanup undo`」，第 5、6、6.5 步「PowerShell 版還沒有，沒跑」。

**紅的那一項要開 issue，不要只寫在 log 裡。**

---

## 9 ・ 自動化的邊界

第 0、1、7 步可以寫成腳本。**第 2、3、4 步不要全自動** ——
這份 smoke 的價值就在「有一雙眼睛真的看過畫面上寫了什麼」。

自動化測試已經在 `test/cleanup-*.test.mjs` 裡了。
這一份是**它們驗不到的那一半**：規則在真實資料上合不合理、
訊息看不看得懂、檔案有沒有真的回到原位。

`test/repo.test.mjs` 會檢查這份文件本身：沙盒要在第一個動資料的指令之前設好、
每一個 CLI 指令都走 `cb`、直接改資料庫或檔案時間的每一行都站在守門後面（而且真的用 bash 跑一次：
`SANDBOX` 是空字串也要擋下）、隔離區空了沒用 `find -type f` 看、
重送 apply 要寫成冪等（舊版寫的是「重送會被拒絕」，那不是實際行為）。
