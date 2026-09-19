/**
 * 在指定的那一刻用 SIGKILL 把自己砍掉，模擬 kill -9、斷電、pet 當掉。
 *
 * 用法：node r2-crash-child.mjs <dbPath> <optsJSON> <apply|undo> <planId> <point>
 * point：before-rename（rename 之前）、after-rename（rename 完、還沒寫 done）。
 *
 * **要在 import 核心之前換掉 fs.renameSync**，再 syncBuiltinESMExports，
 * 核心 `import { renameSync } from 'node:fs'` 拿到的才是換過的那一支。
 * 只在測試裡用（test/audit-0919-r2exec.test.mjs），父行程會給假的 HOME。
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const [dbPath, optsJson, action, planId, point] = process.argv.slice(2)
const die = () => process.kill(process.pid, 'SIGKILL')
const rename = fs.renameSync
fs.renameSync = function (from, to) {
  if (point === 'before-rename') die()
  const r = rename.call(this, from, to)
  if (point === 'after-rename') die()
  return r
}
syncBuiltinESMExports()

const { open } = await import(new URL('../../core/db.ts', import.meta.url).href)
const { applyPlan, undoPlan } = await import(new URL('../../core/cleanup-exec.ts', import.meta.url).href)
const db = open(dbPath)
const opts = JSON.parse(optsJson)
const r = action === 'undo' ? undoPlan(db, planId, opts) : applyPlan(db, planId, opts)
// 走到這裡代表沒有被砍到（point 沒打中），父行程會當成前提失敗
console.log(JSON.stringify({ survived: true, status: r.status }))
