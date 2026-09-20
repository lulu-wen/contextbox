#!/usr/bin/env node
/**
 * 做一個可以完整跑一次的 demo 沙盒 —— **完全不碰你真的 Downloads 與 ~/.contextbox**。
 *
 *   node tools/demo-setup.mjs                  做在 ./demo-sandbox
 *   node tools/demo-setup.mjs --dir <path>     做在別的地方
 *   node tools/demo-setup.mjs --force          資料夾已經有東西也照做（只補檔，不刪）
 *   node tools/demo-setup.mjs --seed-model     順便掃一次，並把「模型的答案」預先塞進快取（P2）
 *   node tools/demo-setup.mjs --live-model     現場真的問模型：把你自己的 model 設定抄進沙盒，
 *                                              **不預塞答案**（預塞了 think 就直接命中快取，等於沒問）
 *     ・ 端點從哪來（依序）：--base-url／--model-name 旗標 → 環境變數
 *       CONTEXTBOX_MODEL_BASEURL／CONTEXTBOX_MODEL_NAME → 你真的 ~/.contextbox/config.json
 *     ・ **金鑰永遠不經過這支程式**：它只從環境變數讀（config.model.keyEnv），
 *       這裡連讀都不讀，更不會印出來
 *
 * 它會建出一個假的家目錄：Downloads 裡放一批**看起來像真的**的檔（安裝檔、壓縮檔、
 * 重複下載、很久沒動的檔、連拍截圖、課程講義），設定檔指到這個沙盒，
 * 隔離區也在沙盒裡；最後把要貼的指令印出來。
 *
 * 為什麼要有這支：demo 與評審要能在自己的機器上跑完整流程，而**清理工具跑錯地方的代價很大**。
 * 沙盒把所有路徑都框在一個資料夾裡：設定、資料庫、隔離區、被清的檔全部都在裡面，
 * 刪掉那個資料夾就什麼都沒留下。
 *
 * 檔案的時間是**往回撥**的（清理規則看「多久沒動」），所以一建好就有東西可以清。
 */
import { mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400_000
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt }

const dir = resolve(opt('--dir', join(process.cwd(), 'demo-sandbox')))
const reset = flag('--reset')
const home = join(dir, 'home')
const downloads = join(home, 'Downloads')

// ── 守門：不可以做在真的家目錄裡 ────────────────────────────────
const realHome = realpathSync(process.env.HOME ?? process.env.USERPROFILE ?? '/')
if (dir === realHome || realHome.startsWith(dir + '/')) {
  console.error(`✘ ${dir} 是你的家目錄（或它的上層）。demo 沙盒要做在別的地方。`)
  process.exit(1)
}
// ── --reset：把「已經清過」的紀錄清掉，可以再 demo 一次 ──────────
// 只刪這個沙盒裡的資料庫、隔離區與 token，**不碰 Downloads 裡的檔**。
// 為什麼要有：放回原位的檔不會再被自動提議（那是對的行為），所以 demo 跑完一輪，
// 清單就空了。重來一次最乾淨的方式是丟掉這個沙盒的紀錄。
if (reset) {
  if (!existsSync(join(dir, 'config.json'))) {
    console.error(`✘ ${dir} 看起來不是 demo 沙盒（沒有 config.json），不敢動它。`)
    process.exit(1)
  }
  for (const name of ['data.db', 'data.db-wal', 'data.db-shm', 'token']) {
    const p = join(dir, name)
    if (existsSync(p)) rmSync(p)
  }
  const q = join(dir, 'quarantine')
  if (existsSync(q)) rmSync(q, { recursive: true })
  console.log(`已經把 ${dir} 的紀錄清掉（Downloads 裡的檔沒有動）。可以再跑一次 scan。`)
  if (!flag('--force')) process.exit(0)
}

if (existsSync(dir) && readdirSync(dir).length && !flag('--force')) {
  console.error(`✘ ${dir} 已經有東西了。換一個資料夾，或加 --force（只會補檔，不會刪任何東西）。`)
  process.exit(1)
}

// ── 產生檔案 ──────────────────────────────────────────────────

/** 寫一個檔，並把它的時間往回撥 days 天。 */
function put(rel, content, days) {
  const path = join(downloads, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  const at = new Date(Date.now() - days * DAY)
  utimesSync(path, at, at)
  return path
}

/** 最小的 PNG 編碼器（灰階、每列一個 filter 0）。截圖用，不需要任何外部套件。 */
function png(width, height, draw) {
  const row = width + 1
  const raw = Buffer.alloc(row * height, 0xff)
  for (let y = 0; y < height; y++) raw[y * row] = 0          // filter: none
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    raw[y * row + 1 + x] = v
  }
  draw(set)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 0                                    // 8 bit、灰階
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

/** 一張「像截圖」的圖：頂端有標題列，中間幾行字，右下角有一顆按鈕。 */
function shot({ lines = 6, extraLine = false, badge = 0, cursor = false } = {}) {
  return png(1280, 720, set => {
    const rect = (x0, y0, w, h, v) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, v)
    }
    rect(0, 0, 1280, 48, 0x22)                                  // 標題列
    for (let i = 0; i < lines; i++) rect(80, 110 + i * 40, 520 + (i % 3) * 180, 16, 0x44)   // 幾行字
    if (extraLine) rect(80, 110 + lines * 40, 300, 16, 0x44)    // 多打一行
    rect(1120, 620, 96, 48, 0x66)                               // 按鈕
    for (let i = 0; i < badge; i++) rect(1190 + i * 10, 610, 8, 8, 0x11)   // 未讀數字
    if (cursor) rect(600, 300, 2, 18, 0x00)                     // 游標
  })
}

const files = []
const note = (name, days, what) => files.push({ name, days, what })

mkdirSync(downloads, { recursive: true })

// 很久沒動的下載（規則：old-download、archive、installer）
put('Node-v24-安裝檔.exe', Buffer.alloc(9_400_000, 7), 45);        note('Node-v24-安裝檔.exe', 45, '45 天沒動的安裝檔')
put('資料結構_lab3.zip', Buffer.from('lab3 內容 '.repeat(2000)), 62); note('資料結構_lab3.zip', 62, '兩個月沒動的壓縮檔')
put('資料結構_lab3 (1).zip', Buffer.from('lab3 內容 '.repeat(2000)), 60); note('資料結構_lab3 (1).zip', 60, '跟上面一模一樣的重複下載')
put('會議記錄草稿.tmp', Buffer.from('暫存'), 30);                   note('會議記錄草稿.tmp', 30, '暫存檔')
put('空的.txt', Buffer.alloc(0), 21);                              note('空的.txt', 21, '空檔')
put('下載到一半的影片.mp4.part', Buffer.alloc(3_200_000, 3), 18);   note('下載到一半的影片.mp4.part', 18, '下載到一半的檔')

// 連拍截圖（P0 的主角）：同一個畫面，差別很小。
// **差異要夠小才算同一批**：換掉一整行字在比對模組裡是「不一樣」（那是刻意的，寧可少問），
// 所以這裡用游標與未讀數字這種小變化。
put('Screenshot 2026-09-18 at 10.31.02.png', shot({ badge: 1 }), 2)
put('Screenshot 2026-09-18 at 10.31.05.png', shot({ badge: 1, cursor: true }), 2)
put('Screenshot 2026-09-18 at 10.31.09.png', shot({ badge: 2 }), 2)
note('Screenshot …10.31.02／05／09.png', 2, '連拍三張：只差游標與未讀數字')
// 對照：同一個版面但內容不同，不可以被當成連拍
put('Screenshot 2026-09-18 at 14.02.44.png', shot({ lines: 9, badge: 3 }), 2)
note('Screenshot …14.02.44.png', 2, '同版面但內容不同的截圖（不可以被當成連拍）')

// 課程檔案（P2／P3／P4 的主角）：有的取好名字，有的沒有
put('作業系統_第5章_行程排程.txt', Buffer.from(
  '作業系統 第 5 章 行程排程\n\n'
  + '一、排班準則：CPU 使用率、產能、周轉時間、等待時間、回應時間。\n'
  + '二、FCFS：先到先服務，會有護送效應（convoy effect）。\n'
  + '三、SJF：最短工作優先，理論上平均等待時間最小，但需要預估執行時間。\n'
  + '四、Round Robin：時間配額 q 的選擇；q 太大退化成 FCFS，太小則切換成本高。\n'
  + '課堂練習：給定五個行程的到達時間與執行時間，畫出甘特圖並算平均等待時間。\n'), 9)
note('作業系統_第5章_行程排程.txt', 9, '取好名字的講義')
put('未命名文件 (3).txt', Buffer.from(
  '作業系統 第 6 章 死結\n\n'
  + '死結的四個必要條件：互斥、持有並等待、不可搶奪、環狀等待。\n'
  + '處理方式：預防、避免（銀行家演算法）、偵測與恢復、鴕鳥策略。\n'
  + '銀行家演算法：Available、Max、Allocation、Need 四張表，檢查安全序列是否存在。\n'
  + '小考範圍到這裡，記得練習資源配置圖判斷有沒有環。\n'), 7)
note('未命名文件 (3).txt', 7, '沒取名、但內容看得出是哪一堂課')
put('IMG_2041.txt', Buffer.from(
  '資料結構 期中考範圍\n\n'
  + '第一部分：堆疊與佇列的實作與應用（中序轉後序、BFS 佇列）。\n'
  + '第二部分：二元搜尋樹的插入、刪除與走訪；AVL 的四種旋轉。\n'
  + '第三部分：圖的表示法、DFS 與 BFS、最短路徑（Dijkstra）。\n'
  + '考試時間：下週三第 3、4 節，可帶一張 A4 手寫小抄。\n'), 5)
note('IMG_2041.txt', 5, '相機預設名，內容是考試範圍')

// ── 一份不可以被送出去的檔 ──────────────────────────────────
//
// 瀏覽器匯出的密碼清單。**檔名一點都不可疑**（沒有 password、沒有「機密」），
// 內容也沒有任何一條金鑰樣式命中 —— P2 的驗證員就是拿這個把整份帳密送去問模型的。
// 現在 core/model-guard.ts 的 looksLikeCredentialTable 會攔下來，
// `think` 那一行會寫「沒送出去 1 個」，清單上講得出為什麼。
//
// **裡面的帳號密碼都是假的**，而且故意寫成一看就知道是範例的樣子。
put('logins.csv', Buffer.from(
  'url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed\n'
  + 'https://portal.example.edu,s1234567@example.edu,DemoOnly-NotARealPassword-1,,,{demo-1},1694500000000,1694500000000\n'
  + 'https://mail.example.com,demo.user@example.com,DemoOnly-NotARealPassword-2,,,{demo-2},1694500000000,1694500000000\n'
  + 'https://shop.example.net,demo.user@example.com,DemoOnly-NotARealPassword-3,,,{demo-3},1694500000000,1694500000000\n'), 12)
note('logins.csv', 12, '瀏覽器匯出的密碼清單 —— 檔名不可疑，靠內容擋下來，不會送給模型')

// ── --live-model：現場真的問模型 ──────────────────────────────
//
// 黑克松的主題就是 agent，所以 demo 主線要跑真的模型。但**端點不可以寫死在 repo 裡**
// （那是每個人自己的選擇，而且寫死內部位址等於把它公開）。所以這裡是「抄你自己已經設好的那一份」：
// 旗標 → 環境變數 → 你真的 ~/.contextbox/config.json。抄不到就照實講，沙盒照樣做得起來。
//
// **金鑰不經過這支程式**：它只活在環境變數裡（設定檔的 keyEnv 指的那一個），跑 demo 的那個視窗要有它。
const live = flag('--live-model')
const modelCfg = { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' }
let modelFrom = ''
if (live) {
  const fromFlag = { baseUrl: opt('--base-url', ''), name: opt('--model-name', '') }
  const fromEnv = {
    baseUrl: (process.env.CONTEXTBOX_MODEL_BASEURL ?? '').trim(),
    name: (process.env.CONTEXTBOX_MODEL_NAME ?? '').trim(),
  }
  let fromFile = { baseUrl: '', name: '', keyEnv: '' }
  try {
    const raw = JSON.parse(readFileSync(join(realHome, '.contextbox', 'config.json'), 'utf8'))
    const m = raw && typeof raw === 'object' ? raw.model : null
    if (m && typeof m === 'object') {
      fromFile = {
        baseUrl: typeof m.baseUrl === 'string' ? m.baseUrl.trim() : '',
        name: typeof m.name === 'string' ? m.name.trim() : '',
        keyEnv: typeof m.keyEnv === 'string' ? m.keyEnv.trim() : '',
      }
    }
  } catch { /* 沒有、讀不到、不是 JSON —— 都當成沒設定，不要讓 demo 做不起來 */ }

  if (fromFlag.baseUrl && fromFlag.name) { Object.assign(modelCfg, fromFlag); modelFrom = '指令上給的' }
  else if (fromEnv.baseUrl && fromEnv.name) { Object.assign(modelCfg, fromEnv); modelFrom = '環境變數' }
  else if (fromFile.baseUrl && fromFile.name) {
    modelCfg.baseUrl = fromFile.baseUrl
    modelCfg.name = fromFile.name
    if (fromFile.keyEnv) modelCfg.keyEnv = fromFile.keyEnv
    modelFrom = '你自己的 ~/.contextbox/config.json'
  }
}

const cfg = {
  watch: [downloads],
  filed: join(home, 'Documents', 'Filed'),
  model: modelCfg,
  readonly: false,
  pdfPages: 3,
  maxBytes: 20971520,
  cleanup: { roots: [downloads], screenshots: false },
}
const cfgPath = join(dir, 'config.json')
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

// ── --seed-model：把示範用的「模型答案」預先塞進快取（P2） ──────
//
// **為什麼要有**：評審與 demo 的機器上沒有模型叢集，而「看懂內容」正是這一期的主角。
// 快取本來就是「同樣的內容只問一次」，所以把答案先寫進去，畫面就跑得完整個流程 ——
// 而且那幾列 `seeded=1`，面板會標「示範答案」，不會假裝是真的問過的（預想的預期行為第 10 條）。
//
// 答案是 2026-09-19 用真的模型（Qwen3-VL-8B）跑一次抄回來的，證據那一段有截短。快取鍵是**內容的 sha256**，
// 所以要先掃一次：`file_items` 有 id、`file_texts` 有讀出來的文字，算出來的鍵才跟真的問一次一樣
// （真的接上模型跑 think 時會直接命中，不會把示範答案蓋掉）。
const SEEDED = [
  ['作業系統_第5章_行程排程.txt', {
    course: '作業系統', topic: '行程排程', kind: '作業',
    suggestedName: '作業系統_行程排程',
    evidence: '作業系統 第 5 章 行程排程 一、排班準則：CPU 使用率、產能、周轉時間⋯⋯ 二、FCFS：先到先服務，會有護送效應',
    confidence: '高',
  }],
  ['未命名文件 (3).txt', {
    course: '作業系統', topic: '死結', kind: '筆記',
    suggestedName: '作業系統_死結',
    evidence: '作業系統 第 6 章 死結 死結的四個必要條件：互斥、持有並等待、不可搶奪、環狀等待',
    confidence: '高',
  }],
  ['IMG_2041.txt', {
    course: '資料結構', topic: '期中考範圍', kind: '考試',
    suggestedName: '資料結構_期中考範圍',
    evidence: '資料結構 期中考範圍 第一部分：堆疊與佇列的實作與應用（中序轉後序、BFS 佇列）',
    confidence: '高',
  }],
]

// --live-model 的時候**不預塞**：塞了 think 會直接命中快取，等於沒有真的問模型。
if (flag('--seed-model') && !live) {
  const dbPath = join(dir, 'data.db')
  const { open: openDb } = await import(new URL('../core/db.ts', import.meta.url))
  const { scanDownloads } = await import(new URL('../core/cleanup-scanner.ts', import.meta.url))
  const { putModelView, viewKey } = await import(new URL('../core/model-store.ts', import.meta.url))
  const { textPayload, PROMPT_VERSION } = await import(new URL('../core/model.ts', import.meta.url))
  const db = openDb(dbPath)
  try {
    scanDownloads({ db, roots: [downloads], quarantine: join(dir, 'quarantine'), maxBytes: cfg.maxBytes })
    const at = new Date().toISOString()
    let n = 0
    for (const [name, view] of SEEDED) {
      const path = join(downloads, name)
      const item = db.prepare('SELECT id FROM file_items WHERE path=?').get(path)
      if (!item) { console.error(`  （跳過 ${name}：掃描沒有收到它）`); continue }
      const row = db.prepare('SELECT text FROM file_texts WHERE item_id=?').get(item.id)
      const text = typeof row?.text === 'string' ? row.text : null
      if (!text) { console.error(`  （跳過 ${name}：還沒讀到它的文字）`); continue }
      putModelView(db, {
        key: viewKey(textPayload(text)), item_id: item.id, source: 'text',
        course: view.course, topic: view.topic, kind: view.kind,
        suggested_name: view.suggestedName, evidence: view.evidence, confidence: view.confidence,
        model: '示範答案（demo-setup 預先塞的）', prompt_version: PROMPT_VERSION, at, seeded: 1,
      })
      n++
    }
    console.log('')
    console.log(`已經預先塞了 ${n} 筆「模型的答案」到快取裡（畫面上會標「示範答案」）。`)
    console.log('沒有模型叢集也看得到完整流程；真的接上模型之後，這幾筆不會被蓋掉。')
  } finally { db.close() }
}

// ── 印出怎麼跑 ────────────────────────────────────────────────
//
// **貼進去就要能動**，所以 Windows 印 PowerShell 的寫法，別的印 POSIX shell 的。
// Windows 上家目錄是 %USERPROFILE%（Node 的 homedir() 讀的是它，不是 HOME），
// 沙盒要框得住就得連它一起換掉。
const isWindows = process.platform === 'win32'
const pairs = [
  ['HOME', home],
  ...(isWindows ? [['USERPROFILE', home]] : []),
  ['CONTEXTBOX_CONFIG', cfgPath],
  ['CONTEXTBOX_DB', join(dir, 'data.db')],
  ['CONTEXTBOX_QUARANTINE', join(dir, 'quarantine')],
  ['CONTEXTBOX_TOKEN_PATH', join(dir, 'token')],
  ['CONTEXTBOX_PORT', '0'],
]
const env = pairs.map(([k, v]) => isWindows ? `$env:${k} = "${v}"` : `export ${k}="${v}"`)
// Windows 上常常是在 Git Bash 裡跑（process.platform 還是 win32，但 $env: 那個寫法貼下去不會動），
// 所以兩種都印。
const bashEnv = pairs.map(([k, v]) => `export ${k}="${v.split('\\').join('/')}"`)

console.log(`demo 沙盒做好了：${dir}`)
console.log('')
console.log('Downloads 裡放了：')
for (const f of files) console.log(`  ${f.name}　—— ${f.what}（${f.days} 天沒動）`)
console.log('')
console.log(isWindows
  ? '把這幾行貼進 PowerShell（只影響這個視窗，不會動到你真的設定）：'
  : '把這幾行貼進終端機（只影響這個視窗，不會動到你真的設定）：')
console.log('')
for (const line of env) console.log('  ' + line)
console.log('')
// --live-model 的狀況要講清楚：抄到了什麼、金鑰在不在、下一步怎麼確認接得上。
// **不印端點網址** —— demo 常常是投影出去的，那是你自己的位址。
if (live) {
  console.log('')
  if (modelCfg.baseUrl && modelCfg.name) {
    console.log(`模型：現場真的問（設定抄自${modelFrom}，模型名稱 ${modelCfg.name}）。`)
    console.log('　　　沒有預塞任何答案 —— 畫面上看到的每一句都是這一次問出來的。')
    if (!String(process.env[modelCfg.keyEnv] ?? '').trim()) {
      console.log(`⚠ 這個視窗還沒有 ${modelCfg.keyEnv}。金鑰只從環境變數讀，貼上面那幾行之後記得也 export 它。`)
    }
  } else {
    console.log('⚠ --live-model 但找不到可以用的模型設定（旗標、環境變數、你自己的 ~/.contextbox/config.json 都沒有）。')
    console.log('　 沙盒照樣做好了，但「看懂內容」是關的。要嘛補設定，要嘛改用 --seed-model 跑示範答案。')
  }
}

console.log('')
if (isWindows) {
  console.log('在 Git Bash（或 MSYS／Cygwin）裡的話，改貼這幾行：')
  console.log('')
  for (const line of bashEnv) console.log('  ' + line)
  console.log('')
  console.log('（cmd.exe 則是 set X=Y，不要加引號。）')
} else {
  console.log('（Windows 上跑這支程式會直接印成 PowerShell 與 Git Bash 兩種寫法。）')
}
console.log('')
console.log('然後照著跑：')
console.log(`  cd ${REPO}`)
console.log('  node cli.mjs cleanup scan       # 掃一遍，看它找到什麼')
console.log('  node cli.mjs cleanup list       # 清單：✔ 的是預設會清的')
console.log('  node cli.mjs cleanup apply      # 搬進隔離區（七天內都放得回來）')
console.log('  node cli.mjs cleanup undo       # 反悔：全部放回原位')
console.log('  node cli.mjs pet                # 開寵物與面板（網址會印出來）')
console.log(live
  ? '  node cli.mjs think              # **真的問模型**（一次一個檔，一個檔幾秒；失敗會講是連不上還是答不對）'
  : '  node cli.mjs think              # 讓模型看一輪（沒設定模型就不做事；--seed-model 已經先塞好答案）')
console.log('  node cli.mjs rename             # 它怎麼稱呼這些檔（改得回來）')
console.log('  node cli.mjs file               # 同一堂課歸在一起（搬得回來）')
console.log('')
console.log('')
console.log('想再 demo 一次（清單會因為「放回去的不再提議」而變空）：')
console.log(`  node tools/demo-setup.mjs --dir ${dir} --reset`)
console.log('')
console.log(`玩完直接刪掉整個 ${dir} 就乾淨了。`)
