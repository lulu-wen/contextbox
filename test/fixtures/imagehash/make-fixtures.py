# 開發期產生 imagehash 測試用的灰階檔（測試執行時不會跑這支，也不需要 PIL）。
#
# 來源：headless Chromium 截的 8 組真實截圖（PNG），以及對應的 expected.json。
# 做法：用 PIL 讀出 RGB，照 core/png.ts 的灰階公式 (299R + 587G + 114B + 500) / 1000 取整，
#       把每張存成 <名稱>.gray.gz（raw 8 位元灰階、列優先、gzip，mtime 固定為 0 以便重現），
#       寬高與 raw 的 sha256 記在 images.json。
#
# 用法：python3 make-fixtures.py <含 png/ 與 expected.json 的資料夾>
#
# golden.json 由 make-golden.py 產生：另一份照預想表定義寫的 Python 實作（面積平均縮放、9×8 dHash、
# 長邊 640～960 的細比對縮圖）對這些灰階檔算出來的答案，測試只比對存下來的值。
# 合成的反例與字形表由 make-synth.py 產生（放在 synth/）。
import gzip
import hashlib
import json
import os
import shutil
import sys

from PIL import Image

src = sys.argv[1]
out = os.path.dirname(os.path.abspath(__file__))
images = {}
for fn in sorted(os.listdir(os.path.join(src, 'png'))):
    if not fn.endswith('.png'):
        continue
    name = fn[:-4]
    im = Image.open(os.path.join(src, 'png', fn)).convert('RGB')
    w, h = im.size
    b = im.tobytes()
    g = bytearray(w * h)
    for i in range(w * h):
        j = 3 * i
        g[i] = (299 * b[j] + 587 * b[j + 1] + 114 * b[j + 2] + 500) // 1000
    raw = bytes(g)
    with open(os.path.join(out, name + '.gray.gz'), 'wb') as f:
        f.write(gzip.compress(raw, compresslevel=9, mtime=0))
    images[name] = {'width': w, 'height': h, 'sha256': hashlib.sha256(raw).hexdigest()}

with open(os.path.join(out, 'images.json'), 'w', encoding='utf-8') as f:
    json.dump({
        'method': 'PIL 讀 RGB，灰階 = (299R + 587G + 114B + 500) // 1000（與 core/png.ts 相同），raw 列優先、gzip',
        'images': images,
    }, f, ensure_ascii=False, indent=2)
    f.write('\n')

shutil.copyfile(os.path.join(src, 'expected.json'), os.path.join(out, 'expected.json'))
