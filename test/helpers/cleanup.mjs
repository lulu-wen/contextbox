import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from '../../core/db.ts'
import { scanDownloads } from '../../core/cleanup-scanner.ts'
import { createPlan } from '../../core/cleanup-plans.ts'

export function fixture(t, files = { 'a.zip': 'archive a', 'b.zip': 'archive b' }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-exec-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads)
  const dbPath = join(dir, 'data.db')
  const db = open(dbPath)
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const opts = { roots: [downloads], quarantine: join(dir, 'quarantine'), maxBytes: 1024 * 1024 }
  const old = new Date(Date.now() - 120 * 86400000)
  for (const [name, content] of Object.entries(files)) {
    const path = join(downloads, name)
    writeFileSync(path, content)
    utimesSync(path, old, old)
  }
  const scan = () => scanDownloads({ db, ...opts })
  scan()
  const plan = () => createPlan(db)
  return { db, dbPath, dir, downloads, opts, old, scan, plan }
}
