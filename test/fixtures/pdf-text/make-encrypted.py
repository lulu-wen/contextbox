# 開發期產生範例檔用（測試執行時不會跑這支）。
# 只設擁有者密碼、使用者密碼空白的加密 PDF（很多學校／出版社的講義長這樣）。
# 用法：python3 make-encrypted.py 輸出路徑
import sys
from reportlab.pdfgen import canvas
from reportlab.lib.pdfencrypt import StandardEncryption

out = sys.argv[1]
enc = StandardEncryption('', ownerPassword='owner', canPrint=1, canModify=0, canCopy=0, canAnnotate=0)
c = canvas.Canvas(out, encrypt=enc, pageCompression=1)
c.setFont('Helvetica', 14)
c.drawString(72, 760, 'Protected lecture notes')
c.showPage()
c.save()
