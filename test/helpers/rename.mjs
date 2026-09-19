/**
 * 改名測試用的沙盒：一個假的 Downloads、一個資料庫、掃一次、把「模型的答案」塞進快取。
 *
 * **不打真的模型**：`seed()` 寫的是 model_views 那一列（快取鍵就是內容的 sha256 ＋ 提示詞版本，
 * 跟 tools/demo-setup.mjs --seed-model 走同一條路），所以不需要叢集也能跑完整條線。
 */
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from '../../core/db.ts'
import { scanDownloads } from '../../core/cleanup-scanner.ts'
import { putModelView, viewKey } from '../../core/model-store.ts'
import { textPayload, PROMPT_VERSION } from '../../core/model.ts'

/** 一天。檔案的時間往回撥，這樣不會撞到「十分鐘內還在變動就不碰」那條規矩。 */
export const DAY = 86400_000

export function sandbox(t, files = {}, { days = 30 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-rename-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads)
  const dbPath = join(dir, 'data.db')
  const db = open(dbPath)
  t.after(() => { try { db.close() } catch { /* 已經關了 */ } rmSync(dir, { recursive: true, force: true }) })

  const put = (name, content, old = days) => {
    const path = join(downloads, name)
    writeFileSync(path, content)
    const at = new Date(Date.now() - old * DAY)
    utimesSync(path, at, at)
    return path
  }
  for (const [name, content] of Object.entries(files)) put(name, content)

  const scope = { roots: [downloads], quarantine: join(dir, 'quarantine') }
  // 「整理好的」資料夾（P4）。**故意跟 Downloads 平行、不在清理範圍裡** ——
  // 搬進去的檔就不再被掃描收成候選（預想的預期行為 3）。一開始不建，第一次歸檔才長出來。
  const filed = join(dir, 'Filed')
  const fileScope = { ...scope, filed }
  const scan = () => scanDownloads({ db, roots: [downloads], quarantine: scope.quarantine, maxBytes: 20 * 1024 * 1024 })
  scan()

  /** 把一筆「模型的答案」塞進快取。鍵是內容的 sha256，所以要先掃過（file_texts 有文字）。 */
  const seed = (name, view) => {
    const path = join(downloads, name)
    const item = db.prepare('SELECT id FROM file_items WHERE path=?').get(path)
    if (!item) throw new Error(`沙盒裡沒有 ${name}（掃描沒收到它）`)
    const row = db.prepare('SELECT text FROM file_texts WHERE item_id=?').get(item.id)
    if (typeof row?.text !== 'string') throw new Error(`沙盒還沒讀到 ${name} 的文字`)
    putModelView(db, {
      key: viewKey(textPayload(row.text)), item_id: item.id, source: 'text',
      course: view.course ?? '', topic: view.topic ?? '', kind: view.kind ?? '',
      suggested_name: view.suggestedName ?? '', evidence: view.evidence ?? '',
      confidence: view.confidence ?? '高',
      model: view.model ?? '測試用的假模型', prompt_version: PROMPT_VERSION,
      at: new Date().toISOString(), seeded: view.seeded ? 1 : 0,
    })
    return item.id
  }

  /**
   * 直接寫一列看法，**不管快取鍵對不對**（modelViewForItem 是照 item_id 找的）。
   * 用在「一次一百多個檔」這種測試上：掃描一輪最多只讀 60 個檔的內容（MAX_TEXT_BATCH），
   * 用真的快取鍵就要掃好幾輪，而那跟這裡要測的東西無關。
   */
  const seedRaw = (name, view) => {
    const path = join(downloads, name)
    const item = db.prepare('SELECT id FROM file_items WHERE path=?').get(path)
    if (!item) throw new Error(`沙盒裡沒有 ${name}（掃描沒收到它）`)
    db.prepare(`INSERT INTO model_views
      (key,item_id,source,course,topic,kind,suggested_name,evidence,confidence,model,prompt_version,at,seeded)
      VALUES (?,?,'text',?,?,?,?,?,?,?,'v1',?,?)`).run(
      'seed-' + item.id, item.id, view.course ?? '', view.topic ?? '', view.kind ?? '',
      view.suggestedName ?? '', view.evidence ?? '證據', view.confidence ?? '高',
      view.model ?? '測試用的假模型', new Date().toISOString(), view.seeded ? 1 : 0)
    return item.id
  }

  const idOf = name => db.prepare('SELECT id FROM file_items WHERE path=?').get(join(downloads, name))?.id ?? null
  const rowOf = name => db.prepare('SELECT * FROM file_items WHERE path=?').get(join(downloads, name)) ?? null

  /** filed 底下有哪些東西（相對路徑，排序過）。歸檔的測試拿它比「真的搬到哪裡」。 */
  const filedTree = () => {
    const out = []
    const walk = (at, prefix) => {
      let entries = []
      try { entries = readdirSync(at, { withFileTypes: true }) } catch { return }
      for (const e of [...entries].sort((a, b) => a.name < b.name ? -1 : 1)) {
        const rel = prefix ? prefix + '/' + e.name : e.name
        out.push(e.isDirectory() ? rel + '/' : rel)
        if (e.isDirectory()) walk(join(at, e.name), rel)
      }
    }
    walk(filed, '')
    return out
  }

  return {
    db, dbPath, dir, downloads, filed, scope, fileScope, scan, seed, seedRaw, put, idOf, rowOf, filedTree,
  }
}

/** 一段看得出是哪一堂課的講義內容（要超過 30 個字，模型那條線才收）。 */
export const OS_DEADLOCK = '作業系統 第 6 章 死結\n\n'
  + '死結的四個必要條件：互斥、持有並等待、不可搶奪、環狀等待。\n'
  + '處理方式：預防、避免（銀行家演算法）、偵測與恢復、鴕鳥策略。\n'
  + '小考範圍到這裡，記得練習資源配置圖判斷有沒有環。\n'

export const DS_MIDTERM = '資料結構 期中考範圍\n\n'
  + '第一部分：堆疊與佇列的實作與應用（中序轉後序、BFS 佇列）。\n'
  + '第二部分：二元搜尋樹的插入、刪除與走訪；AVL 的四種旋轉。\n'
  + '考試時間：下週三第 3、4 節，可帶一張 A4 手寫小抄。\n'

export const OS_SCHEDULING = '作業系統 第 5 章 行程排程\n\n'
  + '一、排班準則：CPU 使用率、產能、周轉時間、等待時間、回應時間。\n'
  + '二、FCFS：先到先服務，會有護送效應（convoy effect）。\n'
  + '三、Round Robin：時間配額 q 的選擇；q 太大退化成 FCFS。\n'
