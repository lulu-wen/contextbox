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
import { join, resolve, dirname, sep } from 'node:path'
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

/**
 * 這個資料夾是**我們自己建的沙盒**的記號。
 *
 * 稽核 2026-09-20 抓到：以前 `--reset` 只看「有沒有 config.json」，而**真的安裝**
 * （`~/.contextbox`）剛好也有一個 config.json —— `--dir ~/.contextbox --reset`
 * 會遞迴刪掉整個 quarantine，那裡面是使用者的檔。記號檔只有這支程式會寫，不會誤判。
 */
const MARKER = '.contextbox-demo-sandbox'
const isOurSandbox = existsSync(join(dir, MARKER))

/** child 在 parent 底下（或就是它）。用 sep 比，不要用 '/'（Windows 會漏）。 */
const isUnder = (parent, child) => child === parent || child.startsWith(parent + sep)

// ── 守門：不可以做在真的家目錄或真的狀態資料夾裡 ─────────────────
//
// **dir 也要解 symlink**（稽核）：只 resolve 的話，一個指到家目錄的捷徑就整個繞過去了。
// 已經是我們的沙盒就跳過這一關 —— 貼過沙盒環境變數的視窗裡 HOME 就是沙盒，
// 不跳過的話 `--reset` 會誤報「這是你的家目錄」（稽核，那條指令是我們自己印給使用者的）。
const realHome = realpathSync(process.env.HOME ?? process.env.USERPROFILE ?? '/')
const realDir = existsSync(dir) ? realpathSync(dir) : resolve(dir)
const stateDir = join(realHome, '.contextbox')
if (!isOurSandbox) {
  if (realDir === realHome || isUnder(realDir, realHome)) {
    console.error(`✘ ${dir} is your home directory, or sits above it. Build the demo sandbox somewhere else.`)
    process.exit(1)
  }
  if (isUnder(stateDir, realDir)) {
    console.error(`✘ ${dir} is inside your real ${stateDir}, which holds quarantine (your files) and the key. Not touching it.`)
    process.exit(1)
  }
}
// ── --reset：把「已經清過」的紀錄清掉，可以再 demo 一次 ──────────
// 只刪這個沙盒裡的資料庫、隔離區與 token，**不碰 Downloads 裡的檔**。
// 為什麼要有：放回原位的檔不會再被自動提議（那是對的行為），所以 demo 跑完一輪，
// 清單就空了。重來一次最乾淨的方式是丟掉這個沙盒的紀錄。
if (reset) {
  if (!isOurSandbox) {
    console.error(`✘ ${dir} is not a demo sandbox this script built (no ${MARKER}), so its records are left alone.`)
    console.error('  If you really want to start over, check that folder yourself, delete it by hand, and build a new sandbox.')
    process.exit(1)
  }
  for (const name of ['data.db', 'data.db-wal', 'data.db-shm', 'token']) {
    const p = join(dir, name)
    if (existsSync(p)) rmSync(p)
  }
  const q = join(dir, 'quarantine')
  if (existsSync(q)) rmSync(q, { recursive: true })
  console.log(`Cleared the records in ${dir}. The files in Downloads were not touched. You can run scan again.`)
  if (!flag('--force')) process.exit(0)
}

if (existsSync(dir) && readdirSync(dir).length && !flag('--force')) {
  console.error(`✘ ${dir} already has things in it. Pick another folder, or add --force, which only adds files and deletes nothing.`)
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
put('Node-v24-installer.exe', Buffer.alloc(9_400_000, 7), 45);     note('Node-v24-installer.exe', 45, 'an installer nobody has touched in 45 days')
put('data-structures-lab3.zip', Buffer.from('lab3 contents '.repeat(2000)), 62); note('data-structures-lab3.zip', 62, 'an archive nobody has touched in two months')
put('data-structures-lab3 (1).zip', Buffer.from('lab3 contents '.repeat(2000)), 60); note('data-structures-lab3 (1).zip', 60, 'the same download again, byte for byte')
put('meeting-notes-draft.tmp', Buffer.from('scratch'), 30);         note('meeting-notes-draft.tmp', 30, 'a temporary file')
put('empty.txt', Buffer.alloc(0), 21);                              note('empty.txt', 21, 'an empty file')
put('half-downloaded-video.mp4.part', Buffer.alloc(3_200_000, 3), 18); note('half-downloaded-video.mp4.part', 18, 'a download that never finished')

// 連拍截圖（P0 的主角）：同一個畫面，差別很小。
// **差異要夠小才算同一批**：換掉一整行字在比對模組裡是「不一樣」（那是刻意的，寧可少問），
// 所以這裡用游標與未讀數字這種小變化。
put('Screenshot 2026-09-18 at 10.31.02.png', shot({ badge: 1 }), 2)
put('Screenshot 2026-09-18 at 10.31.05.png', shot({ badge: 1, cursor: true }), 2)
put('Screenshot 2026-09-18 at 10.31.09.png', shot({ badge: 2 }), 2)
note('Screenshot …10.31.02/05/09.png', 2, 'a burst of three: only the cursor and the unread badge differ')
// 對照：同一個版面但內容不同，不可以被當成連拍
put('Screenshot 2026-09-18 at 14.02.44.png', shot({ lines: 9, badge: 3 }), 2)
note('Screenshot …14.02.44.png', 2, 'same layout, different content — must not count as a burst')

// 課程檔案（P2／P3／P4 的主角）：有的取好名字，有的沒有
put('operating-systems-ch5-scheduling.txt', Buffer.from(
  'Operating Systems, Chapter 5: Process Scheduling\n\n'
  + '1. Scheduling criteria: CPU utilisation, throughput, turnaround time, waiting time, response time.\n'
  + '2. FCFS: first come, first served, which produces the convoy effect.\n'
  + '3. SJF: shortest job first. In theory the smallest average waiting time, but it needs an estimate of the run time.\n'
  + '4. Round robin: choosing the quantum q. Too large and it degrades to FCFS; too small and switching costs dominate.\n'
  + 'Exercise: given five processes with arrival and burst times, draw the Gantt chart and compute the average waiting time.\n'), 9)
note('operating-systems-ch5-scheduling.txt', 9, 'a lecture handout that already has a good name')
put('Untitled document (3).txt', Buffer.from(
  'Operating Systems, Chapter 6: Deadlock\n\n'
  + 'The four necessary conditions for deadlock: mutual exclusion, hold and wait, no preemption, circular wait.\n'
  + 'Ways to handle it: prevention, avoidance (the banker\'s algorithm), detection and recovery, and the ostrich approach.\n'
  + 'The banker\'s algorithm: the Available, Max, Allocation and Need tables, checked for a safe sequence.\n'
  + 'The quiz covers up to here. Practise spotting cycles in a resource allocation graph.\n'), 7)
note('Untitled document (3).txt', 7, 'no real name, but the contents say which course it is')
put('IMG_2041.txt', Buffer.from(
  'Data Structures: what the midterm covers\n\n'
  + 'Part 1: implementing and using stacks and queues (infix to postfix, the BFS queue).\n'
  + 'Part 2: insertion, deletion and traversal in binary search trees; the four AVL rotations.\n'
  + 'Part 3: graph representations, DFS and BFS, shortest paths (Dijkstra).\n'
  + 'When: next Wednesday, periods 3 and 4. One handwritten A4 sheet allowed.\n'), 5)
note('IMG_2041.txt', 5, 'a camera default name; the contents are an exam syllabus')

// ── 一份不可以被送出去的檔 ──────────────────────────────────
//
// 瀏覽器匯出的密碼清單。**檔名一點都不可疑**（沒有 password、沒有「機密」），
// 內容也沒有任何一條金鑰樣式命中 —— P2 的驗證員就是拿這個把整份帳密送去問模型的。
// 現在 core/model-guard.ts 的 looksLikeCredentialTable 會攔下來，
// `think` 那一行會寫「沒送出去 1 個」，清單上講得出為什麼。
//
// **裡面的帳號密碼都是假的**，而且故意寫成一看就知道是範例的樣子。
put('2026-09 export.csv', Buffer.from(
  'url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed\n'
  + 'https://portal.example.edu,s1234567@example.edu,DemoOnly-NotARealPassword-1,,,{demo-1},1694500000000,1694500000000\n'
  + 'https://mail.example.com,demo.user@example.com,DemoOnly-NotARealPassword-2,,,{demo-2},1694500000000,1694500000000\n'
  + 'https://shop.example.net,demo.user@example.com,DemoOnly-NotARealPassword-3,,,{demo-3},1694500000000,1694500000000\n'), 12)
note('2026-09 export.csv', 12, 'a password export from a browser — the name looks innocent; the contents are what stops it reaching the model')

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

  if (fromFlag.baseUrl && fromFlag.name) { Object.assign(modelCfg, fromFlag); modelFrom = 'the command line' }
  else if (fromEnv.baseUrl && fromEnv.name) { Object.assign(modelCfg, fromEnv); modelFrom = 'the environment' }
  else if (fromFile.baseUrl && fromFile.name) {
    modelCfg.baseUrl = fromFile.baseUrl
    modelCfg.name = fromFile.name
    if (fromFile.keyEnv) modelCfg.keyEnv = fromFile.keyEnv
    modelFrom = 'your own ~/.contextbox/config.json'
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
// 記號：`--reset` 只認這個。真的安裝也有 config.json，光看它會把使用者的隔離區刪掉。
writeFileSync(join(dir, MARKER),
  'This folder is a demo sandbox built by tools/demo-setup.mjs. Deleting the whole thing is safe.\n'
  + 'Generated by tools/demo-setup.mjs — safe to delete the whole folder.\n')

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
  ['operating-systems-ch5-scheduling.txt', {
    course: 'Operating Systems', topic: 'Process Scheduling', kind: 'Lecture',
    suggestedName: 'Operating Systems_Process Scheduling',
    evidence: 'Operating Systems, Chapter 5: Process Scheduling — 1. Scheduling criteria: CPU utilisation, throughput, turnaround time… 2. FCFS: first come, first served, which produces the convoy effect',
    confidence: 'high',
  }],
  ['Untitled document (3).txt', {
    course: 'Operating Systems', topic: 'Deadlock', kind: 'Notes',
    suggestedName: 'Operating Systems_Deadlock',
    evidence: 'Operating Systems, Chapter 6: Deadlock — the four necessary conditions: mutual exclusion, hold and wait, no preemption, circular wait',
    confidence: 'high',
  }],
  ['IMG_2041.txt', {
    course: 'Data Structures', topic: 'Midterm scope', kind: 'Exam',
    suggestedName: 'Data Structures_Midterm scope',
    evidence: 'Data Structures: what the midterm covers — Part 1: implementing and using stacks and queues (infix to postfix, the BFS queue)',
    confidence: 'high',
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
      if (!item) { console.error(`  (skipping ${name}: the scan did not pick it up)`); continue }
      const row = db.prepare('SELECT text FROM file_texts WHERE item_id=?').get(item.id)
      const text = typeof row?.text === 'string' ? row.text : null
      if (!text) { console.error(`  (skipping ${name}: its text has not been read yet)`); continue }
      putModelView(db, {
        key: viewKey(textPayload(text)), item_id: item.id, source: 'text',
        course: view.course, topic: view.topic, kind: view.kind,
        suggested_name: view.suggestedName, evidence: view.evidence, confidence: view.confidence,
        model: 'demo answer (seeded by demo-setup)', prompt_version: PROMPT_VERSION, at, seeded: 1,
      })
      n++
    }
    console.log('')
    console.log(`Seeded ${n} model answers into the cache. The screen marks each one “[demo answer]”.`)
    console.log('You can walk the whole flow without a model cluster, and a real model will not overwrite these.')
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

console.log(`Demo sandbox ready: ${dir}`)
console.log('')
console.log('Downloads now holds:')
for (const f of files) console.log(`  ${f.name}  — ${f.what} (untouched for ${f.days} days)`)
console.log('')
console.log(isWindows
  ? 'Paste these into PowerShell. They only affect this window and never touch your real settings:'
  : 'Paste these into your terminal. They only affect this window and never touch your real settings:')
console.log('')
for (const line of env) console.log('  ' + line)
console.log('')
// --live-model 的狀況要講清楚：抄到了什麼、金鑰在不在、下一步怎麼確認接得上。
// **不印端點網址** —— demo 常常是投影出去的，那是你自己的位址。
if (live) {
  console.log('')
  if (modelCfg.baseUrl && modelCfg.name) {
    console.log(`Model: asking for real (settings copied from ${modelFrom}, model ${modelCfg.name}).`)
    console.log('       Nothing is seeded — every line on screen came from this run.')
    if (!String(process.env[modelCfg.keyEnv] ?? '').trim()) {
      console.log(`⚠ This window has no ${modelCfg.keyEnv} yet. The key is only ever read from the environment, so export it too after pasting the lines above.`)
    }
  } else {
    console.log('⚠ --live-model, but no usable model settings were found — not in the flags, the environment, or your own ~/.contextbox/config.json.')
    console.log('  The sandbox is ready anyway, but reading is off. Either add the settings, or use --seed-model for demo answers.')
  }
}

console.log('')
if (isWindows) {
  console.log('In Git Bash (or MSYS/Cygwin), paste these instead:')
  console.log('')
  for (const line of bashEnv) console.log('  ' + line)
  console.log('')
  console.log('(In cmd.exe it is set X=Y, without quotes.)')
} else {
  console.log('(Run this on Windows and it prints both the PowerShell and the Git Bash form.)')
}
console.log('')
console.log('Then walk through these:')
console.log(`  cd ${REPO}`)
console.log('  node cli.mjs cleanup scan       # look around and see what it finds')
console.log('  node cli.mjs cleanup list       # the list; ✔ means it gets cleaned by default')
console.log('  node cli.mjs cleanup apply      # move them to quarantine (undoable for seven days)')
console.log('  node cli.mjs cleanup undo       # changed your mind: put everything back')
console.log('  node cli.mjs pet                # open the pet and the panel (it prints the address)')
console.log(live
  ? '  node cli.mjs think              # **really ask the model** (one file at a time, a few seconds each; failures say whether it was the connection or the answer)'
  : '  node cli.mjs think              # let the model read a round (does nothing without a model; --seed-model already seeded the answers)')
console.log('  node cli.mjs rename             # what it would call these files (undoable)')
console.log('  node cli.mjs file               # put one course together (undoable)')
console.log('')
console.log('')
console.log('To demo again — the list empties out because anything put back is not suggested again:')
console.log(`  node tools/demo-setup.mjs --dir ${dir} --reset`)
console.log('')
console.log(`When you are done, delete the whole of ${dir} and nothing is left behind.`)
