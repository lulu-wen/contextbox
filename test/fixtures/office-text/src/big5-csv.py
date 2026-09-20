#!/usr/bin/env python3
# 開發期用：產生「繁中 Excel 匯出的 CSV」範例檔（第四輪：大多是 ASCII 的 Big5 檔）。
# 測試執行時不會跑這支，只讀它產生的兩個檔：
#   big5-sales.csv           CP950（繁中 Windows 的 Excel 存 CSV 的預設編碼），CRLF 換行
#   big5-sales.expected.txt  同一份內容的 UTF-8（標準答案：Python 的 cp950 編解碼器）
# 內容：表頭是中文，1,500 列數字與料號，約 1% 的列有兩個字的中文備註。ASCII 佔 95% 以上，
# 中文字平均每 1,000 byte 不到一個（第三輪的程式會把它當成夾零星壞 byte 的 UTF-8）。
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)  # test/fixtures/office-text

rand = random.Random(20260919)
REMARKS = ['急件', '退貨', '含運', '贈品', '補單']
lines = ['日期,品名,數量,單價,金額,備註']
for i in range(1500):
    day = 1 + i // 50
    qty = rand.randint(1, 200)
    price = rand.choice([12, 25, 35, 48, 60, 99, 120, 250])
    remark = rand.choice(REMARKS) if rand.random() < 0.01 else ''
    lines.append(f'2026-09-{day:02d},A-{rand.randint(1000, 9999)},{qty},{price},{qty * price},{remark}')
text = '\r\n'.join(lines) + '\r\n'

data = text.encode('cp950')
ascii_bytes = sum(1 for b in data if b < 0x80)
assert ascii_bytes / len(data) >= 0.95, ascii_bytes / len(data)
assert data.decode('cp950') == text

with open(os.path.join(OUT, 'big5-sales.csv'), 'wb') as f:
    f.write(data)
with open(os.path.join(OUT, 'big5-sales.expected.txt'), 'wb') as f:
    f.write(text.encode('utf-8'))
print(f'big5-sales.csv: {len(data)} byte，ASCII {ascii_bytes / len(data):.2%}，中文字 {sum(1 for c in text if ord(c) > 0x7f)} 個')
