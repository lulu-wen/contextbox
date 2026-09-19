#!/usr/bin/env bash
# 開發期重新產生 pdf-text 的範例檔與標準答案（測試執行時不會跑這支，也不依賴這些工具）。
# 需要：soffice（LibreOffice）、python3（PIL、reportlab、pycairo）、gs（Ghostscript）、pdftotext（poppler）。
# 用法：bash test/fixtures/pdf-text/make-fixtures.sh [暫存目錄]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="${1:-$(mktemp -d)}"
mkdir -p "$work"

# 1. LibreOffice Writer：四頁繁體中文講義（簡單字型＋1 byte 的 ToUnicode、代理對）
soffice -env:UserInstallation="file://$work/lo-profile" --headless \
  --convert-to pdf --outdir "$work" "$here/lecture.fodt" >/dev/null
cp "$work/lecture.pdf" "$here/lecture.pdf"

# 2. cairo：三頁，字型字典在 /ObjStm、xref 串流、Type0 + Identity-H
python3 "$here/make-cairo.py" "$here/cairo.pdf"

# 3. reportlab：不嵌入的 CID 字型，編碼是 /UniCNS-UCS2-H，沒有 ToUnicode
python3 "$here/make-reportlab.py" "$here/reportlab.pdf"

# 4. PIL：只有圖片的掃描版
python3 "$here/make-scan.py" "$here/scan.pdf"

# 5. reportlab：只設擁有者密碼、使用者密碼空白的加密 PDF
python3 "$here/make-encrypted.py" "$here/encrypted.pdf"

# 6. 雙層 FlateDecode bomb（解開是 1 GiB）
python3 "$here/make-bomb.py" "$here/bomb-1g.flate2"

# 7. Ghostscript 重轉的中文講義：LibreOffice 先把 HTML 轉成 PDF（超過 256 個不同漢字），
#    Ghostscript 再轉一次，四個 CJK 子集字型有兩個沒有 ToUnicode（字形名是 /cidNNNNN），
#    一部分字解不出來（測「解不出來的字形比例」這個訊號用）
soffice -env:UserInstallation="file://$work/lo-profile" --headless \
  --convert-to pdf:writer_web_pdf_Export --outdir "$work" "$here/ghostscript-cjk.html" >/dev/null
gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -o "$here/ghostscript-cjk.pdf" "$work/ghostscript-cjk.pdf"

# 標準答案：pdftotext 讀一次存起來（測試只比對去掉空白之後的字）
pdftotext -enc UTF-8 -f 1 -l 3 "$here/lecture.pdf" "$here/lecture.p1-3.txt"
pdftotext -enc UTF-8 "$here/lecture.pdf" "$here/lecture.all.txt"
pdftotext -enc UTF-8 "$here/cairo.pdf" "$here/cairo.all.txt"
pdftotext -enc UTF-8 "$here/reportlab.pdf" "$here/reportlab.all.txt"
