import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 面板改了設定，**跑著的寵物要立刻跟上**（2026-09-20）。
 *
 * 期望值照 ~/contextbox-預想-20260920-設定面板.md 那張表寫死，不是從實作抄的：
 *   - 「改完生不生效」那一列：逐欄講實話。`readonly`、`model.*` 立即生效，其餘欄位下次啟動
 *   - 「讓 readonly 立即生效」那一列：cli.mjs 改傳 getter，route 那邊自己解
 *   - 「唯讀模式下能不能改設定」那一列：唯讀講的是「不搬你的檔」，不是「不准你關掉唯讀」
 *
 * 這一支只管「存下去之後生不生效」，**不管存的那條路**（PATCH /settings 是另一個人在寫）。
 * 所以這裡不 import core/settings.ts：改設定的動作用「寫設定檔 + 叫 onSettingsSaved」模擬，
 * 那正是那條 route 存完檔要做的最後一件事。route 進來之後，只有驅動的方式要換，期望值都一樣。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '../core/server.ts'
import { load, normalize } from '../core/config.ts'
import {
  reloadInto, LIVE_SETTINGS, RESTART_SETTINGS, SETTINGS_WHITELIST, FROZEN_AT_STARTUP,
} from '../core/live-config.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400_000
const TOKEN = 'settings-live-token-abcdef'

/** 設定檔的內容。`base` 之外的欄位由呼叫端蓋掉。 */
function configText(dir, over = {}) {
  return JSON.stringify({
    watch: [join(dir, 'Downloads')],
    filed: join(dir, 'Filed'),
    model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
    readonly: false,
    pdfPages: 3,
    maxBytes: 20971520,
    cleanup: { roots: [join(dir, 'Downloads')], screenshots: false },
    ...over,
  }, null, 2) + '\n'
}

// ═══ 1 ・ 唯讀關掉之後，下一次清理**不用重開**就過 ═════════════

describe('唯讀改了，跑著的寵物立刻跟上（全程走 HTTP）', () => {
  let dir, downloads, cfgFile, live, srv, base, saves

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-live-')))
    downloads = join(dir, 'Downloads')
    mkdirSync(downloads)
    cfgFile = join(dir, 'config.json')
    // 一開始是唯讀。這就是使用者打開面板時的狀態
    writeFileSync(cfgFile, configText(dir, { readonly: true }))

    // **這一行就是 cli.mjs:131 做的事**：module top-level 讀一次，之後整支都拿這一個物件
    live = load(cfgFile).config
    assert.equal(live.readonly, true, '前提：這一份設定是唯讀的')

    // 老到會被列成清理候選的檔
    const old = new Date(Date.now() - 120 * DAY)
    for (const name of ['a.zip', 'b.zip']) {
      const p = join(downloads, name)
      writeFileSync(p, 'content of ' + name)
      utimesSync(p, old, old)
    }

    saves = 0
    // 面板存完設定之後，設定那條 route 要做的最後一件事
    const panelSaved = () => { saves += 1; reloadInto(live, cfgFile) }

    // **跟 cli.mjs 的 pet 一模一樣的接法**：readonly 傳 getter，其餘傳值
    srv = start({
      port: 0, db: join(dir, 'data.db'), token: TOKEN,
      roots: [downloads], quarantine: join(dir, 'quarantine'), maxBytes: 1e7,
      readonly: () => live.readonly,
      restoreRoots: [downloads], screenshotsDir: null, filed: join(dir, 'Filed'),
      onSettingsSaved: panelSaved,
    })
    base = `http://127.0.0.1:${await srv.ready}`
    // 掃描一次才有候選。掃描不搬也不刪，唯讀模式下本來就做得了
    const scanned = await call('POST', '/cleanup/scan')
    assert.equal(scanned.status, 200)
    assert.ok(scanned.body.candidates >= 2, `前提：掃得到候選（拿到 ${JSON.stringify(scanned.body)}）`)
  })
  after(() => { srv?.server.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) })

  async function call(method, path, body) {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-contextbox-token': TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() }
  }

  /** 面板存檔：寫設定檔，再叫 onSettingsSaved（route 存完檔就是這樣收尾的）。 */
  function panelSave(over) {
    writeFileSync(cfgFile, configText(dir, over))
    srv.settingsSaved()
  }

  test('唯讀開著：建清理計畫被擋，403 READ_ONLY，一個檔都沒動', async () => {
    const r = await call('POST', '/cleanup/plans')
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'READ_ONLY')
    assert.ok(existsSync(join(downloads, 'a.zip')), '被擋下來就不可以有任何檔案離開 Downloads')
  })

  test('**面板關掉唯讀之後，下一次清理就過了 —— 沒有重開寵物**', async () => {
    const portBefore = new URL(base).port
    panelSave({ readonly: false })
    assert.equal(saves, 1)
    assert.equal(live.readonly, false, 'reloadInto 要原地蓋回同一個物件')

    const made = await call('POST', '/cleanup/plans')
    assert.equal(made.status, 200, `關掉唯讀之後還被擋：${JSON.stringify(made.body)}`)
    const planId = made.body.id
    assert.ok(planId, '要拿得到計畫 id')

    const applied = await call('POST', `/cleanup/plans/${encodeURIComponent(planId)}/apply`)
    assert.equal(applied.status, 200)
    // 真的搬了才算數：只看狀態碼的話，執行層改成什麼都不做也是綠的
    assert.ok(!existsSync(join(downloads, 'a.zip')), '檔案應該已經搬進隔離區')

    // 同一個 server、同一個埠，從頭到尾沒有重開
    assert.equal(srv.server.listening, true)
    assert.equal(new URL(base).port, portBefore)
  })

  test('反過來也要即時：再打開唯讀，下一次建計畫又被擋', async () => {
    panelSave({ readonly: true })
    assert.equal(live.readonly, true)
    const r = await call('POST', '/cleanup/plans')
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'READ_ONLY')
  })

  test('唯讀開著也存得下去 —— 關不掉的開關是陷阱', async () => {
    // 規格那一列：唯讀講的是「不搬你的檔」，不是「不准你關掉唯讀」。
    // 上一條剛把唯讀打開，現在在唯讀狀態下再存一次，而且要真的生效
    assert.equal(live.readonly, true, '前提：現在是唯讀')
    panelSave({ readonly: false })
    assert.equal(live.readonly, false, '唯讀狀態下存的設定也要算數')
    const r = await call('POST', '/cleanup/plans')
    assert.notEqual(r.status, 403)
  })
})

// ═══ 2 ・ reloadInto 原地蓋，而且一個位元組都不寫回去 ═══════════

describe('reloadInto 只讀不寫，而且蓋回同一個物件', () => {
  /** 一份設定檔 + 從它讀出來的 config。回 { dir, file, cfg }。 */
  function fixture(t, over = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-reload-')))
    mkdirSync(join(dir, 'Downloads'))
    const file = join(dir, 'config.json')
    writeFileSync(file, configText(dir, over))
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
    return { dir, file, cfg: load(file).config }
  }

  test('config 本身、config.model、config.cleanup 都是原地蓋', t => {
    const { dir, file, cfg } = fixture(t)
    const held = cfg, heldModel = cfg.model, heldCleanup = cfg.cleanup
    writeFileSync(file, configText(dir, { readonly: true, model: { baseUrl: 'https://box.example/v1', name: 'qwen', keyEnv: 'CONTEXTBOX_MODEL_KEY' } }))
    reloadInto(cfg, file)
    // 拿著 config 不放的人（cli.mjs 整支、thinkRound({ config })）要看得到新值
    assert.equal(cfg, held)
    assert.equal(cfg.readonly, true)
    // 拿著 config.model 不放的人也要
    assert.equal(cfg.model, heldModel)
    assert.equal(heldModel.name, 'qwen')
    assert.equal(heldModel.baseUrl, 'https://box.example/v1')
    assert.equal(cfg.cleanup, heldCleanup)
  })

  test('**不回寫設定檔** —— normalize 只用來驗，不用來寫', t => {
    // 手加的 comment、寬容讀取器補上的預設值，都不可以因為「重讀了一次」就被寫進檔案。
    // reloadInto 要是回存 normalize 的結果，下面這個 comment 就沒了。
    const { dir, file, cfg } = fixture(t)
    const handWritten = configText(dir, { readonly: true }).replace('{\n', '{\n  "comment": "改給自己看的，不要動",\n')
    writeFileSync(file, handWritten)
    const before = readFileSync(file)
    reloadInto(cfg, file)
    assert.deepEqual(readFileSync(file), before, 'reloadInto 動了設定檔')
    assert.equal(cfg.readonly, true, '但值還是要讀進來')
  })

  test('壞掉的設定檔：講出來，不丟例外 —— 一輪存檔不可以讓寵物死掉', t => {
    const { file, cfg } = fixture(t)
    writeFileSync(file, '{ this is not json')
    const r = reloadInto(cfg, file)
    assert.ok(r.problems.some(p => /config file could not be read/i.test(p)), r.problems.join(' / '))
    assert.equal(r.config, cfg)
  })
})

// ═══ 3 ・ 白名單與「生不生效」的分類，要守得住 ═══════════════════

describe('哪些欄位立即生效，是算出來的，不是宣告的', () => {
  /** 一份設定改成 over 之後，`FROZEN_AT_STARTUP` 那些欄位長什麼樣。 */
  function frozenShape(over) {
    const { config } = normalize({
      watch: [join(FAKE_HOME, 'Downloads')],
      filed: join(FAKE_HOME, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes: 20971520,
      cleanup: { roots: [join(FAKE_HOME, 'Downloads')], screenshots: false },
      ...over,
    })
    const at = (path) => path.split('.').reduce((o, k) => o?.[k], config)
    return JSON.stringify(FROZEN_AT_STARTUP.map(at))
  }

  /** 這一欄可以填的兩個合法值（界內／界外各一種寫法）。 */
  const TRY_VALUES = {
    readonly: [{ readonly: false }, { readonly: true }],
    'model.baseUrl': [
      { model: { baseUrl: '', name: 'm', keyEnv: 'CONTEXTBOX_MODEL_KEY' } },
      { model: { baseUrl: 'https://box.example/v1', name: 'm', keyEnv: 'CONTEXTBOX_MODEL_KEY' } },
    ],
    'model.name': [
      { model: { baseUrl: '', name: 'a', keyEnv: 'CONTEXTBOX_MODEL_KEY' } },
      { model: { baseUrl: '', name: 'b', keyEnv: 'CONTEXTBOX_MODEL_KEY' } },
    ],
    'model.keyEnv': [
      { model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' } },
      { model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_OTHER_KEY' } },
    ],
    'cleanup.screenshots': [
      { cleanup: { roots: [join(FAKE_HOME, 'Downloads')], screenshots: false } },
      { cleanup: { roots: [join(FAKE_HOME, 'Downloads')], screenshots: true } },
    ],
  }

  test('白名單就是規格那五欄，而且每一欄都被歸過類', () => {
    assert.deepEqual([...SETTINGS_WHITELIST].sort(), [
      'cleanup.screenshots', 'model.baseUrl', 'model.keyEnv', 'model.name', 'readonly',
    ], '白名單跟規格 Step 1 最後一列對不上')
    for (const f of SETTINGS_WHITELIST) {
      const live = LIVE_SETTINGS.includes(f)
      const restart = RESTART_SETTINGS.includes(f)
      assert.ok(live !== restart,
        `${f} 沒有被歸類，或兩邊都列了 —— 面板就講不出它生不生效，而規格要的是「逐欄講實話」`)
    }
  })

  test('**改了會連帶動到「啟動時就抓走」那些欄位的，一定要算重開才生效**', () => {
    // 這一條是給之後改白名單的人的。判準不是「這一欄叫什麼名字」，是**它會不會動到
    // cli.mjs 啟動時抓走的那一票**（CLEAN_ROOTS、SHOTS、admitOpts、start() 的那幾個值）。
    // 動到了卻宣告立即生效，寵物就會半套地跟上 —— 那比完全不跟上更危險。
    for (const f of SETTINGS_WHITELIST) {
      const pair = TRY_VALUES[f]
      assert.ok(pair, `白名單多了 ${f}，但這裡沒有給它兩個值 —— 不知道它會動到什麼，先補上再說`)
      const moves = frozenShape(pair[0]) !== frozenShape(pair[1])
      if (moves) {
        assert.ok(RESTART_SETTINGS.includes(f),
          `${f} 一改就會動到 ${FROZEN_AT_STARTUP.join('、')}，那些是寵物啟動時抓走的，`
          + '所以它只能算「下次啟動生效」。要讓它立即生效，先去看 cli.mjs 的 CLEAN_ROOTS 那一段。')
      } else {
        assert.ok(LIVE_SETTINGS.includes(f), `${f} 不會動到任何被凍住的欄位，沒有理由叫使用者重開`)
      }
    }
  })

  test('立即生效的那幾欄，reloadInto 真的送得到啟動時就抓走的持有者手上', t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-deliver-')))
    mkdirSync(join(dir, 'Downloads'))
    const file = join(dir, 'config.json')
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
    for (const f of LIVE_SETTINGS) {
      writeFileSync(file, configText(dir, TRY_VALUES[f][0]))
      const cfg = load(file).config
      // 啟動時抓走的那一層（cli.mjs 有人拿 config，也有人拿 config.model）
      const holder = f.includes('.') ? cfg[f.split('.')[0]] : cfg
      const key = f.split('.').pop()
      writeFileSync(file, configText(dir, TRY_VALUES[f][1]))
      reloadInto(cfg, file)
      assert.equal(holder[key], f.split('.').reduce((o, k) => o[k], cfg),
        `${f} 存下去之後，啟動時抓走那一層的人看到的還是舊值`)
    }
  })

  test('cleanup.screenshots 打開，啟動時抓走的清理範圍**不可以**偷偷變寬', t => {
    // 為什麼它只能算「下次啟動生效」的證據。roots 與 screenshotsDir 是一對：
    // roots 裡有截圖資料夾時，那底下只准清截圖。只跟上 roots 的話，
    // macOS 的截圖資料夾就是桌面 —— 桌面上的舊 zip 會被當成垃圾搬走。
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-shots-')))
    mkdirSync(join(dir, 'Downloads'))
    const file = join(dir, 'config.json')
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
    writeFileSync(file, configText(dir))
    const cfg = load(file).config
    const CLEAN_ROOTS = cfg.cleanup.roots        // ← cli.mjs:160 抓走的就是這一個陣列
    const SHOTS = cfg.cleanup.screenshotsDir ?? null
    assert.equal(SHOTS, null, '前提：截圖資料夾一開始沒開')

    writeFileSync(file, configText(dir, { cleanup: { roots: [join(dir, 'Downloads')], screenshots: true } }))
    reloadInto(cfg, file)

    assert.ok(cfg.cleanup.screenshotsDir, '設定檔裡確實打開了')
    assert.deepEqual(CLEAN_ROOTS, [realpathSync(join(dir, 'Downloads'))],
      '啟動時抓走的清理範圍變寬了，而 screenshotsDir 還是啟動時的 null —— 那個資料夾底下會照全部規則清')
  })

  test('之後有人把路徑類欄位加進白名單，這一條要紅', t => {
    const PATH_FIELDS = ['watch', 'filed', 'cleanup.roots', 'cleanup.screenshotsDir']
    const added = SETTINGS_WHITELIST.filter(f => PATH_FIELDS.includes(f))
    if (!added.length) return       // 這一版沒開路徑類欄位，下面那段是給開的人看的

    // 開了就得先讓 reloadInto 原地改那些陣列（splice），不然 cli.mjs 的 CLEAN_ROOTS
    // 與 start({ roots }) 手上那一份永遠是啟動當下那一個，而 SHOTS 那個字串也要一起換。
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-paths-')))
    mkdirSync(join(dir, 'Downloads'))
    mkdirSync(join(dir, 'Other'))
    const file = join(dir, 'config.json')
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
    writeFileSync(file, configText(dir))
    const cfg = load(file).config
    const CLEAN_ROOTS = cfg.cleanup.roots
    writeFileSync(file, configText(dir, { cleanup: { roots: [join(dir, 'Other')], screenshots: false } }))
    reloadInto(cfg, file)
    assert.equal(cfg.cleanup.roots, CLEAN_ROOTS,
      `白名單收進了 ${added.join('、')}，那 reloadInto 必須原地改 cleanup.roots（splice），`
      + '不可以換成新陣列 —— cli.mjs 的 CLEAN_ROOTS 與 start({ roots }) 抓的是啟動時那一個。'
      + '同一輪也要處理 cleanup.screenshotsDir，見 core/live-config.ts 的 FROZEN_AT_STARTUP。')
  })
})

// ═══ 4 ・ 寵物那邊真的照這樣接（原始碼守門） ════════════════════

describe('cli.mjs 的 pet 真的把 readonly 傳成 getter', () => {
  const cli = readFileSync(join(REPO, 'cli.mjs'), 'utf8')

  /** pet 那一次 `start(…)` 的原文。只看它 —— 其他地方的 `config.readonly` 是每次用才讀，本來就跟得上。 */
  function petStartCall() {
    const at = cli.indexOf('const srv = start(')
    assert.ok(at > 0, 'pet 的 start() 不見了（改名了就把這一條一起改）')
    const end = cli.indexOf('\n    })', at)
    assert.ok(end > at, 'pet 的 start(…) 那一段找不到結尾')
    return cli.slice(at, end)
  }

  test('start() 拿到的是 getter，不是啟動當下那個布林值', () => {
    // 傳值的話 server 手上永遠是啟動那一刻的 readonly：使用者在面板關掉唯讀、
    // 馬上按 Clean up，還是被擋，而面板剛剛才說「已儲存」。
    const petStart = petStartCall()
    assert.ok(/readonly:\s*\(\)\s*=>\s*config\.readonly/.test(petStart),
      'pet 的 start() 沒有把 readonly 傳成 getter')
    assert.ok(!/readonly:\s*config\.readonly\b/.test(petStart),
      'pet 的 start() 又把 config.readonly 當成值交出去了，那一份就凍在啟動當下')
  })

  test('存檔之後會重讀設定檔，而且是原地蓋（不可以換掉 config 物件）', () => {
    assert.ok(/onSettingsSaved:/.test(petStartCall()), 'pet 沒有把 onSettingsSaved 接給 server')
    assert.ok(/reloadInto\(config, cfgPath\)/.test(cli), 'pet 沒有用 reloadInto 原地重讀')
    assert.ok(!/^\s*config\s*=\s*/m.test(cli),
      'config 被整個換掉了 —— 別處抓著舊物件的人（thinkRound({ config })、CLEAN_ROOTS）全部看不到新值')
  })

  test('server 解 getter 的那一步不可以退回 `opts.readonly ?? cfg()`', () => {
    // `??` 看到一個 function 不是 nullish，整個 thunk 回傳的就是那個 function，
    // route 那邊 `ctx.readonly()` 拿到 function → 恆真 → **全機安靜地永遠唯讀**。
    const server = readFileSync(join(REPO, 'core/server.ts'), 'utf8')
    assert.ok(!/readonly:\s*\(\)\s*=>\s*opts\.readonly\s*\?\?/.test(server),
      'server 又用 ?? 直接接 opts.readonly 了，getter 會被當成真值')
    assert.ok(/typeof opts\.readonly === 'function'/.test(server),
      'server 沒有解開 getter')
  })
})

// ═══ 6 ・ **真的跑 `node cli.mjs pet`**，設定面板要有東西 ═══════
//
// 上面幾節都是測試自己叫 start()、自己把參數給齊，所以呼叫端漏傳什麼它們永遠看不見。
// 2026-09-20 使用者在自己的機器上打開 Settings，看到的是
// 「This server was started without a config file」——寵物明明讀了設定檔，
// 卻沒告訴 server 讀的是哪一份（roots／readonly 都傳齊了 ＝ server 不會自己去讀）。
// 只有真的把寵物生出來才抓得到這種洞，所以這一節生真的行程。

describe('真的寵物起來之後，/settings 是有東西的', () => {
  let dir, home, cfgFile, child, port, token, out

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-pet-settings-')))
    home = join(dir, 'home')
    mkdirSync(join(home, '.contextbox'), { recursive: true })
    mkdirSync(join(dir, 'Downloads'), { recursive: true })
    cfgFile = join(home, '.contextbox', 'config.json')
    writeFileSync(cfgFile, configText(dir, { readonly: true }))

    out = ''
    child = spawn(process.execPath, [join(REPO, 'cli.mjs'), 'pet'], {
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home,
        CONTEXTBOX_CONFIG: cfgFile,
        CONTEXTBOX_DB: join(home, '.contextbox', 'data.db'),
        CONTEXTBOX_QUARANTINE: join(home, '.contextbox', 'quarantine'),
        CONTEXTBOX_TOKEN_PATH: join(home, '.contextbox', 'token'),
        CONTEXTBOX_PORT: '0',
      },
    })
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    const t0 = Date.now()
    let m = null
    while (!(m = /127\.0\.0\.1:(\d+)\/\?k=([A-Za-z0-9_-]+)/.exec(out))) {
      if (child.exitCode !== null) throw new Error(`pet 結束了（${child.exitCode}）：\n${out}`)
      if (Date.now() - t0 > 30_000) throw new Error(`等不到 pet 起來：\n${out}`)
      await new Promise(r => setTimeout(r, 40))
    }
    port = Number(m[1])
    token = m[2]
  })

  after(async () => {
    if (child && child.exitCode === null) {
      const done = new Promise(r => child.once('exit', r))
      child.kill('SIGTERM')
      await done
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const get = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/settings`, { headers: { 'x-contextbox-token': token } })
    return [r.status, await r.json()]
  }

  test('**不可以是「這個 server 沒有設定檔」** —— 寵物讀了，就要講出來讀的是哪一份', async () => {
    const [status, body] = await get()
    assert.equal(status, 200, `Settings 一片空白就是這裡回了 500：${JSON.stringify(body)}`)
    assert.ok(!/without a config file/i.test(JSON.stringify(body)), JSON.stringify(body))
  })

  test('五個可改的欄位都在，而且值是這台機器真的設定檔裡的那些', async () => {
    const [, body] = await get()
    assert.equal(body.editable.readonly, true, '設定檔裡寫的是唯讀，面板就要顯示唯讀')
    assert.equal(body.editable.model.keyEnv, 'CONTEXTBOX_MODEL_KEY')
    assert.equal(body.editable.cleanup.screenshots, false)
    assert.ok('baseUrl' in body.editable.model && 'name' in body.editable.model)
  })

  test('改了之後**真的寫進寵物讀的那一份檔**，而且當場生效', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PATCH',
      headers: { 'x-contextbox-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ readonly: false }),
    })
    assert.equal(r.status, 200, await r.text())
    assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).readonly, false, '寫到別的檔去了')
    const [, body] = await get()
    assert.equal(body.editable.readonly, false)
  })
})
