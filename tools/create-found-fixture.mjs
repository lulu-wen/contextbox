import { open, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// Create a new, empty fixture without overwriting any existing file.
const folder = process.argv[2] ? resolve(process.argv[2]) : join(homedir(), 'Downloads')
const path = join(folder, `contextbox-found-test-${randomUUID()}.txt`)
const file = await open(path, 'wx')
await file.close()
// The empty-file rule requires at least one day without modification.
const old = new Date(Date.now() - 2 * 86400_000)
await utimes(path, old, old)
console.log(`Created: ${path}`)
console.log('Next: node cli.mjs cleanup scan')
console.log('Reload ContextBox to reset the previously acknowledged candidate reminder.')
