# 開發期產生範例檔用（測試執行時不會跑這支）。
# 用 PIL 畫一張「看起來像掃描」的灰階圖，直接存成 PDF：整份只有圖片、沒有文字層。
# 用法：python3 make-scan.py 輸出路徑
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
img = Image.new('L', (320, 200), 245)
draw = ImageDraw.Draw(img)
for i in range(8):
    y = 24 + i * 20
    draw.rectangle([20, y, 300 - (i % 3) * 40, y + 8], fill=40)
img.save(out, 'PDF', resolution=72.0)
