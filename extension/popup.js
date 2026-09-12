document.getElementById('setup').onclick = () => chrome.runtime.openOptionsPage()

const out = document.getElementById('out')
const say = t => { out.textContent = t }

/**
 * 掃描是由這裡發動的，不是網頁載入就自動跑。
 *
 * 擴充套件平常一個字都不會寫進你造訪的網頁。你按了這顆按鈕，
 * 我們才用 activeTab 的權限把程式注入「當下這一頁」。
 */
document.getElementById('go').onclick = async () => {
  say('注入中…')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !tab.id) return say('找不到目前的分頁。')
  if (!/^https?:/.test(tab.url || '')) {
    return say('這一頁不是一般網頁（chrome:// 或擴充套件頁面），不能掃描。')
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['factTable.js', 'fill.js', 'content.js'],
    })
  } catch (e) {
    return say('注入失敗：' + ((e && e.message) || e))
  }
  say('掃描中…')
  chrome.tabs.sendMessage(tab.id, 'cb-scan', r => {
    if (chrome.runtime.lastError || !r) {
      return say('這一頁掃不到。請重新整理再試一次。')
    }
    if (r.error) return say('掃描出錯：' + r.error)
    const pct = r.total ? Math.round(r.hit / r.total * 100) : 0
    say(`${r.total} 個欄位 · 認出 ${r.hit} 個（${pct}%）\n細節看網頁右下角那塊面板。`)
  })
}
