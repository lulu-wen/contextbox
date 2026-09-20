# 安裝

**想先看看它做什麼，不用安裝** —— 做一個假的家目錄跑 demo 就好，你真的檔案一個字都不會被動到：

```bash
node tools/demo-setup.mjs --dir /tmp/contextbox-demo --seed-model
```

逐步畫面在 [docs/DEMO.md](docs/DEMO.md)。下面是**真的裝來用**的步驟。

---

## 你需要什麼

| | |
|---|---|
| **Node 24 以上** | `node -v` 要看到 `v24` 或更新 |
| 硬碟 | 隔離區會放你清掉的檔案，**準備跟 Downloads 差不多的空間** |
| 網路 | **不用。** 這個版本完全在本機跑，不連任何外面的服務 |

**不用 `npm install`。** 這個專案零外部依賴。

---

## Windows

### 先跑 demo（不碰你自己的檔，五分鐘）

```powershell
winget install OpenJS.NodeJS          # 要 Node 24 以上；裝完**重開一個 PowerShell 視窗**
node --version                        # 確認看到 v24 或更新

git clone https://github.com/lulu-wen/contextbox
cd contextbox

node tools/demo-setup.mjs --dir $env:TEMP\contextbox-demo --seed-model
```

它會印出**要貼的環境變數**（在 Windows 上會直接印成 PowerShell 的寫法，
`$env:USERPROFILE` 也會一起換掉 —— 那才是 Windows 的家目錄）。
**把那幾行原封不動貼回同一個視窗**，然後：

```powershell
node cli.mjs cleanup scan     # 掃一遍
node cli.mjs cleanup list     # 三張連拍截圖會被歸成一組
node cli.mjs cleanup apply    # 搬進隔離區（不是刪除）
node cli.mjs rename           # 沒取名的檔，模型建議的名字
node cli.mjs file             # 同一堂課的檔歸到 課程/<課名>/<類型>/
node cli.mjs pet              # 開面板（網址會印出來，鑰匙已經帶在裡面）
```

**整個沙盒都在 `%TEMP%\contextbox-demo`，刪掉那個資料夾就什麼都沒留下。**
逐步畫面與每一行預期輸出在 [docs/DEMO.md](docs/DEMO.md)；要現場真的問模型改用
`--live-model`（見 [docs/model-setup.md](docs/model-setup.md)）。

用 `cmd.exe` 的話，環境變數那幾行要換成 `set NAME=值`（不要加引號）。

### 真的裝來用

```powershell
cd contextbox
node cli.mjs doctor
```

`doctor` 會告訴你它打算清哪個資料夾（「清理範圍」）。預設一律是 `%USERPROFILE%\Downloads`，
**不會自動改用 `%USERPROFILE%\OneDrive\Downloads`** —— 從 OneDrive 同步的資料夾搬進隔離區，
等於在雲端與你所有的裝置上刪掉。

**先確認那是你真的在用的 Downloads。** 不對的話改 `%USERPROFILE%\.contextbox\config.json` 的
`cleanup.roots`（清理只看它）：

```json
{ "cleanup": { "roots": ["D:\\Downloads"] } }
```

> ⚠️ **清理範圍跟隔離區要在同一顆碟。** 隔離區預設在 `%USERPROFILE%\.contextbox\quarantine`（多半是 C:），
> 把清理範圍設到 `D:\` 之後每一次清理都是跨磁碟搬移 —— 這個專案**不做「複製再刪除」**（那等於刪檔），
> 所以那些檔會逐項失敗並講原因。要清 D 槽的話，把隔離區也移過去：
> `$env:CONTEXTBOX_QUARANTINE = "D:\.contextbox\quarantine"`（同一個視窗設，或設成使用者層的環境變數）。

**不是 `watch`** —— `watch` 是截圖功能的監看資料夾，改它不會改到清理範圍。
你的 Downloads 真的在 OneDrive 裡、也確定要清它，才自己把那個路徑寫進 `cleanup.roots`。

```powershell
node cli.mjs pet
```

裝成開始選單捷徑（**不需要系統管理員**）：

```powershell
powershell -ExecutionPolicy Bypass -File os\windows\install.ps1
```

要開機自動啟動就加 `-Startup`。細節與移除方式看
[os/windows/README.md](os/windows/README.md)。

> ⚠️ **OneDrive 檔案隨選還沒實測**：如果你的 Downloads 是「僅線上」的佔位檔，
> 掃描要讀檔案內容算指紋，有可能把整個資料夾拉回本機。
> 在有人實測之前，**這種設定請先不要把 OneDrive 的路徑寫進 `cleanup.roots`**。

---

## macOS

```bash
brew install node
git clone https://github.com/lulu-wen/contextbox
cd contextbox
node cli.mjs doctor
node cli.mjs pet
```

第一次跑會跳「ContextBox 想要存取你的下載檔案夾」，要按允許。

> **macOS 的截圖資料夾就是桌面。** 設定檔的 `cleanup.screenshots` 預設是 `false`；打開的話，
> 桌面會加進清理範圍，但**桌面上只清截圖**（檔名 `Screenshot`、`截圖`、`螢幕快照` 開頭，放了 30 天以上的），
> 桌面上的壓縮檔、安裝檔、文件都不會被列出來。要清整個桌面，得自己把它寫進 `cleanup.roots`
> 而且不開這個開關。

---

## Linux

```bash
git clone https://github.com/lulu-wen/contextbox
cd contextbox
node cli.mjs doctor
node cli.mjs pet
```

---

## 檔案放在哪

```
~/.contextbox/config.json      設定（第一次跑會自己建）
~/.contextbox/data.db          資料庫，權限 0600
~/.contextbox/quarantine/      清掉的檔案放這裡，七天後才能清空
~/.contextbox/token            本機 server 的鑰匙
~/Documents/Filed/             歸檔（`node cli.mjs file`）搬進去的那棵樹，只會往裡面搬
```

**Windows 上的 `~` 是 `%USERPROFILE%`。**

---

## 怎麼確認它真的在跑

```bash
node cli.mjs doctor
```

三行要是 ✓：**Downloads 存在**、**隔離區存在**、**監看還活著**。
「監看」那行如果說「從來沒跑過」，就是你還沒開 `pet` 或 `watch`。

---

## 怎麼移除

```bash
# 1. 先把隔離區裡還要的東西救回來
node cli.mjs cleanup quarantine
node cli.mjs cleanup undo <plan-id>

# 2. 再刪設定與資料
rm -rf ~/.contextbox
```

**順序不要反。** `~/.contextbox/quarantine/` 裡是你的檔案，
刪掉那個資料夾就真的沒了 —— 那是整個專案裡唯一會真的失去檔案的地方。

---

## 待補（M3）

- [ ] macOS 的 LaunchAgent
- [ ] 乾淨機器實測紀錄（Windows 與 macOS 各一次）
- [ ] OneDrive 檔案隨選的結論
