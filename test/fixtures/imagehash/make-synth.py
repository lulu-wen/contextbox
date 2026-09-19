# 開發期產生 imagehash 的合成測試圖（測試執行時不會跑這支，也不需要 PIL）。
#
# 兩部分：
#   1. 對抗式驗證找到的反例，逐位元組重現驗證者當時的圖（PIL 畫 RGB 再 convert('L')，
#      字型 Noto Sans CJK TC）。每組畫面共用一張底圖，其他圖只存「跟底圖不一樣的那個方塊」，
#      測試時把方塊貼回底圖再比 sha256，所以檔案小，而且內容逐位元組確定。
#   2. 字形表 glyphs.gray.gz：常用中文字在 14、18、21、28 px 的灰階覆蓋率，
#      測試用它在 JS 裡排出「同版面、換 N 行字」「只改一個字」的四種尺寸畫面（不需要字型檔）。
#
# 用法：python3 make-synth.py
# 需要：PIL、/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc（只有開發期需要）
import gzip
import hashlib
import json
import os
import random

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'synth')
CJK = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
MONO = '/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf'


def font(px):
    return ImageFont.truetype(CJK, px, index=2)  # TC


# ── 驗證者的畫法（照抄，才能逐位元組重現）───────────────────────
def chat(W, H, scale, msgs, dark=False, caret=None, clock='10:41', gray_meta=None):
    bg = (30, 30, 30) if dark else (245, 245, 245)
    bubble_me = (0, 92, 75) if dark else (149, 236, 105)
    bubble_you = (45, 45, 45) if dark else (255, 255, 255)
    fg = (230, 230, 230) if dark else (20, 20, 20)
    meta = (140, 140, 140) if dark else (153, 153, 153)
    im = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(im)
    s = scale
    d.rectangle([0, 0, W, 56 * s], fill=(40, 40, 40) if dark else (255, 255, 255))
    d.text((24 * s, 16 * s), '資料結構 課程群組', font=font(18 * s), fill=fg)
    d.text((W - 90 * s, 18 * s), clock, font=font(14 * s), fill=meta)
    y = 80 * s
    for i, (who, text) in enumerate(msgs):
        f = font(14 * s)
        tw = d.textlength(text, font=f)
        pad = 10 * s
        if who == 'me':
            x1 = W - 24 * s
            x0 = x1 - tw - 2 * pad
            col = bubble_me
        else:
            x0 = 72 * s
            x1 = x0 + tw + 2 * pad
            col = bubble_you
            d.ellipse([24 * s, y, 60 * s, y + 36 * s], fill=(180, 180, 200))
        d.rounded_rectangle([x0, y, x1, y + 38 * s], radius=12 * s, fill=col)
        d.text((x0 + pad, y + 9 * s), text, font=f, fill=fg)
        if gray_meta and i == len(msgs) - 1:
            d.text((x0, y + 42 * s), gray_meta, font=font(11 * s), fill=meta)
        y += 60 * s
    d.rounded_rectangle([24 * s, H - 64 * s, W - 24 * s, H - 20 * s], radius=20 * s,
                        fill=(50, 50, 50) if dark else (255, 255, 255),
                        outline=(200, 200, 200) if not dark else (80, 80, 80))
    d.text((44 * s, H - 54 * s), '輸入訊息', font=font(14 * s), fill=meta)
    if caret is not None:
        cx = 44 * s + caret
        d.rectangle([cx, H - 54 * s, cx + max(1, s) - 1, H - 34 * s], fill=fg)
    return im


def editor(W, H, lines, caret=None, dark=False):
    bg = (30, 30, 30) if dark else (255, 255, 255)
    fg = (212, 212, 212) if dark else (30, 30, 30)
    im = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(MONO, 14)
    for i, l in enumerate(lines):
        d.text((60, 20 + i * 20), l, font=f, fill=fg)
        d.text((10, 20 + i * 20), str(i + 1).rjust(3), font=f, fill=(133, 133, 133))
    if caret:
        r, c = caret
        cw = d.textlength('m', font=f)
        x = 60 + int(c * cw)
        d.rectangle([x, 20 + r * 20, x + 1, 20 + r * 20 + 18], fill=fg)
    return im


POOL = ('的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情部正名定女問力機給等幾很業最間新什打便位因重被走電四第門相次東政海口使教西再平真聽世氣信北少關並內加化由卻代軍產入先山五太水萬市眼體別處總才場師書比住員九笑性通目華報立馬命張活難神數件安表原車白應路期叫死常提感金何更反合放做系計或司利受光王果親界及今京務制解各任至清物台象記邊共風戰干接它許八特覺望直服毛林題建南度統色字請交愛讓認算論百吃義科怎元社術結六功指思非流每青管夫連遠資隊跟帶花快條院變聯言權往展該領傳近留紅治決周保達辦運武半候七必城父強步完革深區即求品士轉量空甚眾技輕程告江語英基派滿式李息寫呢識極令黃德收臉錢黨倒未持取設始版雙歷越史商千片容研像找友孩站廣改議形委早房音火際則首單據導影失拿網香似斯專石若兵弟誰校讀志飛觀爭究包組造落視濟喜離雖壞兄')


def page2(seedlines, W, H, dark, size=16):
    bg = 30 if dark else 255
    fg = 220 if dark else 25
    im = Image.new('L', (W, H), bg)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(CJK, size, index=3)
    y = 40
    for s in seedlines:
        if y > H - 40:
            break
        rnd = random.Random(s)
        txt = ''.join(rnd.choice(POOL) for _ in range(40))
        d.text((80, y), txt, font=f, fill=fg)
        y += int(size * 1.6)
    return im


BASE = [('you', '大家好，下週三的小考範圍是第三章到第五章。'), ('me', '收到，謝謝助教！'),
        ('you', '作業三的截止時間是星期五晚上十二點。'), ('me', '請問可以用 Python 寫嗎？')]
L1 = '期中考改到十一月五日，範圍到第七章，記得帶計算機。'
L2 = '期末報告改成分組上台，每組十分鐘，請先上傳投影片。'
NEW = '作業四的截止時間延到週五晚上十二點。'
CODE = ['def f(x):', '    return x + 1', '', 'print(f(3))']


def gray(im):
    return im.convert('L') if im.mode != 'L' else im


# 每一組：(底圖名, 產生 {圖名: PIL 圖} 的函式)
groups = {
    'chat1280': ('s03-new-msg-a', lambda: {
        's03-new-msg-a': chat(1280, 860, 1, BASE),
        's01-ok-vs-no-a': chat(1280, 860, 1, BASE + [('you', '好')]),
        's01-ok-vs-no-b': chat(1280, 860, 1, BASE + [('you', '不行')]),
        's02-time-change-a': chat(1280, 860, 1, BASE + [('you', '明天早上九點在 R103 集合')]),
        's02-time-change-b': chat(1280, 860, 1, BASE + [('you', '明天下午三點在 R204 集合')]),
        's03-new-msg-b': chat(1280, 860, 1, BASE + [('you', NEW)]),
        's04-long-diff-a': chat(1280, 860, 1, BASE + [('you', L1)]),
        's04-long-diff-b': chat(1280, 860, 1, BASE + [('you', L2)]),
        's08-graymeta-a': chat(1280, 860, 1, BASE, gray_meta='已讀 10:41'),
        's08-graymeta-b': chat(1280, 860, 1, BASE, gray_meta='已讀 10:47'),
        's09-caret-a': chat(1280, 860, 1, BASE, caret=0),
        's09-caret-b': chat(1280, 860, 1, BASE, caret=40),
        's12-clock-b': chat(1280, 860, 1, BASE, clock='10:42'),
    }),
    'chat1280dark': ('s05-dark-ok-no-a', lambda: {
        's05-dark-ok-no-a': chat(1280, 860, 1, BASE + [('you', '好')], dark=True),
        's05-dark-ok-no-b': chat(1280, 860, 1, BASE + [('you', '不行')], dark=True),
        's06-dark-time-a': chat(1280, 860, 1, BASE + [('you', '明天早上九點在 R103 集合')], dark=True),
        's06-dark-time-b': chat(1280, 860, 1, BASE + [('you', '明天下午三點在 R204 集合')], dark=True),
        's07-dark-long-a': chat(1280, 860, 1, BASE + [('you', L1)], dark=True),
        's07-dark-long-b': chat(1280, 860, 1, BASE + [('you', L2)], dark=True),
    }),
    'editor': ('s10-editor-caret-a', lambda: {
        's10-editor-caret-a': editor(1280, 860, CODE * 6, caret=(1, 5)),
        's10-editor-caret-b': editor(1280, 860, CODE * 6, caret=(13, 9)),
        's11-editor-line-a': editor(1280, 860, CODE * 6),
        's11-editor-line-b': editor(1280, 860, ['def f(x):', '    return x * 2 - 7', '', 'print(f(3))'] + CODE * 5),
    }),
    'chat4k': ('s14-4k-new-msg-a', lambda: {
        's13-4k-long-a': chat(3840, 2160, 1, BASE + [('you', L1)]),
        's13-4k-long-b': chat(3840, 2160, 1, BASE + [('you', L2)]),
        's14-4k-new-msg-a': chat(3840, 2160, 1, BASE),
        's14-4k-new-msg-b': chat(3840, 2160, 1, BASE + [('you', NEW)]),
    }),
    'phone': ('s18-phone-clock-a', lambda: {
        's17-phone-ok-no-a': chat(1170, 2532, 3, BASE + [('you', '好')]),
        's17-phone-ok-no-b': chat(1170, 2532, 3, BASE + [('you', '不行')]),
        's18-phone-clock-a': chat(1170, 2532, 3, BASE, clock='10:41'),
        's18-phone-clock-b': chat(1170, 2532, 3, BASE, clock='10:42'),
    }),
    'fhd1x': ('r-fhd1x-long-a', lambda: {
        'r-fhd1x-long-a': chat(1920, 1080, 1, BASE + [('you', L1)]),
        'r-fhd1x-long-b': chat(1920, 1080, 1, BASE + [('you', L2)]),
    }),
    'mac13': ('r-mac13-2x-long-a', lambda: {
        'r-mac13-2x-long-a': chat(2560, 1600, 2, BASE + [('you', L1)]),
        'r-mac13-2x-long-b': chat(2560, 1600, 2, BASE + [('you', L2)]),
    }),
    'mac15': ('r-mac15-2x-long-a', lambda: {
        'r-mac15-2x-long-a': chat(2880, 1800, 2, BASE + [('you', L1)]),
        'r-mac15-2x-long-b': chat(2880, 1800, 2, BASE + [('you', L2)]),
    }),
    'mac16': ('r-mac16-2x-long-a', lambda: {
        'r-mac16-2x-long-a': chat(3456, 2234, 2, BASE + [('you', L1)]),
        'r-mac16-2x-long-b': chat(3456, 2234, 2, BASE + [('you', L2)]),
    }),
}


def kpage(W, H, dark, k):
    seeds = list(range(100, 140))
    for j in range(k):
        seeds[10 + j] = 9000 + j
    return page2(seeds, W, H, dark)


for tag, W, H in (('1920', 1920, 1080), ('1280', 1280, 860)):
    for dark in (False, True):
        ks = {'1920': {False: [4], True: [6]}, '1280': {False: [1], True: [1]}}[tag][dark]
        name = f'k-{tag}-{dark}-a'

        def make(W=W, H=H, dark=dark, tag=tag, ks=ks):
            out = {f'k-{tag}-{dark}-a': kpage(W, H, dark, 0)}
            for k in ks:
                out[f'k-{tag}-{dark}-b{k}'] = kpage(W, H, dark, k)
            return out
        groups[f'k{tag}{dark}'] = (name, make)

# 標準答案：驗證者當時的標記（burst），why 是中文說明
PAIRS = [
    ('s01-ok-vs-no', False, '1280×860 聊天：最後一則「好」→「不行」（規格衝突，見測試）'),
    ('s02-time-change', False, '1280×860 聊天：集合時間地點不同（早上九→下午三、R103→R204）'),
    ('s03-new-msg', False, '1280×860 聊天：多一整則新訊息'),
    ('s04-long-diff', False, '1280×860 聊天：最後一則整句不同（約 25 字）'),
    ('s05-dark-ok-no', False, '1280×860 深色：「好」→「不行」（規格衝突，見測試）'),
    ('s06-dark-time', False, '1280×860 深色：集合時間地點不同'),
    ('s07-dark-long', False, '1280×860 深色：最後一則整句不同'),
    ('s08-graymeta', True, '只有淺灰小字的已讀時間不同'),
    ('s09-caret', True, '只有輸入框游標位置不同'),
    ('s10-editor-caret', True, '編輯器只有游標位置不同'),
    ('s11-editor-line', False, '編輯器：一行程式碼改了（x + 1 → x * 2 - 7）'),
    ('s12-clock', True, '只有右上角時鐘不同'),
    ('s13-4k-long', False, '3840×2160（100%）：最後一則整句不同'),
    ('s14-4k-new-msg', False, '3840×2160（100%）：多一整則新訊息'),
    ('s17-phone-ok-no', False, '手機直式 3x：「好」→「不行」（規格衝突，見測試）'),
    ('s18-phone-clock', True, '手機直式 3x：只有時鐘不同'),
    ('r-fhd1x-long', False, '1920×1080（100%）：最後一則整句不同'),
    ('r-mac13-2x-long', False, '2560×1600（2x）：最後一則整句不同'),
    ('r-mac15-2x-long', False, '2880×1800（2x）：最後一則整句不同'),
    ('r-mac16-2x-long', False, '3456×2234（2x）：最後一則整句不同'),
    ('k-1280-False-b1', False, '1280×860 淺色文件：換掉 1 整行（40 字，16px）'),
    ('k-1280-True-b1', False, '1280×860 深色文件：換掉 1 整行'),
    ('k-1920-False-b4', False, '1920×1080 淺色文件：換掉 4 整行'),
    ('k-1920-True-b6', False, '1920×1080 深色文件：換掉 6 整行'),
]


def pair_names(p):
    n = p
    if n.startswith('k-'):
        return n.rsplit('-', 1)[0] + '-a', n
    if n == 's12-clock':
        return 's03-new-msg-a', 's12-clock-b'   # 驗證者的 s12-a 與 s03-a 是同一張圖
    return n + '-a', n + '-b'


CROP_OF = {'k-1280-False-a': 'k-1920-False-a', 'k-1280-True-a': 'k-1920-True-a'}


def describe(name, W, H, raw, ref, ref_name, crop):
    # raw 跟 ref（同尺寸）不一樣的地方包成一個方塊存起來
    x0, y0, x1, y1 = W, H, -1, -1
    for y in range(H):
        ra = ref[y * W:(y + 1) * W]
        rb = raw[y * W:(y + 1) * W]
        if ra == rb:
            continue
        xs = [x for x in range(W) if ra[x] != rb[x]]
        x0, x1, y0, y1 = min(x0, xs[0]), max(x1, xs[-1]), min(y0, y), max(y1, y)
    meta = {'width': W, 'height': H, 'sha256': hashlib.sha256(raw).hexdigest(), 'base': ref_name}
    if crop:
        meta['crop'] = crop
    if x1 >= 0:
        region = b''.join(raw[y * W + x0:y * W + x1 + 1] for y in range(y0, y1 + 1))
        with open(os.path.join(OUT, name + '.patch.gz'), 'wb') as f:
            f.write(gzip.compress(region, compresslevel=9, mtime=0))
        meta['patch'] = [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
    return meta


def main():
    os.makedirs(OUT, exist_ok=True)
    for fn in os.listdir(OUT):
        os.remove(os.path.join(OUT, fn))
    images = {}
    raws = {}
    for g, (base_name, make) in groups.items():
        pil = {k: gray(v) for k, v in make().items()}
        ims = {k: v.tobytes() for k, v in pil.items()}
        W, H = pil[base_name].size
        base = ims[base_name]
        crop_of = CROP_OF.get(base_name)
        if crop_of:
            # 底圖本身是另一張底圖左上角裁下來、再貼一個方塊（1280 的文件頁是 1920 那張的左上角）
            big, BW = raws[crop_of], images[crop_of]['width']
            cropped = b''.join(big[y * BW:y * BW + W] for y in range(H))
            images[base_name] = describe(base_name, W, H, base, cropped, crop_of, [0, 0, W, H])
        else:
            with open(os.path.join(OUT, base_name + '.gray.gz'), 'wb') as f:
                f.write(gzip.compress(base, compresslevel=9, mtime=0))
            images[base_name] = {'width': W, 'height': H, 'sha256': hashlib.sha256(base).hexdigest()}
        raws[base_name] = base
        for name, raw in ims.items():
            if name == base_name:
                continue
            assert len(raw) == W * H
            images[name] = describe(name, W, H, raw, base, base_name, None)
    pairs = []
    for name, burst, why in PAIRS:
        a, b = pair_names(name)
        assert a in images and b in images, name
        pairs.append({'name': name, 'a': a, 'b': b, 'burst': burst, 'why': why})

    # 字形表：每個字畫在「字寬 × 這個大小所有字墨跡的上下範圍」的格子裡（中文字等寬），存覆蓋率 0～255
    chars = ''.join(dict.fromkeys(POOL))[:96]
    sizes = [14, 18, 21, 28]
    blob = bytearray()
    cells = []
    for px in sizes:
        f = ImageFont.truetype(CJK, px, index=2)
        boxes = [f.getbbox(c) for c in chars]
        y0 = min(b[1] for b in boxes)
        y1 = max(b[3] for b in boxes)
        cells.append([px, y1 - y0])
        for ch in chars:
            im = Image.new('L', (px, y1 - y0), 0)
            ImageDraw.Draw(im).text((0, -y0), ch, font=f, fill=255)
            blob += im.tobytes()
    with open(os.path.join(OUT, 'glyphs.gray.gz'), 'wb') as f:
        f.write(gzip.compress(bytes(blob), compresslevel=9, mtime=0))
    glyphs = {'chars': chars, 'sizes': sizes, 'cells': cells, 'sha256': hashlib.sha256(bytes(blob)).hexdigest(),
              'layout': '依 sizes 的順序，每個大小 len(chars) 個字，每字 cells[i][0]×cells[i][1] 位元組，列優先'}

    with open(os.path.join(OUT, 'synth.json'), 'w', encoding='utf-8') as f:
        json.dump({'method': 'PIL 畫 RGB 再 convert(\'L\')（文件頁直接畫 L），與對抗式驗證的合成程式相同；非底圖只存與底圖不同的方塊',
                   'images': images, 'pairs': pairs, 'glyphs': glyphs}, f, ensure_ascii=False, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
