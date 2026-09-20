import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../core/db.ts'
import { Facts } from '../core/facts.ts'

const fresh = () => new Facts(open(':memory:'))

test('模型提出的東西一律是 candidate，不會自己變成事實', () => {
  const F = fresh()
  const f = F.propose({ key: 'person.name.full', value: '王小明',
    source: { kind: 'file', ref: '畢業證書.pdf', quote: '茲證明王小明君' }, confidence: 0.99 })
  assert.equal(f.status, 'candidate')
  assert.equal(F.get('person.name.full'), null, '沒確認之前查不到')
})

test('confirm 之後才查得到，而且留著出處', () => {
  const F = fresh()
  const f = F.propose({ key: 'person.name.full', value: '王小明',
    source: { kind: 'file', ref: '畢業證書.pdf', quote: '茲證明王小明君' } })
  F.confirm(f.id)
  const got = F.get('person.name.full')
  assert.equal(got.value, '王小明')
  assert.equal(got.source_quote, '茲證明王小明君')
})

test('新的取代舊的，舊的不刪', () => {
  const F = fresh()
  F.manual('contact.phone.mobile', '0912345678')
  F.manual('contact.phone.mobile', '0987654321')
  assert.equal(F.get('contact.phone.mobile').value, '+886987654321')
  assert.equal(F.list('superseded').length, 1, '舊的變成 superseded 留著')
})

test('敏感度從註冊表拿，呼叫端說了不算', () => {
  const F = fresh()
  const f = F.manual('work[0].salary', '月薪 6 萬')
  assert.equal(f.sensitivity, 'sensitive')
})

test('secret 級的東西存不進去', () => {
  const F = fresh()
  assert.throws(() => F.propose({ key: 'password', value: 'x', source: { kind: 'manual' } }),
    /Unknown key/)
})

test('擴充套件問一組欄位，拿回四種不同指示', () => {
  const F = fresh()
  F.manual('person.name.full', '王小明')
  F.manual('contact.address.registered', '台北市大安區')
  F.manual('education[0].school', '台灣大學')
  F.manual('education[1].school', '建國中學')

  const plan = Object.fromEntries(
    F.forForm([
      'person.name.full',                 // 直接填
      'contact.address.registered',       // 敏感，要再點
      'education[].school',               // 兩筆，要選
      'writing.autobiography',            // 要生成
      'person.birthdate',                 // 庫裡沒有
    ]).map(r => [r.key, r.action])
  )
  assert.equal(plan['person.name.full'], 'fill')
  assert.equal(plan['contact.address.registered'], 'confirm-each-time')
  assert.equal(plan['education[].school'], 'pick')
  assert.equal(plan['writing.autobiography'], 'compose')
  assert.equal(plan['person.birthdate'], 'missing')
})

test('到期的事實會被標 stale', () => {
  const F = fresh()
  F.manual('work[0].is_current', true)          // 半年到期
  F.manual('education[0].school', '台灣大學')     // 不過期
  assert.equal(F.sweepStale(new Date()).length, 0, '今天還沒到期')

  const 一年後 = new Date(); 一年後.setFullYear(一年後.getFullYear() + 1)
  const stale = F.sweepStale(一年後)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].key, 'work[0].is_current')
  assert.equal(F.get('education[0].school').value, '台灣大學', '不過期的沒被動到')
})

test('復原：確認過的退回 candidate，被取代的活回來', () => {
  const F = fresh()
  F.manual('contact.email', 'old@example.com')
  const n = F.propose({ key: 'contact.email', value: 'new@example.com',
    source: { kind: 'file', ref: '名片.png' } })
  F.confirm(n.id)
  assert.equal(F.get('contact.email').value, 'new@example.com')

  F.undoLast(1)
  assert.equal(F.get('contact.email').value, 'old@example.com', '舊的回來了')
  assert.equal(F.list('candidate').length, 1, '新的退回 candidate')
})

test('復原 propose：整筆消失', () => {
  const F = fresh()
  F.propose({ key: 'person.gender', value: '男', source: { kind: 'file', ref: 'a.pdf' } })
  assert.equal(F.list('candidate').length, 1)
  F.undoLast(1)
  assert.equal(F.list('candidate').length, 0)
})

test('每個寫入都有留紀錄', () => {
  const F = fresh()
  F.manual('person.name.full', '王小明')
  const ops = F.journal().map(j => j.op)
  assert.deepEqual(ops, ['fact.confirm', 'fact.propose'])
})
