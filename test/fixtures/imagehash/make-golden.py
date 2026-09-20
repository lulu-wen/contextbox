# 開發期：用另一份獨立的 Python 實作重算 golden.json（測試只比對存下來的值，不會跑這支）。
#
# 照預想表的定義直接寫，不看 core/imagehash.ts：
#   - 縮放：面積平均。目標格 (tx, ty) = Σ 來源像素 × 水平重疊 × 垂直重疊 ÷ (W×H)，四捨五入（.5 進位），全程整數。
#     水平重疊 = min((x+1)·tw, (tx+1)·W) − max(x·tw, tx·W)（取正值），垂直同理。
#   - dHash：縮成 9×8，每列「左 < 右」記 1，列優先、高位先，16 個小寫 hex。
#   - 細比對縮圖：長邊 S = ⌈長邊 ÷ 4⌉ 夾在 640～960 之間；長邊 > S 時縮到長邊 S（另一邊 round(邊 × S ÷ 長邊)，.5 進位，至少 1）；否則原樣。
#
# 用法：python3 make-golden.py（讀同一個資料夾的 images.json 與 *.gray.gz，寫 golden.json）
import gzip
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FINE_LONG_SIDE = 640
FINE_CELL_PX = 4
FINE_LONG_SIDE_MAX = 960


def overlaps(src, dst):
    # 每個目標格 t：[(來源索引, 重疊長度)]，座標軸總刻度 src × dst
    out = []
    for t in range(dst):
        lo, hi = t * src, (t + 1) * src
        row = []
        for s in range(src):
            ov = min((s + 1) * dst, hi) - max(s * dst, lo)
            if ov > 0:
                row.append((s, ov))
        out.append(row)
    return out


def resize(g, W, H, tw, th):
    ox = overlaps(W, tw)
    oy = overlaps(H, th)
    # 先水平：每一列對每個目標欄的整數加權和
    rows = []
    for y in range(H):
        base = y * W
        rows.append([sum(g[base + x] * ov for x, ov in ox[tx]) for tx in range(tw)])
    den = W * H
    out = bytearray(tw * th)
    for ty in range(th):
        for tx in range(tw):
            num = sum(rows[y][tx] * ov for y, ov in oy[ty])
            out[ty * tw + tx] = (2 * num + den) // (2 * den)
    return bytes(out)


def dhash(g, W, H):
    p = resize(g, W, H, 9, 8)
    bits = ''
    for r in range(8):
        for c in range(8):
            bits += '1' if p[r * 9 + c] < p[r * 9 + c + 1] else '0'
    return '%016x' % int(bits, 2)


def fine_dims(W, H):
    L = max(W, H)
    S = min(FINE_LONG_SIDE_MAX, max(FINE_LONG_SIDE, -(-L // FINE_CELL_PX)))
    if L <= S:
        return W, H
    rd = lambda n: max(1, (2 * n * S + L) // (2 * L))
    return rd(W), rd(H)


def main():
    meta = json.load(open(os.path.join(HERE, 'images.json'), encoding='utf-8'))['images']
    golden = {}
    for name in sorted(meta):
        W, H = meta[name]['width'], meta[name]['height']
        g = gzip.decompress(open(os.path.join(HERE, name + '.gray.gz'), 'rb').read())
        assert len(g) == W * H
        fw, fh = fine_dims(W, H)
        px = resize(g, W, H, fw, fh)
        golden[name] = {'dHash': dhash(g, W, H), 'fineDims': [fw, fh], 'fineSum': sum(px),
                        'fineSha256': hashlib.sha256(px).hexdigest()}
        print(name, golden[name]['dHash'], fw, fh)
    with open(os.path.join(HERE, 'golden.json'), 'w', encoding='utf-8') as f:
        json.dump({'method': 'make-golden.py：面積平均（整數、.5 進位）、9×8 dHash、長邊 640～960 的細比對縮圖',
                   'images': golden}, f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main()
