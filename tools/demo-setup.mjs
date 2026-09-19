#!/usr/bin/env node
/**
 * 做一個可以完整跑一次的 demo 沙盒 —— **完全不碰你真的 Downloads 與 ~/.contextbox**。
 *
 *   node tools/demo-setup.mjs                  做在 ./demo-sandbox
 *   node tools/demo-setup.mjs --dir <path>     做在別的地方
 *   node tools/demo-setup.mjs --force          資料夾已經有東西也照做（只補檔，不刪）
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
import { mkdirSync, writeFileSync, utimesSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
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
put('作業系統_第5章_行程排程.txt', Buffer.from('作業系統 第 5 章 行程排程\n\nFCFS、SJF、Round Robin 的比較與計算題。\n'), 9)
note('作業系統_第5章_行程排程.txt', 9, '取好名字的講義')
put('未命名文件 (3).txt', Buffer.from('作業系統 第 6 章 死結\n\n四個必要條件、銀行家演算法。\n'), 7)
note('未命名文件 (3).txt', 7, '沒取名、但內容看得出是哪一堂課')
put('IMG_2041.txt', Buffer.from('資料結構 期中考範圍\n\n堆疊、佇列、樹、圖的走訪。\n'), 5)
note('IMG_2041.txt', 5, '相機預設名，內容是考試範圍')

const cfg = {
  watch: [downloads],
  filed: join(home, 'Documents', 'Filed'),
  model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
  readonly: false,
  pdfPages: 3,
  maxBytes: 20971520,
  cleanup: { roots: [downloads], screenshots: false },
}
const cfgPath = join(dir, 'config.json')
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

// ── 印出怎麼跑 ────────────────────────────────────────────────
const env = [
  `export HOME="${home}"`,
  `export CONTEXTBOX_CONFIG="${cfgPath}"`,
  `export CONTEXTBOX_DB="${join(dir, 'data.db')}"`,
  `export CONTEXTBOX_QUARANTINE="${join(dir, 'quarantine')}"`,
  `export CONTEXTBOX_TOKEN_PATH="${join(dir, 'token')}"`,
  'export CONTEXTBOX_PORT=0',
]

console.log(`demo 沙盒做好了：${dir}`)
console.log('')
console.log('Downloads 裡放了：')
for (const f of files) console.log(`  ${f.name}　—— ${f.what}（${f.days} 天沒動）`)
console.log('')
console.log('把這幾行貼進終端機（只影響這個視窗，不會動到你真的設定）：')
console.log('')
for (const line of env) console.log('  ' + line)
console.log('')
console.log('然後照著跑：')
console.log(`  cd ${REPO}`)
console.log('  node cli.mjs cleanup scan       # 掃一遍，看它找到什麼')
console.log('  node cli.mjs cleanup list       # 清單：✔ 的是預設會清的')
console.log('  node cli.mjs cleanup apply      # 搬進隔離區（七天內都放得回來）')
console.log('  node cli.mjs cleanup undo       # 反悔：全部放回原位')
console.log('  node cli.mjs pet                # 開寵物與面板（網址會印出來）')
console.log('')
console.log('')
console.log('想再 demo 一次（清單會因為「放回去的不再提議」而變空）：')
console.log(`  node tools/demo-setup.mjs --dir ${dir} --reset`)
console.log('')
console.log(`玩完直接刪掉整個 ${dir} 就乾淨了。`)
