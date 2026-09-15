#!/usr/bin/env node
/**
 * ContextBox 命令列 —— 檔案與截圖管線的入口。
 *
 *   node cli.mjs doctor              這台機器現在什麼狀況
 *   node cli.mjs propose <檔案>...    手動收一個檔案（右鍵選單走的就是這條）
 *   node cli.mjs watch               常駐監看設定裡的資料夾
 *   node cli.mjs list [狀態]          看收件匣
 *   node cli.mjs search <詞>          全文搜尋（要先有理解，P1 之後才有東西）
 *
 * 三個作業系統的右鍵選單最後都是打 `propose`，所以核心不用知道自己在哪個 OS 上跑。
 * **離開碼是那些選單的契約**：只有真的被拒絕才回非零。
 */
import { load, modelReady, modelKey, CONFIG_PATH } from './core/config.ts'
import { admit } from './core/guard.ts'
import { createWatcher } from './core/watcher.ts'
import { open, DEFAULT_DB } from './core/db.ts'
import { Items } from './core/items.ts'
import { listCandidates, healthSnapshot, META } from './core/cleanup-routes.ts'
import { applyPlan, undoPlan, listQuarantine } from './core/cleanup-exec.ts'
import { createPlan } from './core/cleanup-plans.ts'
import { prepareEmptyQuarantine, emptyQuarantine } from './core/cleanup-quarantine.ts'
import { CleanupError, listJournal } from './core/cleanup-journal.ts'
import { scanDownloads } from './core/cleanup-scanner.ts'
import { existsSync } from 'node:fs'
import { basename, resolve, join } from 'node:path'
import { homedir } from 'node:os'

const QUARANTINE = process.env.CONTEXTBOX_QUARANTINE ?? join(homedir(), '.contextbox', 'quarantine')

/**
 * 離開碼是契約（docs/cli.md）：
 *   0 成功，**包含「沒有東西要清」** —— 那代表 Downloads 很乾淨，不是失敗
 *   1 使用者輸入錯
 *   2 後端錯
 *   3 部分失敗
 */
const EXIT = { ok: 0, badInput: 1, backend: 2, partial: 3 }

const mb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
  : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'

/** 清單上那一列長什麼樣。每一列都要有原因 —— 沒有原因就不該出現。 */
function printCandidate(c) {
  const box = c.defaultChecked ? '✔' : '☐'
  const where = c.subdir ? `${c.folder}/${c.subdir}` : c.folder
  say(`  [${c.itemId.slice(0, 4)}] ${box} ${c.name}`)
  say(`         ${mb(c.bytes).padStart(8)}  ${c.kind}  ${where}`)
  for (const r of c.reasons) say(`         · ${r.reason}（${r.evidence}）`)
  if (c.vetoed) say(`         ⚠ ${c.vetoed}`)
}

const [, , cmd, ...args] = process.argv

const { config, problems, path: cfgPath, created } = load()

let db
try { db = open() }
catch (e) {
  // 右鍵選單一次選 N 個檔就是 N 個行程同時開資料庫。
  // 讓它印一句人話，不要印一坨 Node 堆疊。
  console.error(`打不開資料庫 ${DEFAULT_DB}：${e.message}`)
  console.error('如果剛剛同時開了很多個，等一下再試一次就好。')
  // 打不開資料庫是**後端錯（2）**，不是輸入錯（1）。
  // 回 1 等於跟右鍵選單說「使用者打錯了」，而使用者什麼都沒打錯 ——
  // 呼叫端據此決定要不要重試，分錯就不會重試。
  process.exit(EXIT.backend)
}
const items = new Items(db)

const admitOpts = {
  roots: config.watch,
  maxBytes: config.maxBytes,
  exclude: [config.filed],
}

const say = (...a) => console.log(...a)
const warn = (...a) => console.warn(...a)

const showProblems = () => { for (const p of problems) warn('⚠ ' + p) }

/** 還要等幾天，無條件進位 —— 「還要等 0 天」是錯的訊息。 */
const days = (at) => Math.max(1, Math.ceil((at - Date.now()) / 86400_000))

/**
 * CleanupError → 離開碼。
 *
 * **判準：2 ＝ 這個動作根本沒執行；3 ＝ 執行了但沒有全部成功。**
 * 呼叫端據此決定要不要重試。
 */
function exitFor(e) {
  if (!(e instanceof CleanupError)) return EXIT.backend
  // 使用者打錯了 plan id —— 這是唯一 NOT_FOUND 真的是輸入錯的地方
  if (e.code === 'NOT_FOUND' || e.code === 'BAD_BODY') return EXIT.badInput
  // 另一個行程正在跑。動作沒執行，而且重試會成功
  return EXIT.backend
}

/** B 的錯誤訊息本來就是寫好的人話而且不含路徑，直接用；其他的換罐頭。 */
const cliProblem = (e) => e instanceof CleanupError ? e.message : ('出錯了：' + (e?.message ?? e))

// ── meta：給健康檢查用的心跳 ──────────────────────────────────
const setMeta = (k, v) =>
  db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, String(v))
const getMeta = k => (db.prepare(`SELECT v FROM meta WHERE k=?`).get(k) ?? {}).v ?? null

/** 「3 分鐘前」這種人看得懂的講法 */
function ago(iso) {
  if (!iso) return null
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 90) return `${Math.round(s)} 秒前`
  if (s < 5400) return `${Math.round(s / 60)} 分鐘前`
  if (s < 172800) return `${Math.round(s / 3600)} 小時前`
  return `${Math.round(s / 86400)} 天前`
}

/**
 * 打一次 /models 看模型在不在，順便確認金鑰對不對。
 * 只回一句給人看的話 —— doctor 的價值就在「能不能用」講得斬釘截鐵。
 */
async function probeModel(cfg, key) {
  const url = `${cfg.model.baseUrl}/models`
  try {
    const res = await fetch(url, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 401 || res.status === 403) return `✗ 連得到，但金鑰不對（${res.status}）`
    if (!res.ok) return `✗ ${url} 回了 ${res.status}`
    const data = await res.json().catch(() => ({}))
    const names = (data.data ?? []).map(m => m.id)
    if (!names.length) return '✓ 連得到，但這台沒有列出任何模型'
    return names.includes(cfg.model.name)
      ? `✓ 連得到，${cfg.model.name} 在線上（共 ${names.length} 個模型）`
      : `✗ 連得到，但沒有叫 ${cfg.model.name} 的模型。有的是：${names.slice(0, 6).join('、')}`
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '8 秒沒回應' : (e?.message ?? e)
    return `✗ 連不上 ${url}（${why}）`
  }
}

/** 收一個檔案。回 'new'｜'known'｜'rejected' */
function intake(path, { quiet = false } = {}) {
  const v = admit(resolve(path), admitOpts)
  if (!v.ok) {
    if (!quiet) warn(`✗ ${basename(path)}：${v.why}`)
    return 'rejected'
  }
  let added
  try { added = items.add(v) }
  catch (e) { if (!quiet) warn(`✗ ${basename(path)}：${e.message}`); return 'rejected' }

  if (!quiet) {
    const sameContent = items.bySha(added.item.sha256, added.item.id)
    say(`✓ ${basename(v.real)}  ${v.kind}  ${(v.bytes / 1024).toFixed(0)}KB`
      + (added.fresh ? '' : '（已經收過了，沒有變）')
      + (sameContent.length ? `　※ 另外有 ${sameContent.length} 份一樣的內容，理解可以共用` : ''))
  }
  return added.fresh ? 'new' : 'known'
}

// ── 搜尋 ────────────────────────────────────────────────────
//
// 使用者打的字**不可以**原封不動丟進 MATCH。FTS5 會把它當查詢語法解析，
// 所以 `發票-2026`、`2026/09`、`a"b`、`*` 這些都會讓 CLI 帶著堆疊崩掉——
// 而「搜一個檔名」正是這個工具最自然的用法。
const ftsQuery = q =>
  q.split(/\s+/).filter(Boolean).map(w => '"' + w.replace(/"/g, '""') + '"').join(' ')

switch (cmd) {
  case 'doctor': {
    say('ContextBox 檢查')
    say('')
    say(`設定檔    ${cfgPath}${created ? '（還沒有，剛剛幫你建了一份）' : ''}`)
    say(`資料庫    ${DEFAULT_DB}`)
    say(`唯讀模式  ${config.readonly
      ? '開著（不過搬檔器還沒實作，目前本來就不會動到任何檔案）'
      : '關著'}`)
    say('')
    say('監看資料夾')
    for (const r of config.watch) say(`  ${existsSync(r) ? '✓' : '✗ 不存在'}  ${r}`)
    say(`歸檔到    ${config.filed}${existsSync(config.filed) ? '' : '（同意第一份提案時才會建）'}`)
    say('')

    // 監看到底有沒有在跑？設定正確不代表有人在看。
    const beat = getMeta(META.heartbeat)
    const beatPid = Number(getMeta(META.pid))
    const beatAgo = ago(beat)
    // 心跳只證明「它上次寫的時候還活著」。被 kill -9 掉的話，
    // 心跳會停在那裡，而 doctor 會繼續說「還活著」說滿五分鐘 ——
    // 這個心跳本來就是為了「靜默失敗是最大的敵人」加的，不能自己說謊。
    const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
    if (!beat) say('監看      ✗ 從來沒跑過。要它一直看著就開一個終端機跑 `node cli.mjs watch`。')
    else if (!Number.isInteger(beatPid) || !alive(beatPid)) {
      say(`監看      ✗ 那個行程（pid ${beatPid || '?'}）已經不在了，最後一次心跳是 ${beatAgo}。`)
    } else if ((Date.now() - Date.parse(beat)) > 5 * 60_000) {
      say(`監看      ✗ 行程還在，但最後一次心跳是 ${beatAgo}，看起來卡住了。`)
    } else say(`監看      ✓ ${beatAgo}還活著（pid ${beatPid}）`)

    const h = healthSnapshot(db, { roots: config.watch, quarantine: QUARANTINE })
    say(`隔離區    ${QUARANTINE}`)
    say(`          ${h.quarantine.items} 個檔案，${mb(h.quarantine.bytes)}`
      + (h.quarantine.items
        // canEmptyNow 的意思是「按下去**會有東西**被刪掉」，不是「整區都能清」。
        // 講成「現在可以清空」的話，使用者按完發現還有東西，會以為壞了。
        ? (h.quarantine.canEmptyNow ? '，其中有滿七天可以清空的' : '，最舊的還不到七天')
        : '')
      + (h.quarantine.orphans ? `\n          另有 ${h.quarantine.orphans} 個來路不明的檔，清空不會動到它們` : '')
      + (h.quarantine.truncated ? '\n          ⚠ 隔離區沒讀完，數字可能不準' : ''))
    say(`待清候選  ${h.pendingCandidates} 個`
      + (h.needsHumanCount ? `，另外 ${h.needsHumanCount} 個讀不到` : ''))
    say('')

    const last = items.lastSeen()
    say(`最後收到  ${last ? `${ago(last)}（${last}）` : '還沒收過任何東西'}`)
    say('')

    if (!modelReady(config)) {
      say('模型      ✗ 還沒設定。請在設定檔填 model.baseUrl 與 model.name。')
    } else {
      say(`模型      ${config.model.name} @ ${config.model.baseUrl}`)
      const key = modelKey(config)
      say(`金鑰      ${key ? '✓ 從 ' + config.model.keyEnv + ' 讀到了' : '✗ 環境變數 ' + config.model.keyEnv + ' 是空的'}`)
      // 真的打一次。設定檔填對不代表連得到——靜默失敗是這種工具最大的敵人。
      say(`連線      ${await probeModel(config, key)}`)
    }
    say('')
    const c = items.counts()
    const total = Object.values(c).reduce((a, b) => a + b, 0)
    say(`收件匣    共 ${total} 筆` + (total ? '：' + Object.entries(c).map(([k, v]) => `${k} ${v}`).join('、') : ''))
    showProblems()
    break
  }

  case 'propose': {
    showProblems()
    if (!args.length) { warn('要給檔案路徑。例：node cli.mjs propose ~/Downloads/a.pdf'); process.exit(1) }
    const r = { new: 0, known: 0, rejected: 0 }
    for (const a of args) r[intake(a)]++
    // 「已經收過了」是成功。右鍵選單靠離開碼判斷成敗，
    // 回非零會在 Windows／Nautilus 上跳一個錯誤視窗給使用者看。
    if (r.new + r.known === 0) { process.exitCode = 1; break }
    say(`\n收了 ${r.new} 個新檔案`
      + (r.known ? `，${r.known} 個之前就收過了` : '')
      + (r.rejected ? `，${r.rejected} 個被擋下` : '') + '。')
    if (!modelReady(config)) {
      say('（模型還沒設定，所以只有記下來，還沒有人去看懂它。設定好之後跑 `node cli.mjs doctor` 確認。）')
    }
    break
  }

  case 'watch': {
    showProblems()
    if (!config.watch.length) { warn('設定裡沒有任何監看資料夾。'); process.exit(1) }

    const beat = () => { try { setMeta(META.heartbeat, new Date().toISOString()); setMeta(META.pid, process.pid) } catch { /* 資料庫忙就下次再寫 */ } }

    const w = createWatcher({
      roots: config.watch,
      maxBytes: config.maxBytes,
      exclude: [config.filed],
      onSeed: count => {
        say(`開機掃描：記住了 ${count} 個既有檔案，全部當成已經看過。`)
        say('之後才落地、或是內容有變的檔案才會進收件匣。要處理舊檔就用 propose 手動指定。')
      },
      onFile: v => {
        // 這裡丟例外不會讓檔案消失 —— watcher 會重試，重試太多次才放棄
        const { fresh } = items.add(v)
        say(`＋ ${new Date().toLocaleTimeString('zh-TW')}  ${basename(v.real)}（${v.kind}）`
          + (fresh ? '' : '（內容沒變）'))
      },
      onProblem: m => warn('⚠ ' + m),
    })

    beat()
    w.start()
    const heartbeat = setInterval(beat, 30_000)
    say(`正在看：\n  ${config.watch.join('\n  ')}`)
    say('按 Ctrl+C 停止。')
    if (!modelReady(config)) say('⚠ 模型還沒設定，收到的檔案只會被記下來，不會被看懂。')

    const bye = () => { clearInterval(heartbeat); w.stop(); say('\n停了。'); process.exit(0) }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
    setInterval(() => {}, 1 << 30)          // 讓行程活著
    break
  }

  case 'pet': {
    showProblems()
    const { start } = await import('./core/server.ts')
    const { createCleanupWatcher } = await import('./core/cleanup-watcher.ts')
    // **把 roots 與 quarantine 傳進去。** 不傳的話 server 自己去讀設定檔，
    // 而 pet 印出來的隔離區跟它剛啟動的那個 server 服務的不是同一個目錄。
    const { ready } = start({ roots: config.watch, quarantine: QUARANTINE })
    let port
    try { port = await ready }
    catch (e) {
      if (e?.code === 'EADDRINUSE') {
        say('已經有一個 ContextBox 在跑了。打開 http://127.0.0.1:7391/ 就好。')
        break
      }
      warn('起不來：' + (e?.message ?? e))
      process.exitCode = EXIT.backend
      break
    }

    // 心跳要有人寫，不然 /health 的 watcher 永遠說「從來沒跑過」，
    // 而寵物的 watching 狀態永遠進不去。
    const beat = () => { try { setMeta(META.heartbeat, new Date().toISOString()); setMeta(META.pid, process.pid) } catch { /* 忙就下次 */ } }
    beat()
    const heartbeat = setInterval(beat, 30_000)
    const w = createCleanupWatcher({
      db, roots: config.watch, maxBytes: config.maxBytes,
      onProblem: m => warn('⚠ ' + m),
    })
    w.start()

    say(`ContextBox 在 http://127.0.0.1:${port}`)
    say(`寵物與清理面板：http://127.0.0.1:${port}/　（鑰匙已經幫你帶好了）`)
    say('')
    say(`正在看：${config.watch.map(basename).join('、')}`)
    say(`隔離區：${QUARANTINE}`)
    say('按 Ctrl+C 停止。')
    const bye = () => { clearInterval(heartbeat); w.stop(); say('\n停了。'); process.exit(0) }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
    break
  }

  case 'cleanup': {
    showProblems()
    const sub = args[0]

    if (sub === 'scan') {
      let r
      try {
        r = scanDownloads({ db, roots: config.watch, maxBytes: config.maxBytes })
      } catch (e) {
        warn('掃描出錯：' + e.message)
        process.exitCode = EXIT.backend
        break
      }
      // scanner 回的 candidates 是**規則列數**，但 list 講的是**檔案數** ——
      // 這整支檔案存在的理由就是消掉這個差別，不可以在自己的 CLI 又端出來。
      const files = listCandidates(db, { roots: config.watch }).totalAvailable
      say(`掃了 ${r.scanned} 個檔案，${files} 個可以清。`)
      if (r.skipped) say(`${r.skipped} 個還在變動，這次跳過。`)
      // 讀不到的檔案**不算掃描失敗** —— 掃描的工作是更新資料庫，那件事成功了。
      // 它們已經記成 status=error，在 list 裡看得到。回非 0 會讓每晚 smoke 一直紅。
      if (r.errors) say(`${r.errors} 個讀不到，用 cleanup list 看是哪些。`)
      if (r.truncated) warn('⚠ 檔案太多，這次只掃了前面那些。把監看範圍縮小。')
      break
    }

    if (sub === 'list' || sub === undefined) {
      let r
      try { r = listCandidates(db, { roots: config.watch }) }
      catch (e) {
        // 後端錯是 2 不是 1，而且不要噴一坨 Node 堆疊
        warn('讀不到清理候選：' + (e?.message ?? e))
        process.exitCode = EXIT.backend
        break
      }
      if (!r.total && !r.needsHuman.length) {
        // 沒東西要清是**成功**，不是失敗
        const scanned = db.prepare(`SELECT count(*) n FROM file_items`).get().n
        say(scanned
          ? '沒有東西需要清，Downloads 很乾淨。'
          : '還沒掃過。先跑 `node cli.mjs cleanup scan`。')
        break
      }
      if (r.total) {
        say(`有 ${r.total} 個可以清掉的東西，大概 ${mb(r.bytes)}`
          + (r.truncated ? `（總共有 ${r.totalAvailable} 個，這裡只列前 ${r.total} 個）` : '') + '\n')
        for (const c of r.candidates) { printCandidate(c); say('') }
        const checked = r.candidates.filter(c => c.defaultChecked).length
        say(`☐ 的預設不清。cleanup apply 會清掉打勾的 ${checked} 個。`)
      }
      if (r.needsHuman.length) {
        say(`\n另外 ${r.needsHumanTotal} 個需要你自己看一眼：`
          + (r.needsHumanTruncated ? `（只列前 ${r.needsHuman.length} 個）` : ''))
        for (const h of r.needsHuman) say(`  ${h.name}　${mb(h.bytes)}　—— ${h.why}`)
      }
      break
    }

    // ── 會真的動檔案的 ───────────────────────────────────────
    //
    // **離開碼的判準：2 ＝ 這個動作根本沒執行；3 ＝ 執行了但沒有全部成功。**
    // 呼叫端（右鍵選單、每晚 smoke）據此決定要不要重試：
    // 2 通常重試會成功（鎖住了、資料庫開不了），3 要人去看那幾個檔。
    const execOpts = {
      roots: config.watch, quarantine: QUARANTINE,
      maxBytes: config.maxBytes, readonly: config.readonly,
    }

    if (sub === 'apply') {
      // **唯讀模式不可以建 plan。**
      // createPlan 不看 readonly（只有 applyPlan 看），所以先建再被擋的話，
      // 那份 plan 會留在資料庫裡佔住那些檔案，下一次真的 apply 直接撞
      // 「這個檔案已有待處理的清理計畫」—— 而 smoke 第 0 步正是叫使用者
      // 先跑一次唯讀試跑。照著文件做就會壞掉。
      if (config.readonly && !args[1]) {
        const r = listCandidates(db, { roots: config.watch })
        const checked = r.candidates.filter(c => c.defaultChecked)
        say(`唯讀模式：會清掉 ${checked.length} 個檔案，${mb(checked.reduce((n, c) => n + c.bytes, 0))}。`)
        for (const c of checked) say(`  ✔ ${c.name}　${mb(c.bytes)}`)
        say('\n這次一個都沒動，也沒有建立計畫。')
        break
      }

      let plan
      try {
        // 給了 id 就套用那一份，沒給就用目前的候選建一份新的
        plan = args[1] ? { id: args[1] } : createPlan(db)
      } catch (e) {
        if (e instanceof CleanupError && e.code === 'CONFLICT') {
          // 有 plan 卡著的話要講得出**怎麼往下走**，不然使用者只能去翻資料庫
          const stuck = db.prepare(
            `SELECT id FROM cleanup_plans WHERE status IN ('proposed','partial','error')
             ORDER BY created_at DESC LIMIT 1`).get()
          warn(e.message)
          if (stuck) {
            say(`\n那份計畫是 ${stuck.id}。`)
            say(`  接著清：node cli.mjs cleanup apply ${stuck.id}`)
            say(`  不清了：node cli.mjs cleanup undo ${stuck.id}`)
          }
          process.exitCode = EXIT.backend
          break
        }
        if (e instanceof CleanupError && e.code === 'EMPTY_PLAN') {
          // **沒東西要清是成功。** 回非 0 會讓每晚 smoke 一直紅。
          say('沒有東西需要清，Downloads 很乾淨。')
          break
        }
        warn(cliProblem(e))
        process.exitCode = exitFor(e)
        break
      }

      let r
      try { r = applyPlan(db, plan.id, execOpts) }
      catch (e) {
        if (e instanceof CleanupError && e.code === 'READ_ONLY') {
          // smoke 第 0 步就靠這個確認「只說不做」。回非 0 會讓那一步永遠紅。
          const n = plan.items?.length ?? 0
          say(`唯讀模式：會清掉 ${n} 個檔案，但這次一個都沒動。`)
          break
        }
        warn(cliProblem(e))
        process.exitCode = exitFor(e)
        break
      }

      say(`計畫 ${r.id}`)
      // **逐項的勾要看 journal，不可以看「有沒有被略過」。**
      // 一律印 ✔ 的話，全失敗時會印出五個 ✔ 後面接「搬進隔離區 0 個」——
      // 畫面在說謊，而這支工具的全部價值就是使用者信得過它動了什麼。
      const byItem = new Map()
      for (const j of listJournal(db, r.id)) {
        if (j.op === 'quarantine') byItem.set(j.item_id, j)
      }
      // **失敗原因有兩個地方。** 檢查沒過的話（檔案變了、是重複檔的留存者、
      // 不在白名單資料夾）根本不會寫 journal —— markFailure 只把訊息寫進
      // file_items.error。只查 journal 的話，最常見的那種失敗印出來是一句
      // 「沒有搬動」，使用者完全不知道發生什麼事。
      // spec 第 6 節：沒有 reason 就是 bug。
      const itemError = db.prepare('SELECT error FROM file_items WHERE id=?')
      for (const i of r.items) {
        const j = byItem.get(i.itemId)
        if (i.skipped) { say(`  － ${i.name}　${mb(i.bytes)}　（你略過了）`); continue }
        if (j?.status === 'done') { say(`  ✔ ${i.name}　${mb(i.bytes)}`); continue }
        const why = j?.error ?? itemError.get(i.itemId)?.error ?? '沒有搬動，原因不明'
        say(`  ✘ ${i.name}　${mb(i.bytes)}　—— ${why}`)
      }
      say(`\n搬進隔離區 ${r.quarantinedCount} 個，${mb(r.quarantinedBytes)}。`)
      if (r.quarantinedCount) say(`後悔的話：node cli.mjs cleanup undo ${r.id}`)
      if (r.status === 'partial' || r.status === 'error') {
        warn(`\n⚠ 上面 ✘ 的沒搬成。原檔都還在原位，沒有任何東西被刪除。`)
        // partial 與 error 都是 3 —— 動作執行了，只是檔案沒全部搬成。
        // 全失敗也不是 2：2 要留給「連跑都跑不起來」。
        process.exitCode = EXIT.partial
      }
      break
    }

    if (sub === 'undo') {
      const id = args[1]
      if (!id) {
        warn('要給計畫 id。例：node cli.mjs cleanup undo <plan-id>')
        process.exitCode = EXIT.badInput
        break
      }
      let r
      try { r = undoPlan(db, id, execOpts) }
      catch (e) {
        warn(cliProblem(e))
        process.exitCode = exitFor(e)
        break
      }
      // 只列**真的放回去**的那些。列全部的話會出現「放回去 2 個檔案」
      // 後面接三行 ↩ —— 跟 apply 那邊一律印 ✔ 是同一類的畫面說謊。
      const restored = new Set(
        listJournal(db, id).filter(j => j.op === 'restore' && j.status === 'done')
          .map(j => j.item_id))
      say(`放回去 ${r.restoredCount} 個檔案。`)
      for (const i of r.items) if (restored.has(i.itemId)) say(`  ↩ ${i.name}`)
      if (r.status === 'partial' || r.status === 'error') process.exitCode = EXIT.partial
      break
    }

    if (sub === 'quarantine') {
      let rows
      try { rows = listQuarantine(db) }
      catch (e) { warn(cliProblem(e)); process.exitCode = exitFor(e); break }

      if (args.includes('--empty')) {
        let prep
        try { prep = prepareEmptyQuarantine(db, execOpts) }
        catch (e) { warn(cliProblem(e)); process.exitCode = exitFor(e); break }

        if (!prep.itemCount) {
          const waiting = rows.filter(r => !r.canEmptyNow)
          const soonest = waiting.map(r => Date.parse(r.canEmptyAt)).sort((a, b) => a - b)[0]
          say(waiting.length
            ? `還沒有滿七天的檔案。最早的那個還要等 ${days(soonest)} 天。`
            : '隔離區是空的。')
          break
        }
        say(prep.message)
        say(`會永久刪除 ${prep.itemCount} 個檔案，${mb(prep.bytes)}。`)
        // **二次確認要人真的再打一次。** 這是整個專案唯一會刪檔的路徑。
        say(`確定的話跑：node cli.mjs cleanup quarantine --empty --yes ${prep.token}`)
        if (!args.includes('--yes')) break

        let r
        try { r = emptyQuarantine(db, { ...execOpts, token: args[args.indexOf('--yes') + 1], confirmed: true }) }
        catch (e) { warn(cliProblem(e)); process.exitCode = exitFor(e); break }
        say(`刪掉 ${r.deletedCount} 個，${mb(r.deletedBytes)}。`)
        if (r.errors.length) {
          warn(`${r.errors.length} 個沒刪成：`)
          for (const e of r.errors) warn(`  ${e.error}`)
          process.exitCode = EXIT.partial
        }
        break
      }

      if (!rows.length) { say('隔離區是空的。'); break }
      say(`隔離區有 ${rows.length} 個檔案，${mb(rows.reduce((n, r) => n + r.bytes, 0))}：\n`)
      for (const r of rows) {
        say(`  ${r.name}　${mb(r.bytes)}`)
        say(`         ${r.canEmptyNow ? '可以清空了' : `還要等 ${days(Date.parse(r.canEmptyAt))} 天`}`)
      }
      break
    }

    if (sub === 'dismiss') {
      warn('cleanup dismiss 還沒做好（要先有 plan id 的來源，等 C 的面板）。')
      process.exitCode = EXIT.backend
      break
    }

    warn(`不認得 cleanup ${sub ?? ''}。可以用：scan、list、apply、undo、quarantine`)
    process.exitCode = EXIT.badInput
    break
  }

  case 'list': {
    showProblems()
    const status = args[0]
    const rows = items.list(status, 50)
    if (!rows.length) { say(status ? `沒有狀態是 ${status} 的東西。` : '收件匣是空的。'); break }
    for (const r of rows) say(`${r.status.padEnd(13)} ${r.kind.padEnd(10)} ${basename(r.path)}`)
    say(`\n共 ${rows.length} 筆。`)
    break
  }

  case 'search': {
    showProblems()
    const q = args.join(' ').trim()
    if (!q) { warn('要給搜尋字詞。'); process.exit(1) }

    // trigram 索引至少要三個字元才建得起來，所以短詞走 LIKE。
    // 中文的詞大多是兩個字（發票、收據、學費），不處理的話這個工具
    // 會對「發票」回「找不到」，而使用者會以為是資料沒進去。
    const short = [...q].length < 3
    // LIKE 的 % 與 _ 是萬用字元。不跳脫的話 `search %` 會把整個資料庫
    // 倒出來 —— 包含每一張截圖抄下來的字。
    const like = q.replace(/[\\%_]/g, c => '\\' + c)
    let rows
    try {
      rows = short
        ? db.prepare(
            `SELECT i.*, f.summary FROM items_fts f JOIN items i ON i.id = f.item_id
             WHERE f.name LIKE '%' || ? || '%' ESCAPE '\\'
                OR f.summary LIKE '%' || ? || '%' ESCAPE '\\'
                OR f.text LIKE '%' || ? || '%' ESCAPE '\\' LIMIT 20`
          ).all(like, like, like)
        : db.prepare(
            `SELECT i.*, f.summary FROM items_fts f JOIN items i ON i.id = f.item_id
             WHERE items_fts MATCH ? ORDER BY rank LIMIT 20`
          ).all(ftsQuery(q))
    } catch (e) {
      warn(`這個搜尋字詞資料庫看不懂（${e.message}）。換個說法再試一次。`)
      process.exitCode = 1
      break
    }

    if (!rows.length) {
      say(`找不到「${q}」。`)
      const n = db.prepare(`SELECT count(*) n FROM understanding`).get().n
      if (!n) say('（目前一份文件都還沒被看懂，所以搜尋還沒有東西可以找。那是 P1 的事。）')
      break
    }
    for (const r of rows) say(`${basename(r.path)}\n   ${r.summary ?? ''}\n   ${r.path}\n`)
    break
  }

  default: {
    say(`ContextBox —— 檔案與截圖管線

  node cli.mjs doctor            這台機器現在什麼狀況
  node cli.mjs pet               啟動寵物與清理面板
  node cli.mjs cleanup scan      掃一次 Downloads
  node cli.mjs cleanup list      看有什麼可以清
  node cli.mjs watch             常駐監看
  node cli.mjs propose <檔案>...  手動收一個檔案
  node cli.mjs list [狀態]        看收件匣
  node cli.mjs search <詞>        全文搜尋

設定檔在 ${CONFIG_PATH}`)
    if (cmd) process.exit(1)
  }
}
