# Windows 安裝

## 一行裝好

在 repo 根目錄開 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File os\windows\install.ps1
```

要開機自動啟動就加 `-Startup`：

```powershell
powershell -ExecutionPolicy Bypass -File os\windows\install.ps1 -Startup
```

**不需要系統管理員。** 兩個捷徑都放在使用者自己的資料夾底下。

移除：

```powershell
powershell -ExecutionPolicy Bypass -File os\windows\uninstall.ps1
```

---

## 它到底做了什麼

| | 放在哪 |
|---|---|
| 開始選單捷徑 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\ContextBox Pet.lnk` |
| 開機啟動（選配） | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ContextBox Pet.lnk` |

兩個都指向 `os\windows\contextbox-pet.cmd`，那支做的事就是
`cd` 到 repo 然後 `node cli.mjs pet`。

**沒有動登錄檔、沒有裝服務、沒有要管理員權限。**
不想跑腳本的話，手動把那個 `.cmd` 拉一個捷徑到開始選單，效果一樣。

---

## 移除腳本不會碰你的檔案

`uninstall.ps1` 只刪那兩個捷徑。

`%USERPROFILE%\.contextbox\` 底下的東西**全部留著**，特別是：

```
%USERPROFILE%\.contextbox\quarantine\
```

**那裡面是你的檔案**（被清掉但還沒滿七天的），不是程式的東西。
移除腳本會告訴你裡面還有幾個、多大。要救回來：

```powershell
node cli.mjs cleanup quarantine
```

確定不要了才自己刪那個資料夾。

---

## 兩個編碼陷阱（改這些檔之前先看）

**`.cmd` 一律純 ASCII。** `cmd.exe` 用主控台字碼頁讀檔，
中文在很多機器上會變亂碼。所以 `contextbox-pet.cmd` 裡的訊息全是英文。

**`.ps1` 一定要存成 UTF-8 with BOM。** Windows PowerShell 5.1 沒看到 BOM
就當 ANSI 讀，中文一樣變亂碼。這兩支 `.ps1` 都有 BOM，
**用編輯器改的時候不要把它存掉**。

驗證：

```powershell
# 前三個 byte 要是 239 187 191
(Get-Content os\windows\install.ps1 -Encoding Byte -TotalCount 3)
```

---

## 跑不起來的時候

| 症狀 | 原因 |
|---|---|
| `無法載入檔案 … 執行原則` | 少了 `-ExecutionPolicy Bypass` |
| 視窗一閃就不見 | `.cmd` 失敗時會 `pause`，不該發生。直接在 PowerShell 裡跑 `node cli.mjs pet` 看訊息 |
| `Node.js not found` | `winget install OpenJS.NodeJS`，然後**開一個新視窗**（PATH 要重載） |
| 捷徑點了沒反應 | 右鍵 → 內容 → 確認「開始位置」是 repo 根目錄 |

---

## 待補（M3）

- [ ] 在乾淨的 Windows 機器上實測一次，把結果寫進 `docs/smoke-log/`
- [ ] 圖示（現在捷徑是 cmd 的預設圖示）
- [ ] 確認 OneDrive 已知資料夾移轉時 `doctor` 抓對 Downloads
