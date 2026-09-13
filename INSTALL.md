# 安裝

**骨架版。** M3 之前會補完 Windows／macOS 的實際步驟與截圖。

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

```powershell
winget install OpenJS.NodeJS
git clone https://github.com/lulu-wen/contextbox
cd contextbox
node cli.mjs doctor
```

`doctor` 會告訴你它打算看哪個資料夾。**先確認那是你真的在用的 Downloads** ——
Win11 綁 Microsoft 帳號時，已知資料夾移轉可能把它搬到
`%USERPROFILE%\OneDrive\Downloads`。

不對的話改 `%USERPROFILE%\.contextbox\config.json` 的 `watch`。

```powershell
node cli.mjs pet
```

> ⚠️ **OneDrive 檔案隨選**：如果你的 Downloads 是「僅線上」的佔位檔，
> 掃描時會需要讀檔案內容來算指紋。**M0 要驗這件事不會把整個資料夾拉回本機。**
> 驗完會把結論寫在這裡。

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

- [ ] Windows 開機自動啟動的捷徑
- [ ] macOS 的 LaunchAgent
- [ ] 乾淨機器實測紀錄（Windows 與 macOS 各一次）
- [ ] OneDrive 檔案隨選的結論
