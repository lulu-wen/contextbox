/**
 * ContextBox — 填入路徑的測試
 *
 * 涵蓋四塊：
 *   1. forForm 的五種 action（fill / pick / confirm-each-time / compose / missing）
 *      外加不認得的 key 會回 unknown
 *   2. schema/normalize.ts 與 core/validate.ts 的格式轉換
 *      （民國年、電話、地址，以及「每一個入口都要折全形」這條線）
 *   3. key 註冊表的一致性 —— 註冊表會一直長，這類測試最值錢
 *   4. 擴充套件跟 server 之間的契約（起一台真的 server 打過去）
 *
 * 跑法：node --experimental-strip-types --test test/fill.test.mjs
 *
 * 有幾個測試標了 { todo: ... }：那是「規格說應該這樣、程式現在還不是這樣」。
 * todo 的失敗不算失敗，整份跑起來仍然是綠的，但它會一直提醒有這件事沒做。
 * 詳情看每一個 todo 自己的說明。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { open } from '../core/db.ts'
import { Facts } from '../core/facts.ts'
import { start } from '../core/server.ts'
import { FACT_KEYS, defOf, fillModeOf, SCHEMA_VERSION } from '../schema/factKeys.ts'
import { buildIndex, norm } from '../schema/match.js'
import {
  rocToAD, toDate, toE164, phoneForDisplay, splitAddress, toHalfWidth, foldFullWidth,
} from '../schema/normalize.ts'
import { normalizeValue, ValidationError } from '../core/validate.ts'

const fresh = () => new Facts(open(':memory:'))

/** 把 forForm 的結果轉成 key → 整筆指示，測試裡好查 */
const planOf = (F, keys) => Object.fromEntries(F.forForm(keys).map(r => [r.key, r]))

// ══════════════════════════════════════════════════════════════
// 一、forForm 的五種 action
// ══════════════════════════════════════════════════════════════
describe('forForm 回的五種指示', () => {

  test('fill：不敏感、庫裡剛好一筆，直接填', () => {
    const F = fresh()
    F.manual('person.name.full', '王小明')

    const r = planOf(F, ['person.name.full'])['person.name.full']
    assert.equal(r.action, 'fill')
    assert.equal(r.value, '王小明')
    assert.equal(r.label, '姓名')
    assert.equal(r.source, 'user', 'fill 要講得出這個值哪來的')
    assert.ok(!('options' in r), 'fill 不該帶 options')
    assert.ok(!('sensitivity' in r), '不敏感的不用標敏感度')
  })

  test('pick：可重複的 key 有好幾筆，要人自己選', () => {
    const F = fresh()
    F.manual('education[0].school', '台灣大學')
    F.manual('education[1].school', '建國中學')

    const r = planOf(F, ['education[].school'])['education[].school']
    assert.equal(r.action, 'pick')
    assert.ok(!('value' in r), 'pick 不准偷偷挑一個當預設')
    assert.equal(r.options.length, 2)
    for (const o of r.options) {
      assert.deepEqual(Object.keys(o).sort(), ['id', 'source', 'value'],
        '每個選項要有 id、值、出處，人才選得下去')
      assert.ok(o.id && typeof o.id === 'string')
    }
    assert.deepEqual(r.options.map(o => o.value).sort(), ['台灣大學', '建國中學'])
  })

  test('repeatable 的 key 只有一筆的時候是 fill，多筆才是 pick', () => {
    const F = fresh()
    F.manual('education[0].degree', '碩士')

    assert.equal(planOf(F, ['education[].degree'])['education[].degree'].action, 'fill',
      '只有一筆就沒什麼好選的')

    F.manual('education[1].degree', '學士')
    const r = planOf(F, ['education[].degree'])['education[].degree']
    assert.equal(r.action, 'pick', '變成兩筆就要問')
    assert.equal(r.options.length, 2)
  })

  test('confirm-each-time：敏感欄位有值也要人再點一次，不會變成 fill', () => {
    const F = fresh()
    F.manual('contact.address.registered', '台北市大安區羅斯福路四段1號')

    const r = planOf(F, ['contact.address.registered'])['contact.address.registered']
    assert.equal(r.action, 'confirm-each-time')
    assert.equal(r.sensitivity, 'sensitive', '要把敏感度一起講出來，UI 才知道怎麼說')
    assert.equal(r.label, '戶籍地址')
    assert.equal(r.source, 'user')
    assert.ok('value' in r)
  })

  test('敏感又可重複、而且有好幾筆，仍然是 confirm-each-time，不會掉進 pick', () => {
    const F = fresh()
    F.manual('reference[0].name', '陳老師')
    F.manual('reference[1].name', '林經理')

    const r = planOf(F, ['reference[].name'])['reference[].name']
    assert.equal(r.action, 'confirm-each-time', '敏感度的優先度高於「有幾筆」')
    assert.equal(r.sensitivity, 'sensitive')
    assert.ok(!('options' in r))
  })

  test('每一個敏感的 key，只要庫裡有值就一定是 confirm-each-time', () => {
    // 這一條是鐵則，所以不挑幾個代表測，整份註冊表掃一遍。
    const sensitive = FACT_KEYS.filter(d => d.sensitivity === 'sensitive')
    assert.ok(sensitive.length >= 15, '註冊表裡本來就有一批敏感 key')

    for (const d of sensitive) {
      if (fillModeOf(d) === 'compose') continue      // 長文本來就不填，另一條測
      const F = fresh()
      const key = d.repeatable ? d.key.replace('[]', '[0]') : d.key
      F.manual(key, sampleValueFor(d))

      const r = planOf(F, [d.key])[d.key]
      assert.equal(r.action, 'confirm-each-time', `${d.key} 是敏感的，不該自動填`)
      assert.equal(r.sensitivity, 'sensitive')
    }
  })

  test('compose：長文欄位不管庫裡有沒有值，一律是 compose', () => {
    const F = fresh()
    // 空的
    assert.equal(planOf(F, ['writing.autobiography'])['writing.autobiography'].action, 'compose')

    // 有值的
    F.manual('writing.autobiography', '我是王小明，做了十年後端。')
    F.manual('work[0].description', '負責計費系統。')
    const p = planOf(F, ['writing.autobiography', 'work[].description'])

    assert.equal(p['writing.autobiography'].action, 'compose', '有舊版本也還是要重生成')
    assert.equal(p['work[].description'].action, 'compose')
    for (const r of Object.values(p)) {
      assert.ok(!('value' in r), 'compose 這一版不生成，所以不帶值')
      assert.ok(r.label, '但要講得出這一格是什麼，人才知道在等什麼')
    }
  })

  test('手標的 fill 贏過型別推導：論文題目是長文，但標成 pick', () => {
    const F = fresh()
    F.manual('education[0].thesis', '分散式帳本的共識延遲')
    F.manual('education[1].thesis', '排隊理論在客服的應用')

    const r = planOf(F, ['education[].thesis'])['education[].thesis']
    assert.equal(r.action, 'pick', '固定的事實不是生成物，不該走 compose')
  })

  test('missing：庫裡沒有這筆', () => {
    const F = fresh()
    const r = planOf(F, ['person.nationality'])['person.nationality']
    assert.equal(r.action, 'missing')
    assert.equal(r.label, '國籍', 'missing 也要有標籤，才問得出「要不要現在補」')
    assert.ok(!('value' in r))
  })

  test('unknown：不認得的 key', () => {
    const F = fresh()
    const r = planOf(F, ['totally.made.up.key'])['totally.made.up.key']
    assert.equal(r.action, 'unknown')
    assert.ok(!('label' in r), '不認得就什麼都不知道，連標籤都編不出來')
    assert.ok(!('value' in r))
  })

  test('一次問一整組：五種 action 一次到齊，順序跟問的一樣', () => {
    const F = fresh()
    F.manual('person.name.full', '王小明')
    F.manual('identity.national_id', 'A123456789')
    F.manual('work[0].company', '甲公司')
    F.manual('work[1].company', '乙公司')

    const keys = [
      'person.name.full',      // fill
      'work[].company',        // pick
      'identity.national_id',  // confirm-each-time
      'writing.cover_letter',  // compose
      'person.birthdate',      // missing
      'no.such.key',           // unknown
    ]
    const plan = F.forForm(keys)

    assert.equal(plan.length, keys.length, '問幾個就回幾個，不能漏也不能多')
    assert.deepEqual(plan.map(r => r.key), keys, '順序要對得上，擴充套件是照順序配元素的')
    assert.deepEqual(plan.map(r => r.action),
      ['fill', 'pick', 'confirm-each-time', 'compose', 'missing', 'unknown'])
  })

  test('forForm 只吃不帶序號的 key —— 帶了序號會查不到', () => {
    // 這是現況，寫下來是要讓擴充套件那一側知道：送過去之前要把 [0] 換成 []。
    const F = fresh()
    F.manual('education[0].school', '台灣大學')

    assert.equal(planOf(F, ['education[].school'])['education[].school'].action, 'fill')
    assert.equal(planOf(F, ['education[0].school'])['education[0].school'].action, 'missing',
      '帶序號查不到，不會爆炸但也拿不到值')
  })

  test('敏感欄位就算庫裡沒值，也該回 confirm-each-time 而不是 missing',
    { todo: '現在回 missing（core/facts.ts:158 的空值判斷排在 161 的敏感判斷前面）。'
          + '差別在於 missing 等於對網頁承認「我沒有這筆」，'
          + '一頁塞 75 個隱藏欄位就能問出你有沒有身心障礙身分。見 openIssues。' },
    () => {
      const F = fresh()
      const r = planOf(F, ['person.disability'])['person.disability']
      assert.equal(r.action, 'confirm-each-time')
    })
})

/** 給每個 key 生一個過得了 validate 的值，型別對就好 */
function sampleValueFor(d) {
  switch (d.type) {
    case 'date': return '2000-03-15'
    case 'month': return '2018-09'
    case 'tel': return '0912345678'
    case 'email': return 'a@example.com'
    case 'url': return 'https://example.com/'
    case 'enum': return d.enum[0]
    case 'number': return 3
    case 'boolean': return true
    default: return '測試值'
  }
}

// ══════════════════════════════════════════════════════════════
// 二、格式轉換
// ══════════════════════════════════════════════════════════════
describe('schema/normalize.ts 的轉換', () => {

  test('民國年轉西元：有年有月才算數', () => {
    assert.equal(rocToAD('115年6月'), '2026-06')
    assert.equal(rocToAD('民國 89 年 3 月 15 日'), '2000-03-15')
    assert.equal(rocToAD('民國89年3月15日'), '2000-03-15')
    assert.equal(rocToAD('89年3月'), '2000-03')
    assert.equal(rocToAD('99年12月31日'), '2010-12-31')

    // toDate 會先試民國年，所以同樣的字串走 toDate 要得到一樣的答案
    for (const s of ['115年6月', '民國89年3月15日', '89年3月']) {
      assert.equal(toDate(s), rocToAD(s), `${s} 走哪一支都要一樣`)
    }
  })

  test('民國年寫成 115/6 這種沒有「年」字的，回 null 不猜', () => {
    // 115/6 到底是民國 115 年 6 月還是別的，字面上分不出來。
    // 規則是寧可回 null 讓人自己填，不要猜一個看起來很合理的錯答案。
    assert.equal(rocToAD('115/6'), null)
    assert.equal(toDate('115/6'), null)
    assert.equal(toDate('民國115/6'), null)
  })

  test('西元日期：常見的幾種寫法都轉得到', () => {
    assert.equal(toDate('2026-06-15'), '2026-06-15')
    assert.equal(toDate('2026-06'), '2026-06')
    assert.equal(toDate('2018/9/1'), '2018-09-01')
    assert.equal(toDate('2018.9'), '2018-09')
    assert.equal(toDate('  2026-06-15  '), '2026-06-15', '前後空白要吃掉')
  })

  test('看不懂的日期回 null，不能瞎猜', () => {
    for (const s of ['', '下個月', '不知道', 'N/A', '第三季', '2018年', 'yyyy/mm/dd']) {
      assert.equal(toDate(s), null, `${JSON.stringify(s)} 應該回 null`)
    }
  })

  test('四位數的西元年配上「年」字，不可以被當成民國年', () => {
    // 曾經是 todo：民國那條 regex 沒有錨定，2018年9月 會比中後面三碼 018 →
    // 算成民國 18 年 → 1929-09，差 89 年而且完全靜默。
    // 現在靠 toDate 先試西元、民國那條又加了 (?<!\d) 擋著，所以改成真的會紅的測試。
    assert.equal(toDate('2018年9月'), '2018-09')
    assert.equal(toDate('2000年3月15日'), '2000-03-15')
    assert.equal(toDate('西元2000年3月15日'), '2000-03-15')
    assert.equal(rocToAD('2018年9月'), null, '四位數的年不該被民國那條吃下去')
  })

  test('電話：各種寫法轉 E.164 都一樣，再轉回顯示格式', () => {
    const 手機寫法 = ['0912-345-678', '0912345678', '0912 345 678',
                      '(0912)345678', '+886912345678', '886912345678']
    for (const s of 手機寫法) {
      assert.equal(toE164(s), '+886912345678', `${s} 要轉成同一組數字`)
      assert.equal(phoneForDisplay(toE164(s)), '0912-345-678', `${s} 顯示回來要是人看的樣子`)
    }
    // 顯示格式再存一次，結果不能漂移
    assert.equal(toE164(phoneForDisplay('+886912345678')), '+886912345678')
  })

  test('電話：市話存得進去，顯示就原樣回來（不亂猜區碼怎麼切）', () => {
    assert.equal(toE164('02-2720-8889'), '+886227208889')
    assert.equal(toE164('(02) 2720-8889'), '+886227208889')
    assert.equal(toE164('089-123456'), '+88689123456', '089 是台東市話，不是手機')
    // phoneForDisplay 只認手機，市話回原本的 E.164。
    // 這是刻意的保底：與其猜錯區碼長度，不如原樣呈現。
    assert.equal(phoneForDisplay('+886227208889'), '+886227208889')
  })

  test('電話：外國號碼原樣留著，看不懂的回 null', () => {
    assert.equal(toE164('+1 415 555 0000'), '+14155550000')
    assert.equal(phoneForDisplay('+14155550000'), '+14155550000')

    for (const s of ['', 'abc', '不知道', '分機 1234', '12345']) {
      assert.equal(toE164(s), null, `${JSON.stringify(s)} 應該回 null`)
    }
  })

  test('地址：有郵遞區號、有區的完整地址，四段都拆得出來', () => {
    assert.deepEqual(splitAddress('106台北市大安區羅斯福路四段1號'), {
      full: '106台北市大安區羅斯福路四段1號',
      postalCode: '106', city: '台北市', district: '大安區', rest: '羅斯福路四段1號',
    })
    assert.deepEqual(splitAddress('950台東縣台東市中華路一段1號'), {
      full: '950台東縣台東市中華路一段1號',
      postalCode: '950', city: '台東縣', district: '台東市', rest: '中華路一段1號',
    }, '台東市是區不是縣市，不能被前面的台東縣吃掉')
  })

  test('地址：沒有郵遞區號、沒有區的情況', () => {
    const 沒郵號 = splitAddress('台北市大安區羅斯福路四段1號')
    assert.equal(沒郵號.postalCode, null)
    assert.equal(沒郵號.city, '台北市')
    assert.equal(沒郵號.district, '大安區')

    const 沒區 = splitAddress('新竹市光復路二段101號')
    assert.equal(沒區.city, '新竹市')
    assert.equal(沒區.district, null, '新竹市底下沒再分區，不要硬生一個出來')
    assert.equal(沒區.rest, '光復路二段101號')

    const 只到區 = splitAddress('高雄市三民區')
    assert.equal(只到區.city, '高雄市')
    assert.equal(只到區.district, '三民區')
    assert.equal(只到區.rest, '', '後面沒東西就是空的')
  })

  test('地址：完全看不懂的字串，拆出來全是 null，但 full 一定留著', () => {
    const r = splitAddress('火星')
    assert.equal(r.full, '火星', '原文永遠留著，表單只給一格的時候就填這個')
    assert.equal(r.postalCode, null)
    assert.equal(r.city, null)
    assert.equal(r.district, null)
    assert.equal(r.rest, null)
  })

  test('全形轉半形，順便把多餘空白收乾淨', () => {
    assert.equal(toHalfWidth('ＡＢＣ１２３'), 'ABC123')
    assert.equal(toHalfWidth('ａ１'), 'a1')
    assert.equal(toHalfWidth('王　小明'), '王 小明', '全形空格變半形')
    assert.equal(toHalfWidth('  a   b  '), 'a b')
    assert.equal(toHalfWidth('王小明'), '王小明', '中文本身不要動')
  })
})

// ══════════════════════════════════════════════════════════════
// 二之二、全形字：每一個入口都要折，折完還要量得出來
//
// 這一節是回歸測試。同一個 bug 已經出現兩次：
//   第一次修在日期那條路上（rocToAD 先折全形），電話那條完全沒裝，
//   toE164 的 raw.replace(/[^\d+]/g, '') 照樣把全形數字當雜訊刪掉 ——
//   「0912-345-６７８」變成 +886912345，短三碼、一個錯都不丟。
// 所以這裡不是只測「全形轉得過」，每一條都要順便斷言「不是靜默截短」：
// 看不懂就是 null（或丟錯），不准回一個看起來很合理的半截答案。
// ══════════════════════════════════════════════════════════════
describe('全形進來的時候，每一條路都不准靜默截短', () => {

  /** 挑出字串裡的數字（全形先折半形），用來比「進去幾碼、出來幾碼」 */
  const 數字 = s => foldFullWidth(s).replace(/\D/g, '')

  const 電話案例 = [
    ['0912-345-６７８',     '+886912345678', '尾三碼全形，舊版整段被當雜訊刪掉'],
    ['09１2345678',         '+886912345678', '中間一碼全形'],
    ['０９１２３４５６７８', '+886912345678', '整串全形'],
    ['＋886912345678',      '+886912345678', '全形加號一樣是國碼記號，不折就變成沒有國碼'],
    ['02-2720-8889',        '+886227208889', '市話 10 碼'],
    ['（０２）２７２０－８８８９', '+886227208889', '全形市話，連括號跟破折號都是全形'],
    ['089-123456',          '+88689123456',  '台東市話 9 碼'],
    ['0912345678９',        null,            '11 碼；多出來的那一碼不准被吃掉當成 10 碼'],
    ['0912345',             null,            '太短'],
    ['091234567890',        null,            '太長'],
    ['０９１２３４５６７８９０', null,        '全形折回來還是 12 碼'],
    ['＋886912345',         null,            '+886 後面只有 6 碼，行動號碼要 9 碼'],
    ['+886227208',          null,            '+886 市話只有 6 碼，要 8-9 碼'],
  ]

  test('電話：全形折得回來，折完長度不對就回 null', () => {
    for (const [輸入, 期望, 為什麼] of 電話案例) {
      assert.equal(toE164(輸入), 期望, `${輸入}：${為什麼}`)
    }
  })

  test('電話：只要回得出號碼，輸入的每一碼都要在輸出裡（沒被截短的通則）', () => {
    // 個別案例會老，這條是通則：折半形之後進去幾碼，出來就該有幾碼
    // （本地 0 開頭的差別只有「去掉 0、補上 886」）。
    const 全部 = [...電話案例.map(c => c[0]), '0912345678', '886912345678', '+1 415 555 0000']
    for (const 輸入 of 全部) {
      const 出 = toE164(輸入)
      if (出 === null) continue                 // 回 null 是合格的失敗，這條不管
      const 進碼 = 數字(輸入)
      const 出碼 = 數字(出)
      const 本地 = 進碼.startsWith('0')
      assert.equal(出碼.length, 本地 ? 進碼.length + 2 : 進碼.length,
        `${輸入} 的數字被吃掉了：進去 ${進碼.length} 碼、出來 ${出碼.length} 碼（${出}）`)
      assert.ok(出碼.endsWith(本地 ? 進碼.slice(1) : 進碼),
        `${輸入} → ${出}：尾碼對不上，不是同一組號碼`)
    }
  })

  test('電話：轉成 E.164 再轉回顯示格式，全形版跟半形版是同一筆', () => {
    assert.equal(toE164('0912-345-６７８'), toE164('0912-345-678'))
    assert.equal(phoneForDisplay(toE164('０９１２３４５６７８')), '0912-345-678')
  })

  test('日期：半形、全形、混排、民國、西元，全部落在同一個答案上', () => {
    const 案例 = [
      // ── 上一輪的案例：半形西元與民國 ──
      ['2026-06-15',            '2026-06-15'],
      ['2026-06',               '2026-06'],
      ['2018/9/1',              '2018-09-01'],
      ['2018.9',                '2018-09'],
      ['  2026-06-15  ',        '2026-06-15'],
      ['2018年9月',             '2018-09'],
      ['2000年3月15日',         '2000-03-15'],
      ['西元2000年3月15日',     '2000-03-15'],
      ['115年6月',              '2026-06'],
      ['民國 89 年 3 月 15 日', '2000-03-15'],
      ['99年12月31日',          '2010-12-31'],
      // ── 這一輪的案例：全形與混排 ──
      ['２０２６－０６－１５',   '2026-06-15'],
      ['２０２６－０６',         '2026-06'],
      ['２０１８／９／１',       '2018-09-01'],
      ['２０１８年９月',         '2018-09'],
      ['２024年6月',             '2024-06'],      // 混排：舊版切成「024年」→ 1935-06
      ['１１５年６月',           '2026-06'],
      ['民國８９年３月１５日',   '2000-03-15'],
      ['民國 １１５ 年 ６ 月',   '2026-06'],
    ]
    for (const [輸入, 期望] of 案例) {
      assert.equal(toDate(輸入), 期望, `${輸入} 應該是 ${期望}`)
    }
  })

  test('日期：看不懂就 null，不准生出半截或差一個世紀的年份', () => {
    const 看不懂 = [
      '', '　', '   ', '下個月', '不知道', 'N/A', '第三季', '2018年', 'yyyy/mm/dd',
      '115/6', '民國115/6', '１１５／６',            // 沒有「年」字就分不出民國還是西元
      '2026-13-45', '2018/13', '2018年0月', '2026-06-32', '２０１８年１３月',
    ]
    for (const s of 看不懂) {
      assert.equal(toDate(s), null, `${JSON.stringify(s)} 應該回 null`)
    }
  })

  test('日期：四位數的西元年，不管半形全形都不准被當成民國年', () => {
    // 差 89 年，而且以前是完全靜默的：2018年9月 → 1929-09 照樣寫進事實庫。
    for (const [s, 年] of [
      ['2018年9月', '2018'], ['2000年3月15日', '2000'], ['西元2000年3月15日', '2000'],
      ['２０１８年９月', '2018'], ['２024年6月', '2024'], ['２０００年３月１５日', '2000'],
    ]) {
      const got = toDate(s)
      assert.ok(got && got.startsWith(`${年}-`), `${s} 轉成 ${got}，年份不是 ${年}`)
    }
  })

  test('地址：全形的郵遞區號也要拆得開', () => {
    // 不折的話 \d{3,5} 比不中，連 (.{2,3}[市縣]) 都會跟著垮 —— 四段全變 null，
    // 表單只剩「整串」可以填，分欄的表單就填不動了。
    const 全形 = splitAddress('１０６台北市大安區羅斯福路四段１號')
    assert.deepEqual(全形, {
      full: '106台北市大安區羅斯福路四段1號',
      postalCode: '106', city: '台北市', district: '大安區', rest: '羅斯福路四段1號',
    })
    // 同一個地址不管用哪種寬度打進來，庫裡都要是同一筆
    assert.deepEqual(全形, splitAddress('106台北市大安區羅斯福路四段1號'))
    // 折半形只換寬度不掉字：字數要一樣多
    assert.equal(全形.full.length, '106台北市大安區羅斯福路四段1號'.length)
    // 拆不開的字串照樣把原文留著（折過半形的版本）
    assert.equal(splitAddress('火星').full, '火星')
  })

  test('折半形的兩套工具，各自守著自己的地盤', () => {
    // toHalfWidth 給人看的字用：折英數，留標點（中文標點是內容，折了就是改原文）
    assert.equal(toHalfWidth('ＡＢＣ１２３'), 'ABC123')
    assert.equal(toHalfWidth('台北市，大安區'), '台北市，大安區', '全形逗號是內容，不准折')
    assert.equal(toHalfWidth('＋８８６'), '＋886', 'toHalfWidth 折不掉全形加號 —— 所以電話不能只靠它')
    // foldFullWidth 給機器格式用：整塊全形 ASCII 都折
    assert.equal(foldFullWidth('＋８８６'), '+886')
    assert.equal(foldFullWidth('ｈｔｔｐｓ：／／ａ．ｃｏｍ'), 'https://a.com')
    assert.equal(foldFullWidth('民國８９年'), '民國89年', '中文不在全形 ASCII 區裡，動不到')
    assert.equal(foldFullWidth(foldFullWidth('＋８８６')), foldFullWidth('＋８８６'), '折兩次要跟折一次一樣')
  })
})

// ══════════════════════════════════════════════════════════════
// 二之三、core/validate.ts 的每一個型別分支
// 事實庫只認這一支的輸出，所以「有沒有折全形」要一個分支一個分支地釘住。
// ══════════════════════════════════════════════════════════════
describe('normalizeValue 的每一條型別分支', () => {
  const 正規化 = (key, raw) => normalizeValue(defOf(key), raw)

  test('date／month：全形、民國年都吃得下；轉不出來就丟錯', () => {
    assert.equal(正規化('person.birthdate', '民國８９年３月１５日'), '2000-03-15')
    assert.equal(正規化('person.birthdate', '２０００－０３－１５'), '2000-03-15')
    assert.equal(正規化('education[].start', '２０１８年９月'), '2018-09')
    assert.equal(正規化('education[].start', '民國107年9月'), '2018-09')
    assert.throws(() => 正規化('person.birthdate', '2000年3月'), ValidationError,
      'date 要到日，只有年月就是缺資料')
    assert.throws(() => 正規化('person.birthdate', '不知道'), ValidationError)
    assert.throws(() => 正規化('person.birthdate', '２０００年１３月１日'), ValidationError)
  })

  test('tel：全形折得回來；長度不對一律丟錯，不存半截', () => {
    assert.equal(正規化('contact.phone.mobile', '0912-345-６７８'), '+886912345678')
    assert.equal(正規化('contact.phone.mobile', '＋886912345678'), '+886912345678')
    assert.equal(正規化('contact.phone.home', '（０２）２７２０－８８８９'), '+886227208889')
    for (const 壞的 of ['0912345678９', '0912345', '091234567890', '不知道']) {
      assert.throws(() => 正規化('contact.phone.mobile', 壞的), ValidationError,
        `${壞的} 要丟錯，不能存一個半截號碼`)
    }
  })

  test('email：全形的＠和．也要折得掉', () => {
    // 這兩個字元不在 toHalfWidth 的範圍裡，只折英數的話整筆會被判成「不是 email」。
    assert.equal(正規化('contact.email', 'Ｗａｎｇ＠Ｅｘａｍｐｌｅ．ｃｏｍ'), 'wang@example.com')
    assert.equal(正規化('contact.email', '  WANG@Example.com  '), 'wang@example.com')
    for (const 壞的 of ['王小明', 'a @b.com', 'a@b']) {
      assert.throws(() => 正規化('contact.email', 壞的), ValidationError)
    }
  })

  test('url：正常網址原樣通過，全形打出來的救得回來，path 裡的全形字不准動', () => {
    assert.equal(正規化('person.website', 'https://example.com/a'), 'https://example.com/a')
    assert.equal(正規化('person.website', 'ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ．ｃｏｍ／ａ'),
      'https://example.com/a')
    // path 裡的全形字是內容，折掉等於安靜換了一個網址 —— 所以先拿原字串試，parse 得動就不折。
    assert.equal(正規化('person.website', 'https://example.com/ＡＢ'),
      new URL('https://example.com/ＡＢ').toString())
    assert.equal(正規化('person.website', 'https://example.com/履歷'),
      new URL('https://example.com/履歷').toString())
    assert.throws(() => 正規化('person.website', '不知道'), ValidationError)
  })

  test('enum：折完仍不在清單裡就丟錯，不會挑一個最像的', () => {
    assert.equal(正規化('person.gender', '男'), '男')
    assert.equal(正規化('person.gender', ' 男 '), '男')
    assert.equal(正規化('person.military', '役畢'), '役畢')
    assert.throws(() => 正規化('person.gender', '男生'), ValidationError)
  })

  test('number：全形數字是數字；只有空白不是 0', () => {
    assert.equal(正規化('skill[].years', '１２'), 12)
    assert.equal(正規化('skill[].years', '12'), 12)
    assert.equal(正規化('skill[].years', 3), 3)
    assert.throws(() => 正規化('skill[].years', '三年'), ValidationError)
    assert.throws(() => 正規化('skill[].years', '　'), ValidationError,
      '全形空格 trim 完是空的，不准變成 0')
    assert.throws(() => 正規化('skill[].years', '   '), ValidationError)
  })

  test('text（長文）刻意不折全形：換行與排版本身就是內容', () => {
    const 自傳 = '第一段。\n\n第二段：ＡＢＣ　１２３'
    assert.equal(正規化('writing.autobiography', 自傳), 自傳,
      '折了會把 \\n 併進 \\s+ 壓成一行，整篇自傳變一段')
  })

  test('一般字串：折英數、收多餘空白，中文標點原樣留著', () => {
    assert.equal(正規化('person.name.full', '王　小明'), '王 小明')
    assert.equal(正規化('person.nationality', 'ＴＷ'), 'TW')
    assert.equal(正規化('person.disability', '無'), '無')
    assert.throws(() => 正規化('person.name.full', '　'), ValidationError,
      '只有一個全形空格等於沒填，不准存成空字串')
  })
})

// ══════════════════════════════════════════════════════════════
// 三、key 註冊表的一致性
// ══════════════════════════════════════════════════════════════
describe('schema/factKeys.ts 註冊表', () => {

  /** 算出所有「同一條別名對到兩個不同 key」的情形 */
  function 撞到的別名() {
    const 佔用 = new Map()
    const 撞 = []
    for (const d of FACT_KEYS) {
      // buildIndex 是把 label 也當一條別名，這裡照同一套算
      for (const a of [d.label, ...d.aliases]) {
        const n = norm(a)
        if (!n) continue
        const 先來的 = 佔用.get(n)
        if (!先來的) 佔用.set(n, d)
        else if (先來的.key !== d.key) 撞.push({ alias: a, n, first: 先來的.key, second: d.key })
      }
    }
    return 撞
  }

  test('別名不可以撞到別的 key（已知的那一條先放行，新的一律擋下來）', () => {
    // buildIndex 是「先登記的贏」，撞到的那一條會被靜默吃掉 ——
    // 也就是說「成績」這兩個字永遠只對得到 education[].gpa，
    // language[].score 靠這條別名一輩子比不中。所以這是設定錯誤，不是無害的重複。
    const 已知待修 = new Set(['成績'])
    const 新的撞法 = 撞到的別名().filter(x => !已知待修.has(x.alias))

    assert.deepEqual(新的撞法, [],
      '有新的別名撞到別的 key 了：' +
      新的撞法.map(x => `「${x.alias}」${x.first} vs ${x.second}`).join('、'))
  })

  test('一條別名都不准撞到別的 key',
    { todo: '「成績」同時掛在 schema/factKeys.ts:240 的 education[].gpa '
          + '和 :305 的 language[].score 上。見 openIssues。' },
    () => {
      assert.deepEqual(撞到的別名().map(x => `${x.alias}: ${x.first} vs ${x.second}`), [])
    })

  test('enum 型別一定要有 enum 陣列，而且值不重複', () => {
    for (const d of FACT_KEYS) {
      if (d.type !== 'enum') {
        assert.ok(!d.enum, `${d.key} 不是 enum 型別，不該有 enum 陣列`)
        continue
      }
      assert.ok(Array.isArray(d.enum), `${d.key} 是 enum 型別，一定要列出允許的值`)
      assert.ok(d.enum.length >= 2, `${d.key} 的 enum 只有一個值，那就不用選了`)
      assert.equal(new Set(d.enum).size, d.enum.length, `${d.key} 的 enum 有重複的值`)
      for (const v of d.enum) {
        assert.equal(typeof v, 'string')
        assert.ok(v.trim(), `${d.key} 的 enum 裡有空字串`)
      }
    }
    assert.ok(FACT_KEYS.some(d => d.type === 'enum'), '註冊表裡本來就有 enum 型別')
  })

  test('repeatable 的 key 一定含 []，含 [] 的一定是 repeatable', () => {
    for (const d of FACT_KEYS) {
      if (d.repeatable) {
        assert.ok(d.key.includes('[]'),
          `${d.key} 標了 repeatable 卻沒有 []，存進去會變成單筆覆蓋`)
      } else {
        assert.ok(!d.key.includes('[]'),
          `${d.key} 有 [] 卻沒標 repeatable，validate 會嫌你帶序號`)
      }
    }
    assert.ok(FACT_KEYS.some(d => d.repeatable), '註冊表裡本來就有可重複的 key')
  })

  test('兩個 key 宣告同一個 autocomplete，buildIndex 要當場吵出來', () => {
    const 假註冊表 = [
      { key: 'a.one', label: '甲', type: 'string', sensitivity: 'public',
        expiry: 'never', autocomplete: 'tel', aliases: ['甲欄'] },
      { key: 'b.two', label: '乙', type: 'string', sensitivity: 'public',
        expiry: 'never', autocomplete: 'tel', aliases: ['乙欄'] },
    ]
    assert.throws(() => buildIndex(假註冊表), err => {
      assert.match(err.message, /重複的 autocomplete/)
      assert.match(err.message, /a\.one/)
      assert.match(err.message, /b\.two/, '要講清楚是哪兩個 key 在搶')
      return true
    }, '靜默覆蓋等於有一個 key 永遠比不中，一定要 throw')

    // 只有一個宣告的不該吵
    assert.doesNotThrow(() => buildIndex([假註冊表[0]]))
    // 真的註冊表本來就不該有這個問題
    assert.doesNotThrow(() => buildIndex(FACT_KEYS), '真的註冊表有重複的 autocomplete')
  })

  test('註冊表裡不可以有 secret 級的 key', () => {
    // secret 的定義就是「根本不存」。出現在註冊表裡代表有人想存它。
    const 犯規 = FACT_KEYS.filter(d => d.sensitivity === 'secret').map(d => d.key)
    assert.deepEqual(犯規, [], '這些 key 標成 secret 了：' + 犯規.join('、'))
  })

  test('fillModeOf 的結果一定是 direct / pick / compose 三種之一', () => {
    const 允許 = new Set(['direct', 'pick', 'compose'])
    for (const d of FACT_KEYS) {
      const m = fillModeOf(d)
      assert.ok(允許.has(m), `${d.key} 推出來的填法是 ${m}，不在三種裡面`)
      if (!d.fill) {
        // 沒手標的就要照推導規則來，推導錯了才手標
        const 推導 = d.type === 'text' ? 'compose' : d.repeatable ? 'pick' : 'direct'
        assert.equal(m, 推導, `${d.key} 的推導跑掉了`)
      }
    }
  })

  test('key 命名規則：全小寫、點分隔、不重複', () => {
    const 樣式 = /^[a-z][a-z0-9_]*(\[\])?(\.[a-z][a-z0-9_]*(\[\])?)*$/
    const 看過 = new Set()
    for (const d of FACT_KEYS) {
      assert.match(d.key, 樣式, `${d.key} 不符合命名規則`)
      assert.ok(!看過.has(d.key), `${d.key} 出現兩次`)
      看過.add(d.key)
    }
  })

  test('每個 key 的基本欄位都齊，值也在允許範圍內', () => {
    const 敏感度 = new Set(['public', 'normal', 'sensitive', 'secret'])
    const 效期 = new Set(['never', 'months:6', 'months:12', 'explicit'])
    const 型別 = new Set(['string', 'text', 'number', 'boolean',
                          'date', 'month', 'enum', 'url', 'email', 'tel', 'file'])
    for (const d of FACT_KEYS) {
      assert.ok(d.label && d.label.trim(), `${d.key} 沒有給人看的標籤`)
      assert.ok(型別.has(d.type), `${d.key} 的型別 ${d.type} 不認得`)
      assert.ok(敏感度.has(d.sensitivity), `${d.key} 的敏感度 ${d.sensitivity} 不認得`)
      assert.ok(效期.has(d.expiry), `${d.key} 的效期 ${d.expiry} 不認得`)
      assert.ok(Array.isArray(d.aliases), `${d.key} 的 aliases 一定要是陣列`)
      assert.equal(new Set(d.aliases).size, d.aliases.length, `${d.key} 自己的別名就重複了`)
    }
    // 註冊表只會長不會縮（key 一旦發布就不改名、不刪掉，要改是開新 key 串回去），
    // 所以這裡設一個地板，不是寫死數量——加新 key 不該害這個測試變紅。
    assert.ok(FACT_KEYS.length >= 75, `註冊表只剩 ${FACT_KEYS.length} 個 key，有東西被刪掉了`)
    assert.match(SCHEMA_VERSION, /^\d+\.\d+\.\d+$/)
  })
})

// ══════════════════════════════════════════════════════════════
// 四、擴充套件跟 server 的契約
// ══════════════════════════════════════════════════════════════
describe('擴充套件送一整張表過來，server 回的 plan 形狀', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-fill-'))
  const TOKEN = 'fill-test-token'
  let S, base

  const call = (path, init = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-contextbox-token': TOKEN,
        origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      },
    })

  const 手填 = (key, value) =>
    call('/facts', { method: 'POST', body: JSON.stringify({ key, value }) })

  before(async () => {
    S = start({ port: 0, db: join(dir, 'plan.db'), token: TOKEN })
    base = `http://127.0.0.1:${await S.ready}`

    // 一份看起來像真的履歷表單會需要的資料
    await 手填('person.name.full', '王小明')
    await 手填('contact.email', 'wang@example.com')
    await 手填('contact.phone.mobile', '0912-345-678')
    await 手填('person.birthdate', '民國 89 年 3 月 15 日')   // 敏感
    await 手填('identity.national_id', 'A123456789')          // 敏感
    await 手填('education[0].school', '台灣大學')
    await 手填('education[1].school', '建國中學')             // 兩筆，要選
    await 手填('work[0].company', '甲公司')                   // 一筆，直接填
    await 手填('work[0].salary', '月薪 6 萬')                 // 敏感
  })
  after(() => S.server.close())

  test('掃到的欄位一次問完，五種 action 都回得出來', async () => {
    const keys = [
      'person.name.full',        // fill
      'contact.email',           // fill
      'contact.phone.mobile',    // fill
      'education[].school',      // pick
      'work[].company',          // 只有一筆 → fill
      'person.birthdate',        // confirm-each-time
      'identity.national_id',    // confirm-each-time
      'work[].salary',           // confirm-each-time
      'writing.autobiography',   // compose
      'work[].description',      // compose
      'person.nationality',      // missing
      'preference.remote',       // missing
      'some.field.we.dont.know', // unknown
    ]
    const r = await call('/form/plan', { method: 'POST', body: JSON.stringify({ keys }) })
    assert.equal(r.status, 200)

    const { plan } = await r.json()
    assert.ok(Array.isArray(plan), 'plan 是陣列')
    assert.equal(plan.length, keys.length)
    assert.deepEqual(plan.map(p => p.key), keys, '順序要跟問的一樣')

    const by = Object.fromEntries(plan.map(p => [p.key, p]))
    assert.deepEqual(plan.map(p => p.action), [
      'fill', 'fill', 'fill', 'pick', 'fill',
      'confirm-each-time', 'confirm-each-time', 'confirm-each-time',
      'compose', 'compose', 'missing', 'missing', 'unknown',
    ])

    // 每一種 action 帶的欄位都要對
    const 允許的 = new Set(['fill', 'pick', 'confirm-each-time', 'compose', 'missing', 'unknown'])
    for (const p of plan) {
      assert.ok(允許的.has(p.action), `${p.key} 回了沒看過的 action：${p.action}`)
      if (p.action === 'unknown') {
        assert.deepEqual(Object.keys(p).sort(), ['action', 'key'], 'unknown 什麼都不該多講')
        continue
      }
      assert.ok(p.label && typeof p.label === 'string', `${p.key} 少了標籤`)

      switch (p.action) {
        case 'fill':
          assert.ok('value' in p && p.value !== null && p.value !== '', `${p.key} 說要填卻沒給值`)
          assert.equal(p.source, 'user', `${p.key} 要講得出出處`)
          assert.ok(!('options' in p))
          assert.ok(!('sensitivity' in p), 'fill 只會發生在不敏感的欄位')
          break
        case 'pick':
          assert.ok(Array.isArray(p.options) && p.options.length > 1,
            `${p.key} 說要選卻沒有兩個以上的選項`)
          for (const o of p.options) {
            assert.deepEqual(Object.keys(o).sort(), ['id', 'source', 'value'])
          }
          assert.ok(!('value' in p), 'pick 不准先挑一個')
          break
        case 'confirm-each-time':
          assert.equal(p.sensitivity, 'sensitive', `${p.key} 要人再點一次，就要說是為什麼`)
          assert.ok('value' in p)
          break
        case 'compose':
        case 'missing':
          assert.ok(!('value' in p), `${p.key} 是 ${p.action}，不該帶值`)
          break
      }
    }

    // 抽幾筆對值，確認存進去的是正規化過的格式
    assert.equal(by['person.name.full'].value, '王小明')
    assert.equal(by['contact.phone.mobile'].value, '+886912345678', '電話存 E.164')
    assert.equal(by['person.birthdate'].value, '2000-03-15', '民國年在寫進去的時候就轉掉了')
    assert.deepEqual(by['education[].school'].options.map(o => o.value).sort(),
      ['台灣大學', '建國中學'])
  })

  test('敏感欄位不管問幾次都還是 confirm-each-time，沒有「這個網站以後都好」', async () => {
    const 問一次 = async () => {
      const r = await call('/form/plan', {
        method: 'POST', body: JSON.stringify({ keys: ['identity.national_id'] }),
      })
      return (await r.json()).plan[0]
    }
    for (let i = 0; i < 3; i++) {
      const p = await 問一次()
      assert.equal(p.action, 'confirm-each-time', `第 ${i + 1} 次問還是要人點`)
      assert.equal(p.sensitivity, 'sensitive')
    }
  })

  test('沒給 keys 也不會爆炸，回一個空的 plan', async () => {
    const r = await call('/form/plan', { method: 'POST', body: JSON.stringify({}) })
    assert.equal(r.status, 200)
    assert.deepEqual((await r.json()).plan, [])
  })

  test('網頁直接打 /form/plan 一律擋掉，就算 token 是對的', async () => {
    const r = await fetch(base + '/form/plan', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-contextbox-token': TOKEN,
        origin: 'https://www.evil.example.com',
      },
      body: JSON.stringify({ keys: ['identity.national_id'] }),
    })
    assert.equal(r.status, 403)
    assert.ok(!(await r.text()).includes('A123456789'), '擋掉的回應裡不准夾帶任何值')
  })
})
