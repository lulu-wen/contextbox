#!/bin/sh
# 開發期用：重新產生 test/fixtures/office-text/ 底下的範例檔與標準答案。
# 需要 soffice（LibreOffice）、pdftotext、python3、zip。測試執行時不依賴這些工具。
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(dirname "$HERE")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# 用獨立的 LibreOffice 設定檔，避免跟其他正在跑的 soffice 搶鎖
LO="soffice -env:UserInstallation=file://$TMP/profile --headless"

# 1. 用 LibreOffice 從我寫的 FODT／FODP 產生真的 docx／pptx
$LO --convert-to docx --outdir "$OUT" "$HERE/course-notes.fodt"
$LO --convert-to pptx --outdir "$OUT" "$HERE/lecture.fodp"

# 2. 純文字編碼範例、重新排序過的簡報、小型 zip bomb
python3 "$HERE/generate.py"
# 繁中 Excel 匯出的 CSV（CP950、大多是 ASCII）與它的 UTF-8 標準答案（第四輪）
python3 "$HERE/big5-csv.py"

# 3. 標準答案（docx）：同一份內容「接受所有修訂」後的版本，由 LibreOffice 匯出純文字
$LO --convert-to "txt:Text (encoded):UTF8" --outdir "$TMP" "$HERE/course-notes-accepted.fodt"
cp "$TMP/course-notes-accepted.txt" "$OUT/course-notes.expected.txt"

# 4. 標準答案（pptx）：LibreOffice 轉 PDF，再用 pdftotext 逐頁讀（頁與頁之間是換頁字元）
$LO --convert-to pdf --outdir "$TMP" "$OUT/lecture-reordered.pptx"
pdftotext -enc UTF-8 "$TMP/lecture-reordered.pdf" "$OUT/lecture-reordered.expected.txt"

# 5. 用 Info-ZIP 做的邊界檔
cd "$TMP"
printf 'hello secret' > hello.txt
rm -f "$OUT/encrypted.zip" "$OUT/encrypted.docx" "$OUT/data-descriptor.zip" "$OUT/zip64-stdin.zip"
# 傳統 PKWARE 加密（flag bit 0）
zip -q -X -P secret "$OUT/encrypted.zip" hello.txt
# 整份 docx 的每個 entry 都加密（不是 Office 的密碼保護，是 zip 層的加密）
mkdir docx && (cd docx && unzip -q "$OUT/course-notes.docx" && zip -q -X -r -P secret "$OUT/encrypted.docx" .)
# 輸出到管線：zip 沒辦法回頭改 local header，只好用 data descriptor（flag bit 3）
zip -q -X -fz- - hello.txt | cat > "$OUT/data-descriptor.zip"
# 從 stdin 讀：Info-ZIP 預設直接做成 ZIP64
printf 'zip64 from stdin' | zip -q -X "$OUT/zip64-stdin.zip" -
echo done
