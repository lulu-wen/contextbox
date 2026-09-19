# 開發期產生範例檔用（測試執行時不會跑這支）。
# reportlab 的 UnicodeCIDFont 不嵌入字型、沒有 /ToUnicode，
# 字型編碼是 /UniCNS-UCS2-H（字碼本身就是 UCS-2），很多舊的台灣 PDF 長這樣。
# 最後一行用 Helvetica（標準 14 字型、不嵌入、沒有 /Widths）。
# 用法：python3 make-reportlab.py 輸出路徑
import sys
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase import cidfonts
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

# reportlab 4.1 把 MSung-Light 對到 UniGB-UCS2-H（簡中），這裡改回繁中的 UniCNS-UCS2-H。
cidfonts.defaultUnicodeEncodings['MSung-Light'] = ('cht', 'UniCNS-UCS2-H')
pdfmetrics.registerFont(UnicodeCIDFont('MSung-Light'))

out = sys.argv[1]
c = canvas.Canvas(out, pageCompression=1)
c.setFont('MSung-Light', 16)
c.drawString(72, 760, '計算機概論 期中考範圍')
c.setFont('MSung-Light', 12)
c.drawString(72, 730, '第一章到第五章，含二進位與布林代數。')
c.setFont('Helvetica', 12)
c.drawString(72, 700, 'Midterm: Oct. 21, Room 204')
c.showPage()
c.save()
