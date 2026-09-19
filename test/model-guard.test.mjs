import './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 送去模型之前那道關（core/model-guard.ts）。
 *
 * **這是這一期最兇的一支測試。** 會出事的方向只有一個：把金鑰送出去。
 * 所以每一條都從「有沒有漏掉」那一邊寫，而不是「有沒有誤擋」：
 *
 *   - 名字清單的每一個字、每一個副檔名都真的擋得住（一條一條列，不是抽樣）
 *   - 內容樣式的每一條都擋得住，而且**放在一份正常講義的中間**也擋得住
 *   - 大小寫、全形、前後有別的字都擋得住
 *   - 這台機器**自己設定的模型金鑰**出現在內容裡也擋得住
 *   - 隨機產生的正常中文講義**不會**被擋（誤擋會讓這道關被關掉，那才是真的危險）
 *
 * 預想表第 39 列那一對（能分辨兩種解讀的例子）在「兩層的分工」那一節：
 * `id_rsa` 靠名字擋、`作業系統_第5章.txt` 裡剛好有「password」這個字要照送。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SECRET_EXTS, SECRET_PATTERNS, SECRET_WHY, SECRET_WORDS, screen, secretByContent, secretByName,
} from '../core/model-guard.ts'

// ═══ 兩層的分工 ═══════════════════════════════════════════════

describe('預想表第 39 列的那一對：名字擋 id_rsa，內容有「password」的講義照送', () => {
  test('id_rsa：名字擋得住（它的內容是 base64，沒有任何一條內容樣式命中得了）', () => {
    const body = 'MIIEpAIBAAKCAQEA' + 'q'.repeat(400)
    assert.equal(secretByContent(body), null, '前提：這種內容本身命中不了任何樣式')
    const r = screen({ name: 'id_rsa', text: body })
    assert.equal(r.send, false)
    assert.equal(r.why, SECRET_WHY)
  })

  test('作業系統_第5章.txt 裡剛好有「password」這個字：**照送**', () => {
    const r = screen({
      name: '作業系統_第5章.txt',
      text: '作業系統 第 5 章 行程排程。考題會考 password 的雜湊與 salt，但那是安全那一章的內容。',
    })
    assert.equal(r.send, true, '一份講義提到 password 不是秘密 —— 擋掉它，這道關就會被關掉')
    assert.equal(r.why, null)
  })

  test('反過來：檔名叫 password.txt 就擋（名字那一層才收這個字）', () => {
    assert.equal(screen({ name: 'password.txt', text: '這裡面什麼都沒有' }).send, false)
  })
})

// ═══ 名字那一層 ═══════════════════════════════════════════════

describe('名字清單：每一個字都真的擋得住', () => {
  for (const word of SECRET_WORDS) {
    test(`「${word}」出現在檔名裡就不送`, () => {
      // 前後都夾別的字：子字串比對，不是完整檔名比對
      for (const name of [`${word}.txt`, `我的${word}備份.txt`, `2026-${word}`, word]) {
        const r = screen({ name })
        assert.equal(r.send, false, `${name} 沒被擋下來`)
        assert.equal(r.why, SECRET_WHY)
        assert.ok(r.rule && !r.rule.includes('\n'), '要講得出為什麼')
      }
    })
  }

  test('大小寫不管用', () => {
    for (const name of ['PASSWORD.TXT', 'Secret.md', 'ID_RSA', 'MyToken.json', 'Credentials']) {
      assert.equal(screen({ name }).send, false, `${name} 沒被擋下來`)
    }
  })

  test('全形字母也擋（ｐａｓｓｗｏｒｄ.txt 不可以換一種寫法就溜過去）', () => {
    assert.equal(screen({ name: 'ｐａｓｓｗｏｒｄ.txt' }).send, false)
    assert.equal(screen({ name: 'ＳＥＣＲＥＴ.md' }).send, false)
  })
})

describe('副檔名清單：每一個都真的擋得住', () => {
  for (const ext of SECRET_EXTS) {
    test(`${ext} 不送`, () => {
      assert.equal(screen({ name: `伺服器${ext}` }).send, false, `伺服器${ext} 沒被擋下來`)
      assert.equal(screen({ name: `A${ext.toUpperCase()}` }).send, false, `大寫的 ${ext} 沒被擋下來`)
    })
  }
})

describe('.env 的各種寫法', () => {
  for (const name of ['.env', '.env.local', '.env.production', 'prod.env', '.ENV']) {
    test(`${name} 不送`, () => assert.equal(screen({ name }).send, false))
  }
  test('但 environment.txt 這種普通名字照送', () => {
    assert.equal(screen({ name: 'environment.txt', text: 'x'.repeat(50) }).send, true)
  })
})

describe('名字那一層只收檔名，不收路徑', () => {
  test('一般的講義名字照送', () => {
    for (const name of ['作業系統_第5章_行程排程.txt', '未命名文件 (3).txt', 'IMG_2041.txt',
      'Screenshot 2026-09-18 at 10.31.02.png', '資料結構_lab3.zip', '會議記錄草稿.tmp']) {
      assert.equal(secretByName(name), null, `${name} 被誤擋了`)
    }
  })
})

// ═══ 內容那一層 ═══════════════════════════════════════════════

/** 一份看起來正常的講義，把 secret 夾在中間。 */
const inLecture = (secret) =>
  '作業系統 第 6 章 死結\n\n四個必要條件、銀行家演算法。\n'
  + `附錄：${secret}\n`
  + '下週小考範圍是 5.1 到 6.3。\n'

const CONTENT_CASES = [
  ['私鑰檔頭', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'],
  ['RSA 私鑰檔頭', '-----BEGIN RSA PRIVATE KEY-----'],
  ['OpenSSH 私鑰檔頭', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['PGP 私鑰檔頭', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
  ['憑證檔頭', '-----BEGIN CERTIFICATE-----'],
  ['AWS 金鑰 ID', 'AKIAIOSFODNN7EXAMPLE'],
  ['AWS 臨時金鑰 ID', 'ASIAIOSFODNN7EXAMPLE'],
  ['AWS 秘密金鑰欄位', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG'],
  ['GitHub token', 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'],
  ['GitHub 細粒度 token', 'github_pat_' + 'A'.repeat(30)],
  ['sk- 金鑰', 'sk-' + 'abcdefghijklmnopqrstuvwxyz1234'],
  ['Slack token', 'xoxb-123456789012-abcdefghijkl'],
  ['Google API 金鑰', 'AIza' + 'a'.repeat(35)],
  ['Bearer 授權標頭', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'],
  ['身分證字號', 'A123456789'],
  ['信用卡號', '4111 1111 1111 1111'],
  ['信用卡號（沒有分隔）', '4111111111111111'],
  ['信用卡號（減號分隔）', '5500-0000-0000-0004'],
  // ── P2 驗證員抓到的漏網：Downloads 裡最值錢的那幾種 ──
  ['Stripe 金鑰', 'sk_live_51H8xQrABCDEFGHijklmno'],
  ['Stripe 測試金鑰', 'rk_test_51H8xQrABCDEFGHijklmno'],
  ['帶密碼的連線字串', 'DATABASE_URL=postgres://app:s3cret@db.internal:5432/app'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['Kubernetes Secret', 'apiVersion: v1\nkind: Secret\ndata:\n  token: YWJj'],
  ['.pgpass 格式', 'db.example.com:5432:appdb:appuser:hunter2'],
  ['私鑰欄位', '{"private_key": "-----BEGIN"}'],
  ['帳密表（英文標頭）', 'url,username,password,httpRealm\nhttps://a.com,alice@example.com,Tr0ub4dor&3,'],
  ['帳密表（中文標頭）', '網站,帳號,密碼\nexample.com,alice,hunter2'],
]

describe('內容樣式：每一條都擋得住，夾在講義中間也一樣', () => {
  for (const [label, secret] of CONTENT_CASES) {
    test(label, () => {
      assert.ok(secretByContent(secret), `單獨放：${label} 沒命中`)
      assert.ok(secretByContent(inLecture(secret)), `夾在講義中間：${label} 沒命中`)
      const r = screen({ name: '講義.txt', text: inLecture(secret) })
      assert.equal(r.send, false, `${label} 被送出去了`)
      assert.equal(r.why, SECRET_WHY)
    })
  }

  test('每一條樣式都有測到（清單長出新的一條就要補一個案例）', () => {
    const covered = new Set()
    for (const [, secret] of CONTENT_CASES) {
      for (const [label, re] of SECRET_PATTERNS) if (re.test(secret)) covered.add(label)
    }
    const missing = SECRET_PATTERNS.map(([label]) => label).filter(l => !covered.has(l))
    assert.deepEqual([...new Set(missing)], [], '這幾條樣式沒有任何案例打到')
  })
})

describe('信心卡號用 Luhn，身分證不驗檢查碼', () => {
  test('過 Luhn 的卡號擋掉', () => {
    for (const n of ['4111111111111111', '5500000000000004', '378282246310005', '6011111111111117']) {
      assert.ok(secretByContent(`卡號 ${n}`), `${n} 沒擋`)
    }
  })
  test('一串過不了 Luhn 的訂單編號不算卡號（誤擋會把這道關變成噪音）', () => {
    assert.equal(secretByContent('訂單編號 1234567890123456'), null)
  })
  test('身分證字號**不驗檢查碼**：格式對就擋（檢查碼錯的那些才最像身分證）', () => {
    assert.ok(secretByContent('身分證 A123456789'))
    assert.ok(secretByContent('身分證 B200000000'), '檢查碼錯的也要擋')
  })
  test('一般的 8 碼學號、電話不會被當成身分證', () => {
    assert.equal(secretByContent('學號 41047001 電話 0912345678'), null)
  })
})

// ═══ 這台機器自己的金鑰 ═══════════════════════════════════════

describe('內容裡出現「這台機器設定的模型金鑰」就不送', () => {
  const key = 'cbx-test-key-0123456789abcdef'
  test('原封不動出現在內容裡 → 擋', () => {
    const r = screen({ name: '筆記.txt', text: `我的設定：CONTEXTBOX_MODEL_KEY=${key}\n` + 'x'.repeat(100), key })
    assert.equal(r.send, false)
    assert.equal(r.why, SECRET_WHY)
    assert.ok(!r.rule.includes(key), '為什麼那句話本身不可以把金鑰抄出來')
  })
  test('沒給金鑰、或金鑰太短 → 不比（免得把所有檔都擋掉）', () => {
    const text = '作業系統 第 6 章 死結。四個必要條件、銀行家演算法。abc'
    assert.equal(screen({ name: '講義.txt', text, key: 'abc' }).send, true)
    assert.equal(screen({ name: '講義.txt', text, key: '' }).send, true)
    assert.equal(screen({ name: '講義.txt', text }).send, true)
  })
})

// ═══ 順序與形狀 ═══════════════════════════════════════════════

describe('screen 的形狀', () => {
  test('名字先判：名字命中時不必看內容（連 text 都沒給也擋得住）', () => {
    const r = screen({ name: 'id_rsa' })
    assert.deepEqual(Object.keys(r).sort(), ['rule', 'send', 'why'])
    assert.equal(r.send, false)
  })
  test('過關時 why 與 rule 都是 null', () => {
    assert.deepEqual(screen({ name: '講義.txt', text: '作業系統 第 6 章 死結 ' + 'a'.repeat(50) }),
      { send: true, why: null, rule: null })
  })
  test('擋下來的那句話一定含「看起來像機密」（面板與 doctor 照這句數）', () => {
    assert.match(SECRET_WHY, /看起來像機密/)
    assert.equal(screen({ name: '.env' }).why, SECRET_WHY)
    assert.equal(screen({ name: '講義.txt', text: inLecture('AKIAIOSFODNN7EXAMPLE') }).why, SECRET_WHY)
  })
  test('圖片（沒有 text）只過名字那一層', () => {
    assert.equal(screen({ name: 'Screenshot 2026-09-18.png' }).send, true)
    assert.equal(screen({ name: 'secret-螢幕截圖.png' }).send, false)
  })
})

// ═══ 結構化隨機 ═══════════════════════════════════════════════

/** 很小的可重現亂數（xorshift32）。 */
function rng(seed) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    return x / 4294967296
  }
}

/** 可以夾在句子中間照樣算數的那些（整行格式的不算，見隨機測試的註解）。 */
const INLINE_CASES = CONTENT_CASES.filter(([label]) => !/pgpass|帳密表/.test(label))

describe('弱關鍵字：文件格式放行，純文字與表格照擋', () => {
  // 一份叫「tokenizer作業.pdf」或「帳號與密碼章節.pptx」的講義被擋掉，使用者只會覺得功能壞了。
  // 這幾種格式不是拿來放密碼的，而且內容那一層照樣會擋。
  for (const name of ['tokenizer作業.pdf', '作業系統_帳號與密碼章節.pptx', '密碼學講義.pdf', 'auth 機制報告.docx']) {
    test(`放行：${name}`, () => {
      assert.equal(screen({ name, text: '這一章講雜湊與加鹽。' }).send, true, `${name} 被擋掉了`)
    })
  }
  for (const name of ['password.txt', '金鑰.txt', '我的密碼.csv', 'secret.md', 'token']) {
    test(`照擋：${name}`, () => {
      assert.equal(screen({ name, text: 'hunter2' }).send, false, `${name} 沒擋住`)
    })
  }
  test('文件格式也擋得住強關鍵字與真的秘密', () => {
    assert.equal(screen({ name: 'id_rsa.pdf', text: 'x' }).send, false, '強關鍵字不放行')
    assert.equal(screen({ name: '密碼學講義.pdf', text: '-----BEGIN PRIVATE KEY-----' }).send, false, '內容那一層照樣擋')
  })
})

describe('結構化隨機：秘密塞在任何位置都擋得住；正常講義不會被擋', () => {
  const words = ['行程排程', '死結', '銀行家演算法', '分頁', '虛擬記憶體', '互斥鎖', '號誌',
    '第 3 章', '小考', '作業三', 'FCFS', 'Round Robin', '講義', '範例', '習題']

  test('200 份隨機講義＋隨機位置的秘密 → 每一份都擋得住', () => {
    const next = rng(20260919)
    for (let i = 0; i < 200; i++) {
      const n = 5 + Math.floor(next() * 40)
      const parts = []
      for (let k = 0; k < n; k++) parts.push(words[Math.floor(next() * words.length)])
      // **整行格式**的那幾條（.pgpass、帳密表）不進隨機：它們的語意就是「這一行／這張表是什麼」，
      // 拿逗號把它接在講義中間之後就不再是那個東西了，擋不到是對的。它們各自有自己的案例。
      const [, secret] = INLINE_CASES[Math.floor(next() * INLINE_CASES.length)]
      const at = Math.floor(next() * (parts.length + 1))
      parts.splice(at, 0, secret)
      const text = parts.join(next() < 0.5 ? '\n' : '，')
      const r = screen({ name: '講義.txt', text })
      assert.equal(r.send, false, `第 ${i} 份漏了（秘密在第 ${at} 段）：${secret.slice(0, 24)}`)
    }
  })

  test('200 份隨機講義（沒有秘密）→ 一份都不該被擋', () => {
    const next = rng(777)
    for (let i = 0; i < 200; i++) {
      const n = 5 + Math.floor(next() * 40)
      const parts = []
      for (let k = 0; k < n; k++) parts.push(words[Math.floor(next() * words.length)])
      const text = parts.join(next() < 0.5 ? '\n' : '，')
      const r = screen({ name: `作業系統_第${i % 9 + 1}章.txt`, text })
      assert.equal(r.send, true, `第 ${i} 份被誤擋：${r.rule}`)
    }
  })
})
