# 開發期用：用 LibreOffice 開 docx，「接受所有修訂」後存成 UTF-8 純文字（標準答案，存成「檔名.accepted.txt」）。
# 用法：python3 accept-all-changes.py <profile 資料夾> a.docx b.docx …（要有 LibreOffice 附的 uno 模組）。測試執行時不跑這支。
import sys, os, time, subprocess, uno
from com.sun.star.beans import PropertyValue
def P(n, v):
    p = PropertyValue(); p.Name = n; p.Value = v; return p
# 用獨立的 LibreOffice 設定檔，避免跟其他正在跑的 soffice 搶鎖
prof = 'file://' + os.path.abspath(sys.argv[1])
proc = subprocess.Popen(['soffice', '--headless', '--norestore', '--nologo', '-env:UserInstallation=' + prof, '--accept=pipe,name=pmarkfixture;urp;'])
local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
for _ in range(120):
    try:
        ctx = resolver.resolve('uno:pipe,name=pmarkfixture;urp;StarOffice.ComponentContext'); break
    except Exception:
        time.sleep(0.5)
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext('com.sun.star.frame.Desktop', ctx)
dispatcher = smgr.createInstanceWithContext('com.sun.star.frame.DispatchHelper', ctx)
try:
    for f in sys.argv[2:]:
        url = 'file://' + os.path.abspath(f)
        doc = desktop.loadComponentFromURL(url, '_blank', 0, (P('Hidden', True),))
        frame = doc.getCurrentController().getFrame()
        dispatcher.executeDispatch(frame, '.uno:AcceptAllTrackedChanges', '', 0, ())
        out = 'file://' + os.path.abspath(f) + '.accepted.txt'
        doc.storeToURL(out, (P('FilterName', 'Text (encoded)'), P('FilterOptions', 'UTF8,LF')))
        doc.close(True)
finally:
    try: desktop.terminate()
    except Exception: pass
    proc.wait(timeout=60)
