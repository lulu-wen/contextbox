import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { rmTmp } from './helpers/rm.mjs'
import { linkDir } from './helpers/links.mjs'
/**
 * tools/demo-setup.mjs 的守門。
 *
 * **為什麼這一支值得存在**：`--reset` 是這個專案唯一一處遞迴刪除
 * （`rmSync(quarantine, { recursive: true })`）。core/ 裡「只搬不刪」有 repo.test.mjs 守著，
 * 但那條檢查的 SRC_DIRS 漏掉 tools/（2026-09-20 稽核抓到），而唯一的遞迴刪除就在這裡。
 *
 * 稽核抓到的兩個真的會刪到使用者檔案的路徑：
 *   1. `--dir ~/.contextbox --reset` —— 真的安裝也有 config.json，舊的判斷認不出來，
 *      整個 quarantine（使用者的檔）被遞迴刪掉。
 *   2. 家目錄守門比對「realpath 過的 HOME」與「沒 realpath 過的 --dir」，
 *      一個指到家目錄的捷徑就整個繞過去。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'demo-setup.mjs')

/** 跑一次工具，回 { code, out }。**不丟例外** —— 我們要看的就是它拒絕的那幾次。 */
function run(args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

const box = t => {
  const d = mkdtempSync(join(tmpdir(), 'cb-demo-guard-'))
  t.after(() => rmTmp(d))
  return d
}

describe('demo 沙盒的守門（唯一一處遞迴刪除）', () => {
  test('**真的安裝不可以被 --reset 刪掉**：~/.contextbox 也有 config.json', t => {
    const d = box(t)
    const home = join(d, 'home')
    const state = join(home, '.contextbox')
    mkdirSync(join(state, 'quarantine', 'plan-1'), { recursive: true })
    writeFileSync(join(state, 'config.json'), '{"watch":[]}')
    writeFileSync(join(state, 'quarantine', 'plan-1', 'content'), '使用者的檔')

    const r = run(['--dir', state, '--reset'], { HOME: home, USERPROFILE: home })
    assert.notEqual(r.code, 0, `應該拒絕，實際輸出：${r.out}`)
    assert.match(r.out, /Not touching it|left alone/)
    assert.equal(readFileSync(join(state, 'quarantine', 'plan-1', 'content'), 'utf8'), '使用者的檔',
      '隔離區裡的檔一個都不可以被刪')
    assert.equal(existsSync(join(state, 'config.json')), true)
  })

  test('沒有記號檔的資料夾不可以被 --reset（就算它長得很像沙盒）', t => {
    const d = box(t)
    const fake = join(d, 'looks-like-one')
    mkdirSync(join(fake, 'quarantine'), { recursive: true })
    writeFileSync(join(fake, 'config.json'), '{}')
    writeFileSync(join(fake, 'quarantine', 'x'), '重要')
    const r = run(['--dir', fake, '--reset'])
    assert.notEqual(r.code, 0)
    assert.match(r.out, /is not a demo sandbox this script built/)
    assert.equal(existsSync(join(fake, 'quarantine', 'x')), true)
  })

  test('捷徑繞不過家目錄守門（--dir 也要解 symlink）', t => {
    const d = box(t)
    const home = join(d, 'home')
    mkdirSync(home, { recursive: true })
    const link = join(d, 'link')
    linkDir(home, link)
    const r = run(['--dir', link], { HOME: home, USERPROFILE: home })
    assert.notEqual(r.code, 0, r.out)
    assert.match(r.out, /home directory/)
  })

  test('真的沙盒：建得起來、記號檔在、--reset 收得掉，而且 Downloads 裡的檔沒有被動', t => {
    const d = box(t)
    const sandbox = join(d, 'sandbox')
    const made = run(['--dir', sandbox])
    assert.equal(made.code, 0, made.out)
    assert.equal(existsSync(join(sandbox, '.contextbox-demo-sandbox')), true, '記號檔要寫出來')
    const before = readFileSync(join(sandbox, 'home', 'Downloads', 'empty.txt'), 'utf8')

    writeFileSync(join(sandbox, 'data.db'), 'x')
    mkdirSync(join(sandbox, 'quarantine'), { recursive: true })
    const r = run(['--dir', sandbox, '--reset'])
    assert.equal(r.code, 0, r.out)
    assert.equal(existsSync(join(sandbox, 'data.db')), false, '紀錄要清掉')
    assert.equal(existsSync(join(sandbox, 'quarantine')), false)
    assert.equal(readFileSync(join(sandbox, 'home', 'Downloads', 'empty.txt'), 'utf8'), before,
      'Downloads 裡的檔不可以被動')
  })

  test('貼過沙盒環境變數的視窗裡也 reset 得了（那時 HOME 就是沙盒）', t => {
    const d = box(t)
    const sandbox = join(d, 'sandbox')
    assert.equal(run(['--dir', sandbox]).code, 0)
    const home = join(sandbox, 'home')
    const r = run(['--dir', sandbox, '--reset'], { HOME: home, USERPROFILE: home })
    assert.equal(r.code, 0, `工具自己印給使用者的那一行指令要能跑：${r.out}`)
  })

  test('家目錄本身、家目錄的上層都不可以當沙盒', t => {
    const d = box(t)
    const home = join(d, 'a', 'b', 'home')
    mkdirSync(home, { recursive: true })
    for (const bad of [home, join(d, 'a', 'b'), join(d, 'a')]) {
      const r = run(['--dir', bad], { HOME: home, USERPROFILE: home })
      assert.notEqual(r.code, 0, `${bad} 應該被拒絕：${r.out}`)
    }
  })
})
