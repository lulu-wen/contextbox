document.getElementById('setup').onclick = () => chrome.runtime.openOptionsPage()

document.getElementById('go').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  chrome.tabs.sendMessage(tab.id, 'cb-scan', r => {
    document.getElementById('out').textContent = r
      ? `${r.total} 個欄位 · 認出 ${r.hit} 個 (${Math.round(r.hit / r.total * 100)}%)`
      : '這一頁掃不到（可能要重新整理）'
  })
}
