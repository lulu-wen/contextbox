# 開發期產生 imagehash 第四輪的測試圖（測試執行時不會跑這支，也不需要 PIL）。
#
# 內容：第三輪對抗式驗證找到、當時被判成 same 的反例，逐位元組重現驗證者當時的圖。
# 畫法照抄驗證者的產生程式（p0p1-round3/verify3-imagehash/run/ 的 gen_misc.py、gen_caret.py、gen_col.py、gen_low.py），
# PIL 畫 RGB 再 convert('L')。
#   - R ：真實 Chromium 截圖（驗證者用 headless_shell-1228 截的，real/shots）。浮動按鈕用 CSS 上下跳 4px，
#         兩張之間改徽章（1→2、1→12）、未讀數、淺灰的更新時間、#ddd 的草稿數、時鐘，或什麼都不改。
#         這一類沒辦法重畫，直接收驗證者存的 .gray。
#   - E ：浮動按鈕平移 1～3px，同時徽章數字變了（1→2、3→8、2→5、9→12）。
#   - H ：直條圖（條寬 4～8px），一票從第 3 項移到第 7 項。
#   - F ：灰階亮度幾乎一樣的換色（紅→綠的狀態點與標籤）。灰階差 ≤ 2 的是已知限制（same），其他不可以是 same。
#   - C ：細長的字「!」「l」「I」「|」從第 1 行行尾搬到第 3 行行尾。第三輪判 same 的 140 組全部（照驗證者的 caret.out），
#         加上第四輪挑錯、多收的 72 組（第三輪其實是 similar；一樣不可以是 same，留著），共 212 組。
#   - K ：置中的一欄數字整欄移 3～4px，同時其中一格改掉。第三輪判 same 的 26 組全部（col.out；都是移 3、4px 的），加上第四輪多收的 11 組，共 37 組。
#   - L ：淡色小字（白底 #ccc～#eee、深色底 #3c～#50）的短字串或整行換掉。第三輪判 same 的 292 組全部（low.out），
#         加上第四輪多收的 36 組，共 328 組。
#   - W （第五輪）：淡色小字整行換掉（同一個位置、每個字都不同；5 種解析度 × 7 種顏色 × 中英文 × 11／13px）。
#         期望 notSame，另外記下那行字的範圍（line：兩張逐像素差 > 2 的外框），測 similar 的外框有沒有涵蓋整行。
#   - M ：聊天泡泡裡的多行訊息整段換掉（gen_ml.py）。BAND_WIDE 改用 ≥ 之後從 similar 變 different 的 13 組（期望 different），
#         與 5120 寬 1x 還是 similar 的 35 組（已知限制，期望 notSame）。
#   第四輪的名單（SAME_C／SAME_K／SAME_L）是手抄的，跟 .out 只重疊 68／15／254 組；第五輪改成直接讀 .out 裡判 same 的名單，
#   再併上手抄的名單（見 r3_same）。
# 每一組畫面（同尺寸、同版面）共用一張底圖，其他圖只存「跟底圖不一樣的幾個方塊」，
# 測試時貼回底圖再比 sha256，所以檔案小，而且內容逐位元組確定。
#
# 期望（expect）：照第四輪的規格，全解析度上有任何像素的灰階差 > 2 就不可以是 same（notSame）；
# 整張每個像素的差都 ≤ 2 的才是 same（R 類剛好沒動到的、F 類的已知限制 sameKnown）。
# 這個判斷在這支程式裡直接逐像素算，跟 imagehash.ts 的實作無關。M 類多行字整段不同照預想表是 different，
# 5120 寬 1x 的那 35 組是規格接受的已知限制（similar 也可以，但不可以是 same）。
#
# 用法：PYTHONDONTWRITEBYTECODE=1 python3 make-synth4.py 第三輪驗證者的 run 目錄（p0p1-round3/verify3-imagehash/run）
#   R 類從 run/real/shots 讀；C、K、E、H、F 類畫完跟驗證者當時存的 .gray 比 sha256，對不上就停。
#   C、K、L 類第三輪判 same 的名單從 run 的 caret.out、col.out、low.out 讀（組數不對就停）。
#   L、M 類驗證者沒有留 .gray，照同一份畫法重畫（同一台機器、同一版 PIL 與字型）；W 類是第五輪新畫的。
#   PYTHONDONTWRITEBYTECODE=1 是為了不在 fixtures 裡留下 __pycache__。
# 需要：PIL、Noto Sans CJK、DejaVu Sans、Liberation Sans（只有開發期需要）
import gzip
import hashlib
import json
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'synth4')
SANS = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
LIB = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
CJK = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'


# ── gen_misc.py（照抄）────────────────────────────────────────
def misc_base(W, H, s=1, dark=False):
    bg = (30, 30, 30) if dark else (250, 250, 250); fg = (220, 220, 220) if dark else (30, 30, 30)
    im = Image.new('RGB', (W, H), bg); d = ImageDraw.Draw(im); f = ImageFont.truetype(CJK, int(15 * s), index=2)
    for i in range(8):
        d.text((60 * s, (80 + i * 30) * s), '固定內容第 %d 行：這一行在兩張截圖裡都一樣。' % i, font=f, fill=fg)
    return im


def chart(W, H, bw, unit, v):
    im = misc_base(W, H); d = ImageDraw.Draw(im)
    x0, y0 = 700, 700
    d.line([x0 - 10, y0, x0 + 12 * (bw + 6), y0], fill=(120, 120, 120))
    for i, n in enumerate(v):
        d.rectangle([x0 + i * (bw + 6), y0 - n * unit, x0 + i * (bw + 6) + bw - 1, y0 - 1], fill=(66, 133, 244))
    return im


def fab(W, H, s, dy_, digit):
    im = misc_base(W, H, s); d = ImageDraw.Draw(im)
    cx, cy = (W - 100 * s), (H - 100 * s + dy_ * s)
    r = 28 * s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(33, 150, 243))
    d.rectangle([cx - 10 * s, cy - 8 * s, cx + 10 * s, cy + 8 * s], outline=(255, 255, 255), width=2 * s)
    d.line([cx - 10 * s, cy - 8 * s, cx, cy + 1 * s, cx + 10 * s, cy - 8 * s], fill=(255, 255, 255), width=2 * s)
    br = 9 * s; bx, by = cx + 20 * s, cy - 20 * s
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=(229, 57, 53))
    f = ImageFont.truetype(BOLD, int(11 * s)); tw = d.textlength(digit, font=f)
    d.text((bx - tw / 2, by - 7 * s), digit, font=f, fill=(255, 255, 255))
    return im


def lum(c):
    return (299 * c[0] + 587 * c[1] + 114 * c[2] + 500) // 1000


def dot(W, H, c):
    im = misc_base(W, H); d = ImageDraw.Draw(im)
    d.ellipse([60, 400, 72, 412], fill=c); d.text((80, 398), '伺服器狀態', font=ImageFont.truetype(CJK, 14, index=2), fill=(30, 30, 30))
    d.rounded_rectangle([60, 440, 140, 466], radius=6, fill=c); d.text((72, 444), 'Build', font=ImageFont.truetype(SANS, 14), fill=(255, 255, 255))
    return im


# ── gen_caret.py（照抄）───────────────────────────────────────
L1 = ['Deploy finished', 'Tests passed', 'Build queued', 'All good']


def caret_page(W, H, s, fpx, font, marks, dark=False):
    bg = (30, 30, 30) if dark else (255, 255, 255); fg = (220, 220, 220) if dark else (25, 25, 25)
    im = Image.new('RGB', (W, H), bg); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(font, int(fpx * s), index=2 if font == CJK else 0)
    for i, t in enumerate(L1):
        d.text((80 * s, (100 + i * int(fpx * 2.2)) * s), t + marks.get(i, ''), font=f, fill=fg)
    return im


# ── gen_col.py（照抄；LH 在原程式是全域變數）────────────────────────
def col_page(W, H, s, vals, dx, fpx, LH):
    im = Image.new('RGB', (W, H), (255, 255, 255)); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(SANS, int(fpx * s)); fc = ImageFont.truetype(CJK, int(14 * s), index=2)
    for i in range(10):
        d.text((60 * s, (80 + i * 26) * s), '固定內容第 %d 行，兩張一樣。' % i, font=fc, fill=(30, 30, 30))
    cx = (700) * s + dx
    for i, v in enumerate(vals):
        tw = d.textlength(v, font=f)
        d.text((cx - tw / 2, (80 + i * int(fpx * LH)) * s), v, font=f, fill=(30, 30, 30))
    return im


# ── gen_low.py（照抄）─────────────────────────────────────────
def low_page(W, H, dark):
    bg = (30, 30, 30) if dark else (255, 255, 255)
    im = Image.new('RGB', (W, H), bg); d = ImageDraw.Draw(im)
    fg = (220, 220, 220) if dark else (30, 30, 30)
    f = ImageFont.truetype(CJK, 16, index=2)
    for i in range(6):
        d.text((60, 60 + i * 28), '這是固定的內容第%d行，不會改變。The quick brown fox jumps.' % i, font=f, fill=fg)
    d.rectangle([40, 40, W - 40, H - 40], outline=(200, 200, 200) if not dark else (70, 70, 70))
    return im


LOW_TEXTS = [('最後更新：2026-09-18 由王小明編輯，共 12 頁', '最後更新：2026-09-17 由李大華編輯，共 30 頁'),
             ('Last edited 3 minutes ago by Alice Chen', 'Last edited 5 hours ago by Bob Martin'),
             ('10:41', '10:47'),
             ('已讀', '未讀'),
             ('3 則未讀', '5 則未讀')]
LOW_COLORS = {'ccc': (204, 204, 204), 'ddd': (221, 221, 221), 'e5': (229, 229, 229), 'eee': (238, 238, 238),
              '3c': (60, 60, 60), '44': (68, 68, 68), '50': (80, 80, 80)}

# W（第五輪）：整行字換掉（同一個位置、每個字都不同）
WHOLE_TEXTS = [('今天下午三點在二樓會議室討論期末專題', '明早九點改到一樓大廳請記得帶筆電', CJK, 2),
               ('Reminder: submit the lab report by Friday noon', 'Meeting moved to Tuesday afternoon in room B', LIB, 0)]
WHOLE_RES = [(1920, 1080), (2560, 1440), (3840, 2160), (5120, 1440), (7680, 4320)]


# ── gen_ml.py（照抄）──────────────────────────────────────────
ML_TXT = '大家好下週三的小考範圍是第三章到第五章作業三的截止時間是星期五晚上十二點請問可以用寫嗎期中考改到十一月五日範圍到第七章記得帶計算機期末報告改成分組上台每組十分鐘請先上傳投影片明天早上九點在集合收到謝謝助教'
ML_EN = 'the quick brown fox jumps over lazy dog meeting moved room thursday bring signed forms laptop parking free east gate lunch cancelled caterer sick reschedule monday noon main hall sorry'.split()


def ml_para(seed, n, per, en=False):
    r = random.Random(seed)
    if en:
        out = []
        for _ in range(n):
            s = ''
            while len(s) < per:
                s += (' ' if s else '') + r.choice(ML_EN)
            out.append(s[:per])
        return out
    return [''.join(r.choice(ML_TXT) for _ in range(per)) for _ in range(n)]


def ml_chat(W, H, lines, dark, fpx, pitch, font, x0):
    bg = (30, 30, 30) if dark else (245, 245, 245); bub = (45, 45, 45) if dark else (255, 255, 255); fg = (230, 230, 230) if dark else (20, 20, 20)
    im = Image.new('RGB', (W, H), bg); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 56], fill=(40, 40, 40) if dark else (255, 255, 255))
    d.text((24, 16), '資料結構 課程群組', font=ImageFont.truetype(CJK, 18, index=2), fill=fg)
    f = ImageFont.truetype(font, fpx, index=2 if font == CJK else 0)
    y = 140; lh = round(fpx * pitch); tw = max(d.textlength(l, font=f) for l in lines); pad = 10
    d.rounded_rectangle([x0, y, x0 + tw + 2 * pad, y + len(lines) * lh + 2 * pad], radius=12, fill=bub)
    for i, l in enumerate(lines):
        d.text((x0 + pad, y + pad + i * lh), l, font=f, fill=fg)
    d.ellipse([x0 - 48, y, x0 - 12, y + 36], fill=(180, 180, 200))
    return im


# M 類：BAND_WIDE 改用 ≥ 之後變成 different 的（期望 different）；5120 寬還是 similar 的（期望 notSame）
ML_DIFFERENT = '''
M-1366x768-d-f12-p125-3x3 M-1366x768-d-f12-p145-3x3 M-1366x768-l-f12-p125-3x3 M-2560x1080-d-f14-p125-6x3 M-2560x1080-d-f14-p145-6x3
M-2560x1080-l-f12-p145-6x3 M-2560x1080-l-f14-p125-6x3 M-2560x1080-l-f14-p145-3x3 M-3440x1440-d-f14-p125-6x3 M-3440x1440-d-f14-p145-6x3
M-3440x1440-l-f12-p145-6x3 M-3440x1440-l-f14-p125-6x3 M-3440x1440-l-f14-p145-3x3
'''.split()
ML_KNOWN = '''
M-5120x1440-d-f12-p125-3x3 M-5120x1440-d-f12-p125-3x4 M-5120x1440-d-f12-p125-3x8 M-5120x1440-d-f12-p125-5x10 M-5120x1440-d-f12-p125-6x3 M-5120x1440-d-f12-p145-2x6
M-5120x1440-d-f12-p145-3x3 M-5120x1440-d-f12-p145-3x4 M-5120x1440-d-f12-p145-3x8 M-5120x1440-d-f12-p145-5x10 M-5120x1440-d-f12-p145-6x3 M-5120x1440-d-f14-p125-3x3
M-5120x1440-d-f14-p125-3x4 M-5120x1440-d-f14-p125-6x3 M-5120x1440-d-f14-p145-3x3 M-5120x1440-d-f14-p145-3x4 M-5120x1440-d-f14-p145-6x3 M-5120x1440-l-f12-p125-3x3
M-5120x1440-l-f12-p125-3x4 M-5120x1440-l-f12-p125-3x8 M-5120x1440-l-f12-p125-5x10 M-5120x1440-l-f12-p125-6x3 M-5120x1440-l-f12-p145-2x6 M-5120x1440-l-f12-p145-3x3
M-5120x1440-l-f12-p145-3x4 M-5120x1440-l-f12-p145-3x8 M-5120x1440-l-f12-p145-5x10 M-5120x1440-l-f12-p145-6x3 M-5120x1440-l-f14-p125-3x3 M-5120x1440-l-f14-p125-3x4
M-5120x1440-l-f14-p125-5x10 M-5120x1440-l-f14-p125-6x3 M-5120x1440-l-f14-p145-3x3 M-5120x1440-l-f14-p145-3x4 M-5120x1440-l-f14-p145-6x3
'''.split()

# 第四輪手抄的名單（跟驗證者的 .out 只重疊一部分；第五輪起跟 r3_same 讀到的完整名單併在一起用）
SAME_C = '''
C-hd-f16-dejavu-!-l C-hd-f16-dejavu-!-d C-hd-f16-dejavu-l-l C-hd-f16-dejavu-l-d C-hd-f16-dejavu-I-l C-hd-f16-dejavu-I-d
C-hd-f16-dejavu-x-l C-hd-f16-dejavu-x-d C-hd-f16-lib-!-l C-hd-f16-lib-!-d C-hd-f16-lib-l-l C-hd-f16-lib-l-d
C-hd-f16-lib-I-l C-hd-f16-lib-I-d C-hd-f16-lib-x-l C-hd-f16-lib-x-d C-hd-f20-dejavu-!-l C-hd-f20-dejavu-!-d
C-hd-f20-dejavu-l-l C-hd-f20-dejavu-l-d C-hd-f20-dejavu-I-l C-hd-f20-dejavu-I-d C-hd-f20-dejavu-x-l C-hd-f20-dejavu-x-d
C-hd-f20-lib-!-l C-hd-f20-lib-!-d C-hd-f20-lib-l-l C-hd-f20-lib-l-d C-hd-f20-lib-I-l C-hd-f20-lib-I-d
C-hd-f20-lib-x-l C-hd-f20-lib-x-d C-fhd-f14-lib-!-l C-fhd-f14-lib-!-d C-fhd-f14-lib-l-l C-fhd-f14-lib-l-d
C-fhd-f14-lib-I-l C-fhd-f14-lib-I-d C-fhd-f16-dejavu-!-l C-fhd-f16-dejavu-!-d C-fhd-f16-dejavu-l-l C-fhd-f16-dejavu-l-d
C-fhd-f16-dejavu-I-l C-fhd-f16-dejavu-I-d C-fhd-f16-dejavu-x-l C-fhd-f16-dejavu-x-d C-fhd-f16-lib-!-l C-fhd-f16-lib-!-d
C-fhd-f16-lib-l-l C-fhd-f16-lib-l-d C-fhd-f16-lib-I-l C-fhd-f16-lib-I-d C-fhd-f16-lib-x-l C-fhd-f16-lib-x-d
C-fhd-f20-dejavu-!-l C-fhd-f20-dejavu-!-d C-fhd-f20-dejavu-l-l C-fhd-f20-dejavu-l-d C-fhd-f20-dejavu-I-l C-fhd-f20-dejavu-I-d
C-fhd-f20-dejavu-x-l C-fhd-f20-dejavu-x-d C-fhd-f20-lib-!-l C-fhd-f20-lib-!-d C-fhd-f20-lib-l-l C-fhd-f20-lib-l-d
C-fhd-f20-lib-I-l C-fhd-f20-lib-I-d C-fhd-f20-lib-x-l C-fhd-f20-lib-x-d C-qhd-f20-dejavu-!-l C-qhd-f20-dejavu-!-d
C-qhd-f20-lib-!-l C-qhd-f20-lib-!-d C-qhd-f20-lib-l-l C-qhd-f20-lib-l-d C-qhd-f20-lib-I-l C-qhd-f20-lib-I-d
C-4k-f20-lib-!-l C-4k-f20-lib-!-d C-4k-f20-lib-l-l C-4k-f20-lib-l-d C-4k-f20-lib-I-l C-4k-f20-lib-I-d
C-mac2x-f14-dejavu-!-l C-mac2x-f14-dejavu-!-d C-mac2x-f14-dejavu-l-l C-mac2x-f14-dejavu-l-d C-mac2x-f14-dejavu-I-l C-mac2x-f14-dejavu-I-d
C-mac2x-f14-dejavu-x-l C-mac2x-f14-dejavu-x-d C-mac2x-f14-lib-!-l C-mac2x-f14-lib-!-d C-mac2x-f14-lib-l-l C-mac2x-f14-lib-l-d
C-mac2x-f14-lib-I-l C-mac2x-f14-lib-I-d C-mac2x-f14-lib-x-l C-mac2x-f14-lib-x-d C-mac2x-f16-dejavu-!-l C-mac2x-f16-dejavu-!-d
C-mac2x-f16-dejavu-l-l C-mac2x-f16-dejavu-l-d C-mac2x-f16-dejavu-I-l C-mac2x-f16-dejavu-I-d C-mac2x-f16-lib-!-l C-mac2x-f16-lib-!-d
C-mac2x-f16-lib-l-l C-mac2x-f16-lib-l-d C-mac2x-f16-lib-I-l C-mac2x-f16-lib-I-d C-mac2x-f16-lib-x-l C-mac2x-f16-lib-x-d
C-4k150-f14-dejavu-!-l C-4k150-f14-dejavu-!-d C-4k150-f14-dejavu-l-l C-4k150-f14-dejavu-l-d C-4k150-f14-dejavu-I-l C-4k150-f14-dejavu-I-d
C-4k150-f14-dejavu-x-l C-4k150-f14-dejavu-x-d C-4k150-f14-lib-!-l C-4k150-f14-lib-!-d C-4k150-f14-lib-l-l C-4k150-f14-lib-l-d
C-4k150-f14-lib-I-l C-4k150-f14-lib-I-d C-4k150-f14-lib-x-l C-4k150-f14-lib-x-d C-4k150-f16-lib-!-l C-4k150-f16-lib-!-d
C-4k150-f16-lib-l-l C-4k150-f16-lib-l-d C-4k150-f16-lib-I-l C-4k150-f16-lib-I-d C-4k150-f20-lib-!-l C-4k150-f20-lib-!-d
C-4k150-f20-lib-l-l C-4k150-f20-lib-l-d
'''.split()
SAME_K = '''
K114-fhd-f13-dx3-r3 K114-fhd-f13-dx3-r5 K114-fhd-f13-dx4-r3 K114-fhd-f13-dx4-r5 K114-fhd-f13-dx4-r0 K114-fhd-f16-dx3-r3
K114-qhd-f13-dx4-r3 K114-qhd-f13-dx4-r5 K114-qhd-f13-dx4-r0 K114-qhd-f16-dx4-r3 K114-qhd-f16-dx4-r5 K114-qhd-f16-dx4-r0
K114-qhd-f20-dx4-r0 K114-mac2x-f13-dx3-r5 K114-mac2x-f13-dx4-r3 K114-mac2x-f13-dx4-r5 K114-mac2x-f13-dx4-r0 K114-mac2x-f16-dx3-r5
K130-fhd-f13-dx3-r3 K130-fhd-f13-dx4-r3 K130-fhd-f13-dx4-r0 K130-qhd-f13-dx4-r3 K130-qhd-f13-dx4-r0 K130-qhd-f16-dx4-r3
K130-qhd-f16-dx4-r0 K130-mac2x-f13-dx4-r3
'''.split()
SAME_L = '''
L-1920x1080-l-eee-t2-f11-cjk L-1920x1080-l-eee-t2-f11-lib L-1920x1080-l-eee-t4-f11-cjk L-1920x1080-l-eee-t4-f13-cjk L-2560x1440-l-ddd-t2-f11-cjk L-2560x1440-l-ddd-t4-f11-cjk
L-2560x1440-l-ddd-t4-f12-cjk L-2560x1440-l-e5-t2-f11-cjk L-2560x1440-l-e5-t2-f12-cjk L-2560x1440-l-e5-t2-f12-lib L-2560x1440-l-e5-t4-f11-cjk L-2560x1440-l-e5-t4-f12-cjk
L-2560x1440-l-e5-t4-f13-cjk L-2560x1440-l-eee-t2-f11-cjk L-2560x1440-l-eee-t2-f11-lib L-2560x1440-l-eee-t2-f12-cjk L-2560x1440-l-eee-t2-f12-lib L-2560x1440-l-eee-t2-f13-cjk
L-2560x1440-l-eee-t4-f11-cjk L-2560x1440-l-eee-t4-f12-cjk L-2560x1440-l-eee-t4-f13-cjk L-2560x1440-d-3c-t2-f11-cjk L-2560x1440-d-3c-t2-f11-lib L-2560x1440-d-3c-t4-f11-cjk
L-2560x1440-d-3c-t4-f12-cjk L-2560x1440-d-44-t2-f11-cjk L-2560x1440-d-44-t4-f11-cjk L-3440x1440-l-ddd-t2-f11-cjk L-3440x1440-l-ddd-t4-f11-cjk L-3440x1440-l-ddd-t4-f12-cjk
L-3440x1440-l-e5-t2-f11-cjk L-3440x1440-l-e5-t2-f12-cjk L-3440x1440-l-e5-t2-f12-lib L-3440x1440-l-e5-t4-f11-cjk L-3440x1440-l-e5-t4-f12-cjk L-3440x1440-l-e5-t4-f13-cjk
L-3440x1440-l-eee-t2-f11-cjk L-3440x1440-l-eee-t2-f11-lib L-3440x1440-l-eee-t2-f12-cjk L-3440x1440-l-eee-t2-f12-lib L-3440x1440-l-eee-t2-f13-cjk L-3440x1440-l-eee-t4-f11-cjk
L-3440x1440-l-eee-t4-f12-cjk L-3440x1440-l-eee-t4-f13-cjk L-3440x1440-d-3c-t2-f11-cjk L-3440x1440-d-3c-t2-f11-lib L-3440x1440-d-3c-t4-f11-cjk L-3440x1440-d-3c-t4-f12-cjk
L-3440x1440-d-44-t2-f11-cjk L-3440x1440-d-44-t4-f11-cjk L-3840x2160-l-ddd-t2-f11-cjk L-3840x2160-l-ddd-t4-f11-cjk L-3840x2160-l-ddd-t4-f12-cjk L-3840x2160-l-e5-t2-f11-cjk
L-3840x2160-l-e5-t2-f12-cjk L-3840x2160-l-e5-t2-f12-lib L-3840x2160-l-e5-t4-f11-cjk L-3840x2160-l-e5-t4-f12-cjk L-3840x2160-l-e5-t4-f13-cjk L-3840x2160-l-eee-t2-f11-cjk
L-3840x2160-l-eee-t2-f11-lib L-3840x2160-l-eee-t2-f12-cjk L-3840x2160-l-eee-t2-f12-lib L-3840x2160-l-eee-t2-f13-cjk L-3840x2160-l-eee-t4-f11-cjk L-3840x2160-l-eee-t4-f12-cjk
L-3840x2160-l-eee-t4-f13-cjk L-3840x2160-d-3c-t2-f11-cjk L-3840x2160-d-3c-t2-f11-lib L-3840x2160-d-3c-t4-f11-cjk L-3840x2160-d-3c-t4-f12-cjk L-3840x2160-d-44-t2-f11-cjk
L-3840x2160-d-44-t4-f11-cjk L-5120x1440-l-ccc-t2-f11-cjk L-5120x1440-l-ccc-t2-f11-lib L-5120x1440-l-ccc-t4-f11-cjk L-5120x1440-l-ccc-t4-f12-cjk L-5120x1440-l-ddd-t2-f11-cjk
L-5120x1440-l-ddd-t2-f11-lib L-5120x1440-l-ddd-t2-f12-cjk L-5120x1440-l-ddd-t2-f12-lib L-5120x1440-l-ddd-t2-f13-cjk L-5120x1440-l-ddd-t4-f11-cjk L-5120x1440-l-ddd-t4-f12-cjk
L-5120x1440-l-ddd-t4-f13-cjk L-5120x1440-l-ddd-t0-f11-cjk L-5120x1440-l-ddd-t3-f11-cjk L-5120x1440-l-e5-t2-f11-cjk L-5120x1440-l-e5-t2-f11-lib L-5120x1440-l-e5-t2-f12-cjk
L-5120x1440-l-e5-t2-f12-lib L-5120x1440-l-e5-t2-f13-cjk L-5120x1440-l-e5-t4-f11-cjk L-5120x1440-l-e5-t4-f12-cjk L-5120x1440-l-e5-t4-f13-cjk L-5120x1440-l-e5-t0-f11-cjk
L-5120x1440-l-e5-t0-f12-cjk L-5120x1440-l-e5-t3-f11-cjk L-5120x1440-l-eee-t2-f11-cjk L-5120x1440-l-eee-t2-f11-lib L-5120x1440-l-eee-t2-f12-cjk L-5120x1440-l-eee-t2-f12-lib
L-5120x1440-l-eee-t2-f13-cjk L-5120x1440-l-eee-t2-f13-lib L-5120x1440-l-eee-t4-f11-cjk L-5120x1440-l-eee-t4-f12-cjk L-5120x1440-l-eee-t4-f13-cjk L-5120x1440-l-eee-t0-f11-cjk
L-5120x1440-l-eee-t0-f12-cjk L-5120x1440-l-eee-t0-f13-cjk L-5120x1440-l-eee-t1-f11-cjk L-5120x1440-l-eee-t1-f11-lib L-5120x1440-l-eee-t3-f11-cjk L-5120x1440-l-eee-t3-f12-cjk
L-5120x1440-d-3c-t2-f11-cjk L-5120x1440-d-3c-t2-f11-lib L-5120x1440-d-3c-t2-f12-cjk L-5120x1440-d-3c-t2-f12-lib L-5120x1440-d-3c-t4-f11-cjk L-5120x1440-d-3c-t4-f12-cjk
L-5120x1440-d-3c-t4-f13-cjk L-5120x1440-d-3c-t0-f11-cjk L-5120x1440-d-3c-t0-f12-cjk L-5120x1440-d-3c-t1-f11-cjk L-5120x1440-d-3c-t3-f11-cjk L-5120x1440-d-44-t2-f11-cjk
L-5120x1440-d-44-t2-f11-lib L-5120x1440-d-44-t2-f12-cjk L-5120x1440-d-44-t2-f12-lib L-5120x1440-d-44-t4-f11-cjk L-5120x1440-d-44-t4-f12-cjk L-5120x1440-d-44-t0-f11-cjk
L-5120x1440-d-44-t3-f11-cjk L-5120x1440-d-50-t2-f11-cjk L-5120x1440-d-50-t2-f11-lib L-5120x1440-d-50-t4-f11-cjk L-5120x2880-l-ccc-t2-f11-cjk L-5120x2880-l-ccc-t2-f11-lib
L-5120x2880-l-ccc-t4-f11-cjk L-5120x2880-l-ccc-t4-f12-cjk L-5120x2880-l-ddd-t2-f11-cjk L-5120x2880-l-ddd-t2-f11-lib L-5120x2880-l-ddd-t2-f12-cjk L-5120x2880-l-ddd-t2-f12-lib
L-5120x2880-l-ddd-t2-f13-cjk L-5120x2880-l-ddd-t4-f11-cjk L-5120x2880-l-ddd-t4-f12-cjk L-5120x2880-l-ddd-t4-f13-cjk L-5120x2880-l-ddd-t0-f11-cjk L-5120x2880-l-ddd-t3-f11-cjk
L-5120x2880-l-e5-t2-f11-cjk L-5120x2880-l-e5-t2-f11-lib L-5120x2880-l-e5-t2-f12-cjk L-5120x2880-l-e5-t2-f12-lib L-5120x2880-l-e5-t2-f13-cjk L-5120x2880-l-e5-t4-f11-cjk
L-5120x2880-l-e5-t4-f12-cjk L-5120x2880-l-e5-t4-f13-cjk L-5120x2880-l-e5-t0-f11-cjk L-5120x2880-l-e5-t0-f12-cjk L-5120x2880-l-e5-t3-f11-cjk L-5120x2880-l-eee-t2-f11-cjk
L-5120x2880-l-eee-t2-f11-lib L-5120x2880-l-eee-t2-f12-cjk L-5120x2880-l-eee-t2-f12-lib L-5120x2880-l-eee-t2-f13-cjk L-5120x2880-l-eee-t2-f13-lib L-5120x2880-l-eee-t4-f11-cjk
L-5120x2880-l-eee-t4-f12-cjk L-5120x2880-l-eee-t4-f13-cjk L-5120x2880-l-eee-t0-f11-cjk L-5120x2880-l-eee-t0-f12-cjk L-5120x2880-l-eee-t0-f13-cjk L-5120x2880-l-eee-t1-f11-cjk
L-5120x2880-l-eee-t1-f11-lib L-5120x2880-l-eee-t3-f11-cjk L-5120x2880-l-eee-t3-f12-cjk L-5120x2880-d-3c-t2-f11-cjk L-5120x2880-d-3c-t2-f11-lib L-5120x2880-d-3c-t2-f12-cjk
L-5120x2880-d-3c-t2-f12-lib L-5120x2880-d-3c-t4-f11-cjk L-5120x2880-d-3c-t4-f12-cjk L-5120x2880-d-3c-t4-f13-cjk L-5120x2880-d-3c-t0-f11-cjk L-5120x2880-d-3c-t0-f12-cjk
L-5120x2880-d-3c-t1-f11-cjk L-5120x2880-d-3c-t3-f11-cjk L-5120x2880-d-44-t2-f11-cjk L-5120x2880-d-44-t2-f11-lib L-5120x2880-d-44-t2-f12-cjk L-5120x2880-d-44-t2-f12-lib
L-5120x2880-d-44-t4-f11-cjk L-5120x2880-d-44-t4-f12-cjk L-5120x2880-d-44-t0-f11-cjk L-5120x2880-d-44-t3-f11-cjk L-5120x2880-d-50-t2-f11-cjk L-5120x2880-d-50-t2-f11-lib
L-5120x2880-d-50-t4-f11-cjk L-7680x4320-l-ccc-t2-f11-cjk L-7680x4320-l-ccc-t2-f11-lib L-7680x4320-l-ccc-t2-f12-cjk L-7680x4320-l-ccc-t2-f12-lib L-7680x4320-l-ccc-t2-f13-cjk
L-7680x4320-l-ccc-t4-f11-cjk L-7680x4320-l-ccc-t4-f12-cjk L-7680x4320-l-ccc-t4-f13-cjk L-7680x4320-l-ccc-t0-f11-cjk L-7680x4320-l-ccc-t3-f11-cjk L-7680x4320-l-ddd-t2-f11-cjk
L-7680x4320-l-ddd-t2-f11-lib L-7680x4320-l-ddd-t2-f12-cjk L-7680x4320-l-ddd-t2-f12-lib L-7680x4320-l-ddd-t2-f13-cjk L-7680x4320-l-ddd-t2-f13-lib L-7680x4320-l-ddd-t4-f11-cjk
L-7680x4320-l-ddd-t4-f12-cjk L-7680x4320-l-ddd-t4-f13-cjk L-7680x4320-l-ddd-t0-f11-cjk L-7680x4320-l-ddd-t0-f12-cjk L-7680x4320-l-ddd-t3-f11-cjk L-7680x4320-l-ddd-t3-f12-cjk
L-7680x4320-l-e5-t2-f11-cjk L-7680x4320-l-e5-t2-f11-lib L-7680x4320-l-e5-t2-f12-cjk L-7680x4320-l-e5-t2-f12-lib L-7680x4320-l-e5-t2-f13-cjk L-7680x4320-l-e5-t2-f13-lib
L-7680x4320-l-e5-t4-f11-cjk L-7680x4320-l-e5-t4-f12-cjk L-7680x4320-l-e5-t4-f13-cjk L-7680x4320-l-e5-t0-f11-cjk L-7680x4320-l-e5-t0-f12-cjk L-7680x4320-l-e5-t0-f13-cjk
L-7680x4320-l-e5-t1-f11-cjk L-7680x4320-l-e5-t3-f11-cjk L-7680x4320-l-e5-t3-f12-cjk L-7680x4320-l-eee-t2-f11-cjk L-7680x4320-l-eee-t2-f11-lib L-7680x4320-l-eee-t2-f12-cjk
L-7680x4320-l-eee-t2-f12-lib L-7680x4320-l-eee-t2-f13-cjk L-7680x4320-l-eee-t2-f13-lib L-7680x4320-l-eee-t4-f11-cjk L-7680x4320-l-eee-t4-f12-cjk L-7680x4320-l-eee-t4-f13-cjk
L-7680x4320-l-eee-t0-f11-cjk L-7680x4320-l-eee-t0-f12-cjk L-7680x4320-l-eee-t0-f13-cjk L-7680x4320-l-eee-t1-f11-cjk L-7680x4320-l-eee-t1-f11-lib L-7680x4320-l-eee-t1-f12-cjk
L-7680x4320-l-eee-t3-f11-cjk L-7680x4320-l-eee-t3-f12-cjk L-7680x4320-l-eee-t3-f13-cjk L-7680x4320-d-3c-t2-f11-cjk L-7680x4320-d-3c-t2-f11-lib L-7680x4320-d-3c-t2-f12-cjk
L-7680x4320-d-3c-t2-f12-lib L-7680x4320-d-3c-t2-f13-cjk L-7680x4320-d-3c-t4-f11-cjk L-7680x4320-d-3c-t4-f12-cjk L-7680x4320-d-3c-t4-f13-cjk L-7680x4320-d-3c-t0-f11-cjk
L-7680x4320-d-3c-t0-f12-cjk L-7680x4320-d-3c-t0-f13-cjk L-7680x4320-d-3c-t1-f11-cjk L-7680x4320-d-3c-t3-f11-cjk L-7680x4320-d-44-t2-f11-cjk L-7680x4320-d-44-t2-f11-lib
L-7680x4320-d-44-t2-f12-cjk L-7680x4320-d-44-t2-f12-lib L-7680x4320-d-44-t4-f11-cjk L-7680x4320-d-44-t4-f12-cjk L-7680x4320-d-44-t4-f13-cjk L-7680x4320-d-44-t0-f11-cjk
L-7680x4320-d-44-t0-f12-cjk L-7680x4320-d-44-t1-f11-cjk L-7680x4320-d-44-t3-f11-cjk L-7680x4320-d-44-t3-f12-cjk L-7680x4320-d-50-t2-f11-cjk L-7680x4320-d-50-t2-f11-lib
L-7680x4320-d-50-t2-f12-cjk L-7680x4320-d-50-t2-f12-lib L-7680x4320-d-50-t4-f11-cjk L-7680x4320-d-50-t4-f12-cjk L-7680x4320-d-50-t0-f11-cjk L-7680x4320-d-50-t0-f12-cjk
L-7680x4320-d-50-t1-f11-cjk L-7680x4320-d-50-t3-f11-cjk
'''.split()


# 第三輪驗證者判成 same 的完整名單：main() 從 run 目錄的 caret.out、col.out、low.out 讀進來（每一行第一欄是等級、第二欄是組名）
R3_SAME = {'C': set(), 'K': set(), 'L': set()}
R3_SAME_COUNT = {'C': 140, 'K': 26, 'L': 292}


def r3_same(run):
    for cls, fn in (('C', 'caret.out'), ('K', 'col.out'), ('L', 'low.out')):
        with open(os.path.join(run, fn), encoding='utf-8') as f:
            names = [ln.split()[1] for ln in f if ln.split() and ln.split()[0] == 'same']
        assert len(names) == len(set(names)) == R3_SAME_COUNT[cls], f'{fn} 裡判 same 的有 {len(names)} 組，應該是 {R3_SAME_COUNT[cls]}'
        R3_SAME[cls] = set(names)


def all_scenes():
    """回傳畫面清單：每一項是（畫面群組、底圖名稱、畫底圖的函式、反例清單），反例是（組名、畫 a、畫 b、說明）；底圖就是那一組共用的畫面（不一定是某一張 a）。"""
    S = []
    # H：直條圖一票換邊
    for (W, H, tag) in [(1280, 800, 'hd'), (1920, 1080, 'fhd'), (2560, 1440, 'qhd')]:
        pairs = []
        for bw in (4, 6, 8):
            for unit in (12, 16, 24):
                v = [3, 5, 4, 6, 2, 5, 3, 4, 5, 2]; w = list(v); w[2] -= 1; w[6] += 1
                pairs.append((f'H-{tag}-bw{bw}-u{unit}', (lambda W=W, H=H, bw=bw, unit=unit, v=v: chart(W, H, bw, unit, v)),
                              (lambda W=W, H=H, bw=bw, unit=unit, w=w: chart(W, H, bw, unit, w)), f'{W}×{H} 直條圖一票從第 3 項移到第 7 項（條寬 {bw}px、一票 {unit}px）'))
        S.append((f'misc-{tag}-1', f'base-misc-{tag}-1', (lambda W=W, H=H: misc_base(W, H)), pairs))
    # E：浮動按鈕平移＋徽章數字變了
    for (W, H, s, tag) in [(1280, 800, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (2880, 1800, 2, 'mac2x')]:
        pairs = []
        for dy in (1, 2, 3):
            for (d1, d2) in (('1', '2'), ('3', '8'), ('2', '5'), ('9', '12')):
                pairs.append((f'E-{tag}-dy{dy}-{d1}to{d2}', (lambda W=W, H=H, s=s, d1=d1: fab(W, H, s, 0, d1)),
                              (lambda W=W, H=H, s=s, dy=dy, d2=d2: fab(W, H, s, dy, d2)), f'{W}×{H}@{s} 浮動按鈕移 {dy}px，徽章 {d1}→{d2}'))
        if s == 1:
            # 同尺寸、s=1 的 H、F 也畫在同一種底圖上，併進同一組
            for sc in S:
                if sc[0] == f'misc-{tag}-1':
                    sc[3].extend(pairs)
                    break
            else:
                S.append((f'misc-{tag}-1', f'base-misc-{tag}-1', (lambda W=W, H=H: misc_base(W, H)), pairs))
        else:
            S.append((f'misc-{tag}-{s}', f'base-misc-{tag}-{s}', (lambda W=W, H=H, s=s: misc_base(W, H, s)), pairs))
    # F：灰階亮度幾乎一樣的換色
    for (W, H, tag) in [(1280, 800, 'hd'), (1920, 1080, 'fhd')]:
        pairs = []
        for (c1, c2, nm) in (((255, 0, 0), (0, 132, 0), 'red-green'), ((207, 34, 46), (26, 127, 55), 'gh-red-green'), ((220, 53, 69), (25, 135, 84), 'bs-danger-success')):
            pairs.append((f'F-{tag}-{nm}', (lambda W=W, H=H, c1=c1: dot(W, H, c1)), (lambda W=W, H=H, c2=c2: dot(W, H, c2)),
                          f'{W}×{H} 狀態顏色 {c1}（灰階 {lum(c1)}）→ {c2}（灰階 {lum(c2)}）'))
        for sc in S:
            if sc[0] == f'misc-{tag}-1':
                sc[3].extend(pairs)
                break
    # C：細長的字搬家
    want_c = set(SAME_C) | R3_SAME['C']
    for (W, H, s, tag) in [(1280, 800, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k'), (2880, 1800, 2, 'mac2x'), (3840, 2160, 1.5, '4k150')]:
        for fpx in (14, 16, 20):
            for font, fn in ((SANS, 'dejavu'), (LIB, 'lib')):
                for dark in (False, True):
                    pairs = []
                    for ch in ('!', 'l', 'I', '|'):
                        name = f'C-{tag}-f{fpx}-{fn}-{"x" if ch == "|" else ch}-{"d" if dark else "l"}'
                        if name not in want_c:
                            continue
                        pairs.append((name, (lambda W=W, H=H, s=s, fpx=fpx, font=font, ch=ch, dark=dark: caret_page(W, H, s, fpx, font, {0: ch}, dark)),
                                      (lambda W=W, H=H, s=s, fpx=fpx, font=font, ch=ch, dark=dark: caret_page(W, H, s, fpx, font, {2: ch}, dark)),
                                      f'{W}×{H}@{s}「{ch}」從第 1 行行尾搬到第 3 行行尾（{fpx}px，{fn}，{"深色" if dark else "淺色"}）'))
                    if pairs:
                        S.append((f'caret-{tag}-{fpx}-{fn}-{dark}', f'base-caret-{tag}-f{fpx}-{fn}-{"d" if dark else "l"}',
                                  (lambda W=W, H=H, s=s, fpx=fpx, font=font, dark=dark: caret_page(W, H, s, fpx, font, {}, dark)), pairs))
    # K：一欄數字整欄平移＋一格改掉
    want_k = set(SAME_K) | R3_SAME['K']
    for LH in (1.15, 1.3):
        for (W, H, s, tag) in [(1280, 800, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (2880, 1800, 2, 'mac2x')]:
            pairs = []
            for fpx in (13, 16, 20):
                for dx in (1, 2, 3, 4):
                    for (i, new) in ((3, '8'), (5, '17'), (0, '2')):
                        name = f'K{int(LH * 100)}-{tag}-f{fpx}-dx{dx}-r{i}'
                        if name not in want_k:
                            continue
                        v = ['3', '12', '7', '5', '9', '4', '11', '6']; w = list(v); w[i] = new
                        pairs.append((name, (lambda W=W, H=H, s=s, v=v, fpx=fpx, LH=LH: col_page(W, H, s, v, 0, fpx, LH)),
                                      (lambda W=W, H=H, s=s, w=w, dx=dx, fpx=fpx, LH=LH: col_page(W, H, s, w, dx, fpx, LH)),
                                      f'{W}×{H}@{s} 置中的一欄數字整欄右移 {dx}px，第 {i + 1} 列 {v[i]}→{new}（{fpx}px，行高 {LH}）'))
            if pairs:
                S.append((f'col-{tag}-{LH}', f'base-col-{tag}-{int(LH * 100)}', (lambda W=W, H=H, s=s, LH=LH: col_page(W, H, s, [], 0, 13, LH)), pairs))
    # L：淡色小字
    want_l = set(SAME_L) | R3_SAME['L']
    for (W, H) in [(1280, 800), (1920, 1080), (2560, 1440), (3440, 1440), (3840, 2160), (5120, 1440), (5120, 2880), (7680, 4320)]:
        for dark in (False, True):
            pairs = []
            cols = ['3c', '44', '50'] if dark else ['ccc', 'ddd', 'e5', 'eee']
            for cn in cols:
                for ti, (t1, t2) in enumerate(LOW_TEXTS):
                    for fs in (11, 12, 13):
                        for fontp, fi in ((CJK, 2), (LIB, 0)):
                            if fontp == LIB and ti in (0, 3, 4):
                                continue
                            name = f'L-{W}x{H}-{"d" if dark else "l"}-{cn}-t{ti}-f{fs}-{"cjk" if fi == 2 else "lib"}'
                            if name not in want_l:
                                continue
                            col = LOW_COLORS[cn]
                            pairs.append((name, (lambda t1=t1, fs=fs, fontp=fontp, fi=fi, col=col: ('text', t1, fs, fontp, fi, col)),
                                          (lambda t2=t2, fs=fs, fontp=fontp, fi=fi, col=col: ('text', t2, fs, fontp, fi, col)),
                                          f'{W}×{H} {"深色底" if dark else "白底"} #{cn} {fs}px「{t1}」→「{t2}」'))
            # W（第五輪）：同一個位置的淡色小字整行換掉（每個字都不同），用來測外框要涵蓋整行
            if (W, H) in WHOLE_RES:
                for cn in cols:
                    for ti, (t1, t2, fontp, fi) in enumerate(WHOLE_TEXTS):
                        for fs in (11, 13):
                            name = f'W-{W}x{H}-{"d" if dark else "l"}-{cn}-t{ti}-f{fs}'
                            col = LOW_COLORS[cn]
                            pairs.append((name, (lambda t1=t1, fs=fs, fontp=fontp, fi=fi, col=col: ('text', t1, fs, fontp, fi, col)),
                                          (lambda t2=t2, fs=fs, fontp=fontp, fi=fi, col=col: ('text', t2, fs, fontp, fi, col)),
                                          f'{W}×{H} {"深色底" if dark else "白底"} #{cn} {fs}px 整行換掉「{t1}」→「{t2}」'))
            if pairs:
                S.append((f'low-{W}x{H}-{dark}', f'base-low-{W}x{H}-{"d" if dark else "l"}', (lambda W=W, H=H, dark=dark: low_page(W, H, dark)), pairs))
    # M：多行字整段不同
    want_m = set(ML_DIFFERENT) | set(ML_KNOWN)
    for W, H in [(1366, 768), (1600, 900), (3440, 1440), (5120, 1440), (2560, 1080)]:
        for dark in (False, True):
            pairs = []
            for fpx in (12, 14):
                for pitch in (1.25, 1.45):
                    for (n, per, en) in [(2, 6, False), (2, 10, False), (3, 4, False), (3, 8, False), (5, 10, False), (2, 24, True), (4, 28, True), (3, 3, False), (6, 3, False)]:
                        font = SANS if en else CJK
                        name = f'M-{W}x{H}-{"d" if dark else "l"}-f{fpx}-p{int(pitch * 100)}-{n}x{per}{"e" if en else ""}'
                        if name not in want_m:
                            continue
                        pairs.append((name, (lambda W=W, H=H, n=n, per=per, en=en, dark=dark, fpx=fpx, pitch=pitch, font=font: ml_chat(W, H, ml_para(1, n, per, en), dark, fpx, pitch, font, W // 2)),
                                      (lambda W=W, H=H, n=n, per=per, en=en, dark=dark, fpx=fpx, pitch=pitch, font=font: ml_chat(W, H, ml_para(2, n, per, en), dark, fpx, pitch, font, W // 2)),
                                      f'{W}×{H} 泡泡裡 {n} 行 × {per} {"英文字元" if en else "字"}整段不同（{fpx}px，行高 {pitch}）'))
            if pairs:
                # 底圖：同尺寸、同深淺色、泡泡裡只有一行空白（其他圖只存泡泡那一塊）
                S.append((f'ml-{W}x{H}-{dark}', f'base-ml-{W}x{H}-{"d" if dark else "l"}', (lambda W=W, H=H, dark=dark: ml_chat(W, H, [''], dark, 12, 1.25, CJK, W // 2)), pairs))
    return S


def strip_boxes(base, img):
    """跟底圖不一樣的地方切成幾個方塊（每 32 列看一次外框，連續有差異的併成一塊）。回傳 [(x, y, w, h)]。"""
    W, H = base.size
    diff = ImageChops.difference(base, img)
    bands = []
    cur = None
    STEP = 32
    for y0 in range(0, H, STEP):
        bb = diff.crop((0, y0, W, min(H, y0 + STEP))).getbbox()
        if bb is None:
            if cur:
                bands.append(cur); cur = None
            continue
        x0, yy0, x1, yy1 = bb[0], y0 + bb[1], bb[2], y0 + bb[3]
        if cur is None:
            cur = [x0, yy0, x1, yy1]
        else:
            cur = [min(cur[0], x0), cur[1], max(cur[2], x1), yy1]
    if cur:
        bands.append(cur)
    return [(x0, y0, x1 - x0, y1 - y0) for x0, y0, x1, y1 in bands]


def max_diff(a, b):
    """整張逐像素的最大灰階差、差 > 2 的像素數（直接用 PIL 算，跟 imagehash.ts 無關）。"""
    diff = ImageChops.difference(a, b)
    hist = diff.histogram()
    mx = max(i for i, n in enumerate(hist) if n) if any(hist) else 0
    return mx, sum(hist[3:])


def main():
    if len(sys.argv) < 2:
        sys.exit('用法：python3 make-synth4.py 驗證者的 run 目錄')
    run = sys.argv[1]
    r3_same(run)
    os.makedirs(OUT, exist_ok=True)
    for fn in os.listdir(OUT):
        os.remove(os.path.join(OUT, fn))
    images, pairs = {}, []

    def put_base(name, im):
        raw = im.tobytes()
        with open(os.path.join(OUT, name + '.gray.gz'), 'wb') as f:
            f.write(gzip.compress(raw, compresslevel=9, mtime=0))
        images[name] = {'width': im.size[0], 'height': im.size[1], 'sha256': hashlib.sha256(raw).hexdigest()}

    def put_patched(name, base_name, base, im):
        raw = im.tobytes()
        meta = {'width': im.size[0], 'height': im.size[1], 'sha256': hashlib.sha256(raw).hexdigest(), 'base': base_name}
        boxes = strip_boxes(base, im)
        if boxes:
            W = im.size[0]
            chunks = []
            for (x, y, w, h) in boxes:
                chunks.append(b''.join(raw[(y + r) * W + x:(y + r) * W + x + w] for r in range(h)))
            with open(os.path.join(OUT, name + '.patch.gz'), 'wb') as f:
                f.write(gzip.compress(b''.join(chunks), compresslevel=9, mtime=0))
            meta['patches'] = [list(b) for b in boxes]
        images[name] = meta

    def check_ref(sub, iname, im):
        p = os.path.join(run, sub, iname + '.gray')
        with open(p, 'rb') as f:
            ref = hashlib.sha256(f.read()).hexdigest()
        assert ref == hashlib.sha256(im.tobytes()).hexdigest(), f'{iname} 跟驗證者當時的圖不一樣'

    def expect_of(name, a, b):
        mx, n = max_diff(a, b)
        if mx <= 2:
            return ('sameKnown' if name.startswith('F-') else 'same'), mx, n
        if name in ML_DIFFERENT:
            return 'different', mx, n
        return 'notSame', mx, n

    # R：真實 Chromium 截圖
    shots = os.path.join(run, 'real', 'shots')
    rpairs = json.load(open(os.path.join(shots, 'pairs.json'), encoding='utf-8'))
    for tag in ('hd', 'fhd', 'qhd', 'mac2x'):
        base_name = f'R-{tag}-same-p300-a'

        def load(n):
            m = json.load(open(os.path.join(shots, n + '.json')))
            with open(os.path.join(shots, n + '.gray'), 'rb') as f:
                return Image.frombytes('L', (m['width'], m['height']), f.read())
        base = load(f'{tag}-same-p300-a')
        put_base(base_name, base)
        for p in rpairs:
            if not p['name'].startswith(tag + '-'):
                continue
            ims = {}
            for side in ('a', 'b'):
                src = p[side]
                im = load(src)
                ims[side] = im
                iname = 'R-' + src
                if iname != base_name:
                    put_patched(iname, base_name, base, im)
            exp, mx, n = expect_of('R-' + p['name'], ims['a'], ims['b'])
            pairs.append({'name': 'R-' + p['name'], 'a': 'R-' + p['a'], 'b': 'R-' + p['b'], 'expect': exp, 'maxDiff': mx, 'changed': n,
                          'why': p['why'].replace('x', '×', 1)})
        print('R', tag, file=sys.stderr)

    # 其他：畫出來
    for scene, base_name, fbase, plist in all_scenes():
        rgb_base = fbase()
        base = rgb_base.convert('L')
        put_base(base_name, base)
        for name, fa, fb, why in plist:
            ims = {}
            for side, fn in (('a', fa), ('b', fb)):
                out = fn()
                if isinstance(out, tuple):  # L 類：在底圖上寫一行字
                    _, text, fs, fontp, fi, col = out
                    rgb = rgb_base.copy()
                    ImageDraw.Draw(rgb).text((60, 300), text, font=ImageFont.truetype(fontp, fs, index=fi), fill=col)
                    im = rgb.convert('L')
                else:
                    im = out.convert('L')
                iname = f'{name}-{side}'
                sub = {'C': 'caret', 'K': 'col', 'E': 'misc', 'H': 'misc', 'F': 'misc'}.get(name.split('-')[0][0])
                if sub:
                    check_ref(sub, iname, im)
                ims[side] = im
                put_patched(iname, base_name, base, im)
            exp, mx, n = expect_of(name, ims['a'], ims['b'])
            pr = {'name': name, 'a': f'{name}-a', 'b': f'{name}-b', 'expect': exp, 'maxDiff': mx, 'changed': n, 'why': why}
            if name.startswith('W-'):
                # 那行字的範圍：兩張逐像素差 > 2 的外框（x、y、寬、高）
                bb = ImageChops.difference(ims['a'], ims['b']).point(lambda v: 255 if v > 2 else 0).getbbox()
                pr['line'] = [bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]]
            pairs.append(pr)
        print(scene, len(plist), file=sys.stderr)

    with open(os.path.join(OUT, 'synth4.json'), 'w', encoding='utf-8') as f:
        head = {'method': "PIL 畫 RGB 再 convert('L')，與第三輪對抗式驗證的產生程式相同（R- 開頭的是驗證者的 Chromium 截圖）；每一組畫面共用一張底圖，其他圖只存與底圖不同的幾個方塊（patches，依序接在 .patch.gz 裡）",
                'expect': {'notSame': '不可以是 same（全解析度上有像素的灰階差 > 2）', 'same': '全解析度上每個像素的差都 ≤ 2', 'sameKnown': '已知限制：灰階亮度一樣的換色，灰階上看不出來', 'different': '多行字整段不同：不一樣（不成組）'},
                'fields': {'maxDiff': '兩張逐像素的最大灰階差', 'changed': '灰階差 > 2 的像素數', 'line': 'W 類：那行字的範圍（兩張逐像素差 > 2 的外框，x、y、寬、高）'}}
        f.write('{\n')
        for k, v in head.items():
            f.write(f' {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)},\n')
        f.write(' "images": {\n')
        items = list(images.items())
        for i, (k, v) in enumerate(items):
            f.write(f'  {json.dumps(k)}: {json.dumps(v, separators=(",", ":"))}' + (',\n' if i < len(items) - 1 else '\n'))
        f.write(' },\n "pairs": [\n')
        for i, pr in enumerate(pairs):
            f.write('  ' + json.dumps(pr, ensure_ascii=False, separators=(',', ':')) + (',\n' if i < len(pairs) - 1 else '\n'))
        f.write(' ]\n}\n')


if __name__ == '__main__':
    main()
