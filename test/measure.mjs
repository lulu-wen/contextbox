/** 把測試表單的欄位餵進比對器，量出命中率。不需要瀏覽器。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const { FACT_KEYS } = await import(join(here, '../schema/factKeys.ts'))
const { buildIndex } = await import(join(here, '../schema/match.js'))
const CB = buildIndex(FACT_KEYS)

const html = readFileSync(join(here, 'resume-form.html'), 'utf8')
const fields = [...html.matchAll(/<label for="(\w+)">([^<]+)<\/label>\s*<(input|select|textarea)([^>]*)>/g)]
  .map(m => ({
    label: m[2],
    autocomplete: (m[4].match(/autocomplete="([^"]+)"/) ?? [])[1] ?? null,
  }))

const rows = fields.map(f => {
  const { def, layer, conflict } = CB.matchField({ autocomplete: f.autocomplete, labels: [f.label] })
  return { ...f, key: def?.key ?? null, layer, conflict }
})

const hit = rows.filter(r => r.key)
const miss = rows.filter(r => !r.key)
const pct = n => Math.round(n / rows.length * 100)

console.log(`\n欄位總數 ${rows.length}　認出 ${hit.length} 個 (${pct(hit.length)}%)`)
console.log(`  第 1 層 autocomplete  ${rows.filter(r => r.layer === 1).length}`)
console.log(`  第 2 層 標籤文字       ${rows.filter(r => r.layer === 2).length}`)
console.log(`  認不出來              ${miss.length}\n`)
if (miss.length) {
  console.log('認不出來的欄位：')
  for (const m of miss) console.log('  ・' + m.label)
}
const conflicts = rows.filter(r => r.conflict)
if (conflicts.length) {
  console.log('\n標籤與 autocomplete 打架（採用標籤）：')
  for (const c of conflicts) console.log(`  ・${c.label}　標籤說 ${c.key}，autocomplete 說 ${c.conflict}`)
}
const wrong = hit.filter(r => {
  const l = r.label
  return (l.includes('薪') && !r.key.includes('salary')) ||
         (l.includes('自傳') && !r.key.includes('auto'))
})
if (wrong.length) {
  console.log('\n可能配錯的：')
  for (const w of wrong) console.log(`  ・${w.label} → ${w.key}`)
}

console.log('\n──── 全部對應 ────')
for (const r of rows) {
  const s = r.key ? CB.sensitivityOf(r.key) : '—'
  const lock = s === 'sensitive' ? '🔒' : '  '
  console.log(`${lock} ${r.label.padEnd(12, '　')} → ${r.key ?? '（認不出來）'}`)
}
