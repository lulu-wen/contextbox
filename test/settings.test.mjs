import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  statSync, lstatSync, chmodSync, rmSync, existsSync, realpathSync, symlinkSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { readSettings, applyPatch, EDITABLE } from '../core/settings.ts'
import { start } from '../core/server.ts'

/**
 * 面板裡改設定（2026-09-20）。
 *
 * 這是**寫使用者設定檔**的第一條路徑，四條高風險全中：寫壞了下次啟動整個起不來、
 * `model.baseUrl` 一改就是「把我的檔案送去別台主機」、`readonly` 一關就是「可以搬我的檔了」、
 * 而且錯了會沉默 —— 面板說「已儲存」而檔案裡是別的東西，要好幾天後才會發現。
 *
 * 規格（`contextbox-預想-20260920-設定面板.md`）那張表的每一列在這裡至少一條，
 * 而且成對的（界內／界外）都要有。
 */

let root
before(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cb-settings-'))) })
after(() => rmSync(root, { recursive: true, force: true }))

let n = 0
/** 每個案例自己一個資料夾。`raw` 是字串就原樣寫進去（拿來做壞掉的 JSON）。 */
function box(raw) {
  const d = join(root, 'case' + n++)
  mkdirSync(d, { recursive: true })
  const p = join(d, 'config.json')
  if (raw !== undefined) writeFileSync(p, typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2) + '\n')
  return p
}

const bytes = p => (existsSync(p) ? readFileSync(p) : null)
const json = p => JSON.parse(readFileSync(p, 'utf8'))
/** 沒有任何環境變數的環境：keySet 一律 false，測試之間不互相影響。 */
const NO_ENV = {}

// ══ 讀設定 ═══════════════════════════════════════════════

describe('讀設定', () => {
  test('家目錄底下的路徑縮成 `~/…`，而且**讀一頁設定不可以順手建檔**', () => {
    // 規格那一列：不變量 8（不回絕對路徑）護的是免 token 的 /health 與候選清單；
    // 使用者自己設的資料夾，在自己帶 token 的設定頁看不到反而荒謬。
    const p = join(homedir(), '.contextbox', 'config.json')
    const s = readSettings(p, NO_ENV, {})
    assert.equal(s.path, '~/.contextbox/config.json')
    assert.equal(existsSync(dirname(p)), false, 'GET 不可以建出 ~/.contextbox')
  })

  test('設定檔放在家目錄以外就照實講（縮不了就不縮）', () => {
    const p = box({})
    assert.equal(readSettings(p, NO_ENV, {}).path, p)
  })

  test('顯示用的欄位都縮成 `~`，隔離區用 server 給的那一個', () => {
    const p = join(homedir(), 'box', 'config.json')
    const s = readSettings(p, NO_ENV, { quarantine: join(homedir(), '.contextbox', 'quarantine') })
    assert.equal(s.shown.quarantine, '~/.contextbox/quarantine')
    assert.equal(s.shown.filed, '~/Documents/Filed')
    for (const w of [...s.shown.watch, ...s.shown.cleanupRoots]) {
      assert.match(w, /^~[/\\]/, `${w} 沒縮成 ~`)
    }
    assert.equal(s.shown.pdfPages, 3)
    assert.equal(s.shown.maxBytes, 20 * 1024 * 1024)
  })

  test('**金鑰只說有沒有設，值永遠不出這條 HTTP**', () => {
    const secret = 'sk-live-' + 'z'.repeat(40)
    const p = box({ model: { keyEnv: 'CONTEXTBOX_OTHER_KEY' } })
    const on = readSettings(p, { CONTEXTBOX_OTHER_KEY: secret }, {})
    assert.equal(on.keySet, true)
    assert.equal(on.editable.model.keyEnv, 'CONTEXTBOX_OTHER_KEY')
    assert.ok(!JSON.stringify(on).includes(secret), '回應裡帶著金鑰')
    // 空白不算設了 —— 空字串跟「沒設」一樣不能用
    assert.equal(readSettings(p, { CONTEXTBOX_OTHER_KEY: '   ' }, {}).keySet, false)
    assert.equal(readSettings(p, {}, {}).keySet, false)
  })

  test('**使用者把金鑰貼進 baseUrl：problems 一個字都不可以帶它**', () => {
    // config.ts 已經護住 keyEnv 那一欄了，但 baseUrl 讀不懂時它印的是整串原字串 ——
    // 而「貼錯格子」正是 2026-09-20 早上那一次的樣子。
    const secret = 'bsa_' + 'q'.repeat(40)
    const p = box({ model: { baseUrl: secret } })
    const s = readSettings(p, NO_ENV, {})
    assert.ok(!JSON.stringify(s).includes(secret), `problems 把金鑰印出來了：${s.problems.join(' / ')}`)
    assert.ok(s.problems.some(x => /model URL/.test(x)), '還是要講那一欄讀不懂')
    assert.equal(s.editable.model.baseUrl, '')
  })

  test('**貼進來的金鑰前後有空白，一樣一個字都不可以帶**', () => {
    // 上面那條只測了「不多不少剛好一串」。但從瀏覽器輸入框貼過去的東西前後幾乎一定帶空白，
    // 而 normalize 是**先 trim 再把值印進句子**（config.ts:391）—— secretsOf 只收原字串的話
    // 兩邊就對不上，scrub 什麼都換不掉，金鑰原封不動出現在 GET /settings 的回應裡。
    // 2026-09-20 稽核實測：同一把假金鑰，只差前面兩個空白，一個被遮一個沒被遮。
    const secret = 'bsa_' + 'q'.repeat(40)
    for (const [l, r] of [['  ', '  '], [' ', ' '], ['\t', ''], ['', '\n'], ['\r\n', '\r\n'], [' ', '']]) {
      const s = readSettings(box({ model: { baseUrl: l + secret + r } }), NO_ENV, {})
      assert.ok(!JSON.stringify(s).includes(secret), `${JSON.stringify(l + '…' + r)} 這一種空白沒擋住：${s.problems.join(' / ')}`)
      assert.ok(s.problems.some(x => /model URL/.test(x)), '還是要講那一欄讀不懂')
    }
  })

  test('**金鑰被當成主機名也要遮**（`http://<金鑰>` 這個形狀）', () => {
    // normalize 讀得懂 `http://sk-live-…` 這一串：它是一個合法網址，主機名就是整把金鑰。
    // 於是走的不是「讀不懂」那一句，而是 config.ts:285 的「不安全」那一句 —— 那一句會把
    // protocol + hostname 印出來，而 URL 解析器**會把主機名轉小寫**。只比原字串的 scrub
    // 因此對不上，整把金鑰（小寫版，一樣能用）就出去了。
    const secret = 'sk-live-9f3aQxR7ZtLm42PdV8bKcY6w'
    for (const raw of ['http://' + secret, '  http://' + secret + '  ', 'HTTP://' + secret]) {
      const s = readSettings(box({ model: { baseUrl: raw } }), NO_ENV, {})
      const all = JSON.stringify(s)
      assert.ok(!all.includes(secret.toLowerCase()), `${raw} 沒擋住：${s.problems.join(' / ')}`)
      assert.ok(!all.includes(secret), `${raw} 沒擋住：${s.problems.join(' / ')}`)
      assert.ok(s.problems.some(x => /not safe/.test(x)), '還是要講那一欄不能用')
    }
  })

  test('**設定檔本身讀不懂的時候，也不可以把檔案內容貼回來**', () => {
    // V8 的 JSON SyntaxError 訊息會把出錯位置前後約十個位元組的**原文**附上
    //（`Unexpected token 's', "sk-live-9f"... is not valid JSON`）。
    // 使用者把金鑰直接存成 config.json、或設定檔第一行就是 `sk-…`，那十個位元組就是金鑰開頭。
    const secret = 'sk-live-9f3aQxR7ZtLm42PdV8bKcY6w'
    const s = readSettings(box(secret + '\n'), NO_ENV, {})
    const all = JSON.stringify(s)
    assert.ok(!all.includes('sk-live'), `回應裡帶著金鑰開頭：${all}`)
    assert.ok(s.problems.some(x => /could not be read/.test(x)), '還是要講這份檔讀不懂')
  })

  test('JSON 壞掉：照預設顯示，並且明講讀不懂', () => {
    const p = box('{ 這不是 JSON')
    const s = readSettings(p, NO_ENV, {})
    assert.ok(s.problems.some(x => /could not be read/.test(x)))
    assert.equal(s.editable.readonly, false)
    assert.equal(readFileSync(p, 'utf8'), '{ 這不是 JSON', '讀一下不可以改到檔案')
  })

  test('**live 加 restart 剛好是可以改的那五欄，不重疊也不漏**', () => {
    // 「逐欄講實話」：一律說「已生效」或一律說「要重開」都是騙人。
    const s = readSettings(box({}), NO_ENV, {})
    assert.deepEqual([...s.live, ...s.restart].sort(), [...EDITABLE].sort())
    assert.equal(new Set([...s.live, ...s.restart]).size, EDITABLE.length, '同一欄不可以兩邊都掛')
    assert.deepEqual(s.restart, ['cleanup.screenshots'])
  })
})

// ══ 白名單 ═══════════════════════════════════════════════

describe('可以改哪些欄位', () => {
  test('白名單以外的鍵一律 400，**不是安靜忽略**', () => {
    // 安靜忽略等於面板騙人：使用者把清理範圍改成 `/` 之後看到「已儲存」，而檔案裡沒有這回事。
    for (const patch of [
      { cleanup: { roots: ['/'] } },
      { watch: ['/'] },
      { filed: '/tmp/x' },
      { pdfPages: 9 },
      { maxBytes: 1024 },
      { cleanup: { screenshotsDir: '/tmp/x' } },
      { model: { temperature: 0.7 } },
      { readOnly: true },                       // 大小寫拼錯也是「不認得」
    ]) {
      const p = box({ readonly: false })
      const before = bytes(p)
      const r = applyPatch(p, patch, NO_ENV, {})
      assert.equal(r.ok, false, JSON.stringify(patch) + ' 應該被拒絕')
      assert.equal(r.code, 'BAD_SETTING')
      assert.ok(Object.keys(r.fields).length, JSON.stringify(patch) + ' 要說是哪一欄')
      assert.deepEqual(bytes(p), before, JSON.stringify(patch) + ' 之後檔案被動過了')
    }
  })

  test('白名單那五欄都存得進去', () => {
    const p = box({})
    const r = applyPatch(p, {
      readonly: true,
      model: { baseUrl: 'https://api.example.com/v1', name: 'qwen3', keyEnv: 'CONTEXTBOX_OTHER_KEY' },
      cleanup: { screenshots: true },
    }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    const after = json(p)
    assert.equal(after.readonly, true)
    assert.equal(after.model.baseUrl, 'https://api.example.com/v1')
    assert.equal(after.model.name, 'qwen3')
    assert.equal(after.model.keyEnv, 'CONTEXTBOX_OTHER_KEY')
    assert.equal(after.cleanup.screenshots, true)
  })

  test('型別不對就擋 —— **不繼承 normalize 的寬容**', () => {
    // normalize 讀檔時 `readonly:"true"` 會靜靜變成 true、`model.name: 123` 靜靜變成空字串。
    // 那對「讀一份手改過的檔」是對的，對「存使用者剛打的字」是錯的。
    for (const patch of [
      { readonly: 'true' }, { readonly: 1 }, { readonly: null },
      { model: { name: 123 } }, { model: { baseUrl: null } }, { model: 'https://x' },
      { cleanup: { screenshots: 'yes' } }, { cleanup: [] },
    ]) {
      const p = box({ readonly: false })
      const before = bytes(p)
      const r = applyPatch(p, patch, NO_ENV, {})
      assert.equal(r.ok, false, JSON.stringify(patch) + ' 應該被拒絕')
      assert.equal(r.code, 'BAD_SETTING')
      assert.deepEqual(bytes(p), before)
    }
  })

  test('型別對的界內值收得下（跟上面成對）', () => {
    for (const patch of [
      { readonly: false }, { readonly: true },
      { model: { name: '' } }, { model: { baseUrl: '' } },
      { cleanup: { screenshots: false } },
      {},                                        // 什麼都沒改也算一次儲存，不是錯
    ]) {
      const p = box({ readonly: true })
      assert.equal(applyPatch(p, patch, NO_ENV, {}).ok, true, JSON.stringify(patch) + ' 應該收')
    }
  })
})

// ══ (a) 這次改的欄位 normalize 有意見 → 整份拒絕 ═══════════════

describe('存到一半的壞值：拒絕、檔案一個位元組都不動', () => {
  test('明文 http 打到公網 → 400，而且 problems 那句話原樣回給面板', () => {
    const p = box({ model: { name: 'keep-me' } })
    const before = bytes(p)
    const r = applyPatch(p, { model: { baseUrl: 'http://8.8.8.8/v1' } }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BAD_SETTING')
    assert.match(r.fields['model.baseUrl'], /not safe/)
    assert.deepEqual(bytes(p), before, '被拒絕的 patch 不可以動到檔案')
  })

  test('同一欄打自己內網就收得下（界內／界外成對）', () => {
    for (const good of ['http://127.0.0.1:8000/v1', 'http://192.168.1.50:8000/v1',
                        'http://100.64.0.1/v1', 'https://api.example.com/v1']) {
      const p = box({})
      const r = applyPatch(p, { model: { baseUrl: good } }, NO_ENV, {})
      assert.equal(r.ok, true, good + ' 應該收')
      assert.equal(json(p).model.baseUrl, good)
    }
  })

  test('keyEnv 不是 CONTEXTBOX_ 開頭 → 400；是的話 → 收', () => {
    const bad = box({})
    const r = applyPatch(bad, { model: { keyEnv: 'AWS_SECRET_ACCESS_KEY' } }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.match(r.fields['model.keyEnv'], /CONTEXTBOX_/)

    const ok = box({})
    assert.equal(applyPatch(ok, { model: { keyEnv: 'CONTEXTBOX_OTHER_KEY' } }, NO_ENV, {}).ok, true)
    assert.equal(json(ok).model.keyEnv, 'CONTEXTBOX_OTHER_KEY')
  })

  test('keyEnv 被清成空字串 → 400，不可以靜靜退回預設（2026-09-20 稽核 verify:contract-8）', () => {
    // config.ts:393 對空字串的規矩是「當成沒這個鍵，用預設 CONTEXTBOX_MODEL_KEY」——
    // 讀一份手改過的檔時那是對的，但**存**的時候不是：面板 400 之後會把那一格清掉，
    // 下一次儲存就夾著 `keyEnv: ""` 上來，於是使用者的 CONTEXTBOX_OTHER_KEY 從檔案裡消失，
    // keySet 變 false，而畫面說「已儲存」。這一欄要嘛是個變數名，要嘛就別送。
    const p = box({ model: { keyEnv: 'CONTEXTBOX_OTHER_KEY' } })
    const before = bytes(p)
    for (const empty of ['', '   ']) {
      const r = applyPatch(p, { model: { keyEnv: empty } }, NO_ENV, {})
      assert.equal(r.ok, false, JSON.stringify(empty) + ' 不可以被收下')
      assert.equal(r.code, 'BAD_SETTING')
      assert.match(r.fields['model.keyEnv'], /cannot be empty/)
      assert.deepEqual(bytes(p), before, '被拒絕的 patch 不可以動到檔案')
    }
    assert.equal(json(p).model.keyEnv, 'CONTEXTBOX_OTHER_KEY')
  })

  test('**keyEnv 被填成金鑰本人：回應一個字都不帶它**（2026-09-20 真的發生過）', () => {
    // 那一欄要的是「環境變數的名字」，但很容易被讀成「把金鑰放這裡」。
    // 今天早上 doctor 把使用者貼進去的金鑰整串印出來了 —— 於是它進了終端機、截圖，
    // 以及他複製貼上的每一個地方。錯誤訊息只講規則。
    const key = 'bsa_' + 'x'.repeat(40)
    const p = box({})
    const before = bytes(p)
    const r = applyPatch(p, { model: { keyEnv: key } }, NO_ENV, {})
    assert.equal(r.ok, false)
    const all = JSON.stringify(r)
    assert.ok(!all.includes(key), `回應把金鑰印出來了：${all}`)
    assert.ok(!all.includes('x'.repeat(10)), all)
    assert.match(r.fields['model.keyEnv'], /not the key itself/i)
    assert.deepEqual(bytes(p), before)
  })

  test('**使用者把金鑰貼進 model.baseUrl：400 那一句話也一個字都不可以帶它**', () => {
    // 成對的另一半在「讀設定」那一節。這一條守的是**被拒絕的 PATCH**：normalize 讀不懂
    // 那串網址時印的是使用者打的整串原文，而那句話會進 400 的 fields、回到瀏覽器、
    // 貼在輸入框旁邊、被截圖 —— 跟 2026-09-20 早上 doctor 那件事是同一個坑。
    // 2026-09-20 的突變測試證明這裡完全沒被釘住：只把這一處的 say() 拿掉，全套 2815 條照樣全綠。
    const secret = 'sk-live-9f3aQxR7ZtLm42PdV8bKcY6w'
    for (const raw of [secret, '  ' + secret + '  ', ' ' + secret + ' ', '\t' + secret + '\n',
                       'http://' + secret, '  HTTP://' + secret + '  ']) {
      const p = box({})
      const before = bytes(p)
      const r = applyPatch(p, { model: { baseUrl: raw } }, NO_ENV, {})
      assert.equal(r.ok, false, raw + ' 應該被拒絕')
      assert.equal(r.code, 'BAD_SETTING')
      const all = JSON.stringify(r)
      assert.ok(!all.includes(secret), `${JSON.stringify(raw)} 把金鑰印出來了：${all}`)
      assert.ok(!all.includes(secret.toLowerCase()), `${JSON.stringify(raw)} 把小寫版印出來了：${all}`)
      assert.ok(!all.includes(secret.slice(0, 16)), `連前半截都不可以留：${all}`)
      assert.ok(/model URL/.test(r.fields['model.baseUrl']), '遮掉之後還是要講得出哪裡不行')
      assert.deepEqual(bytes(p), before)
    }
  })

  test('網址裡的帳號密碼：normalize 會靜靜拿掉，那不可以當成「存好了」', () => {
    const p = box({})
    const r = applyPatch(p, { model: { baseUrl: 'https://user:pw@api.example.com/v1' } }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.match(r.fields['model.baseUrl'], /username and password/)
    assert.equal(json(p).model, undefined, '被拒絕就不可以留下半套的 model')
  })
})

// ══ 值被整理過 ≠ 值被丟掉 ══════════════════════════════════

describe('**被整理過的值要收，被丟掉的值才擋**', () => {
  test('尾斜線、主機名大小寫是整理 —— 收，而且檔案裡留的是使用者打的那一串', () => {
    // 只比「normalize 之後的值跟送來的不一樣」就擋的話，使用者永遠存不進一個合法的網址：
    // checkBaseUrl 會把 `…/v1/` 的尾斜線拿掉、把主機名轉小寫。
    for (const [asked, canonical] of [
      ['https://api.example.com/v1/', 'https://api.example.com/v1'],
      ['HTTPS://API.EXAMPLE.COM/v1', 'https://api.example.com/v1'],
      ['http://127.0.0.1:8000/v1//', 'http://127.0.0.1:8000/v1'],
    ]) {
      const p = box({})
      const r = applyPatch(p, { model: { baseUrl: asked } }, NO_ENV, {})
      assert.equal(r.ok, true, asked + ' 只是被整理，不該擋')
      assert.equal(json(p).model.baseUrl, asked, 'normalize 只用來驗，不用來寫')
      assert.equal(r.settings.editable.model.baseUrl, canonical, '回給面板的是整理過的樣子')
    }
  })

  test('model.name 前後的空白會被 trim，那也是整理', () => {
    const p = box({})
    const r = applyPatch(p, { model: { name: '  qwen3-27b  ' } }, NO_ENV, {})
    assert.equal(r.ok, true)
    assert.equal(json(p).model.name, '  qwen3-27b  ')
    assert.equal(r.settings.editable.model.name, 'qwen3-27b')
  })

  test('**值原樣收下，但 normalize 對它的「後果」有意見 → 照樣存，那句話給使用者看**', () => {
    // cleanup.screenshots 打開會把截圖資料夾加進清理範圍。歸檔資料夾剛好在那底下時，
    // normalize 會多講一句「整理好的檔之後又會被列成清理候選」—— 那是後果的提醒，
    // 不是「這個 true 我不收」。值原樣收下了就不該擋。
    const filed = join(homedir(), 'Pictures', 'Screenshots', 'Filed')
    const p = box({ filed, cleanup: { roots: [join(homedir(), 'Downloads')], screenshots: false } })
    const r = applyPatch(p, { cleanup: { screenshots: true } }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(json(p).cleanup.screenshots, true)
    assert.ok(r.settings.problems.some(x => /cleanup candidates/.test(x)),
      '後果還是要講：' + JSON.stringify(r.settings.problems))
  })
})

// ══ 比較基準：normalize **收下**的值，不是檔案裡的舊值 ══════

describe('**檔案裡本來就是壞的，不可以因此就放行**', () => {
  // 2026-09-20 稽核（correctness-1／contract-6 各自獨立找到同一條）。
  // 訊號 2 原本是「把這一欄退回**檔案裡已經有的那個值**再 normalize 一次」。
  // 舊值也壞的時候，兩邊生出**逐位元組一樣**的句子，於是互相抵銷、blame 變空、
  // 一個 normalize 明明拒絕掉的值被當成「只是被整理過」寫進檔案。
  // normalize 有三句話完全不帶使用者的值（looksLikeAKey、CONTEXTBOX_ 開頭、帳號密碼），
  // 它們一碰就撞。當初的測試只跑過「壞 → 好」，所以這條活了下來。

  test('**檔案裡已經有一把金鑰，再貼一把新的還是要擋**（不然新金鑰會被寫進檔案）', () => {
    const oldKey = 'sk-old-' + 'a'.repeat(30)
    const newKey = 'sk-live-' + 'Z'.repeat(30)
    const p = box({ model: { keyEnv: oldKey } })
    const before = bytes(p)
    const r = applyPatch(p, { model: { keyEnv: newKey } }, NO_ENV, {})
    assert.equal(r.ok, false, '這是不變量 2：金鑰不可以進設定檔')
    assert.equal(r.code, 'BAD_SETTING')
    assert.match(r.fields['model.keyEnv'], /not the key itself/i)
    const all = JSON.stringify(r)
    assert.ok(!all.includes(newKey) && !all.includes(oldKey), all)
    assert.ok(!readFileSync(p, 'utf8').includes(newKey), '新金鑰被寫進設定檔了')
    assert.deepEqual(bytes(p), before)
  })

  test('keyEnv 那一句「要 CONTEXTBOX_ 開頭」也不帶值，所以也會撞', () => {
    const p = box({ model: { keyEnv: 'FOO' } })
    const before = bytes(p)
    const r = applyPatch(p, { model: { keyEnv: 'OPENAI_API_KEY' } }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.match(r.fields['model.keyEnv'], /CONTEXTBOX_/)
    assert.deepEqual(bytes(p), before)
  })

  test('**網址裡本來就有帳號密碼，換一組新的還是要擋**（不然密碼會被寫進檔案）', () => {
    const p = box({ model: { baseUrl: 'https://old:oldpw@api.example.com/v1' } })
    const before = bytes(p)
    const r = applyPatch(p, { model: { baseUrl: 'https://alice:Sup3rSecretPassw0rd@api.example.com/v1' } }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.match(r.fields['model.baseUrl'], /username and password/)
    assert.ok(!readFileSync(p, 'utf8').includes('Sup3rSecretPassw0rd'), '密碼被寫進設定檔了')
    assert.deepEqual(bytes(p), before)
  })

  test('**同一台不安全的主機換一個路徑還是要擋**（那一句只印 protocol + hostname）', () => {
    const p = box({ model: { baseUrl: 'http://evil.example/a' } })
    const before = bytes(p)
    const r = applyPatch(p, { model: { baseUrl: 'http://evil.example/b' } }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.match(r.fields['model.baseUrl'], /not safe/)
    assert.deepEqual(bytes(p), before)
  })

  test('對照：本來就髒的檔案，合法但**被整理過**的值照樣存得進去', () => {
    // 基準線換成「normalize 收下的值」之後還要成立的另一半 —— 不然使用者永遠存不進一個合法網址。
    // normalize 對自己的輸出是冪等的，所以只是被整理的值，兩邊的句子一樣、blame 還是空的。
    for (const [asked, canonical] of [
      ['https://api.example.com/v1/', 'https://api.example.com/v1'],
      ['HTTPS://API.EXAMPLE.COM/v1', 'https://api.example.com/v1'],
      ['https://api.example.com:443/v1', 'https://api.example.com/v1'],
    ]) {
      const p = box({ model: { baseUrl: 'http://evil.example/a' }, filed: homedir() })
      const r = applyPatch(p, { model: { baseUrl: asked } }, NO_ENV, {})
      assert.equal(r.ok, true, asked + ' 只是被整理，不該擋：' + JSON.stringify(r))
      assert.equal(json(p).model.baseUrl, asked, 'normalize 只用來驗，不用來寫')
      assert.equal(r.settings.editable.model.baseUrl, canonical)
    }
  })

  test('對照：model.name 的前後空白，在一份髒檔案上也還是「整理」', () => {
    const p = box({ model: { keyEnv: 'FOO' }, cleanup: { roots: ['/'] } })
    const r = applyPatch(p, { model: { name: '  qwen3-27b  ' } }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(json(p).model.name, '  qwen3-27b  ')
    assert.equal(json(p).model.keyEnv, 'FOO', '沒改到的欄位原樣留著，連壞的也是')
  })

  test('對照：值原樣收下、只是「後果」有意見的那一句，跟別的欄位一起送也不可以擋', () => {
    // 這一條釘的是另一個候選修法（把那一欄從基準線裡**刪掉**）會弄壞的東西：
    // `cleanup.screenshots` 不在檔案裡就等於 false，刪掉它等於偷偷換掉預設值，
    // 「歸檔資料夾之後又會被列成清理候選」那一句會變成憑空多出來的罪名。
    // 現在靠 Object.is 短路擋著，但基準線不該有這種脆弱處 —— 這裡一次送兩欄，
    // 讓 baseUrl 那一欄真的走到基準線那一行，而 screenshots 的後果句在兩邊都在。
    const filed = join(homedir(), 'Pictures', 'Screenshots', 'Filed')
    const p = box({ filed, cleanup: { roots: [join(homedir(), 'Downloads')], screenshots: false } })
    const r = applyPatch(p, {
      cleanup: { screenshots: true },
      model: { baseUrl: 'https://api.example.com/v1/' },
    }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(json(p).cleanup.screenshots, true)
    assert.equal(json(p).model.baseUrl, 'https://api.example.com/v1/')
    assert.ok(r.settings.problems.some(x => /cleanup candidates/.test(x)),
      '後果還是要講：' + JSON.stringify(r.settings.problems))
  })
})

// ══ (b) 舊毛病不可以擋住這次的儲存 ═════════════════════════

describe('壞值但不是這次改的', () => {
  test('檔案裡 filed 本來就壞掉，照樣關得掉 readonly', () => {
    // 否則使用者被一個舊毛病鎖在門外，連 readonly 都關不掉。
    const p = box({ readonly: true, filed: homedir() })
    const r = applyPatch(p, { readonly: false }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(json(p).readonly, false)
    assert.equal(json(p).filed, homedir(), '沒改到的欄位原樣留著，連壞的也是')
    assert.ok(r.settings.problems.some(x => /filed folder/.test(x)), '毛病還在，只是不擋存檔')
  })

  test('壞掉的 cleanup.roots 也擋不住改 model.name', () => {
    const p = box({ cleanup: { roots: ['/'] }, model: {} })
    const r = applyPatch(p, { model: { name: 'qwen3' } }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(json(p).cleanup.roots, ['/'])
  })

  test('但**這次**就是去碰那一欄的話，擋得下來（成對）', () => {
    const p = box({ readonly: true, filed: homedir() })
    const before = bytes(p)
    const r = applyPatch(p, { readonly: false, model: { baseUrl: 'http://8.8.8.8/v1' } }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.deepEqual(Object.keys(r.fields), ['model.baseUrl'], 'readonly 是好的，不要連它一起怪')
    assert.deepEqual(bytes(p), before, '整份拒絕：好的那一欄也不可以偷偷存進去')
  })

  test('本來就壞的那一欄，這次改成好的 → 收，而且毛病消失', () => {
    const p = box({ model: { baseUrl: 'http://evil.example/v1' } })
    assert.ok(readSettings(p, NO_ENV, {}).problems.some(x => /model URL/.test(x)), '前提：本來就有毛病')
    const r = applyPatch(p, { model: { baseUrl: 'https://ok.example/v1' } }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(!r.settings.problems.some(x => /model URL/.test(x)), JSON.stringify(r.settings.problems))
  })
})

// ══ (c) 只動 patch 的鍵 ════════════════════════════════════

describe('沒改到的欄位原樣抄回去', () => {
  test('**手加的 comment、巢狀的未知欄位、沒碰到的欄位，一個都不可以掉**', () => {
    // 用 normalize 之後的完整 config 覆蓋整份檔案的話，這些全部消失 ——
    // 而且是安靜地消失。normalize 只用來「驗」，不用來「寫」。
    const original = {
      comment: '這是我自己加的，請不要動它',
      watch: [join(homedir(), 'Downloads')],
      filed: join(homedir(), 'Documents', 'Filed'),
      pdfPages: 7,
      maxBytes: 12345678,
      readonly: false,
      model: { baseUrl: 'https://api.example.com/v1', name: 'qwen3', keyEnv: 'CONTEXTBOX_MODEL_KEY', temperature: 0.7 },
      cleanup: { roots: [join(homedir(), 'Downloads')], screenshots: false, note: '手寫的備註' },
    }
    const p = box(original)
    assert.equal(applyPatch(p, { readonly: true }, NO_ENV, {}).ok, true)
    assert.deepEqual(json(p), { ...original, readonly: true })
  })

  test('沒有設定檔的機器：按了儲存就建一份（預設 + 這次的 patch），mode 0600', () => {
    const p = join(root, 'fresh', '.contextbox', 'config.json')
    assert.equal(existsSync(p), false)
    const r = applyPatch(p, { readonly: true }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    const after = json(p)
    assert.equal(after.readonly, true)
    assert.ok(Array.isArray(after.watch) && after.watch.length, '底稿要跟 load() 寫出來的那一份一樣')
    assert.equal(after.cleanup.screenshotsDir, undefined, 'screenshotsDir 是算出來的，不進檔案')
    assert.equal(statSync(p).mode & 0o777, 0o600)
  })
})

// ══ (d) 兩個面板同時開 ═════════════════════════════════════

describe('寫的當下重讀檔案', () => {
  test('中間被別人改過的鍵留得住', () => {
    // 存記憶體裡那份再寫出去的話，B 會把 A 剛存的蓋掉 —— 而且兩邊都顯示「已儲存」。
    const p = box({ readonly: false, model: {} })
    assert.equal(applyPatch(p, { readonly: true }, NO_ENV, {}).ok, true)              // 面板 A
    const mid = json(p)
    writeFileSync(p, JSON.stringify({ ...mid, comment: '另一個行程寫的' }, null, 2) + '\n')
    assert.equal(applyPatch(p, { model: { name: 'qwen3' } }, NO_ENV, {}).ok, true)    // 面板 B
    const after = json(p)
    assert.equal(after.readonly, true, 'A 存的不見了')
    assert.equal(after.model.name, 'qwen3', 'B 存的不見了')
    assert.equal(after.comment, '另一個行程寫的', '中間那次手改不見了')
  })
})

// ══ (e) 原子寫入 ═══════════════════════════════════════════

describe('寫檔被打斷也不可以留下半截的 config.json', () => {
  test('mode 0600，而且既有檔案的權限會被改回來', () => {
    const p = box({ readonly: false })
    chmodSync(p, 0o644)
    assert.equal(applyPatch(p, { readonly: true }, NO_ENV, {}).ok, true)
    assert.equal(statSync(p).mode & 0o777, 0o600)
  })

  test('**換掉的是整個檔案（inode 變了），不是就地改寫**', () => {
    // writeFileSync 直接蓋是就地改寫：寫到一半斷電就留下半截的 JSON，下次啟動整個壞掉。
    // 同目錄暫存檔 + renameSync 之後，同一個路徑指向的是另一個 inode。
    const p = box({ readonly: false })
    const before = statSync(p).ino
    assert.equal(applyPatch(p, { readonly: true }, NO_ENV, {}).ok, true)
    assert.notEqual(statSync(p).ino, before, '看起來是就地改寫，那就不是原子的')
  })

  test('暫存檔跟正本同一個目錄，而且寫完不留下來', () => {
    const p = box({ readonly: false })
    assert.equal(applyPatch(p, { readonly: true }, NO_ENV, {}).ok, true)
    assert.deepEqual(readdirSync(dirname(p)), ['config.json'], '暫存檔沒收乾淨')
    // 跨檔案系統的 rename 會回 EXDEV，所以暫存檔不可以放到系統暫存目錄去
    const src = readFileSync(new URL('../core/settings.ts', import.meta.url), 'utf8')
    assert.match(src, /renameSync\(/, '換成 writeFileSync 直接蓋就不是原子的了')
    assert.ok(!/tmpdir\(\)/.test(src), '暫存檔要放在正本旁邊，不是系統暫存目錄')
  })

  test('寫不出去 → WRITE_FAILED，檔案不動', { skip: process.getuid?.() === 0 && 'root 不受權限限制' }, () => {
    const p = box({ readonly: false })
    const before = bytes(p)
    chmodSync(dirname(p), 0o500)
    try {
      const r = applyPatch(p, { readonly: true }, NO_ENV, {})
      assert.equal(r.ok, false)
      assert.equal(r.code, 'WRITE_FAILED')
      assert.match(r.error, /could not be written/)
    } finally { chmodSync(dirname(p), 0o700) }
    assert.deepEqual(bytes(p), before)
  })

  test('現在的內容讀不懂就不敢覆蓋（跟 load() 同一條規矩）', () => {
    for (const raw of ['{ 這不是 JSON', '[1,2,3]', '"just a string"']) {
      const p = box(raw)
      const before = bytes(p)
      const r = applyPatch(p, { readonly: true }, NO_ENV, {})
      assert.equal(r.ok, false, raw + ' 不該被覆蓋')
      assert.equal(r.code, 'WRITE_FAILED')
      assert.deepEqual(bytes(p), before, raw + ' 被蓋掉了 —— 沒改到的鍵要原樣抄回去，而我們根本不知道那些鍵是什麼')
    }
  })

  test('**讀不懂的那一句也要過 say()：家目錄不可以出現在 WRITE_FAILED 裡**',
    { skip: process.getuid?.() === 0 && 'root 不受權限限制' }, () => {
    // 這條路上每一句話都經過 say()（homeless + scrub），就這一句沒有 —— 於是使用者的
    // OS 帳號名整串出現在面板上，而同一頁上面兩行寫的是 `~/.contextbox/config.json`。
    // 設定頁是使用者最可能截圖貼給別人看的一頁（cleanup-real-state.js:1349）。
    const d = join(FAKE_HOME, 'writefail')
    mkdirSync(d, { recursive: true })
    const p = join(d, 'config.json')
    writeFileSync(p, '{"readonly":false}\n')
    chmodSync(p, 0o000)
    try {
      const r = applyPatch(p, { readonly: true }, NO_ENV, {})
      assert.equal(r.ok, false)
      assert.equal(r.code, 'WRITE_FAILED')
      assert.ok(!r.error.includes(FAKE_HOME), `WRITE_FAILED 帶著家目錄絕對路徑：${r.error}`)
      assert.match(r.error, /could not be read/, '還是要講得出哪一步不行')
    } finally { chmodSync(p, 0o600) }
  })

  test('**WRITE_FAILED 也不可以把檔案內容貼回來**', () => {
    // 同一句話的另一半漏洞：JSON 解析錯誤的訊息會附上出錯位置前後約十個位元組的原文。
    // 設定檔第一行就是金鑰的時候（貼錯地方、或者存成了 .env 的樣子），那十個位元組就是它。
    const secret = 'sk-live-9f3aQxR7ZtLm42PdV8bKcY6w'
    const p = box(secret + '\n')
    const before = bytes(p)
    const r = applyPatch(p, { readonly: true }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.equal(r.code, 'WRITE_FAILED')
    assert.ok(!r.error.includes('sk-live'), `WRITE_FAILED 帶著檔案內容：${r.error}`)
    assert.deepEqual(bytes(p), before)
  })
})

// ══ 設定檔是捷徑（dotfiles） ═══════════════════════════════

describe('**config.json 是捷徑的時候，要寫進捷徑指到的那個檔**', () => {
  // 2026-09-20 稽核（correctness-4／security-12）。`renameSync` **不跟著最後一段的捷徑走**，
  // 所以 `ln -s ~/dotfiles/contextbox.json ~/.contextbox/config.json` 這種裝法會被
  // 一次儲存悄悄拆掉：readRaw 順著捷徑讀、寫入卻蓋在捷徑本身上，面板照樣說「已儲存」。
  // 之後 dotfiles repo 裡那一份永遠停在存檔前，下一次 `chezmoi apply` 反而把面板改的全部倒掉。

  /** link → target 的一組。回 { link, target }。 */
  function linked(name, targetBody, mk) {
    const d = join(root, 'link' + n++)
    mkdirSync(join(d, 'dotfiles'), { recursive: true })
    const target = join(d, 'dotfiles', name)
    if (targetBody !== undefined) writeFileSync(target, JSON.stringify(targetBody, null, 2) + '\n')
    const link = join(d, 'config.json')
    mk(target, link)
    return { link, target }
  }

  test('絕對路徑的捷徑：捷徑還在，值進了正本，沒碰到的鍵也還在', () => {
    const { link, target } = linked('contextbox.json', { readonly: false, comment: '手加的' },
      (t, l) => symlinkSync(t, l))
    const r = applyPatch(link, { readonly: true }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(lstatSync(link).isSymbolicLink(), true, '捷徑被換成一般檔了')
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).readonly, true, '值沒進正本')
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).comment, '手加的')
    assert.equal(statSync(target).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dirname(target)), ['contextbox.json'], '暫存檔沒收乾淨')
  })

  test('相對路徑的捷徑（dotfiles 幾乎都是這一種）', () => {
    const { link, target } = linked('contextbox.json', { readonly: false },
      (t, l) => symlinkSync(join('dotfiles', basename(t)), l))
    assert.equal(applyPatch(link, { readonly: true }, NO_ENV, {}).ok, true)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).readonly, true)
  })

  test('捷徑指到捷徑（兩層）也要一路走到底', () => {
    const { link, target } = linked('contextbox.json', { readonly: false }, (t, l) => {
      const mid = join(dirname(l), 'middle.json')
      symlinkSync(t, mid)
      symlinkSync(mid, l)
    })
    assert.equal(applyPatch(link, { readonly: true }, NO_ENV, {}).ok, true)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).readonly, true)
  })

  test('斷掉的捷徑：把正本補出來，不是把捷徑換掉', () => {
    // realpathSync 對斷掉的捷徑會丟例外，所以不能只靠它 —— 而這正是
    // 「dotfiles 還沒 checkout」的那一刻，第一次儲存應該要把檔案生在 repo 裡。
    const { link, target } = linked('contextbox.json', undefined, (t, l) => symlinkSync(t, l))
    assert.equal(existsSync(target), false, '前提：正本還不存在')
    assert.equal(applyPatch(link, { readonly: true }, NO_ENV, {}).ok, true)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).readonly, true)
  })

  test('被拒絕的儲存不可以動到捷徑，也不可以動到正本', () => {
    const { link, target } = linked('contextbox.json', { readonly: false }, (t, l) => symlinkSync(t, l))
    const before = bytes(target)
    const r = applyPatch(link, { model: { baseUrl: 'http://8.8.8.8/v1' } }, NO_ENV, {})
    assert.equal(r.ok, false)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.deepEqual(bytes(target), before)
  })

  test('對照：捷徑是**資料夾**的那一種裝法本來就沒事（stow 的預設）', () => {
    // 稽核的範圍修正：整個 ~/.contextbox 是捷徑的話，dirname() 就穿過去了，
    // rename 的最後一段是真的檔案 —— 這一種一直都是對的，不可以修壞它。
    const d = join(root, 'linkdir' + n++)
    mkdirSync(join(d, 'dotfiles', 'contextbox'), { recursive: true })
    const realDir = join(d, 'dotfiles', 'contextbox')
    writeFileSync(join(realDir, 'config.json'), JSON.stringify({ readonly: false }, null, 2) + '\n')
    const linkDir = join(d, '.contextbox')
    symlinkSync(realDir, linkDir)
    assert.equal(applyPatch(join(linkDir, 'config.json'), { readonly: true }, NO_ENV, {}).ok, true)
    assert.equal(lstatSync(linkDir).isSymbolicLink(), true)
    assert.equal(JSON.parse(readFileSync(join(realDir, 'config.json'), 'utf8')).readonly, true)
  })
})

// ══ 唯讀模式 ═══════════════════════════════════════════════

describe('唯讀模式下能不能改設定', () => {
  test('**readonly: true 不擋 PATCH /settings —— 關不掉的開關是陷阱**', () => {
    // 唯讀講的是「不搬你的檔」，不是「不准你關掉唯讀」。
    const p = box({ readonly: true })
    const r = applyPatch(p, { readonly: false }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(json(p).readonly, false)
  })

  test('唯讀開著的時候，別的欄位一樣改得動', () => {
    const p = box({ readonly: true, model: {} })
    assert.equal(applyPatch(p, { model: { name: 'qwen3' } }, NO_ENV, {}).ok, true)
    assert.equal(json(p).readonly, true, '沒叫它關就不要關')
  })

  test('**CONTEXTBOX_READONLY=1 壓著的時候，取消打勾不可以回「已生效」**', () => {
    // 環境變數贏過檔案（config.ts:169 第一行就 return true）。以前這裡會存成功、
    // 面板印「Read-only mode. It is in effect now.」，而唯讀根本沒關掉。
    // 誠實的做法是講出來是誰壓著它，不是假裝存好了。
    const p = box({ readonly: true })
    const before = bytes(p)
    process.env.CONTEXTBOX_READONLY = '1'
    try {
      const r = applyPatch(p, { readonly: false }, NO_ENV, {})
      assert.equal(r.ok, false, '環境變數壓著的時候不可以假裝存好了')
      assert.match(r.fields.readonly, /CONTEXTBOX_READONLY/)
      assert.deepEqual(bytes(p), before)
      // 界內成對：同一個環境下，別的欄位照樣改得動（不變量 5）
      const p2 = box({ readonly: false, model: {} })
      assert.equal(applyPatch(p2, { model: { name: 'qwen3' } }, NO_ENV, {}).ok, true, '別的欄位不可以被連坐')
      // 界內成對：叫它「開著」跟環境變數說的一樣，那就沒有衝突
      assert.equal(applyPatch(box({ readonly: false }), { readonly: true }, NO_ENV, {}).ok, true)
    } finally { delete process.env.CONTEXTBOX_READONLY }
  })
})

// ══ 這一輪稽核順手補的幾條 ═════════════════════════════════

describe('面板存檔的其他邊界', () => {
  test('**restartNeeded 只列真的變了的欄位**', () => {
    // 面板拿這個清單印「要重開寵物才生效」。送來但沒改到的欄位也列進去的話，
    // 使用者被叫去重開一次什麼都沒變的寵物 —— 面板每按一次儲存就叫一次。
    const p = box({ cleanup: { screenshots: true } })
    const r = applyPatch(p, { cleanup: { screenshots: true }, model: { name: 'qwen3' } }, NO_ENV, {})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.restartNeeded, [], '沒變的欄位不可以叫使用者重開')
    // 成對：真的變了就要列
    assert.deepEqual(applyPatch(p, { cleanup: { screenshots: false } }, NO_ENV, {}).restartNeeded,
      ['cleanup.screenshots'])
  })

  test('**什麼都沒改的那一次不可以動到檔案**', () => {
    // 空的 patch 一樣算一次儲存（不是錯），但它現在會把整份檔案重寫一遍 ——
    // 使用者自己排的版跟縮排就這樣沒了，而且白換一個 inode。
    const text = '{\n      "readonly": false,\n  "comment": "我自己排的版"\n}\n'
    const p = box(text)
    const r = applyPatch(p, {}, NO_ENV, {})
    assert.equal(r.ok, true, '什麼都沒改也算一次儲存，不是錯')
    assert.equal(readFileSync(p, 'utf8'), text, '沒改任何欄位卻把檔案重排版了')
  })

  test('**字串欄位有長度上限**（面板不可以寫出一份幾 MB 的 config.json）', () => {
    // 型別對就收的話，一個貼歪的剪貼簿（整份文件、整個 base64）就變成一份幾 MB 的設定檔，
    // 而每一次啟動、每一次 doctor、每一次面板讀取都要重新解析它。
    for (const patch of [
      { model: { name: 'q'.repeat(513) } },
      { model: { keyEnv: 'CONTEXTBOX_' + 'A'.repeat(513) } },
      { model: { baseUrl: 'https://api.example.com/' + 'a'.repeat(513) } },
    ]) {
      const p = box({})
      const before = bytes(p)
      const r = applyPatch(p, patch, NO_ENV, {})
      assert.equal(r.ok, false, JSON.stringify(patch).slice(0, 60) + ' 應該被拒絕')
      assert.equal(r.code, 'BAD_SETTING')
      assert.match(Object.values(r.fields)[0], /too long/)
      assert.deepEqual(bytes(p), before)
    }
    // 界內成對：剛好到上限要收得下
    assert.equal(applyPatch(box({}), { model: { name: 'q'.repeat(512) } }, NO_ENV, {}).ok, true)
  })

  test('**top-level `__proto__` 要回 400，不是安靜忽略**', () => {
    // `bad['__proto__'] = '…'` 在一般物件上會走進 __proto__ 的 setter，而那個 setter
    // **只收物件**：塞一個字串進去等於什麼都沒發生，Object.keys(bad).length 還是 0，
    // 於是這次 PATCH 退化成一個空的 patch，回 200 saved:true。
    // JSON.parse 會把 `__proto__` 做成自有屬性，所以這條從 HTTP 真的進得來。
    const p = box({ readonly: false })
    const before = bytes(p)
    const r = applyPatch(p, JSON.parse('{"__proto__":{"readonly":true}}'), NO_ENV, {})
    assert.equal(r.ok, false, '白名單以外的鍵一律 400，不是安靜忽略')
    assert.equal(r.code, 'BAD_SETTING')
    assert.equal(typeof r.fields['__proto__'], 'string')
    assert.match(r.fields['__proto__'], /cannot be changed here/)
    assert.deepEqual(bytes(p), before)
  })
})

// ══ HTTP ═════════════════════════════════════════════════

const TOKEN = 'settings-test-token-abc'
let S, base, dir, CFG
let NOCFG, noCfgBase
/** onSettingsSaved 收到的每一份設定。 */
const saved = []

before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-settings-http-')))
  mkdirSync(join(dir, 'Downloads'))
  CFG = join(dir, 'config.json')
  writeFileSync(CFG, JSON.stringify({ readonly: false, comment: '手加的' }, null, 2) + '\n')
  // roots／quarantine／maxBytes／readonly 全部給 —— 不給的話 /health 會去讀使用者真的設定檔。
  // 全部給了就代表 server 自己沒讀過設定檔，所以 configPath 要明講（見 core/server.ts 那一段）。
  S = start({
    port: 0, db: ':memory:', token: TOKEN, roots: [join(dir, 'Downloads')],
    quarantine: join(dir, 'q'), maxBytes: 1e7, readonly: false,
    configPath: CFG, onSettingsSaved: c => saved.push(c),
  })
  base = `http://127.0.0.1:${await S.ready}`
  // 第二台：**沒有**設定檔可改（沒給 configPath，自己也沒讀過設定檔）
  NOCFG = start({
    port: 0, db: ':memory:', token: TOKEN, roots: [join(dir, 'Downloads')],
    quarantine: join(dir, 'q'), maxBytes: 1e7, readonly: false,
  })
  noCfgBase = `http://127.0.0.1:${await NOCFG.ready}`
})
after(() => {
  S?.server.close()
  NOCFG?.server.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (path, { token = TOKEN, origin = 'chrome-extension://abc', at, ...init } = {}) =>
  fetch((at ?? base) + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-contextbox-token': token } : {}),
      ...(origin ? { origin } : {}),
    },
  })

const patch = (body, opts = {}) => call('/settings', { method: 'PATCH', body: JSON.stringify(body), ...opts })

describe('誰可以改', () => {
  test('沒帶 token → 401（GET 與 PATCH 都是）', async () => {
    for (const method of ['GET', 'PATCH']) {
      const r = await call('/settings', { token: null, method, body: method === 'PATCH' ? '{}' : undefined })
      assert.equal(r.status, 401, method)
      await r.arrayBuffer()
    }
  })

  test('**session cookie 只開得了網頁，開不了設定 API**', async () => {
    // 這是既有的不變量（server.test.mjs 也守著）。設定是寫入路徑，更不可以破例。
    const first = await fetch(`${base}/?k=${encodeURIComponent(TOKEN)}`, { headers: { 'sec-fetch-dest': 'document' } })
    const id = /cb_session=([^;]+)/.exec(first.headers.get('set-cookie'))[1]
    await first.text()
    for (const init of [{}, { method: 'PATCH', body: '{"readonly":true}' }]) {
      const r = await fetch(base + '/settings', { ...init, headers: { cookie: `cb_session=${id}` } })
      assert.equal(r.status, 401, JSON.stringify(init))
      await r.arrayBuffer()
    }
    assert.equal(json(CFG).readonly, false, 'cookie 不可以改到設定檔')
  })

  test('惡意網頁就算猜到 token 也進不來', async () => {
    const r = await call('/settings', { origin: 'https://evil.example.com' })
    assert.equal(r.status, 403)
  })

  test('用錯方法 → 405，帶 Allow', async () => {
    const r = await call('/settings', { method: 'POST', body: '{}' })
    assert.equal(r.status, 405)
    assert.equal(r.headers.get('allow'), 'GET, PATCH')
    assert.equal((await r.json()).code, 'BAD_METHOD')
  })
})

describe('GET /settings', () => {
  test('回的形狀就是契約那一份', async () => {
    const r = await call('/settings')
    assert.equal(r.status, 200)
    const s = await r.json()
    assert.deepEqual(Object.keys(s).sort(),
      ['editable', 'keySet', 'live', 'path', 'problems', 'restart', 'shown'].sort())
    assert.deepEqual(Object.keys(s.editable).sort(), ['cleanup', 'model', 'readonly'].sort())
    assert.deepEqual(Object.keys(s.shown).sort(),
      ['cleanupRoots', 'filed', 'maxBytes', 'pdfPages', 'quarantine', 'watch'].sort())
    assert.equal(typeof s.keySet, 'boolean')
    assert.equal(s.editable.readonly, false)
  })

  test('金鑰設在環境變數裡：只說有沒有，值不出現在回應裡', async () => {
    const secret = 'sk-http-' + 'y'.repeat(40)
    process.env.CONTEXTBOX_MODEL_KEY = secret
    try {
      const body = await (await call('/settings')).text()
      assert.ok(!body.includes(secret), '回應裡帶著金鑰')
      assert.equal(JSON.parse(body).keySet, true)
    } finally { delete process.env.CONTEXTBOX_MODEL_KEY }
    assert.equal((await (await call('/settings')).json()).keySet, false)
  })

  test('**沒有設定檔可改的 server：兩條都講清楚，而且不建檔**', async () => {
    // opts 全部給齊時 server 這一輩子沒讀過任何設定檔，它跑的是呼叫端給的值。
    // 那時候還去改 ~/.contextbox/config.json 的話，面板會說「已儲存」而跑著的寵物不理它。
    for (const method of ['GET', 'PATCH']) {
      const r = await call('/settings', { at: noCfgBase, method, body: method === 'PATCH' ? '{"readonly":true}' : undefined })
      assert.equal(r.status, 500, method)
      const b = await r.json()
      assert.equal(b.code, 'BAD_CONFIG')
      assert.match(b.error, /without a config file/)
    }
    assert.equal(existsSync(join(FAKE_HOME, '.contextbox')), false, '不可以順手建一份')
  })
})

describe('PATCH /settings', () => {
  test('存得進去，回 saved／settings／restartNeeded，而且叫了 onSettingsSaved', async () => {
    const was = saved.length
    const r = await patch({ model: { name: 'qwen3-27b' } })
    assert.equal(r.status, 200)
    const b = await r.json()
    assert.equal(b.saved, true)
    assert.equal(b.settings.editable.model.name, 'qwen3-27b')
    assert.deepEqual(b.restartNeeded, [], 'model.* 是立刻生效的那一組')
    assert.equal(json(CFG).model.name, 'qwen3-27b')
    assert.equal(json(CFG).comment, '手加的', '手加的欄位還在')
    assert.equal(saved.length, was + 1, '寵物要知道自己的設定被改了')
    assert.equal(saved.at(-1).model.name, 'qwen3-27b')
  })

  test('restartNeeded 逐欄講實話', async () => {
    const b = await (await patch({ cleanup: { screenshots: true }, readonly: false })).json()
    assert.deepEqual(b.restartNeeded, ['cleanup.screenshots'])
    await patch({ cleanup: { screenshots: false } })
  })

  test('白名單以外的鍵 → 400 BAD_SETTING，檔案不動', async () => {
    const before = bytes(CFG)
    const r = await patch({ cleanup: { roots: ['/'] } })
    assert.equal(r.status, 400)
    const b = await r.json()
    assert.equal(b.code, 'BAD_SETTING')
    assert.match(b.fields['cleanup.roots'], /cannot be changed here/)
    assert.deepEqual(bytes(CFG), before)
  })

  test('這次改的欄位壞掉 → 400，檔案不動', async () => {
    const before = bytes(CFG)
    const r = await patch({ model: { baseUrl: 'http://8.8.8.8/v1' } })
    assert.equal(r.status, 400)
    assert.match((await r.json()).fields['model.baseUrl'], /not safe/)
    assert.deepEqual(bytes(CFG), before)
  })

  test('body 看不懂 → 400 BAD_BODY（server 那一關），檔案不動', async () => {
    const before = bytes(CFG)
    const r = await call('/settings', { method: 'PATCH', body: '{ 壞掉的 JSON' })
    assert.equal(r.status, 400)
    assert.equal((await r.json()).code, 'BAD_BODY')
    assert.deepEqual(bytes(CFG), before)
  })

  test('**兩個面板同時 PATCH 不同欄位，兩邊都留得住**', async () => {
    await patch({ readonly: false, model: { name: 'before' } })
    const [a, b] = await Promise.all([
      patch({ readonly: true }),
      patch({ model: { name: 'after' } }),
    ])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    await a.json(); await b.json()
    const after = json(CFG)
    assert.equal(after.readonly, true)
    assert.equal(after.model.name, 'after')
    assert.equal(after.comment, '手加的')
  })

  test('**被退回的那一次，金鑰不出這條 HTTP**（貼進端點那一格的情況）', async () => {
    // 不變量 2 包含**失敗**的那一次。函式那一條在上面，這一條走整條線
    //（server → JSON → 瀏覽器），因為外洩是發生在回應本體上，不是在回傳值上。
    // 2026-09-20 的突變測試：只把 400 那一處的 scrub 拿掉，全套 2815 條照樣全綠。
    const secret = 'sk-live-9f3aQxR7ZtLm42PdV8bKcY6w'
    for (const raw of [secret, '  ' + secret + '  ', 'http://' + secret]) {
      const before = bytes(CFG)
      const r = await patch({ model: { baseUrl: raw } })
      assert.equal(r.status, 400, raw)
      const text = await r.text()
      assert.ok(!text.includes(secret), '400 的回應裡帶著金鑰：' + text)
      assert.ok(!text.includes(secret.toLowerCase()), '400 的回應裡帶著小寫版金鑰：' + text)
      assert.ok(!text.includes(secret.slice(0, 16)), '400 的回應裡帶著半截金鑰：' + text)
      assert.equal(JSON.parse(text).code, 'BAD_SETTING')
      assert.deepEqual(bytes(CFG), before)
    }
  })

  test('唯讀開著也改得動設定（關不掉的開關是陷阱）', async () => {
    assert.equal(json(CFG).readonly, true, '前提：現在是唯讀')
    const r = await patch({ readonly: false })
    assert.equal(r.status, 200)
    await r.json()
    assert.equal(json(CFG).readonly, false)
  })
})

test('**跑完不可以在家目錄留下任何東西**', () => {
  // 放在最後：前面每一條都跑過了，還是乾淨的才算數。
  assert.equal(existsSync(join(FAKE_HOME, '.contextbox')), false,
    '測試在家目錄建了 .contextbox —— 有路徑去讀（甚至建立）了使用者真的設定檔')
})
