# 開發期產生範例檔用（測試執行時不會跑這支）。
# 雙層 FlateDecode bomb：1 GiB 的空白壓一次（約 1 MB），再壓一次（約 2 KB）。
# PDF 裡用 /Filter [/FlateDecode /FlateDecode] 解，第二層會想解出 1 GiB。
# 用法：python3 make-bomb.py 輸出路徑
import sys
import zlib

co = zlib.compressobj(9)
chunk = b' ' * (16 << 20)
parts = [co.compress(chunk) for _ in range(64)]
parts.append(co.flush())
open(sys.argv[1], 'wb').write(zlib.compress(b''.join(parts), 9))
