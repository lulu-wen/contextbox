# 開發期產生 imagehash 第三輪的合成測試圖（測試執行時不會跑這支，也不需要 PIL）。
#
# 內容：第二輪對抗式驗證找到、當時判錯的反例，逐位元組重現驗證者當時的圖。
# 畫法照抄驗證者的產生程式（p0p1-round2/verify2-imagehash/adv/gen_a_lib.py、gen_a.py、gen_b.py、
# gen_c.py、gen_d.py、gen_e.py、gen_g.py、gen_i.py），PIL 畫 RGB 再 convert('L')。
#   - A1：聊天泡泡裡的多行訊息（3～6 行 × 8～12 字，行高 1.35／1.5），整段不同
#   - A2：程式碼前幾行換成別的短行（等寬 14px、行距 19px）
#   - A3：英文便條 5 行整段不同（13px、行距 18px）
#   - B ：聊天最後一則短回覆不同（Approved→Rejected、同意→不同意、收到→已取消……），泡泡寬度跟著變
#   - D ：淺灰小字（#999、#aaa、#bbb，12px）整行資訊不同
#   - F2：行事曆同一格的事件（考試名稱、時間、教室）不同
#   - G ：成績表同一列 6 科分數全部不同
#   - D1、E1：多行訊息（2～10 行、行高 1.3～1.7），整段不同
#   - I ：桌面上 300～340px 寬的聊天視窗，最後一則 60 多字訊息內容完全不同
#   - C ：（第三輪另外加的，不是驗證者的）輸入框的游標移動、游標一閃、多打一個細長的字「l」「I」「|」「1」（第四輪起全部不可以是 same）
# 每一組畫面（同尺寸、同深淺色、同版面）共用一張底圖，其他圖只存「跟底圖不一樣的那個方塊」，
# 測試時貼回底圖再比 sha256，所以檔案小，而且內容逐位元組確定。
#
# 用法：python3 make-synth3.py [驗證者 adv 目錄]
#   給了 adv 目錄時，驗證者的每一張都跟他當時存的 .gray 比 sha256，對不上就停（C 開頭的不比）。
# 需要：PIL、Noto Sans CJK、Noto Sans Mono、DejaVu Sans（只有開發期需要）
import gzip
import hashlib
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'synth3')
CJK = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
MONO = '/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf'
SANS = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'


def cjk(px):
    return ImageFont.truetype(CJK, px, index=2)


def sans(px):
    return ImageFont.truetype(SANS, px)


# ── 驗證者的畫法（照抄，才能逐位元組重現）───────────────────────
TXT = '大家好下週三的小考範圍是第三章到第五章作業三的截止時間是星期五晚上十二點請問可以用寫嗎期中考改到十一月五日範圍到第七章記得帶計算機期末報告改成分組上台每組十分鐘請先上傳投影片明天早上九點在集合收到謝謝助教'


def para(seed, lines, per):
    r = random.Random(seed)
    return [''.join(r.choice(TXT) for _ in range(per)) for _ in range(lines)]


def chat_multi(W, H, s, lines, dark=False, pitch=1.45, fpx=14):
    bg = (30, 30, 30) if dark else (245, 245, 245)
    bub = (45, 45, 45) if dark else (255, 255, 255)
    fg = (230, 230, 230) if dark else (20, 20, 20)
    im = Image.new('RGB', (W, H), bg); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 56 * s], fill=(40, 40, 40) if dark else (255, 255, 255))
    d.text((24 * s, 16 * s), '資料結構 課程群組', font=cjk(18 * s), fill=fg)
    f = cjk(fpx * s)
    y = 80 * s
    d.rounded_rectangle([72 * s, y, 72 * s + 300 * s, y + 38 * s], radius=12 * s, fill=bub)
    d.text((82 * s, y + 9 * s), '大家好，下週三的小考範圍是第三章。', font=f, fill=fg)
    y += 60 * s
    lh = round(fpx * pitch * s)
    tw = max(d.textlength(l, font=f) for l in lines)
    pad = 10 * s
    d.rounded_rectangle([72 * s, y, 72 * s + tw + 2 * pad, y + len(lines) * lh + 2 * pad], radius=12 * s, fill=bub)
    for i, l in enumerate(lines):
        d.text((72 * s + pad, y + pad + i * lh), l, font=f, fill=fg)
    d.ellipse([24 * s, y, 60 * s, y + 36 * s], fill=(180, 180, 200))
    return im


def code_page(W, H, lines, dark=True, fpx=14, pitch=19):
    bg = (30, 30, 30) if dark else (255, 255, 255); fg = (212, 212, 212) if dark else (30, 30, 30)
    im = Image.new('RGB', (W, H), bg); d = ImageDraw.Draw(im); f = ImageFont.truetype(MONO, fpx)
    for i, l in enumerate(lines):
        d.text((60, 20 + i * pitch), l, font=f, fill=fg)
        d.text((10, 20 + i * pitch), str(i + 1).rjust(3), font=f, fill=(133, 133, 133))
    return im


BASE_CODE = ['def handler(event, ctx):', '    items = load(event)', '    for it in items:', '        if it.ok:', '            push(it)', '    return len(items)', '', 'class Store:', '    def __init__(self):', '        self.data = {}', '    def get(self, k):', '        return self.data.get(k)', ''] * 3
ALT2 = ['x = [i*i for i in r]', 'y = sum(x) / len(x)', 'z = max(y, 0.5) * 3', 'w = z - y + 7', 'q = (w, z, y)', 'print(q)']
EN1 = ['Meeting moved to Room 204', 'on Thursday at 3pm. Please', 'bring the signed forms and', 'your laptop. Parking is free', 'after 5pm at the east gate.']
EN2 = ['Lunch is cancelled today', 'because the caterer is sick.', 'We will reschedule it for', 'next Monday at noon in the', 'main hall. Sorry about that!']


def card_page(W, H, lines, dark=False, fpx=13, pitch=18):
    bg = (243, 243, 243) if not dark else (32, 32, 32); card = (255, 255, 255) if not dark else (45, 45, 45); fg = (30, 30, 30) if not dark else (225, 225, 225)
    im = Image.new('RGB', (W, H), bg); d = ImageDraw.Draw(im); f = ImageFont.truetype(SANS, fpx)
    d.rectangle([0, 0, W, 48], fill=card)
    d.text((20, 16), 'Team Notes', font=f, fill=fg)
    x0, y0 = W - 320, 80
    d.rectangle([x0, y0, x0 + 260, y0 + 30 + len(lines) * pitch], fill=card)
    for i, l in enumerate(lines):
        d.text((x0 + 12, y0 + 14 + i * pitch), l, font=f, fill=fg)
    return im


def chat_b(W, H, s, last, dark=False, latin=False, me=False):
    bg = (30, 30, 30) if dark else (239, 234, 226)
    bub_you = (45, 45, 45) if dark else (255, 255, 255)
    bub_me = (0, 92, 75) if dark else (217, 253, 211)
    fg = (230, 230, 230) if dark else (20, 20, 20)
    im = Image.new('RGB', (W, H), bg); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 56 * s], fill=(40, 40, 40) if dark else (255, 255, 255))
    d.text((24 * s, 16 * s), 'Project team' if latin else '專題小組', font=cjk(18 * s), fill=fg)
    f = ImageFont.truetype(SANS, 14 * s) if latin else cjk(14 * s)
    msgs = [('you', 'Did everyone upload the slides?' if latin else '大家投影片都上傳了嗎？'), ('me', 'Yes, done.' if latin else '傳好了'), ('you', 'Can we meet tomorrow?' if latin else '明天可以開會嗎？'), ('me' if me else 'you', last)]
    y = 80 * s
    for who, t in msgs:
        tw = d.textlength(t, font=f); pad = 10 * s
        if who == 'me':
            x1 = W - 24 * s; x0 = x1 - tw - 2 * pad; col = bub_me
        else:
            x0 = 72 * s; x1 = x0 + tw + 2 * pad; col = bub_you
        d.rounded_rectangle([x0, y, x1, y + 38 * s], radius=12 * s, fill=col); d.text((x0 + pad, y + 9 * s), t, font=f, fill=fg); y += 60 * s
    return im


EN = [('Sure, see you at 3', 'Sorry, I cannot go'), ('OK', 'No'), ('Yes, 3pm works', 'No, 5pm is better'), ('Room 204', 'Room 318'), ('Approved', 'Rejected'), ('I will pay', 'You pay'), ('Deal!', 'No deal')]
ZH = [('好的，明天見', '不行，我有事'), ('可以', '不可以'), ('三點', '五點半'), ('同意', '不同意'), ('我付', '你付'), ('收到', '已取消')]


def meta_page(W, H, s, line, gray=(153, 153, 153), fpx=12):
    im = Image.new('RGB', (W, H), (255, 255, 255)); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 56 * s], fill=(245, 245, 245)); d.text((24 * s, 16 * s), '文件資訊', font=cjk(18 * s), fill=(20, 20, 20))
    d.text((40 * s, 90 * s), '專題報告 期末版 最終確認', font=cjk(20 * s), fill=(20, 20, 20))
    d.text((40 * s, 124 * s), line, font=cjk(fpx * s), fill=gray)
    return im


META1 = '最後更新：2026-09-18 由王小明編輯，共 12 頁，已分享給 5 人'
META2 = '最後更新：2026-09-19 由李大華編輯，共 15 頁，已分享給 9 人'


def cal(W, H, s, title, time, room):
    im = Image.new('RGB', (W, H), (255, 255, 255)); d = ImageDraw.Draw(im)
    colw = int((W - 80 * s) / 7)
    for i in range(8):
        d.line([(80 * s + i * colw, 40 * s), (80 * s + i * colw, H)], fill=(220, 220, 220))
    for h in range(16):
        d.line([(80 * s, 60 * s + h * 48 * s), (W, 60 * s + h * 48 * s)], fill=(235, 235, 235)); d.text((20 * s, 54 * s + h * 48 * s), f'{8+h}:00', font=sans(11 * s), fill=(120, 120, 120))
    x0 = 80 * s + 2 * colw + 4 * s; y0 = 60 * s + 2 * 48 * s
    d.rounded_rectangle([x0, y0, x0 + colw - 8 * s, y0 + 90 * s], radius=4 * s, fill=(200, 225, 255))
    f = cjk(12 * s)
    d.text((x0 + 6 * s, y0 + 4 * s), title, font=f, fill=(10, 40, 90)); d.text((x0 + 6 * s, y0 + 22 * s), time, font=f, fill=(10, 40, 90)); d.text((x0 + 6 * s, y0 + 40 * s), room, font=f, fill=(10, 40, 90))
    return im


def grade(W, H, s, row):
    im = Image.new('RGB', (W, H), (255, 255, 255)); d = ImageDraw.Draw(im); f = sans(14 * s)
    names = ['王小明', '李大華', '陳美麗', '林志強', '張雅婷']
    base = [[85, 92, 77, 64, 90, 88], [70, 81, 93, 55, 72, 68], [91, 60, 84, 79, 66, 95], [58, 73, 69, 88, 94, 71], [82, 77, 90, 61, 85, 79]]
    for r in range(5):
        y = 80 * s + r * 32 * s
        d.text((40 * s, y), names[r], font=cjk(14 * s), fill=(20, 20, 20))
        vals = row if r == 2 else base[r]
        for c, v in enumerate(vals):
            d.text((200 * s + c * 100 * s, y), str(v), font=f, fill=(20, 20, 20))
        d.line([(30 * s, y + 26 * s), (W - 30 * s, y + 26 * s)], fill=(220, 220, 220))
    return im


def wrap(d, text, f, maxw):
    lines = []; cur = ''
    for ch in text:
        if d.textlength(cur + ch, font=f) > maxw:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def desktop(W, H, s, last, lh=1.5, winw=480):
    im = Image.new('RGB', (W, H), (58, 110, 165)); d = ImageDraw.Draw(im)
    d.rectangle([40 * s, 40 * s, W - winw * s - 80 * s, H - 80 * s], fill=(255, 255, 255))
    for i in range(18):
        d.text((60 * s, 70 * s + i * 28 * s), '專題進度表：第 %d 週　資料蒐集、訪談整理、原型設計、使用者測試' % (i + 1), font=cjk(14 * s), fill=(40, 40, 40))
    d.rectangle([0, H - 40 * s, W, H], fill=(30, 30, 30))
    x0 = W - winw * s - 40 * s; y0 = 40 * s; x1 = W - 40 * s; y1 = H - 80 * s
    d.rectangle([x0, y0, x1, y1], fill=(239, 234, 226)); d.rectangle([x0, y0, x1, y0 + 48 * s], fill=(255, 255, 255)); d.text((x0 + 16 * s, y0 + 14 * s), '專題小組（5）', font=cjk(16 * s), fill=(20, 20, 20))
    f = cjk(14 * s); pad = 10 * s; maxw = int(winw * 0.62 * s)
    y = y0 + 70 * s
    for who, t in [('you', '大家投影片都上傳了嗎？'), ('me', '傳好了，在共用資料夾'), ('you', '明天幾點開會？'), ('you', last)]:
        ls = wrap(d, t, f, maxw); tw = max(d.textlength(l, font=f) for l in ls); h = len(ls) * round(14 * lh * s)
        if who == 'me':
            bx1 = x1 - 16 * s; bx0 = bx1 - tw - 2 * pad; col = (217, 253, 211)
        else:
            bx0 = x0 + 56 * s; bx1 = bx0 + tw + 2 * pad; col = (255, 255, 255); d.ellipse([x0 + 12 * s, y, x0 + 44 * s, y + 32 * s], fill=(180, 180, 200))
        d.rounded_rectangle([bx0, y, bx1, y + h + 2 * pad], radius=10 * s, fill=col)
        for i, l in enumerate(ls):
            d.text((bx0 + pad, y + pad + i * round(14 * lh * s)), l, font=f, fill=(20, 20, 20))
        y += h + 2 * pad + 14 * s
    return im


LONG_A = '明天的專題討論改到下午兩點，地點在圖書館三樓的討論室，請大家記得帶筆電和上週的訪談資料，另外報告順序是第三組先上台，每組十五分鐘。'
LONG_B = '明天的會議取消，改成線上各自進度回報，週五中午前把問卷分析上傳到共用資料夾，下週一早上九點再到系館二樓集合一起排練，辛苦了大家。'


# ── 游標與細長的字（第三輪另外加的，不是驗證者的）─────────────
def field(W, H, s, txt, caret_after=None, px=14):
    f = ImageFont.truetype(SANS, px * s)
    im = Image.new('RGB', (W, H), (255, 255, 255)); d = ImageDraw.Draw(im)
    d.rectangle([90 * s, 90 * s, 600 * s, 130 * s], outline=(180, 180, 180))
    d.text((100 * s, 100 * s), txt, font=f, fill=(20, 20, 20))
    if caret_after is not None:
        x = 100 * s + int(d.textlength(txt[:caret_after], font=f)) + s
        d.rectangle([x, 98 * s, x + s - 1, 98 * s + 18 * s - 1], fill=(20, 20, 20))
    return im


# ── 所有反例（名稱與驗證者相同），每一組：（畫面群組、畫 a、畫 b、期望、說明）─────────
def all_pairs():
    P = {}

    def add(name, scene, fa, fb, expect, why):
        P[name] = (scene, fa, fb, expect, why)

    for (W, H, s, tag) in [(1280, 720, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k'), (3840, 2160, 1.5, '4k150'), (2560, 1600, 2, 'mac2x')]:
        for (N, M) in [(3, 8), (4, 10), (5, 10), (6, 12)]:
            for pitch in (1.35, 1.5):
                for dark in (False, True):
                    ss = int(s) if s == int(s) else s
                    add(f'A1-{tag}-{N}x{M}-p{int(pitch*100)}-{"d" if dark else "l"}', f'multi-{tag}-{dark}',
                        (lambda W=W, H=H, ss=ss, N=N, M=M, dark=dark, pitch=pitch: chat_multi(W, H, ss, para(1, N, M), dark, pitch)),
                        (lambda W=W, H=H, ss=ss, N=N, M=M, dark=dark, pitch=pitch: chat_multi(W, H, ss, para(2, N, M), dark, pitch)),
                        'different', f'{W}×{H}@{s} 泡泡裡的多行訊息 {N} 行 × {M} 字整段不同，行高 {pitch}')
    for (W, H, tag) in [(1280, 720, 'hd'), (1920, 1080, 'fhd'), (2560, 1440, 'qhd'), (3840, 2160, '4k')]:
        for dark in (True, False):
            b = list(BASE_CODE); b[0:6] = ALT2[:6]
            add(f'A2-{tag}-short-{"d" if dark else "l"}', f'code-{tag}-{dark}',
                (lambda W=W, H=H, dark=dark: code_page(W, H, BASE_CODE, dark)), (lambda W=W, H=H, dark=dark, b=b: code_page(W, H, b, dark)),
                'different', f'{W}×{H} 程式碼前 6 行換成別的短行')
        for dark in (False, True):
            add(f'A3-{tag}-p18-{"d" if dark else "l"}', f'card-{tag}-{dark}',
                (lambda W=W, H=H, dark=dark: card_page(W, H, EN1, dark, 13, 18)), (lambda W=W, H=H, dark=dark: card_page(W, H, EN2, dark, 13, 18)),
                'different', f'{W}×{H} 英文便條 5 行整段不同（13px，行距 18px）')
    for (W, H, s, tag) in [(1280, 860, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k'), (2880, 1800, 2, 'mac2x'), (1170, 2532, 3, 'phone')]:
        for dark in (False, True):
            for me in (False, True):
                for i, (x, y) in enumerate(EN):
                    add(f'B-en{i}-{tag}-{"d" if dark else "l"}-{"me" if me else "you"}', f'chat-{tag}-{dark}-en',
                        (lambda W=W, H=H, s=s, x=x, dark=dark, me=me: chat_b(W, H, s, x, dark, True, me)), (lambda W=W, H=H, s=s, y=y, dark=dark, me=me: chat_b(W, H, s, y, dark, True, me)),
                        'notSame', f'{W}×{H}@{s} 最後一則英文 "{x}" → "{y}"')
                for i, (x, y) in enumerate(ZH):
                    add(f'B-zh{i}-{tag}-{"d" if dark else "l"}-{"me" if me else "you"}', f'chat-{tag}-{dark}-zh',
                        (lambda W=W, H=H, s=s, x=x, dark=dark, me=me: chat_b(W, H, s, x, dark, False, me)), (lambda W=W, H=H, s=s, y=y, dark=dark, me=me: chat_b(W, H, s, y, dark, False, me)),
                        'notSame', f'{W}×{H}@{s} 最後一則中文「{x}」→「{y}」')
    for (W, H, s, tag) in [(1280, 720, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k')]:
        for (g, gl) in [((153, 153, 153), '999'), ((170, 170, 170), 'aaa'), ((187, 187, 187), 'bbb')]:
            add(f'D-{tag}-{gl}', f'meta-{tag}-{gl}',
                (lambda W=W, H=H, s=s, g=g: meta_page(W, H, s, META1, g)), (lambda W=W, H=H, s=s, g=g: meta_page(W, H, s, META2, g)),
                'notSame', f'{W}×{H} 淺灰 #{gl} 12px 整行資訊不同')
    for (W, H, s, tag) in [(1280, 860, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k'), (2880, 1800, 2, 'mac2x')]:
        add(f'F2-{tag}', f'cal-{tag}',
            (lambda W=W, H=H, s=s: cal(W, H, s, '期中考', '10:00-12:00', 'R103')), (lambda W=W, H=H, s=s: cal(W, H, s, '期末考', '13:00-15:00', 'R318')),
            'notSame', f'{W}×{H}@{s} 行事曆事件：考試名稱、時間、教室不同')
    for (W, H, s, tag) in [(1280, 720, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k')]:
        add(f'G-{tag}', f'grade-{tag}',
            (lambda W=W, H=H, s=s: grade(W, H, s, [91, 60, 84, 79, 66, 95])), (lambda W=W, H=H, s=s: grade(W, H, s, [47, 85, 52, 93, 71, 38])),
            'notSame', f'{W}×{H} 成績表同一列 6 科分數全部不同')
    for (W, H, s, tag) in [(1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k'), (1920, 1080, 1.25, 'fhd125'), (1920, 1080, 1.5, 'fhd150')]:
        for (N, M) in [(2, 6), (3, 6), (3, 10), (4, 14), (6, 16), (8, 20), (10, 24), (12, 28)]:
            for pitch in (1.3, 1.4, 1.5, 1.6, 1.7):
                add(f'D1-{tag}-{N}x{M}-p{int(pitch*100)}', f'multi-{tag}-False',
                    (lambda W=W, H=H, s=s, N=N, M=M, pitch=pitch: chat_multi(W, H, s, para(11, N, M), False, pitch)),
                    (lambda W=W, H=H, s=s, N=N, M=M, pitch=pitch: chat_multi(W, H, s, para(12, N, M), False, pitch)),
                    'different', f'{W}×{H}@{s} 泡泡裡 {N} 行 × {M} 字整段不同，行高 {pitch}')
    for (N, M) in [(3, 6), (3, 8), (4, 8), (4, 10), (5, 10), (5, 12), (6, 12), (6, 14), (7, 14)]:
        for pitch in (1.4, 1.5, 1.7):
            for seed in range(4):
                add(f'E1-fhd-{N}x{M}-p{int(pitch*100)}-s{seed}', 'multi-fhd-False',
                    (lambda N=N, M=M, pitch=pitch, seed=seed: chat_multi(1920, 1080, 1, para(100 + seed * 2, N, M), False, pitch)),
                    (lambda N=N, M=M, pitch=pitch, seed=seed: chat_multi(1920, 1080, 1, para(101 + seed * 2, N, M), False, pitch)),
                    'different', f'1920×1080 泡泡裡 {N} 行 × {M} 字整段不同，行高 {pitch}')
    for (W, H, s, tag) in [(1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k')]:
        for winw in (300, 340, 380, 480):
            for lh in (1.4, 1.5):
                add(f'I-{tag}-w{winw}-lh{int(lh*100)}', f'desk-{tag}-{winw}-{lh}',
                    (lambda W=W, H=H, s=s, lh=lh, winw=winw: desktop(W, H, s, LONG_A, lh, winw)), (lambda W=W, H=H, s=s, lh=lh, winw=winw: desktop(W, H, s, LONG_B, lh, winw)),
                    'different', f'{W}×{H}@{s} 桌面上 {winw}px 寬的聊天視窗，最後一則 60 多字訊息內容完全不同，行高 {lh}')
    for (W, H, s, tag) in [(1280, 860, 1, 'hd'), (1920, 1080, 1, 'fhd'), (2560, 1440, 1, 'qhd'), (3840, 2160, 1, '4k'), (2880, 1800, 2, 'mac2x')]:
        for px in (14, 20):
            sc = f'caret-{tag}-{px}'
            t = 'hello world'
            add(f'C-{tag}-{px}-move', sc, (lambda W=W, H=H, s=s, px=px: field(W, H, s, t, 3, px)), (lambda W=W, H=H, s=s, px=px: field(W, H, s, t, 9, px)),
                'notSame', f'{W}×{H}@{s} 輸入框只有游標從第 3 字後移到第 9 字後（{px}px）')
            add(f'C-{tag}-{px}-blink', sc, (lambda W=W, H=H, s=s, px=px: field(W, H, s, t, 11, px)), (lambda W=W, H=H, s=s, px=px: field(W, H, s, t, None, px)),
                'notSame', f'{W}×{H}@{s} 游標一張有一張沒有（跟多打一個細長的字分不開，所以不是 same）')
            for ch in 'lI|1':
                add(f'C-{tag}-{px}-type{ord(ch)}', sc, (lambda W=W, H=H, s=s, px=px: field(W, H, s, 'hello wor', 9, px)), (lambda W=W, H=H, s=s, px=px, ch=ch: field(W, H, s, 'hello wor' + ch, 10, px)),
                    'notSame', f'{W}×{H}@{s} 多打一個細長的字「{ch}」，游標跟著往後（{px}px）')
            for ch in 'l|':
                add(f'C-{tag}-{px}-bare{ord(ch)}', sc, (lambda W=W, H=H, s=s, px=px: field(W, H, s, 'hello wor', None, px)), (lambda W=W, H=H, s=s, px=px, ch=ch: field(W, H, s, 'hello wor' + ch, None, px)),
                    'notSame', f'{W}×{H}@{s} 多打一個細長的字「{ch}」，畫面上沒有游標（{px}px）')
    return P


# 收進 fixtures 的：第二輪判錯的全部（A1、A2、A3、B、D、F2、G、D1、E1、I），名稱照驗證者的
SELECT = '''
A1-fhd-3x8-p135-l A1-fhd-3x8-p135-d A1-fhd-3x8-p150-l A1-fhd-3x8-p150-d A1-fhd-4x10-p135-l A1-fhd-4x10-p135-d A1-fhd-4x10-p150-l A1-fhd-4x10-p150-d
A1-fhd-5x10-p135-l A1-fhd-5x10-p135-d A1-fhd-5x10-p150-l A1-fhd-5x10-p150-d A1-fhd-6x12-p150-d A1-qhd-3x8-p135-l A1-qhd-3x8-p135-d A1-qhd-3x8-p150-l
A1-qhd-3x8-p150-d A1-qhd-4x10-p135-l A1-qhd-4x10-p135-d A1-qhd-4x10-p150-l A1-qhd-4x10-p150-d A1-qhd-5x10-p135-l A1-qhd-5x10-p135-d A1-qhd-5x10-p150-l
A1-qhd-5x10-p150-d A1-qhd-6x12-p135-l A1-qhd-6x12-p135-d A1-qhd-6x12-p150-l A1-qhd-6x12-p150-d A1-4k-3x8-p135-l A1-4k-3x8-p135-d A1-4k-3x8-p150-l
A1-4k-3x8-p150-d A1-4k-4x10-p135-l A1-4k-4x10-p135-d A1-4k-4x10-p150-l A1-4k-4x10-p150-d A1-4k-5x10-p135-l A1-4k-5x10-p135-d A1-4k-5x10-p150-l
A1-4k-5x10-p150-d A1-4k-6x12-p135-l A1-4k-6x12-p135-d A1-4k-6x12-p150-l A1-4k-6x12-p150-d A1-4k150-3x8-p135-l A1-4k150-3x8-p135-d A1-4k150-4x10-p135-l
A1-4k150-4x10-p135-d A1-4k150-5x10-p135-l A1-4k150-5x10-p135-d A1-4k150-6x12-p135-l A1-4k150-6x12-p135-d A2-qhd-short-d A2-qhd-short-l A2-4k-short-d
A2-4k-short-l A3-fhd-p18-l A3-fhd-p18-d A3-qhd-p18-l A3-qhd-p18-d A3-4k-p18-l A3-4k-p18-d
D-fhd-bbb D-qhd-999 D-qhd-aaa D-qhd-bbb D-4k-999 D-4k-aaa D-4k-bbb F2-hd F2-fhd F2-qhd F2-4k G-hd G-fhd G-qhd G-4k
D1-fhd-2x6-p150 D1-fhd-3x6-p130 D1-fhd-3x6-p150 D1-qhd-2x6-p140 D1-qhd-2x6-p150 D1-qhd-2x6-p160 D1-qhd-2x6-p170 D1-qhd-3x6-p130
D1-qhd-3x6-p140 D1-qhd-3x6-p150 D1-qhd-3x6-p160 D1-qhd-3x6-p170 D1-qhd-3x10-p170 D1-qhd-4x14-p170 D1-qhd-6x16-p130 D1-qhd-6x16-p140
D1-qhd-6x16-p150 D1-qhd-6x16-p160 D1-qhd-6x16-p170 D1-4k-2x6-p140 D1-4k-2x6-p150 D1-4k-2x6-p160 D1-4k-2x6-p170 D1-4k-3x6-p130
D1-4k-3x6-p140 D1-4k-3x6-p150 D1-4k-3x6-p160 D1-4k-3x6-p170 D1-4k-3x10-p170 D1-4k-4x14-p170 D1-4k-6x16-p130 D1-4k-6x16-p140
D1-4k-6x16-p150 D1-4k-6x16-p160 D1-4k-6x16-p170 D1-4k-8x20-p130 D1-4k-8x20-p140 D1-4k-8x20-p150 D1-4k-8x20-p160 D1-4k-8x20-p170
D1-4k-10x24-p130 D1-4k-10x24-p140 D1-4k-10x24-p150 D1-4k-10x24-p160 D1-4k-10x24-p170 D1-fhd150-3x6-p130
E1-fhd-3x6-p150-s0 E1-fhd-3x6-p150-s1 E1-fhd-3x6-p150-s2 E1-fhd-3x6-p150-s3 E1-fhd-3x8-p150-s0 E1-fhd-3x8-p150-s1 E1-fhd-3x8-p150-s2 E1-fhd-3x8-p150-s3
E1-fhd-4x8-p150-s0 E1-fhd-4x8-p150-s1 E1-fhd-4x8-p150-s2 E1-fhd-4x8-p150-s3 E1-fhd-4x10-p150-s0 E1-fhd-4x10-p150-s1 E1-fhd-4x10-p150-s2 E1-fhd-4x10-p150-s3
E1-fhd-5x10-p150-s0 E1-fhd-5x10-p150-s1 E1-fhd-5x10-p150-s2 E1-fhd-5x10-p150-s3
I-qhd-w300-lh140 I-qhd-w300-lh150 I-qhd-w340-lh140 I-qhd-w340-lh150 I-4k-w300-lh140 I-4k-w300-lh150 I-4k-w340-lh140 I-4k-w340-lh150
'''.split()
# B：第二輪判錯的 170 組全收
B_WRONG = '''
en1-hd-l-you zh1-hd-l-you zh2-hd-l-you zh3-hd-l-you zh4-hd-l-you zh5-hd-l-you en1-hd-l-me zh1-hd-l-me zh3-hd-l-me zh4-hd-l-me en1-hd-d-you
en6-hd-d-you zh1-hd-d-you zh2-hd-d-you zh3-hd-d-you zh4-hd-d-you zh5-hd-d-you en1-hd-d-me en4-hd-d-me en5-hd-d-me en6-hd-d-me zh1-hd-d-me zh2-hd-d-me
zh3-hd-d-me zh4-hd-d-me zh5-hd-d-me en1-fhd-l-you en5-fhd-l-you en6-fhd-l-you zh1-fhd-l-you zh2-fhd-l-you zh3-fhd-l-you zh4-fhd-l-you zh5-fhd-l-you
en1-fhd-l-me zh1-fhd-l-me zh3-fhd-l-me zh4-fhd-l-me en1-fhd-d-you en5-fhd-d-you en6-fhd-d-you zh1-fhd-d-you zh2-fhd-d-you zh3-fhd-d-you zh4-fhd-d-you
zh5-fhd-d-you en1-fhd-d-me en4-fhd-d-me en5-fhd-d-me en6-fhd-d-me zh1-fhd-d-me zh2-fhd-d-me zh3-fhd-d-me zh4-fhd-d-me zh5-fhd-d-me en1-qhd-l-you
en3-qhd-l-you en4-qhd-l-you en5-qhd-l-you en6-qhd-l-you zh1-qhd-l-you zh2-qhd-l-you zh3-qhd-l-you zh4-qhd-l-you zh5-qhd-l-you en1-qhd-l-me
en5-qhd-l-me zh1-qhd-l-me zh3-qhd-l-me zh4-qhd-l-me en1-qhd-d-you en3-qhd-d-you en6-qhd-d-you zh1-qhd-d-you zh2-qhd-d-you zh3-qhd-d-you zh4-qhd-d-you
zh5-qhd-d-you en1-qhd-d-me en4-qhd-d-me en5-qhd-d-me en6-qhd-d-me zh1-qhd-d-me zh2-qhd-d-me zh3-qhd-d-me zh4-qhd-d-me zh5-qhd-d-me en1-4k-l-you
en3-4k-l-you en4-4k-l-you en5-4k-l-you en6-4k-l-you zh1-4k-l-you zh2-4k-l-you zh3-4k-l-you zh4-4k-l-you zh5-4k-l-you en1-4k-l-me en5-4k-l-me
zh1-4k-l-me zh3-4k-l-me zh4-4k-l-me en1-4k-d-you en3-4k-d-you en6-4k-d-you zh1-4k-d-you zh2-4k-d-you zh3-4k-d-you zh4-4k-d-you zh5-4k-d-you
en1-4k-d-me en4-4k-d-me en5-4k-d-me en6-4k-d-me zh1-4k-d-me zh2-4k-d-me zh3-4k-d-me zh4-4k-d-me zh5-4k-d-me en1-mac2x-l-you zh1-mac2x-l-you
zh2-mac2x-l-you zh3-mac2x-l-you zh4-mac2x-l-you zh5-mac2x-l-you en1-mac2x-l-me zh1-mac2x-l-me zh3-mac2x-l-me zh4-mac2x-l-me en1-mac2x-d-you
en6-mac2x-d-you zh1-mac2x-d-you zh2-mac2x-d-you zh3-mac2x-d-you zh4-mac2x-d-you zh5-mac2x-d-you en1-mac2x-d-me en4-mac2x-d-me en5-mac2x-d-me
en6-mac2x-d-me zh1-mac2x-d-me zh2-mac2x-d-me zh3-mac2x-d-me zh4-mac2x-d-me zh5-mac2x-d-me en1-phone-l-you zh1-phone-l-you zh2-phone-l-you
zh3-phone-l-you zh4-phone-l-you zh5-phone-l-you en1-phone-l-me zh1-phone-l-me zh3-phone-l-me zh4-phone-l-me en1-phone-d-you zh1-phone-d-you
zh2-phone-d-you zh3-phone-d-you zh4-phone-d-you zh5-phone-d-you en1-phone-d-me en4-phone-d-me en5-phone-d-me en6-phone-d-me zh1-phone-d-me
zh2-phone-d-me zh3-phone-d-me zh4-phone-d-me zh5-phone-d-me
'''.split()


def gray(im):
    return im.convert('L')


def main():
    adv_dir = sys.argv[1] if len(sys.argv) > 1 else None
    allp = all_pairs()
    wanted = list(SELECT) + ['B-' + n for n in B_WRONG] + [n for n in allp if n.startswith('C-')]
    os.makedirs(OUT, exist_ok=True)
    for fn in os.listdir(OUT):
        os.remove(os.path.join(OUT, fn))
    scenes = {}
    for name in wanted:
        scenes.setdefault(allp[name][0], []).append(name)
    images, pairs = {}, []
    for scene, names in scenes.items():
        base_name = None
        base = None
        W = H = None
        for name in names:
            _, fa, fb, expect, why = allp[name]
            for tag, fn in (('a', fa), ('b', fb)):
                g = gray(fn())
                raw = g.tobytes()
                iname = f'{name}-{tag}'
                sha = hashlib.sha256(raw).hexdigest()
                if adv_dir and not name.startswith('C-'):
                    with open(os.path.join(adv_dir, iname + '.gray'), 'rb') as f:
                        ref = hashlib.sha256(f.read()).hexdigest()
                    assert ref == sha, f'{iname} 跟驗證者當時的圖不一樣'
                if base is None:
                    base_name, base, (W, H) = iname, raw, g.size
                    with open(os.path.join(OUT, iname + '.gray.gz'), 'wb') as f:
                        f.write(gzip.compress(raw, compresslevel=9, mtime=0))
                    images[iname] = {'width': W, 'height': H, 'sha256': sha}
                    continue
                assert g.size == (W, H)
                x0, y0, x1, y1 = W, H, -1, -1
                for y in range(H):
                    ra = base[y * W:(y + 1) * W]
                    rb = raw[y * W:(y + 1) * W]
                    if ra == rb:
                        continue
                    xs = [x for x in range(W) if ra[x] != rb[x]]
                    x0, x1, y0, y1 = min(x0, xs[0]), max(x1, xs[-1]), min(y0, y), max(y1, y)
                meta = {'width': W, 'height': H, 'sha256': sha, 'base': base_name}
                if x1 >= 0:
                    region = b''.join(raw[y * W + x0:y * W + x1 + 1] for y in range(y0, y1 + 1))
                    with open(os.path.join(OUT, iname + '.patch.gz'), 'wb') as f:
                        f.write(gzip.compress(region, compresslevel=9, mtime=0))
                    meta['patch'] = [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
                images[iname] = meta
            pairs.append({'name': name, 'a': f'{name}-a', 'b': f'{name}-b', 'expect': expect, 'why': why})
        print(scene, len(names), file=sys.stderr)
    order = {n: i for i, n in enumerate(wanted)}
    pairs.sort(key=lambda p: order[p['name']])
    with open(os.path.join(OUT, 'synth3.json'), 'w', encoding='utf-8') as f:
        head = {'method': "PIL 畫 RGB 再 convert('L')，與第二輪對抗式驗證的產生程式相同（C- 開頭的是第三輪另外加的游標與細長字）；每一組畫面共用一張底圖，其他圖只存與底圖不同的方塊",
                'expect': {'different': '不一樣（不成組）', 'notSame': '不可以是 same（similar 或 different 都可以）', 'same': '幾乎一樣（第四輪起沒有這種組：游標移動也是 notSame）'}}
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
