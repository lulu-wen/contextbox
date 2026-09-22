/**
 * 設定的測試。
 *
 * 這支檔案原本一條測試都沒有 —— 而兩個會讓整個產品靜默停擺的問題
 * 剛好都落在這裡。不是巧合。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import { rmTmp } from './helpers/rm.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { normalize, load, defaults, osDefaults, expand, modelKey } from '../core/config.ts'

let root
before(() => { root = mkdtempSync(join(tmpdir(), 'cb-config-')) })
after(() => rmTmp(root))

let n = 0
const tmp = () => {
  const d = join(root, 'case' + n++)
  mkdirSync(d, { recursive: true })
  return d
}

describe('監看與歸檔資料夾', () => {
  test('歸檔資料夾在監看資料夾底下：警告，但不可以把監看資料夾拿掉', () => {
    // 以前這裡把整個 watch root 移除，所以設 filed=~/Downloads/Filed
    // （很自然的設法）會讓 ~/Downloads 整個不看了，而訊息說的是另一回事。
    const d = tmp()
    const dl = join(d, 'Downloads')
    mkdirSync(dl, { recursive: true })
    const r = normalize({ watch: [dl], filed: join(dl, 'Filed') })

    assert.deepEqual(r.config.watch, [dl], '監看資料夾一定要留著')
    assert.ok(r.problems.some(p => /exclude/.test(p)), '要說明歸檔的會被排除掉')
  })

  test('歸檔資料夾在**清理**資料夾底下：要出聲（不然「整理好的不再被提議清理」不成立）', () => {
    // 稽核（2026-09-20）：watch 那一邊有警告，cleanup.roots 這一邊沒有，
    // 而 filed=~/Downloads/Filed 是很自然的設法 —— 那樣搬進去的檔過一陣子又會被列成候選。
    const d = tmp()
    const dl = join(d, 'Downloads')
    mkdirSync(dl, { recursive: true })
    const r = normalize({ cleanup: { roots: [dl] }, filed: join(dl, 'Filed') })
    assert.deepEqual(r.config.cleanup.roots, [dl], '清理資料夾一定要留著（只出聲，不改設定）')
    assert.ok(r.problems.some(p => /cleanup folders/.test(p) && /cleanup candidates/.test(p)), JSON.stringify(r.problems))
  })

  test('歸檔資料夾跟清理資料夾分開的時候不要亂警告', () => {
    const d = tmp()
    const dl = join(d, 'Downloads')
    const filed = join(d, 'Filed')
    mkdirSync(dl, { recursive: true })
    mkdirSync(filed, { recursive: true })
    const r = normalize({ cleanup: { roots: [dl] }, filed, watch: [dl] })
    assert.equal(r.problems.filter(p => /清理候選/.test(p)).length, 0, JSON.stringify(r.problems))
  })

  test('監看資料夾在歸檔資料夾底下：要出聲，不然等於白看', () => {
    const d = tmp()
    const filed = join(d, 'Filed')
    const w = join(filed, 'Inbox')
    mkdirSync(w, { recursive: true })
    const r = normalize({ watch: [w], filed })
    assert.ok(r.problems.some(p => /nothing is watched/.test(p)))
  })

  test('同一個資料夾寫兩次只算一次', () => {
    const d = tmp()
    assert.equal(normalize({ watch: [d, d, d] }).config.watch.length, 1)
  })

  test('watch 寫壞了就退回預設值並出聲', () => {
    const r = normalize({ watch: 'not-an-array' })
    assert.ok(r.config.watch.length > 0)
    assert.ok(r.problems.some(p => /The watch setting could not be read/.test(p)))
  })

  test('歸檔資料夾不可以是家目錄或金鑰資料夾', () => {
    for (const bad of [homedir(), join(homedir(), '.ssh', 'Filed')]) {
      const r = normalize({ filed: bad })
      assert.notEqual(r.config.filed, bad, bad + ' 不該被接受')
      assert.ok(r.problems.length > 0, bad + ' 要出聲')
    }
  })
})

describe('金鑰只能放在我們自己的環境變數裡', () => {
  test('別人的環境變數一律拒絕', () => {
    // 設定檔是「會被備份、會被貼到聊天室」的東西。它雖然不放金鑰，
    // 但它可以指定去讀哪一個環境變數 —— 那等於一條把憑證送出去的路。
    for (const bad of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'PATH', 'a b c']) {
      const r = normalize({ model: { keyEnv: bad } })
      assert.equal(r.config.model.keyEnv, 'CONTEXTBOX_MODEL_KEY', bad + ' 不該被接受')
      assert.ok(r.problems.some(p => /CONTEXTBOX_/.test(p)))
    }
  })

  test('**使用者把金鑰本身填進 keyEnv 時，不可以把它印回去**（2026-09-20 真的發生了）', () => {
    // 那一欄要的是「環境變數的名字」，但很容易被讀成「把金鑰放這裡」。
    // 使用者真的貼了金鑰進去，而警告訊息把它整串印在 doctor 的畫面上 ——
    // 於是那把金鑰進了終端機歷史、截圖、以及他複製貼上的每一個地方。
    const key = 'bsa_' + 'x'.repeat(40)
    const r = normalize({ model: { keyEnv: key } })
    const all = r.problems.join('\n')
    assert.ok(!all.includes(key), `警告訊息把金鑰印出來了：${all}`)
    assert.ok(!all.includes('x'.repeat(10)), all)
    assert.match(all, /not the key itself/i, '要講清楚那一欄放的是名字')
    assert.match(all, /rotate/i, '已經寫進檔案的金鑰要叫他換掉')
    assert.equal(r.config.model.keyEnv, 'CONTEXTBOX_MODEL_KEY', '退回預設的名字')
  })

  test('只是打錯名字（短、像個變數名）→ 照舊講規則就好', () => {
    const r = normalize({ model: { keyEnv: 'MY_KEY' } })
    assert.match(r.problems.join('\n'), /must start with CONTEXTBOX_/)
  })

  test('CONTEXTBOX_ 開頭的可以', () => {
    const r = normalize({ model: { keyEnv: 'CONTEXTBOX_OTHER_KEY' } })
    assert.equal(r.config.model.keyEnv, 'CONTEXTBOX_OTHER_KEY')
    assert.deepEqual(r.problems, [])
  })

  test('modelKey 讀的是環境變數，不是設定檔', () => {
    process.env.CONTEXTBOX_TEST_KEY = 'sk-abc'
    try {
      const { config } = normalize({ model: { keyEnv: 'CONTEXTBOX_TEST_KEY' } })
      assert.equal(modelKey(config), 'sk-abc')
    } finally { delete process.env.CONTEXTBOX_TEST_KEY }
  })
})

describe('模型網址', () => {
  test('https 到哪都行；明文 http 只准打自己內網', () => {
    for (const good of [
      'https://api.example.com/v1',
      'http://127.0.0.1:8000/v1',
      'http://localhost:8000/v1',
      'http://100.64.0.1/v1',                // CGNAT 網段（Tailscale 這類內網就落在這裡）
      'http://192.168.1.50:8000/v1',
      'http://10.0.0.5/v1',
      'http://172.16.3.9/v1',
    ]) {
      const r = normalize({ model: { baseUrl: good } })
      assert.equal(r.config.model.baseUrl, good.replace(/\/+$/, ''), good + ' 應該收')
    }
  })

  test('明文送到網際網路上的主機一律拒絕', () => {
    for (const bad of ['http://evil.example/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1',
                       'file:///etc/passwd', 'javascript:alert(1)', '不是網址']) {
      const r = normalize({ model: { baseUrl: bad } })
      assert.equal(r.config.model.baseUrl, '', bad + ' 不該被接受')
      assert.ok(r.problems.length > 0, bad + ' 要出聲')
    }
  })

  test('**讀不懂的網址不可以被原樣印回去**（那一格常被貼進金鑰）', () => {
    // 2026-09-20 稽核：keyEnv 那一欄早就只講規則、不回放值了（同一支檔 383-386 行），
    // baseUrl 這一欄卻還在 `The model URL ${raw} could not be read` 裡把整串原文印出去。
    // 而「貼錯格子」正是那天早上 doctor 把使用者的金鑰印到終端機的那一個動作。
    // 這一行是根，下游（settings.ts 的 scrub、cli 的 showProblems）每一層都只是在補它。
    const key = 'sk-live-9f3aQxR7ZtLm42PdV8bKcY6w'
    for (const raw of [key, '  ' + key + '  ', 'not a url ' + key]) {
      const r = normalize({ model: { baseUrl: raw } })
      const all = r.problems.join(' / ')
      assert.ok(!all.includes(key), `problems 把整串印出來了：${all}`)
      assert.ok(!all.includes(key.slice(0, 16)), `連半截都不可以留：${all}`)
      assert.ok(r.problems.some(p => /model URL/.test(p)), '還是要講那一欄讀不懂')
      assert.equal(r.config.model.baseUrl, '')
    }
  })

  test('網址裡的帳號密碼要拿掉', () => {
    const r = normalize({ model: { baseUrl: 'https://user:pw@api.example.com/v1' } })
    assert.ok(!r.config.model.baseUrl.includes('pw'), '不要把密碼留在設定裡')
    assert.ok(r.problems.some(p => /username and password/.test(p)))
  })
})

describe('數字欄位', () => {
  test('超出範圍就退回預設值並出聲，不要安靜夾擠', () => {
    // 以前 maxBytes:0 會被夾成 1024，然後每個檔案都回
    // 「檔案 0.0MB，超過上限 0MB」，而 doctor 顯示一切正常。
    const d = defaults()
    for (const v of [0, -5, 'x', 1e12]) {
      const r = normalize({ maxBytes: v })
      assert.equal(r.config.maxBytes, d.maxBytes, `maxBytes=${v} 要退回預設`)
      assert.ok(r.problems.some(p => /maxBytes/.test(p)))
    }
    assert.equal(normalize({ pdfPages: 99 }).config.pdfPages, d.pdfPages)
    assert.equal(normalize({ pdfPages: 5 }).config.pdfPages, 5)
  })
})

describe('讀檔', () => {
  test('第一次跑會寫一份預設設定，並如實回報', () => {
    const p = join(tmp(), 'config.json')
    const r = load(p)
    assert.equal(r.created, true)
    assert.equal(existsSync(p), true)
    assert.equal(load(p).created, false, '第二次就不是新建的了')
  })

  test('寫不出來的時候要講，不可以謊報「幫你建了一份」', () => {
    const d = tmp()
    chmodSync(d, 0o500)
    try {
      const r = load(join(d, 'config.json'))
      assert.equal(r.created, false, '沒寫成功就不可以說建好了')
      assert.ok(r.problems.some(p => /could not be written/.test(p)))
    } finally { chmodSync(d, 0o700) }
  })

  test('JSON 壞掉：用預設值跑，而且不覆蓋使用者的檔案', () => {
    const p = join(tmp(), 'config.json')
    writeFileSync(p, '{ 這不是 JSON')
    const r = load(p)
    assert.ok(r.problems.some(x => /could not be read/.test(x)))
    assert.equal(r.config.watch.length > 0, true)
    assert.equal(readFileSync(p, 'utf8'), '{ 這不是 JSON', '不可以覆蓋掉')
  })

  test('**JSON 壞掉的那一句不可以把檔案內容貼出來**', () => {
    // V8 的 JSON SyntaxError 會附上出錯位置前後約十個位元組的原文
    //（`Unexpected token 's', "sk-live-9f"... is not valid JSON`）。
    // 設定檔第一行就是金鑰的時候 —— 貼錯地方、或者存成了 .env 的樣子 —— 那十個位元組就是它，
    // 而 load() 的 problems 會被 doctor／think／watch 整段印到終端機上。
    const key = 'sk-live-9f3aQxR7ZtLm42PdV8bKcY6w'
    const p = join(tmp(), 'config.json')
    writeFileSync(p, key + '\n')
    const r = load(p)
    const all = r.problems.join(' / ')
    assert.ok(!all.includes('sk-live'), `問題訊息帶著檔案內容：${all}`)
    assert.ok(/could not be read/.test(all), '還是要講這份檔讀不懂')
    assert.equal(readFileSync(p, 'utf8'), key + '\n', '不可以覆蓋掉')
  })
})

describe('路徑展開', () => {
  test('~ 與 %USERPROFILE%', () => {
    assert.equal(expand('~'), homedir())
    assert.equal(expand('~/Downloads'), join(homedir(), 'Downloads'))
    assert.equal(expand('%USERPROFILE%/Pictures'), join(homedir(), 'Pictures'))
  })
})

describe('各作業系統的預設值', () => {
  test('Windows 看 Pictures\\Screenshots 與 Downloads', () => {
    const w = osDefaults('win32', 'C:\\Users\\lulu')
    assert.equal(w.watch.length, 2)
    assert.ok(w.watch[0].includes('Screenshots'), '使用者的截圖是在 Windows 上拍的')
    assert.ok(w.watch[1].includes('Downloads'))
  })

  test('macOS 的截圖預設落在桌面', () => {
    assert.ok(osDefaults('darwin', '/Users/lulu').watch[0].includes('Desktop'))
  })
})

describe('唯讀模式', () => {
  test('環境變數也可以開', () => {
    process.env.CONTEXTBOX_READONLY = '1'
    try { assert.equal(normalize({}).config.readonly, true) }
    finally { delete process.env.CONTEXTBOX_READONLY }
  })

  test('**環境變數壓過檔案的時候要講出來**', () => {
    // 以前這裡第一行就 return true，什麼都不講：面板把打勾取消、存檔成功、
    // 回「Read-only mode. It is in effect now.」，而唯讀其實還開著。
    // 使用者以為自己關掉了保護，下一次清理卻什麼都不做，而沒有任何一句話說得出為什麼。
    process.env.CONTEXTBOX_READONLY = '1'
    try {
      const clash = normalize({ readonly: false })
      assert.equal(clash.config.readonly, true, '安全開關還是以環境變數為準')
      assert.ok(clash.problems.some(p => /CONTEXTBOX_READONLY/.test(p)),
        '沒說是誰壓著它：' + clash.problems.join(' / '))
      // 沒有衝突的兩種情況不要囉嗦
      for (const raw of [{}, { readonly: true }]) {
        assert.ok(!normalize(raw).problems.some(p => /CONTEXTBOX_READONLY/.test(p)), JSON.stringify(raw))
      }
    } finally { delete process.env.CONTEXTBOX_READONLY }
  })

  test('正常的 true／false', () => {
    assert.equal(normalize({ readonly: true }).config.readonly, true)
    assert.equal(normalize({ readonly: false }).config.readonly, false)
    assert.equal(normalize({}).config.readonly, false)
  })

  test('**型別寫錯要倒向安全那一邊，而且要出聲**', () => {
    // 這是安全開關。數字欄位壞掉會退回預設值並出聲，這個以前什麼都不做，
    // 而且退回的方向是「把保護關掉」—— readonly:"true" 靜靜變成 false。
    for (const v of ['true', 'yes', 1, {}]) {
      const r = normalize({ readonly: v })
      assert.equal(r.config.readonly, true, `readonly=${JSON.stringify(v)} 要當成開著`)
      assert.ok(r.problems.some(p => /readonly/.test(p)), `readonly=${JSON.stringify(v)} 要出聲`)
    }
  })
})

describe('監看資料夾也要檢查', () => {
  test('指到家目錄或根目錄要出聲', () => {
    for (const bad of [homedir(), '/']) {
      const r = normalize({ watch: [bad] })
      assert.ok(r.problems.some(p => /watched folder/.test(p)), bad + ' 要出聲')
    }
  })
})
