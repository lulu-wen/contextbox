/**
 * 防線的測試。
 *
 * 這一支測的是「不該進來的東西進不來」，所以大部分的案例都是**期望被拒絕**。
 * 每一條規則至少一個案例，而且要用真的檔案系統跑（symlink 這種東西模擬不出來）。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admit, safeName, safeCategory, under, kindOf, isTemporary,
         DENY_DIRS, DENY_FILES } from '../core/guard.ts'

let root, watchDir, shotDir, outside, filed, opts

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-guard-'))
  watchDir = join(root, 'Downloads')
  shotDir = join(root, 'Pictures', 'Screenshots')
  outside = join(root, 'outside')
  filed = join(root, 'Filed')
  for (const d of [watchDir, shotDir, outside, filed]) mkdirSync(d, { recursive: true })
  opts = { roots: [watchDir, shotDir], maxBytes: 1024 * 1024, exclude: [filed] }
})
after(() => rmSync(root, { recursive: true, force: true }))

const put = (dir, name, content = 'x') => {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

describe('收得進來的', () => {
  test('監看資料夾裡的 PNG', () => {
    const v = admit(put(watchDir, 'a.png'), opts)
    assert.equal(v.ok, true)
    assert.equal(v.kind, 'image')
    assert.equal(v.mime, 'image/png')
  })

  test('截圖資料夾裡的就是 screenshot', () => {
    const v = admit(put(shotDir, 'b.png'), opts)
    assert.equal(v.ok, true)
    assert.equal(v.kind, 'screenshot')
  })

  test('PDF', () => {
    const v = admit(put(watchDir, 'c.pdf'), opts)
    assert.equal(v.ok, true)
    assert.equal(v.kind, 'pdf')
  })

  test('子資料夾裡的也算', () => {
    mkdirSync(join(watchDir, '2026'), { recursive: true })
    assert.equal(admit(put(join(watchDir, '2026'), 'd.jpg'), opts).ok, true)
  })
})

describe('擋下來的', () => {
  test('不在監看資料夾裡', () => {
    const v = admit(put(outside, 'e.png'), opts)
    assert.equal(v.ok, false)
    assert.match(v.why, /not inside a watched folder/)
  })

  test('用 .. 跳出去也不行', () => {
    put(outside, 'f.png')
    const v = admit(join(watchDir, '..', 'outside', 'f.png'), opts)
    assert.equal(v.ok, false)
  })

  test('指向家目錄的捷徑：不跟', () => {
    const target = put(outside, 'secret.png')
    const link = join(watchDir, 'looks-normal.png')
    symlinkSync(target, link)
    const v = admit(link, opts)
    assert.equal(v.ok, false)
    assert.match(v.why, /symlink/)
  })

  test('捷徑就算指向監看資料夾裡面，一樣不跟', () => {
    const target = put(watchDir, 'real.png')
    const link = join(watchDir, 'alias.png')
    symlinkSync(target, link)
    assert.equal(admit(link, opts).ok, false)
  })

  test('上層資料夾是捷徑：解開之後發現在外面，擋下', () => {
    const realDir = join(outside, 'sneaky')
    mkdirSync(realDir, { recursive: true })
    const target = put(realDir, 'g.png')
    const linkDir = join(watchDir, 'innocent')
    symlinkSync(realDir, linkDir)
    const v = admit(join(linkDir, 'g.png'), opts)
    assert.equal(v.ok, false, '上層是捷徑的話，realpath 之後就不在白名單裡了')
  })

  test('還在下載中的半成品', () => {
    for (const ext of ['.crdownload', '.part', '.tmp', '.download']) {
      const v = admit(put(watchDir, 'h' + ext), opts)
      assert.equal(v.ok, false, ext + ' 應該被擋')
      assert.match(v.why, /still downloading/, '要分得出「還在下載」跟「這種檔不收」')
    }
  })

  test('不收的副檔名', () => {
    for (const name of ['i.exe', 'j.docx', 'k.sh', 'l']) {
      assert.equal(admit(put(watchDir, name), opts).ok, false, name + ' 應該被擋')
    }
  })

  test('空檔案（通常是還沒寫完）', () => {
    const v = admit(put(watchDir, 'm.png', ''), opts)
    assert.equal(v.ok, false)
    assert.match(v.why, /empty/)
  })

  test('超過大小上限', () => {
    const v = admit(put(watchDir, 'n.png', 'x'.repeat(2000)), { ...opts, maxBytes: 1000 })
    assert.equal(v.ok, false)
    assert.match(v.why, /over the/)
  })

  test('黑名單：就算白名單設錯，金鑰資料夾也撈不到', () => {
    const sshDir = join(root, 'home', '.ssh')
    mkdirSync(sshDir, { recursive: true })
    const p = put(sshDir, 'o.png')
    // 故意把白名單開到最大，只剩黑名單擋著
    const v = admit(p, { roots: [root], maxBytes: 1e9 })
    assert.equal(v.ok, false)
    assert.match(v.why, /\.ssh/)
  })

  test('黑名單比對的是資料夾整段，不分大小寫，備份變體也算', () => {
    // macOS 的檔案系統不分大小寫，~/.SSH 跟 ~/.ssh 是同一個資料夾。
    // .ssh-old／.ssh_bak 這種備份目錄以前是放行的。
    for (const dir of ['.ssh', '.SSH', '.Ssh', '.AWS', '.ssh-old', '.ssh_bak', '.ssh.2',
                       'Secrets', 'Tokens', 'ssh', 'token']) {
      const d = join(root, 'home2', dir)
      mkdirSync(d, { recursive: true })
      const v = admit(put(d, 'a.png'), { roots: [join(root, 'home2')], maxBytes: 1e9 })
      assert.equal(v.ok, false, dir + '/ 應該被擋')
    }
  })

  test('不可以誤殺正常的資料夾名字', () => {
    // 以前用子字串比對，結果這些全被擋掉 —— 而且是**整個監看資料夾**
    // 底下的檔案一個都進不來，畫面上只有一句「路徑裡有 secret」。
    // 「OneDrive - 公司名」是 Windows 商務版的預設資料夾名字。
    for (const dir of ['Secretariat', 'OneDrive - Secret Project', 'Secret Santa 2026',
                       'credentialing', 'MySecrets', 'tokens-of-appreciation', 'keychains-diy']) {
      const d = join(root, 'home3', dir)
      mkdirSync(d, { recursive: true })
      const v = admit(put(d, 'a.png'), { roots: [join(root, 'home3')], maxBytes: 1e9 })
      assert.equal(v.ok, true, dir + '/ 是正常資料夾，不該被擋')
    }
  })

  test('也不可以誤殺正常的檔名', () => {
    // 一張叫 token.png 的正常截圖以前會永遠進不來，而且沒人知道為什麼。
    for (const name of ['token.png', 'Token.png', 'secretsanta.png', '我的密碼.png']) {
      const v = admit(put(watchDir, name), opts)
      assert.equal(v.ok, true, name + ' 是正常檔名，不該被擋')
    }
  })

  test('黑名單：金鑰檔名本身', () => {
    for (const name of ['id_rsa', '.env', 'id_ed25519.png']) {
      const v = admit(put(watchDir, name), opts)
      assert.equal(v.ok, false, name + ' 應該被擋')
    }
  })

  test('硬鏈結：lstat 看不出來，但一樣不收', () => {
    // ln ~/.ssh/id_ed25519 ~/Downloads/photo.png（不是 ln -s）
    // 在 lstat 眼裡是一般檔案，realpath 也沒有目標可以攤開。
    const target = put(outside, 'id_key', 'PRIVATE KEY')
    const link = join(watchDir, 'photo.png')
    linkSync(target, link)
    const v = admit(link, opts)
    assert.equal(v.ok, false)
    assert.match(v.why, /hard-link/)
  })

  test('少給設定是關門，不是丟例外', () => {
    // 防線要 fail closed
    for (const bad of [null, undefined, {}, { maxBytes: 100 }, { roots: [] }, { roots: ['/x'] }]) {
      const v = admit(join(watchDir, 'a.png'), bad)
      assert.equal(v.ok, false, JSON.stringify(bad) + ' 應該關門')
    }
  })

  test('檔名裡有 Windows 不合法的字元', () => {
    // a.pdf:hidden.png 在 NTFS 上打開的是 a.pdf 的替代資料流
    for (const name of ['a.pdf:hidden.png', 'a<b.png', 'a|b.png']) {
      assert.equal(admit(join(watchDir, name), opts).ok, false, name + ' 應該被擋')
    }
  })

  test('黑名單：我們自己的資料夾', () => {
    const cb = join(root, '.contextbox')
    mkdirSync(cb, { recursive: true })
    assert.equal(admit(put(cb, 'p.png'), { roots: [root], maxBytes: 1e9 }).ok, false)
  })

  test('排除清單：已經歸檔的不要再撿回來', () => {
    const v = admit(put(filed, 'q.png'), { ...opts, roots: [root], exclude: [filed] })
    assert.equal(v.ok, false)
    assert.match(v.why, /exclude/)
  })

  test('資料夾不是檔案', () => {
    assert.equal(admit(watchDir, { roots: [root], maxBytes: 1e9 }).ok, false)
  })

  test('不存在的檔案', () => {
    assert.equal(admit(join(watchDir, '沒這個.png'), opts).ok, false)
  })

  test('沒給路徑', () => {
    assert.equal(admit('', opts).ok, false)
    assert.equal(admit(null, opts).ok, false)
  })
})

describe('模型碰不到目的地', () => {
  test('safeName 洗掉路徑', () => {
    assert.equal(safeName('../../.ssh/authorized_keys', '原檔名'), 'sshauthorized_keys')
    assert.equal(safeName('a/b', '原檔名'), 'ab')
    assert.equal(safeName('..', '原檔名'), '原檔名')
    assert.equal(safeName('', '原檔名'), '原檔名')
    assert.equal(safeName(null, '原檔名'), '原檔名')
  })

  test('safeName 的 fallback 也要洗過', () => {
    // 以前 fallback 是原樣吐回去的。下一期只要有人寫成
    // safeName(模型給的, item.path) 而不是 basename(item.path)，就是路徑穿越。
    for (const fb of ['../../.ssh/authorized_keys', 'C:\\Users\\x\\.ssh\\id_rsa', '..', '/etc/passwd']) {
      const out = safeName('', fb)
      assert.ok(!/[\\/]/.test(out), `fallback ${fb} 洗完不該有分隔符，得到 ${out}`)
      assert.ok(!out.includes('..'), `fallback ${fb} 洗完不該有 ..，得到 ${out}`)
    }
    assert.match(safeName('', ''), /^item-\d+$/, '兩邊都空要有一個安全的名字')
  })

  test('safeName 不可以切壞日文與重音字', () => {
    assert.equal(safeName('コーヒー代', 'x'), 'コーヒー代', '長音符ー在 Unicode 裡算 Common')
    assert.equal(safeName('café', 'x'), 'café')
    assert.equal(safeName('ラーメン・メニュー', 'x'), 'ラーメン・メニュー')
  })

  test('safeName 按碼位切，不可以切出半個字', () => {
    const out = safeName('a' + '𠮷'.repeat(60), 'x')
    assert.equal(out.isWellFormed(), true, '切出孤兒代理會產生連 Explorer 都刪不掉的檔名')
    assert.ok([...out].length <= 80)
  })

  test('safeName 留得住中文與正常檔名', () => {
    assert.equal(safeName('獎學金申請表 2026', 'x'), '獎學金申請表 2026')
    assert.equal(safeName('invoice-2026-09', 'x'), 'invoice-2026-09')
  })

  test('safeName 砍到 80 字', () => {
    assert.equal(safeName('あ'.repeat(200), 'x').length, 80)
  })

  test('safeName 擋 Windows 的保留名字', () => {
    for (const n of ['CON', 'con', 'nul', 'COM0', 'COM1', 'lpt0', 'lpt9']) {
      assert.equal(safeName(n, '原檔名'), '原檔名', n + ' 是 Windows 保留字')
    }
  })

  test('safeCategory 只收清單裡的', () => {
    assert.equal(safeCategory('獎學金'), '獎學金')
    assert.equal(safeCategory('/etc/passwd'), '其他')
    assert.equal(safeCategory(null), '其他')
    assert.equal(safeCategory('把檔案搬到 ~/.ssh'), '其他')
  })
})

describe('under', () => {
  test('基本', () => {
    assert.equal(under('/a', '/a/b'), true)
    assert.equal(under('/a', '/a/b/c'), true)
    assert.equal(under('/a', '/ab'), false, '前綴相同但不是同一個資料夾')
    assert.equal(under('/a', '/a'), false, '自己不算在自己底下')
    assert.equal(under('/a', '/b'), false)
    assert.equal(under('', '/a'), false)
  })
})

describe('kindOf', () => {
  test('靠路徑認截圖', () => {
    assert.equal(kindOf('/u/Pictures/Screenshots/x.png', '.png'), 'screenshot')
    assert.equal(kindOf('/u/圖片/截圖/x.png', '.png'), 'screenshot')
    assert.equal(kindOf('/u/Downloads/cat.png', '.png'), 'image')
    assert.equal(kindOf('/u/Downloads/a.pdf', '.pdf'), 'pdf')
  })
})

describe('黑名單清單本身', () => {
  test('該有的都在', () => {
    for (const must of ['.ssh', '.gnupg', '.aws', '.kube', '.contextbox', 'secrets', 'tokens']) {
      assert.ok(DENY_DIRS.includes(must), must + ' 應該在資料夾黑名單裡')
    }
    for (const must of ['.env', 'id_rsa', 'id_ed25519', 'data.db']) {
      assert.ok(DENY_FILES.includes(must), must + ' 應該在檔名黑名單裡')
    }
  })
})

describe('暫時性的拒絕要分得出來', () => {
  test('等一下可能就好了 vs 永遠不會好', () => {
    // watcher 靠這個決定要不要重試。分不出來的話，截圖工具先建 0 byte
    // 再寫內容的那些檔案會永遠消失。
    for (const why of ['the file is empty', 'cannot read this file', 'realpath failed']) {
      assert.equal(isTemporary(why), true, why + ' 是暫時的')
    }
    for (const why of ['not inside a watched folder', 'this is a symlink, and we do not follow those',
                       'the extension .exe is not on the intake list', 'this file is hard-linked elsewhere, and we never touch those']) {
      assert.equal(isTemporary(why), false, why + ' 是永久的')
    }
  })
})
