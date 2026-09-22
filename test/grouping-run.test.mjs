import './helpers/isolate-home.mjs'   // 一定要第一個 import
/**
 * 分類真的跑起來（P7）。規格：docs/grouping-spec.md
 *
 * `test/grouping.test.mjs` 守純邏輯，這一支守**有副作用的那半邊**：
 *
 *   · 一個檔都不動（規格第 8 條）—— `group` 是提議，不是動作
 *   · 送出去的東西不含檔名、不含 evidence、不含原文（規格「送出去的東西」第 1 條）
 *   · 對照表整份取代，不累積（第 11 條）
 *   · 一批壞掉不會拖垮其他批；全部壞掉就**一個字都不寫**
 *   · 沒對到的數字加得起來（第 6 條）
 *
 * **全部打假的本機模型伺服器**，一次都不打真的模型、也不讀真的金鑰。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open as openDb } from '../core/db.ts'
import { putModelView, viewKey } from '../core/model-store.ts'
import { PROMPT_VERSION } from '../core/model.ts'
import { cleanGroupName, mergePhraseGroups, carryOver, phraseMessages } from '../core/grouping.ts'
import {
  PHRASE_BATCH, parseGroupAnswer, readGroupMap, runGrouping, writeGroupMap,
} from '../core/grouping-run.ts'
import { applyFilings, filingSuggestions, groupFolderFor } from '../core/filing.ts'
import { startFakeModel } from './helpers/fake-model.mjs'
import { rmTmp } from './helpers/rm.mjs'

const KEY_ENV = 'CONTEXTBOX_MODEL_KEY'
const FAKE_KEY = 'fake-key-for-tests-0123456789'
const DAY = 86400_000

const cfg = (baseUrl, name = 'fake-model') => ({
  watch: [], filed: '', readonly: false, pdfPages: 3, maxBytes: 1 << 20,
  cleanup: { roots: [], screenshots: false, screenshotsDir: null },
  model: { baseUrl, name, keyEnv: KEY_ENV },
})

function withKey(t, value) {
  const before = process.env[KEY_ENV]
  if (value === null) delete process.env[KEY_ENV]
  else process.env[KEY_ENV] = value
  t.after(() => { if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before })
}

/** 包成 chat completion 的樣子。 */
const answer = groups => ({
  id: 'chatcmpl-fake', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ groups }) }, finish_reason: 'stop' }],
})

/**
 * 沙盒：真的資料庫、真的檔案、假的模型。
 *
 * `whatItIs` 直接寫進 model_views（這一期測的是分類，不是逐檔怎麼問）。
 */
function sandbox(t, files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-group-')))
  const downloads = join(dir, 'Downloads')
  const filed = join(dir, 'Filed')
  mkdirSync(downloads)
  mkdirSync(filed)
  const db = openDb(join(dir, 'data.db'))
  t.after(() => { db.close(); rmTmp(dir) })

  const at = new Date(Date.now() - DAY).toISOString()
  files.forEach(([name, whatItIs, over = {}], i) => {
    const path = join(downloads, name)
    writeFileSync(path, 'x'.repeat(200))
    // 剛剛才動過的檔不會被歸檔（十分鐘的保護期），所以把時間往回調一天
    const old = new Date(Date.now() - DAY)
    utimesSync(path, old, old)
    const id = 'item-' + i
    db.prepare(
      `INSERT INTO file_items (id, path, name, ext, bytes, status, first_seen_at, last_seen_at, mtime, sha256, naming)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, path, name, name.slice(name.lastIndexOf('.')), 200, 'candidate', at, at, at, 'sha-' + i, 'named')
    putModelView(db, {
      key: viewKey(name + '::' + whatItIs, PROMPT_VERSION),
      item_id: id, source: 'text',
      course: over.course ?? 'Unknown', topic: 'Unknown', kind: 'Other',
      suggested_name: name, what_it_is: whatItIs, subject: '', evidence: '',
      confidence: over.confidence ?? 'high',
      model: 'fake-model', prompt_version: PROMPT_VERSION, at, seeded: 0,
    })
  })

  const scope = { roots: [downloads], filed, quarantine: join(dir, 'Quarantine'), readonly: false }
  return { dir, downloads, filed, db, scope, names: () => readdirSync(downloads).sort() }
}

// ═══ 模型回的東西怎麼讀 ═══════════════════════════════════════

describe('parseGroupAnswer：只修跳脫，不發明', () => {
  test('正常的一筆', () => {
    const got = parseGroupAnswer(JSON.stringify({ groups: [{ name: 'Resumes', why: 'x', members: [1] }] }))
    assert.equal(got.length, 1)
    assert.equal(got[0].name, 'Resumes')
  })

  // 2026-09-21 的教訓：表格與投影片抄出來的引文很常帶裸 TAB，
  // 那一個字元就讓 JSON.parse 失敗、整筆答案被當成失敗
  test('理由裡有一個裸 TAB 還是讀得回來', () => {
    const raw = '{"groups":[{"name":"Resumes","why":"CV\tand cover letters","members":[1]}]}'
    assert.throws(() => JSON.parse(raw))
    const got = parseGroupAnswer(raw)
    assert.equal(got.length, 1)
    assert.match(got[0].why, /CV/)
  })

  test('壞掉、不是陣列、空的 → 空陣列，不丟例外', () => {
    for (const bad of ['', '   ', 'not json', '{"groups":"nope"}', '{"nope":[]}', '[]', null, undefined, 42]) {
      assert.deepEqual(parseGroupAnswer(bad), [], `${JSON.stringify(bad)} 應該是空陣列`)
    }
  })

  test('**被切成半截的答案是失敗，不是半筆資料**', () => {
    // 實機真的發生過：177 種說法一次問，回答在 max_tokens 被切掉
    const cut = '{"groups":[{"name":"Technical Reports","why":"x","members":[18, 26, 30'
    assert.deepEqual(parseGroupAnswer(cut), [])
  })
})

// ═══ 對照表 ═══════════════════════════════════════════════════

describe('對照表：整份取代，一個交易', () => {
  test('寫得進去、讀得回來，照涵蓋說法多的排前面', t => {
    const s = sandbox(t, [])
    writeGroupMap(s.db, [
      { name: 'Resumes', why: 'CVs', phrases: ['resume'] },
      { name: 'Exams', why: 'tests', phrases: ['exam', 'exam question', 'past paper'] },
    ])
    const map = readGroupMap(s.db)
    assert.deepEqual(map.map(g => g.folder), ['Exams', 'Resumes'])
    assert.equal(map[0].phrases.length, 3)
    assert.equal(map[1].why, 'CVs')
  })

  // 規格第 11 條：重新分類會整份取代，不會累積出兩份互相矛盾的
  test('**再寫一次是取代，不是疊上去**', t => {
    const s = sandbox(t, [])
    writeGroupMap(s.db, [{ name: 'Resumes', why: '', phrases: ['resume', 'cv'] }])
    writeGroupMap(s.db, [{ name: 'Exams', why: '', phrases: ['exam'] }])
    const map = readGroupMap(s.db)
    assert.deepEqual(map.map(g => g.folder), ['Exams'])
    assert.equal(groupFolderFor(s.db, 'resume'), '', '上一輪的說法還留著')
  })

  test('一個說法只會對到一個資料夾', t => {
    const s = sandbox(t, [])
    writeGroupMap(s.db, [
      { name: 'Resumes', why: '', phrases: ['resume'] },
      { name: 'Applications', why: '', phrases: ['resume'] },
    ])
    assert.equal(readGroupMap(s.db).length, 1)
    assert.equal(groupFolderFor(s.db, 'Resume '), 'Applications', '後寫的蓋過前面的，但只有一個')
  })
})

// ═══ 一批一批問 ═══════════════════════════════════════════════

describe('runGrouping：問一批、收一批', () => {
  const many = n => Array.from({ length: n }, (_, i) => [`f${i}.pdf`, `kind ${i}`])

  test('**送出去的東西不含檔名、不含原文**', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, [['Peng-Ju_Wen_CV_1.docx', 'resume'], ['secret-plan.pdf', 'project proposal']])
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method === 'POST' && String(req.url).endsWith('/chat/completions')) {
        send(200, answer([{ name: 'Resumes', why: 'CVs', members: [1, 2] }]))
        return true
      }
      return false
    })
    await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    const posts = fake.requests.filter(r => r.method === 'POST')
    assert.equal(posts.length, 1, '一批就是一次呼叫')
    const sent = posts[0].raw
    assert.ok(!sent.includes('Peng-Ju_Wen_CV_1'), '檔名被送出去了')
    assert.ok(!sent.includes('secret-plan'), '檔名被送出去了')
    assert.ok(!sent.includes('xxxxxxxxxx'), '檔案內容被送出去了')
    assert.ok(sent.includes('resume'), '說法本身要送')
  })

  test('**一個檔都不動**', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, [['a.pdf', 'resume'], ['b.pdf', 'exam']])
    const before = s.names()
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method === 'POST') { send(200, answer([{ name: 'Resumes', why: '', members: [1, 2] }])); return true }
      return false
    })
    const r = await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    assert.equal(r.ok, true)
    assert.deepEqual(s.names(), before, 'group 搬了檔案')
    assert.deepEqual(readdirSync(s.filed), [], 'group 在 filed 底下建了東西')
  })

  test('超過一批就分批問，而且把已經有的資料夾名帶上去', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, many(PHRASE_BATCH + 5))
    let nth = 0
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method !== 'POST') return false
      nth++
      send(200, answer([{ name: nth === 1 ? 'Reports' : 'Reports', why: '', members: [1] }]))
      return true
    })
    await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    const posts = fake.requests.filter(r => r.method === 'POST')
    assert.equal(posts.length, 2, `${PHRASE_BATCH + 5} 種說法應該分成兩批`)
    assert.ok(!posts[0].raw.includes('already made'), '第一批不該有「已經做過的資料夾」')
    assert.ok(posts[1].raw.includes('Reports'), '第二批要看得到第一批取的名字')
  })

  // 跟逐檔同一條規矩：一個壞掉不會拖垮其他九個
  test('一批壞掉，其他批照樣寫得進去', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, many(PHRASE_BATCH + 5))
    let nth = 0
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method !== 'POST') return false
      nth++
      if (nth === 1) { send(500, { error: 'nope' }); return true }
      send(200, answer([{ name: 'Reports', why: 'r', members: [1] }]))
      return true
    })
    const r = await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    assert.equal(r.ok, true, '一批壞掉不該讓整件事失敗')
    assert.equal(r.asked, 1)
    assert.ok(r.error, '壞掉的那一批要講出來')
    assert.deepEqual(readGroupMap(s.db).map(g => g.folder), ['Reports'])
  })

  test('**全部壞掉就一個字都不寫**，舊的對照表還在', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, [['a.pdf', 'resume']])
    writeGroupMap(s.db, [{ name: 'FromLastTime', why: '', phrases: ['resume'] }])
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method !== 'POST') return false
      send(500, { error: 'nope' })
      return true
    })
    const r = await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    assert.equal(r.ok, false)
    assert.equal(r.asked, 0)
    assert.deepEqual(readGroupMap(s.db).map(g => g.folder), ['FromLastTime'])
  })

  test('模型沒設定 → 失敗，而且一個請求都不發', async t => {
    withKey(t, '')
    const s = sandbox(t, [['a.pdf', 'resume']])
    const fake = await startFakeModel(t)
    const r = await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    assert.equal(r.ok, false)
    assert.deepEqual(fake.requests, [])
  })

  // 規格第 6 條：沒對到的不可以安靜消失
  test('沒對到的說法算得出來，數字加得起來', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, [['a.pdf', 'resume'], ['b.pdf', 'exam'], ['c.pdf', 'sprite sheet']])
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method !== 'POST') return false
      send(200, answer([{ name: 'Resumes', why: '', members: [1] }]))
      return true
    })
    const r = await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    assert.equal(r.ok, true)
    const matched = r.groups.flatMap(g => g.phrases).length
    assert.equal(matched + r.unmatched.length, r.phrases.length,
      '分到的加上沒分到的要等於總數')
    assert.equal(r.files, 3)
    assert.equal(r.speechless, 0)
  })

  test('課名說得出來的檔不進分類那一份', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, [
      ['a.pdf', 'lecture handout', { course: '作業系統' }],
      ['b.pdf', 'resume'],
    ])
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method !== 'POST') return false
      send(200, answer([{ name: 'Resumes', why: '', members: [1] }]))
      return true
    })
    const r = await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    assert.equal(r.files, 1, '有課名的檔不該走分類這條路')
    assert.deepEqual(r.phrases.map(p => p.phrase), ['resume'])
  })

  // 使用者（2026-09-21）：a folder that could hold anything is not a folder
  test('**什麼都裝得下的名字整組丟掉**，它的說法算沒對到', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, [['a.pdf', 'resume'], ['b.pdf', 'terminal session log']])
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method !== 'POST') return false
      send(200, answer([
        { name: 'Resumes', why: '', members: [1] },
        { name: 'Miscellaneous', why: 'things that do not fit', members: [2] },
      ]))
      return true
    })
    const r = await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    assert.deepEqual(r.groups.map(g => g.name), ['Resumes'])
    assert.ok(r.unmatched.includes('terminal session log'))
    assert.equal(groupFolderFor(s.db, 'terminal session log'), '')
  })
})

// ═══ 分完之後真的搬得動 ═══════════════════════════════════════

describe('分完之後：課名說不出來的檔也有資料夾可以放', () => {
  test('**整條線**：分類 → 建議 → 搬進去', async t => {
    withKey(t, FAKE_KEY)
    const s = sandbox(t, [['Peng-Ju_Wen_CV_1.docx', 'resume'], ['midterm.pdf', 'exam']])
    const fake = await startFakeModel(t, ({ req, send }) => {
      if (req.method !== 'POST') return false
      send(200, answer([
        { name: 'Resumes', why: 'CVs and cover letters', members: [1] },
        { name: 'Exams', why: 'tests', members: [2] },
      ]))
      return true
    })
    const r = await runGrouping(s.db, cfg(fake.baseUrl), s.scope)
    assert.equal(r.ok, true)

    // 分類那一步**還沒有搬任何東西**
    assert.deepEqual(s.names(), ['Peng-Ju_Wen_CV_1.docx', 'midterm.pdf'].sort())

    const list = filingSuggestions(s.db, s.scope)
    const grouped = list.items.filter(i => !i.course && i.toFolder)
    assert.equal(grouped.length, 2, '兩個都該有去處了')
    for (const g of grouped) assert.ok(g.whatItIs, '畫面要講得出「它說這是什麼」')

    // **這是這一期的重點，也是 CLI 先前漏掉的那一行**：這幾個檔的 course 是空的，
    // 不把 folder 帶下去就會被「沒有可用的課名」那一關擋掉 —— 畫面上明明列得出去處，
    // 按下去卻什麼都沒搬。先把那個壞結果釘住：
    const without = applyFilings(s.db, grouped.map(g => ({ itemId: g.itemId })), s.scope)
    assert.deepEqual(without.results.map(o => o.ok), [false, false])
    for (const o of without.results) assert.match(o.why, /no usable course name/)
    assert.deepEqual(readdirSync(s.filed), [], '擋下來的時候不該留下半個資料夾')

    const applied = applyFilings(
      s.db, grouped.map(g => ({ itemId: g.itemId, folder: g.toFolder })), s.scope)
    assert.deepEqual(applied.results.map(o => o.ok), [true, true],
      applied.results.map(o => o.why).join(' / '))
    assert.deepEqual(readdirSync(s.filed).sort(), ['Exams', 'Resumes'])
    assert.deepEqual(s.names(), [], '原本的資料夾應該空了')
  })

  test('沒有對照表的時候，那些檔就是沒有去處（不亂塞）', t => {
    const s = sandbox(t, [['a.pdf', 'resume']])
    const list = filingSuggestions(s.db, s.scope)
    assert.deepEqual(list.items, [])
  })
})

// ═══ 併批 ═════════════════════════════════════════════════════

describe('mergePhraseGroups：好幾批併成一份', () => {
  test('資料夾名折大小寫，不會在磁碟上變成兩個', () => {
    const got = mergePhraseGroups([
      { name: 'Research papers', why: 'papers', phrases: ['research paper'] },
      { name: 'research Papers', why: '', phrases: ['conference paper'] },
    ])
    assert.equal(got.length, 1)
    assert.equal(got[0].name, 'Research papers', '留第一次出現的寫法')
    assert.equal(got[0].why, 'papers')
    assert.deepEqual(got[0].phrases, ['research paper', 'conference paper'])
  })

  test('跨批也是一個說法只進一組', () => {
    const got = mergePhraseGroups([
      { name: 'A', why: '', phrases: ['resume'] },
      { name: 'B', why: '', phrases: ['resume'] },
    ])
    assert.deepEqual(got.map(g => g.name), ['A'])
  })

  test('名字洗不出來、或一個說法都不剩 → 整組不見', () => {
    const got = mergePhraseGroups([
      { name: '../../etc', why: '', phrases: ['x'] },
      { name: 'CON', why: '', phrases: ['y'] },
      { name: 'Misc', why: '', phrases: ['z'] },
      { name: 'Real', why: '', phrases: [] },
    ])
    assert.deepEqual(got.map(g => g.name), ['etc'], 'CON、Misc 與空的都該不見')
  })
})

describe('carryOver：帶名字給下一批', () => {
  test('沒有就是空字串（第一批不該多一段話）', () => {
    assert.equal(carryOver([]), '')
    assert.equal(carryOver(['', '   ', 'CON']), '', '洗不出來的名字不該撐出一段話')
  })

  test('有就講出來，而且不重複', () => {
    const s = carryOver(['Resumes', 'Resumes', 'Exams'])
    assert.match(s, /Resumes/)
    assert.match(s, /Exams/)
    assert.equal(s.split('Resumes').length - 1, 1)
  })

  test('phraseMessages 帶了名字才會多那一段', () => {
    const rows = [{ phrase: 'resume', count: 2 }]
    assert.equal(JSON.stringify(phraseMessages(rows)).includes('already made'), false)
    assert.equal(JSON.stringify(phraseMessages(rows, ['Exams'])).includes('already made'), true)
  })
})

describe('什麼都裝得下的名字', () => {
  test('整個名字就是那些字 → 洗成空的', () => {
    for (const bad of ['Misc', 'miscellaneous', 'Other', 'Documents', 'Files', 'Unsorted', 'Technical', 'Personal']) {
      assert.equal(cleanGroupName(bad), '', `${bad} 不該當資料夾名`)
    }
  })

  test('說得出裡面是什麼的照過', () => {
    for (const ok of ['Lecture materials', 'Application forms', 'Unknown documents', 'Personal finance']) {
      assert.equal(cleanGroupName(ok), ok, `${ok} 被誤殺了`)
    }
  })
})
