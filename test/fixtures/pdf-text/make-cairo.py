# 開發期產生範例檔用（測試執行時不會跑這支）。
# 用 cairo 畫三頁含繁體中文的講義，輸出 cairo.pdf。
# cairo 1.18 會把字型字典放進 /ObjStm，中文字型是 Type0（CIDFontType2）+ Identity-H + 2 byte 的 ToUnicode。
# 用法：python3 make-cairo.py 輸出路徑
import sys
import cairo

out = sys.argv[1]
surface = cairo.PDFSurface(out, 595, 842)
ctx = cairo.Context(surface)

pages = [
    [
        ('AR PL UKai TW', 22, '作業系統 第五週 行程排班'),
        ('AR PL UMing TW', 13, '先來先服務（FCFS）最簡單，但短工作可能被長工作卡住。'),
        ('AR PL UMing TW', 13, '最短工作優先（SJF）平均等待時間最小，需要預估執行時間。'),
        ('DejaVu Sans', 12, 'Round Robin: each process gets a time quantum q = 20 ms.'),
    ],
    [
        ('AR PL UKai TW', 18, '第二節 優先權與飢餓'),
        ('AR PL UMing TW', 13, '優先權排班可能讓低優先權的行程永遠等不到 CPU，稱為飢餓。'),
        ('AR PL UMing TW', 13, '解法：老化（aging），等得越久優先權越高。'),
    ],
    [
        ('AR PL UKai TW', 18, '第三節 練習題'),
        ('AR PL UMing TW', 13, '請計算下表五個行程在 RR（q=4）下的平均周轉時間。'),
        ('DejaVu Serif', 12, 'Deadline: Friday 23:59, submit via the course website.'),
    ],
]

for lines in pages:
    y = 80
    for family, size, text in lines:
        ctx.select_font_face(family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(size)
        ctx.move_to(60, y)
        ctx.show_text(text)
        y += size * 2.2
    ctx.show_page()

surface.finish()
