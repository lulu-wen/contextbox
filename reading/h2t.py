#!/usr/bin/env python3
"""極簡 HTML -> 純文字：抓 <article>/<main> 主體，保留段落、標題、清單、程式碼。"""
import re, sys, html
from html.parser import HTMLParser

DROP = {"script","style","nav","footer","header","aside","noscript","svg","form","button"}
BLOCK = {"p","div","section","article","li","tr","blockquote","pre","br","hr",
         "h1","h2","h3","h4","h5","h6","ul","ol","table"}
HEAD = {"h1":"# ","h2":"## ","h3":"### ","h4":"#### ","h5":"##### ","h6":"###### "}

class T(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.pre, self.pending = [], 0, 0, ""
    def handle_starttag(self, tag, attrs):
        if tag in DROP: self.skip += 1; return
        if self.skip: return
        if tag == "pre": self.pre += 1
        if tag in BLOCK: self.out.append("\n")
        if tag in HEAD: self.pending = HEAD[tag]
        if tag == "li": self.pending = "- "
        if tag == "hr": self.out.append("\n---\n")
    def handle_endtag(self, tag):
        if tag in DROP: self.skip = max(0, self.skip-1); return
        if self.skip: return
        if tag == "pre": self.pre = max(0, self.pre-1)
        if tag in BLOCK: self.out.append("\n")
    def handle_data(self, d):
        if self.skip: return
        if not self.pre:
            d = re.sub(r"[ \t\r\f\v]+", " ", d)
            if not d.strip(): 
                if d: self.out.append(" ")
                return
        if self.pending:
            self.out.append(self.pending); self.pending = ""
        self.out.append(d)

def convert(raw):
    # 只留主要內容區塊，避免整頁導覽雜訊
    m = re.search(r"<article\b.*?</article>", raw, re.S|re.I) or \
        re.search(r"<main\b.*?</main>", raw, re.S|re.I)
    body = m.group(0) if m else raw
    p = T(); p.feed(body)
    txt = "".join(p.out)
    txt = re.sub(r"[ \t]+\n", "\n", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt)
    return txt.strip()

if __name__ == "__main__":
    raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
    sys.stdout.write(convert(raw) + "\n")
