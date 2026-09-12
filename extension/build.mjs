/**
 * 把 factKeys.ts 的資料 ＋ match.js 的邏輯，打包成擴充套件能直接吃的一支 factTable.js。
 * 跑法：node --experimental-strip-types extension/build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { FACT_KEYS, SCHEMA_VERSION } = await import(join(here, '../schema/factKeys.ts'))

const matchSrc = readFileSync(join(here, '../schema/match.js'), 'utf8')
  .replace(/^export /gm, '')          // content script 不是 module，拿掉 export

const out = `// 自動產生，不要手改。改 schema/factKeys.ts 或 schema/match.js 之後重跑 build.mjs。
// schema ${SCHEMA_VERSION}
${matchSrc}
const FACT_KEYS = ${JSON.stringify(FACT_KEYS, null, 0)};
const SCHEMA_VERSION = ${JSON.stringify(SCHEMA_VERSION)};
const CB = buildIndex(FACT_KEYS);
`
writeFileSync(join(here, 'factTable.js'), out)
console.log(`factTable.js 產生完成 · ${FACT_KEYS.length} 個 key · schema ${SCHEMA_VERSION}`)
