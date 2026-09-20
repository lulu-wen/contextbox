#!/usr/bin/env python3
# 開發期用：產生 office-text 測試範例檔。測試執行時不會跑這支，只讀它產生的檔案。
# 用法：先跑 generate.sh（它會先用 LibreOffice 轉出 docx／pptx，再呼叫這支）。
import os
import struct
import sys
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)  # test/fixtures/office-text


def write(name, data):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(data)


# ---- 純文字：各種編碼 ----
write('big5.txt', '資料結構\n第3週：堆疊與佇列\n'.encode('big5'))
write('latin1-cafe.txt', 'café'.encode('latin-1'))
write('utf8-bom.txt', b'\xef\xbb\xbf' + '資料結構 UTF-8 有 BOM'.encode('utf-8'))
write('utf8-nobom.txt', '資料結構 UTF-8 沒有 BOM'.encode('utf-8'))
write('utf16le-bom.txt', b'\xff\xfe' + '資料結構 UTF-16LE'.encode('utf-16-le'))


# ---- 簡報：把 LibreOffice 轉出來的 lecture.pptx 重新排序 ----
# 模擬使用者把第 3 張拖到第 1 張：檔案還叫 slide3.xml，只有 sldIdLst 的順序變了。
def reorder_pptx(src, dst):
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == 'ppt/presentation.xml':
                s = data.decode('utf-8')
                old = '<p:sldId id="256" r:id="rId4"/><p:sldId id="257" r:id="rId5"/><p:sldId id="258" r:id="rId6"/>'
                new = '<p:sldId id="258" r:id="rId6"/><p:sldId id="256" r:id="rId4"/><p:sldId id="257" r:id="rId5"/>'
                assert old in s, 'presentation.xml 的 sldIdLst 跟預期不同'
                data = s.replace(old, new).encode('utf-8')
            zi = zipfile.ZipInfo(info.filename, date_time=(2026, 9, 19, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zout.writestr(zi, data)


reorder_pptx(os.path.join(OUT, 'lecture.pptx'), os.path.join(OUT, 'lecture-reordered.pptx'))


# ---- 小型 zip bomb：宣稱 1 KB，實際解開 10 MB ----
def small_bomb(dst):
    payload = b'\0' * (10 * 1024 * 1024)
    comp = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = comp.compress(payload) + comp.flush()
    crc = zlib.crc32(payload) & 0xffffffff
    name = b'bomb.txt'
    declared = 1024
    local = struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0, 8, 0, 0x5321, crc, len(raw), declared, len(name), 0) + name
    central = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0, 8, 0, 0x5321, crc, len(raw), declared,
                          len(name), 0, 0, 0, 0, 0, 0) + name
    body = local + raw
    eocd = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, 1, 1, len(central), len(body), 0)
    with open(dst, 'wb') as f:
        f.write(body + central + eocd)


small_bomb(os.path.join(OUT, 'bomb-declared-1k.zip'))

print('ok', file=sys.stderr)
