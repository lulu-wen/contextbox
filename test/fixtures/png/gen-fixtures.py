#!/usr/bin/env python3
"""產生 test/fixtures/png/ 底下的測試圖與標準答案（開發期工具，測試執行時不會用到）。

用法：
    python3 test/fixtures/png/gen-fixtures.py <真實截圖資料夾>

需要 PIL（Pillow）。產出：
- 各 color type／bit depth／filter 的小圖（本檔內建的 Python 編碼器產生，並用 PIL 解一次確認編碼正確）
- PIL 自己編碼的圖（PIL 的編碼器選擇）
- 交錯式（Adam7）圖、JPEG
- 兩張 headless Chromium 真實截圖（原檔直接複製）
- expected.json：每張圖的兩份答案
    ref：照規格公式算的灰階（本檔 ref_gray，與 JS 實作各自獨立寫）→ 測試要求完全相同
    pil：PIL 的答案 → 測試要求每像素差距 ≤ 1
"""
import base64, gzip, hashlib, io, json, os, random, shutil, struct, sys, zlib

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


# ---------- 最小 PNG 編碼器 ----------

def chunk(typ, data):
    body = typ + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)


def pack_row(pixels, ct, bd):
    ch = CHANNELS[ct]
    out = bytearray()
    if bd >= 8:
        for px in pixels:
            assert len(px) == ch
            for s in px:
                assert 0 <= s < (1 << bd)
                out += bytes([s]) if bd == 8 else struct.pack('>H', s)
        return bytes(out)
    acc = 0
    nbits = 0
    for (s,) in pixels:
        assert 0 <= s < (1 << bd)
        acc = (acc << bd) | s
        nbits += bd
        if nbits == 8:
            out.append(acc)
            acc = 0
            nbits = 0
    if nbits:
        out.append(acc << (8 - nbits))
    return bytes(out)


def paeth(a, b, c):
    # 照 PNG 規格：先比 a，再比 b，最後 c
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def filter_row(ft, row, prev, bpp):
    out = bytearray([ft])
    for i, x in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = prev[i] if prev is not None else 0
        c = prev[i - bpp] if (prev is not None and i >= bpp) else 0
        pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][ft]
        out.append((x - pred) & 0xff)
    return bytes(out)


def encode_image_data(width, height, rows, ct, bd, filters):
    bpp = max(1, CHANNELS[ct] * bd // 8)
    out = bytearray()
    prev = None
    for y in range(height):
        row = pack_row(rows[y], ct, bd)
        out += filter_row(filters[y % len(filters)], row, prev, bpp)
        prev = row
    return bytes(out)


ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def encode_png(width, height, rows, ct, bd, filters=(0,), plte=None, trns=None,
               interlace=0, idat_split=None, ancillary=()):
    ihdr = struct.pack('>IIBBBBB', width, height, bd, ct, 0, 0, interlace)
    if interlace == 0:
        raw = encode_image_data(width, height, rows, ct, bd, filters)
    else:
        raw = bytearray()
        for (x0, y0, dx, dy) in ADAM7:
            sub = [[rows[y][x] for x in range(x0, width, dx)] for y in range(y0, height, dy)]
            if sub and sub[0]:
                raw += encode_image_data(len(sub[0]), len(sub), sub, ct, bd, filters)
        raw = bytes(raw)
    z = zlib.compress(raw, 9)
    out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
    for typ, data in ancillary:
        out += chunk(typ, data)
    if plte is not None:
        out += chunk(b'PLTE', b''.join(bytes(c) for c in plte))
    if trns is not None:
        out += chunk(b'tRNS', trns)
    if idat_split:
        for i in range(0, len(z), idat_split):
            out += chunk(b'IDAT', z[i:i + idat_split])
        out += chunk(b'IDAT', b'')  # 零長度 IDAT 也合法
    else:
        out += chunk(b'IDAT', z)
    out += chunk(b'IEND', b'')
    return out


# ---------- 照規格算的灰階（ref） ----------

def ref_gray(width, height, rows, ct, bd, plte=None, trns=None):
    """16 位元取高位元組；小於 8 位元等比放大；Y1000 = 299R+587G+114B；
    疊白底 out = floor((Y1000*a + 255000*(255-a) + 127500) / 255000)；tRNS 用完整樣本值比對。"""
    maxv = (1 << bd) - 1

    def to8(s):
        if bd == 16:
            return s >> 8
        if bd == 8:
            return s
        return s * 255 // maxv

    tv = None
    if trns is not None:
        if ct == 0:
            tv = struct.unpack('>H', trns)[0]
        elif ct == 2:
            tv = struct.unpack('>HHH', trns)
        elif ct == 3:
            tv = list(trns)
    out = bytearray()
    for y in range(height):
        for x in range(width):
            px = rows[y][x]
            if ct == 0:
                y1000, a = 1000 * to8(px[0]), (0 if tv is not None and px[0] == tv else 255)
            elif ct == 2:
                r, g, b = (to8(s) for s in px)
                y1000, a = 299 * r + 587 * g + 114 * b, (0 if tv is not None and tuple(px) == tuple(tv) else 255)
            elif ct == 3:
                r, g, b = plte[px[0]]
                y1000 = 299 * r + 587 * g + 114 * b
                a = tv[px[0]] if tv is not None and px[0] < len(tv) else 255
            elif ct == 4:
                g, a = (to8(s) for s in px)
                y1000 = 1000 * g
            else:
                r, g, b, a = (to8(s) for s in px)
                y1000 = 299 * r + 587 * g + 114 * b
            out.append((y1000 * a + 255000 * (255 - a) + 127500) // 255000)
    return bytes(out)


def ref_gray_from_pil_rgb(im):
    """真實截圖（RGB 8 位元）：PIL 解出 RGB 後照規格公式算。"""
    assert im.mode == 'RGB'
    return bytes((299 * r + 587 * g + 114 * b + 500) // 1000 for (r, g, b) in im.getdata())


# ---------- PIL 的答案 ----------

def pil_gray(data):
    """回傳（灰階 bytes，方法說明）。"""
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode in ('I', 'I;16', 'I;16B'):
        # PIL 的 I→L 會把 >255 的值直接截成 255，不能當答案；改用 PIL 解出的 16 位元值取高位元組
        t = im.info.get('transparency')
        vals = list(im.getdata())
        return bytes(255 if (t is not None and v == t) else (v >> 8) for v in vals), 'pil-decode16-highbyte'
    if im.mode in ('RGBA', 'LA', 'PA') or 'transparency' in im.info:
        rgba = im.convert('RGBA')
        bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
        return Image.alpha_composite(bg, rgba).convert('L').tobytes(), 'pil-composite-white-L'
    return im.convert('L').tobytes(), 'pil-convert-L'


def pil_pixels_match(data, rows, ct, bd, plte):
    """用 PIL 解一次，確認本檔的編碼器寫出來的像素正確（驗證 filter 實作與 PIL 一致）。"""
    im = Image.open(io.BytesIO(data))
    im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            got = im.getpixel((x, y))
            src = rows[y][x]
            if ct == 3:
                exp = src[0]
                if im.mode == 'P':
                    assert got == exp, (x, y, got, exp)
                continue
            if bd == 16:
                if im.mode.startswith('I'):
                    exp = src[0]
                else:
                    exp = tuple(s >> 8 for s in src)
                    if ct == 4:  # PIL 把 16 位元 LA 開成 RGBA
                        exp = (exp[0], exp[0], exp[0], exp[1])
            elif bd < 8:
                exp = src[0] * 255 // ((1 << bd) - 1)
            else:
                exp = src if len(src) > 1 else src[0]
            assert got == exp, (x, y, got, exp, im.mode)


def b64(b):
    return base64.b64encode(b).decode('ascii')


def main():
    shots_dir = sys.argv[1]
    rnd = random.Random(20260919)
    manifest = {'generated': [], 'pilEncoded': [], 'interlaced': [], 'screenshots': []}

    def save(name, data):
        with open(os.path.join(HERE, name), 'wb') as f:
            f.write(data)

    def add_generated(name, w, h, rows, ct, bd, plte=None, trns=None, filters=(0, 1, 2, 3, 4), note='', **kw):
        data = encode_png(w, h, rows, ct, bd, filters=filters, plte=plte, trns=trns, **kw)
        pil_pixels_match(data, rows, ct, bd, plte)
        ref = ref_gray(w, h, rows, ct, bd, plte=plte, trns=trns)
        pil, method = pil_gray(data)
        diff = max(abs(a - b) for a, b in zip(ref, pil))
        entry = {'file': name, 'width': w, 'height': h, 'colorType': ct, 'bitDepth': bd,
                 'trns': trns is not None, 'note': note, 'ref': b64(ref)}
        if diff <= 1:
            entry['pil'] = b64(pil)
            entry['pilMethod'] = method
        else:
            # PIL 這一張跟規格不一致（例如 16 位元 tRNS 只比高位元組），PIL 答案不能用
            entry['pil'] = None
            entry['pilMethod'] = f'{method}（與規格差 {diff}，不採用）'
        save(name, data)
        manifest['generated'].append(entry)
        print(name, len(data), 'bytes, pil diff', diff, method)

    W, H = 37, 11

    def rand_rows(ct, bd, w=W, h=H, pool=None):
        ch = CHANNELS[ct]
        if pool is not None:
            return [[rnd.choice(pool) for _ in range(w)] for _ in range(h)]
        return [[tuple(rnd.randrange(1 << bd) for _ in range(ch)) for _ in range(w)] for _ in range(h)]

    combos = [(0, 1), (0, 2), (0, 4), (0, 8), (0, 16), (2, 8), (2, 16), (3, 1), (3, 2), (3, 4), (3, 8),
              (4, 8), (4, 16), (6, 8), (6, 16)]
    for ct, bd in combos:
        plte = None
        if ct == 3:
            n = min(1 << bd, 200)
            plte = [tuple(rnd.randrange(256) for _ in range(3)) for _ in range(n)]
            rows = [[(rnd.randrange(n),) for _ in range(W)] for _ in range(H)]
        else:
            rows = rand_rows(ct, bd)
        if bd == 16:
            # 放幾個會分辨「取高位元組」與「除以 257」的值
            for i, v in enumerate([0x80FF, 0xFF00, 0x01FF, 0x8000, 0x0000, 0xFFFF]):
                rows[0][i] = tuple([v] * CHANNELS[ct])
        add_generated(f'ct{ct}-d{bd}.png', W, H, rows, ct, bd, plte=plte, note='隨機像素；filter 依列循環 0、1、2、3、4')

    # tRNS
    rows = rand_rows(0, 2)
    add_generated('ct0-d2-trns.png', W, H, rows, 0, 2, trns=struct.pack('>H', 2), note='灰階 2 位元，值 2 透明')
    rows = rand_rows(0, 8, pool=[(0,), (50,), (100,), (150,), (200,), (255,)])
    add_generated('ct0-d8-trns.png', W, H, rows, 0, 8, trns=struct.pack('>H', 100), note='灰階 8 位元，值 100 透明')
    rows = rand_rows(0, 16, pool=[(0x1234,), (0x12FF,), (0x1200,), (0x0000,), (0xFFFF,), (0x80FF,)])
    add_generated('ct0-d16-trns.png', W, H, rows, 0, 16, trns=struct.pack('>H', 0x1234),
                  note='灰階 16 位元，0x1234 透明；0x12FF／0x1200 高位元組相同但不透明')
    rows = rand_rows(2, 8, pool=[(10, 20, 30), (200, 100, 50), (0, 255, 0), (10, 20, 31)])
    add_generated('ct2-d8-trns.png', W, H, rows, 2, 8, trns=struct.pack('>HHH', 10, 20, 30),
                  note='RGB 8 位元，(10,20,30) 透明；(10,20,31) 不透明')
    rows = rand_rows(2, 16, pool=[(0x0A00, 0x1400, 0x1E00), (0x0A01, 0x1400, 0x1E00), (0xC800, 0x6400, 0x3200), (0, 0xFFFF, 0)])
    add_generated('ct2-d16-trns.png', W, H, rows, 2, 16, trns=struct.pack('>HHH', 0x0A00, 0x1400, 0x1E00),
                  note='RGB 16 位元，完整 16 位元比對；只差低位元組的顏色不透明')
    plte = [tuple(rnd.randrange(256) for _ in range(3)) for _ in range(16)]
    rows = [[(rnd.randrange(16),) for _ in range(W)] for _ in range(H)]
    add_generated('ct3-d4-trns.png', W, H, rows, 3, 4, plte=plte, trns=bytes([0, 64, 128, 200, 255]),
                  note='調色盤 16 色，tRNS 只給前 5 個（其餘不透明）')
    plte = [tuple(rnd.randrange(256) for _ in range(3)) for _ in range(256)]
    rows = [[(rnd.randrange(256),) for _ in range(W)] for _ in range(H)]
    add_generated('ct3-d8-trns.png', W, H, rows, 3, 8, plte=plte, trns=bytes(rnd.randrange(256) for _ in range(256)),
                  note='調色盤 256 色，每色隨機透明度')
    add_generated('ct3-d1-trns-black.png', 4, 2, [[(0,), (1,), (0,), (1,)], [(1,), (0,), (1,), (0,)]], 3, 1,
                  plte=[(0, 0, 0), (0, 0, 0)], trns=bytes([0]),
                  note='預想表的例子：索引 0 = 黑、tRNS[0]=0 → 255；索引 1 = 黑、不透明 → 0')

    # Paeth：全部列都用 Paeth，像素值從小集合挑，製造平手
    rows = rand_rows(0, 8, w=64, h=64, pool=[(0,), (6,), (10,), (12,), (250,), (255,), (128,)])
    add_generated('paeth-ties-ct0-d8.png', 64, 64, rows, 0, 8, filters=(4,), note='全部 Paeth，小值集合製造平手')
    rows = rand_rows(6, 8, w=33, h=17)
    add_generated('paeth-ct6-d8.png', 33, 17, rows, 6, 8, filters=(4,), note='全部 Paeth，RGBA（bpp=4）')
    rows = rand_rows(6, 16, w=9, h=9)
    add_generated('paeth-ct6-d16.png', 9, 9, rows, 6, 16, filters=(4, 3), note='Paeth／Average，RGBA16（bpp=8）')

    # 多個 IDAT（每 7 bytes 切一段，最後附零長度 IDAT）＋ 輔助 chunk
    rows = rand_rows(6, 8)
    add_generated('ct6-d8-split-idat.png', W, H, rows, 6, 8, idat_split=7,
                  ancillary=[(b'tEXt', b'Comment\x00hello'), (b'gAMA', struct.pack('>I', 45455))],
                  note='IDAT 切成很多段＋零長度 IDAT＋tEXt／gAMA')

    # 1×1 的極小圖
    add_generated('one-pixel-green.png', 1, 1, [[(0, 255, 0)]], 2, 8, note='純綠 → 150')

    # ---------- PIL 自己編碼的圖 ----------
    src = Image.open(os.path.join(shots_dir, '03-check-a.png')).convert('RGB').crop((100, 120, 260, 220))
    variants = {
        'pil-rgb.png': src,
        'pil-l.png': src.convert('L'),
        'pil-1.png': src.convert('1'),
        'pil-p256.png': src.quantize(256),
        'pil-p16.png': src.quantize(16),
    }
    rgba = src.convert('RGBA')
    alpha = Image.linear_gradient('L').resize(src.size)
    rgba.putalpha(alpha)
    variants['pil-rgba.png'] = rgba
    la = src.convert('L').convert('LA')
    la.putalpha(alpha.rotate(90))
    variants['pil-la.png'] = la
    i16 = Image.frombytes('I;16', src.size, bytes(
        b for v in src.convert('L').getdata() for b in struct.pack('<H', v * 257 + (v % 7) * 13)))
    variants['pil-i16.png'] = i16
    p_t = src.quantize(32)
    p_t.info['transparency'] = 3
    variants['pil-p-transparency.png'] = p_t
    for name, im in variants.items():
        buf = io.BytesIO()
        kw = {'transparency': 3} if name == 'pil-p-transparency.png' else {}
        im.save(buf, 'PNG', **kw)
        data = buf.getvalue()
        save(name, data)
        pil, method = pil_gray(data)
        manifest['pilEncoded'].append({'file': name, 'width': im.size[0], 'height': im.size[1],
                                       'pil': b64(zlib.compress(pil, 9)), 'pilMethod': method})
        print(name, len(data), 'bytes', method, im.mode)

    # ---------- 交錯式 ----------
    for ct, bd in [(2, 8), (0, 1)]:
        rows = rand_rows(ct, bd, w=13, h=9)
        name = f'interlaced-ct{ct}-d{bd}.png'
        data = encode_png(13, 9, rows, ct, bd, filters=(0, 1, 2, 3, 4), interlace=1)
        pil_pixels_match(data, rows, ct, bd, None)  # PIL 解得出來，代表這是合法的 Adam7 檔
        save(name, data)
        manifest['interlaced'].append({'file': name, 'width': 13, 'height': 9})
        print(name, len(data))

    # ---------- JPEG ----------
    buf = io.BytesIO()
    src.resize((16, 16)).save(buf, 'JPEG', quality=80)
    save('not-png.jpg', buf.getvalue())

    # ---------- 真實截圖（headless Chromium，原檔） ----------
    for srcname, name in [('01-same-a.png', 'chromium-1280x860.png'), ('06-size-b.png', 'chromium-1280x720.png')]:
        shutil.copyfile(os.path.join(shots_dir, srcname), os.path.join(HERE, name))
        data = open(os.path.join(HERE, name), 'rb').read()
        im = Image.open(io.BytesIO(data))
        im.load()
        pil = im.convert('L').tobytes()
        ref = ref_gray_from_pil_rgb(im)
        diff = max(abs(a - b) for a, b in zip(ref, pil))
        assert diff <= 1
        gz = name.replace('.png', '.pil-gray.gz')
        with open(os.path.join(HERE, gz), 'wb') as f:
            f.write(gzip.compress(pil, 9, mtime=0))
        manifest['screenshots'].append({'file': name, 'width': im.size[0], 'height': im.size[1],
                                        'pilGrayGz': gz, 'pilMethod': 'pil-convert-L',
                                        'refSha256': hashlib.sha256(ref).hexdigest()})
        print(name, len(data), 'gz', os.path.getsize(os.path.join(HERE, gz)), 'ref vs pil max diff', diff)

    with open(os.path.join(HERE, 'expected.json'), 'w') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
