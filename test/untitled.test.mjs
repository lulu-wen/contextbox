import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { classifyName, isTempName, UntitledError, MAX_NAME_INPUT_LENGTH } from '../core/untitled.ts'

// 期望值抄自實作前寫死的預想表（untitled.ts 那一節），不是從實作抄回來的。
// 名字與答案都是寫死的期望值，不可以改。
// 第三欄是理由裡一定要出現的關鍵字（表上「理由」欄有寫的才檢查）。
const TABLE = [
  // 未命名
  ['Untitled.pdf', 'untitled', /未命名/],
  ['untitled (2).docx', 'untitled', /未命名/],
  ['Untitled-1.png', 'untitled', /未命名/],
  ['未命名.docx', 'untitled', /未命名/],
  ['未命名文件 (3).docx', 'untitled', /未命名/],
  ['無標題.pdf', 'untitled', /未命名/],
  // Windows 右鍵新增
  ['新增 Microsoft Word 文件.docx', 'untitled', /Windows 右鍵新增/],
  ['新增 Microsoft Word 文件 (2).docx', 'untitled', /Windows 右鍵新增/],
  ['新增文字文件.txt', 'untitled', /Windows 右鍵新增/],
  // Office
  ['Document1.docx', 'untitled', null],
  ['Document (3).pdf', 'untitled', null],
  ['文件1.docx', 'untitled', null],
  ['Book1.xlsx', 'untitled', /Office/],
  ['活頁簿1.xlsx', 'untitled', /Office/],
  ['Presentation1.pptx', 'untitled', /Office/],
  ['簡報1.pptx', 'untitled', /Office/],
  // 相機
  ['IMG_2041.png', 'untitled', /相機/],
  ['IMG_20260917_141203.jpg', 'untitled', /相機/],
  ['DSC01234.JPG', 'untitled', /相機/],
  ['PXL_20260917_031415926.jpg', 'untitled', /相機/],
  // 截圖
  ['Screenshot 2026-09-19 141203.png', 'untitled', /截圖/],
  ['螢幕擷取畫面 2026-09-19 141203.png', 'untitled', /截圖/],
  ['截圖 2026-09-19 下午2.12.03.png', 'untitled', /截圖/],
  // 掃描器
  ['scan0003.pdf', 'untitled', /掃描/],
  ['掃描_20260917.pdf', 'untitled', /掃描/],
  // 瀏覽器
  ['download.pdf', 'untitled', /瀏覽器/],
  ['download (3).pdf', 'untitled', /瀏覽器/],
  ['file.pdf', 'untitled', /瀏覽器/],
  ['file (2).pdf', 'untitled', /瀏覽器/],
  ['image.png', 'untitled', /瀏覽器/],
  ['image (4).png', 'untitled', /瀏覽器/],
  // LINE
  ['LINE_ALBUM_2026917_260917_1.jpg', 'untitled', /LINE/],
  ['messageImage_1726540000000.jpg', 'untitled', /LINE/],
  // 雜湊、UUID
  ['a1b2c3d4e5f6a7b8c9d0.pdf', 'untitled', /雜湊|UUID/],
  ['3f2504e0-4f89-11d3-9a0c-0305e82c3301.pdf', 'untitled', /雜湊|UUID/],
  // 只有數字
  ['20260917.pdf', 'untitled', /數字/],
  ['1726540000.pdf', 'untitled', /數字/],
  // NFKC 之後一樣
  ['Untitled（2）.pdf', 'untitled', /未命名/],
  // 副本也是
  ['IMG_2041 (1).png', 'untitled', /相機/],
  // 一個籠統的字
  ['report.pdf', 'generic', /籠統/],
  ['final.pdf', 'generic', /籠統/],
  ['final_v2.docx', 'generic', /籠統/],
  ['notes.txt', 'generic', /籠統/],
  ['筆記.docx', 'generic', /籠統/],
  ['講義.pdf', 'generic', /籠統/],
  ['作業.pdf', 'generic', /籠統/],
  ['lecture.pptx', 'generic', /籠統/],
  ['HW.pdf', 'generic', /籠統/],
  ['test.pdf', 'generic', /籠統/],
  // 有可以辨認的資訊
  ['資料結構 第3週 講義.pdf', 'named', null],
  ['lecture3.pptx', 'named', null],
  ['HW3.pdf', 'named', null],
  ['hw3 (1).pdf', 'named', null],
  ['期中考範圍.docx', 'named', null],
  ['王小明-履歷.pdf', 'named', null],
]

function check(name, state, reasonRe) {
  const got = classifyName(name)
  assert.equal(got.state, state, `${JSON.stringify(name)} 應該是 ${state}，實際是 ${got.state}（${got.reason}）`)
  assert.equal(typeof got.reason, 'string')
  assert.ok(got.reason.length > 0, `${JSON.stringify(name)} 的 reason 不可以是空的`)
  if (reasonRe) assert.match(got.reason, reasonRe, `${JSON.stringify(name)} 的理由「${got.reason}」`)
  assert.deepEqual(Object.keys(got).sort(), ['reason', 'state'])
}

describe('classifyName：預想表（寫死的期望值）', () => {
  for (const [name, state, reasonRe] of TABLE) {
    test(`${name} → ${state}`, () => check(name, state, reasonRe))
  }
})

describe('classifyName：成對的邊界', () => {
  test('lecture.pptx（generic）vs lecture3.pptx（named）', () => {
    check('lecture.pptx', 'generic')
    check('lecture3.pptx', 'named')
  })
  test('HW.pdf（generic）vs HW3.pdf（named）', () => {
    check('HW.pdf', 'generic')
    check('HW3.pdf', 'named')
  })
  test('Document1.docx（untitled）vs Document-資料結構.docx（named）', () => {
    check('Document1.docx', 'untitled')
    check('Document-資料結構.docx', 'named')
  })
})

describe('classifyName：表上沒列、我判斷的例子', () => {
  test('Mac 的截圖名（舊版 Screen Shot、新版 Screenshot、PM 前面是窄不換行空白）', () => {
    check('Screen Shot 2026-09-19 at 2.12.03 PM.png', 'untitled', /截圖/)
    check('Screenshot 2026-09-19 at 2.12.03\u202fPM.png', 'untitled', /截圖/)
    check('Screenshot 2026-09-19 at 2.12.03 PM (2).png', 'untitled', /截圖/)
  })

  test('沒有副檔名的截圖名：最後一個點後面是「03 PM」，不可以當成副檔名切掉', () => {
    check('Screen Shot 2026-09-19 at 2.12.03 PM', 'untitled', /截圖/)
    check('截圖 2026-09-19 下午2.12.03', 'untitled', /截圖/)
  })

  test('Android 與 Windows 的截圖名', () => {
    check('Screenshot_20260917-141203.png', 'untitled', /截圖/)
    check('Screenshot_20260917-141203_Chrome.jpg', 'untitled', /截圖/)
    check('Screenshot (12).png', 'untitled', /截圖/)
    check('螢幕擷取畫面 (3).png', 'untitled', /截圖/)
  })

  test('截圖名後面加了使用者自己的字就是 named', () => {
    check('Screenshot 資料結構 作業.png', 'named')
    check('截圖 2026-09-19 期中考範圍.png', 'named')
  })

  test('iPhone 編輯過的照片 IMG_E2041', () => {
    check('IMG_E2041.JPG', 'untitled', /相機/)
    check('IMG_E2041 (1).JPG', 'untitled', /相機/)
  })

  test('相機名後面加了使用者自己的字就是 named', () => {
    check('IMG_2041_資料結構.png', 'named')
    check('IMG_2041 王小明.jpg', 'named')
  })

  test('WhatsApp 存下來的圖（含新版的 8 碼 hex 尾巴、Android 的 WA 編號）', () => {
    check('WhatsApp Image 2026-09-17 at 14.12.03.jpeg', 'untitled', /通訊軟體/)
    check('WhatsApp Image 2026-09-17 at 14.12.03 (1).jpeg', 'untitled', /通訊軟體/)
    check('WhatsApp Image 2026-09-17 at 14.12.03_a1b2c3d4.jpeg', 'untitled', /通訊軟體/)
    check('WhatsApp Video 2026-09-17 at 14.12.03.mp4', 'untitled', /通訊軟體/)
    check('IMG-20260917-WA0001.jpg', 'untitled', /通訊軟體/)
  })

  test('通訊軟體前綴後面一定要有時間，光是「whatsapp」不算沒取名', () => {
    check('WhatsApp.pdf', 'named')
    check('WhatsApp Image 資料結構.jpeg', 'named')
  })

  test('LINE 相簿名是人取的（不是日期）就是 named', () => {
    check('LINE_ALBUM_畢業旅行_260917_1.jpg', 'named')
  })

  test('Word 開檔時的暫存鎖定檔 ~$ 不是取名問題：不建議改名（named），理由要講清楚', () => {
    check('~$報告.docx', 'named', /暫存/)
    check('~$未命名.docx', 'named', /暫存/)
    check('~$cument1.docx', 'named', /暫存/)
    check('.~lock.期末報告.docx#', 'named', /暫存/)
    check('._IMG_2041.png', 'named', /暫存/)
  })

  test('名字前後有空白：去掉之後再判斷', () => {
    check('  Untitled  .pdf', 'untitled', /未命名/)
    check('\u3000IMG_2041\u3000.png', 'untitled', /相機/)
    check('  report .pdf', 'generic')
    check(' 王小明-履歷 .pdf', 'named')
    check('report.pdf   ', 'generic')
  })

  test('只有符號：沒有任何文字或數字，當成沒取名', () => {
    check('___.pdf', 'untitled', /符號/)
    check('!!!.png', 'untitled', /符號/)
    check('-.txt', 'untitled', /符號/)
  })

  test('只有表情符號：是人打的，但看不出內容 → generic', () => {
    check('🎉.png', 'generic')
    check('❤️❤️.jpg', 'generic')
  })

  test('空字串與只有空白、只有副檔名：沒有檔名', () => {
    check('', 'untitled', /空/)
    check('   ', 'untitled', /空/)
    check(' .pdf', 'untitled', /空/)
    check('.pdf', 'untitled', /空/)
  })

  test('一般的點開頭檔（不是副檔名）當成有名字', () => {
    check('.bashrc', 'named')
  })

  test('不分大小寫、全形英數字（NFKC）', () => {
    check('UNTITLED.PDF', 'untitled')
    check('img_2041.png', 'untitled')
    check('ＩＭＧ＿２０４１.png', 'untitled', /相機/)
    check('文件１.docx', 'untitled')
    check('ＨＷ３.pdf', 'named')
    check('ＨＷ.pdf', 'generic')
  })

  test('看不見的字元（零寬、雙向控制字元）不影響判斷', () => {
    check('Untitled\u200b.pdf', 'untitled')
    check('IMG\u200d_2041.png', 'untitled')
    check('\u202eUntitled.pdf', 'untitled')
  })

  test('各種作業系統的副本字尾', () => {
    check('IMG_2041 copy.png', 'untitled', /相機/)
    check('IMG_2041 copy 2.png', 'untitled', /相機/)
    check('IMG_2041 - Copy.png', 'untitled', /相機/)
    check('IMG_2041 - Copy (2).png', 'untitled', /相機/)
    check('IMG_2041 - 複製.png', 'untitled', /相機/)
    check('IMG_2041 - 複製 (2).png', 'untitled', /相機/)
    check('IMG_2041 拷貝.png', 'untitled', /相機/)
    check('IMG_2041 拷貝 2.png', 'untitled', /相機/)
    check('report - Copy.pdf', 'generic')
    check('資料結構 - 複製.pdf', 'named')
  })

  test('Google 雲端硬碟的「Copy of …」前綴、「… 的副本」字尾', () => {
    check('Copy of Untitled document.docx', 'untitled', /未命名/)
    check('Copy of Copy of IMG_2041.png', 'untitled', /相機/)
    check('Copy of report.pdf', 'generic')
    check('Copy of 資料結構.pdf', 'named')
    check('未命名文件 的副本.docx', 'untitled', /未命名/)
    check('copy of.pdf', 'named')
  })

  test('螢幕錄影、舊版剪取工具、Snipaste 也是只有時間的預設名', () => {
    check('Screen Recording 2026-09-19 at 2.12.03 PM.mov', 'untitled', /截圖|錄影/)
    check('螢幕錄影 2026-09-19 下午2.12.03.mov', 'untitled', /截圖|錄影/)
    check('Capture.PNG', 'untitled', /截圖/)
    check('Snipaste_2026-09-19_14-12-03.png', 'untitled', /截圖/)
    check('capture the flag 解題.pdf', 'named')
  })

  test('其他程式的未命名：Untitled Diagram；Mac 存檔撞名的「IMG_1234 2」', () => {
    check('Untitled Diagram.drawio', 'untitled', /未命名/)
    check('IMG_1234 2.jpg', 'untitled', /相機/)
    check('IMG_1234 2 資料結構.jpg', 'named')
  })

  test('副本字尾一定要跟前面分開；黏在一起的是字的一部分', () => {
    check('IMG_2041copy.png', 'named')
    check('IMG_2041 copy.png', 'untitled')
  })

  test('只有 (1) 這種編號：不可以把整個名字當副本字尾吃光', () => {
    check('(1).pdf', 'untitled', /數字/)
  })

  test('數字接在籠統字後面是 named；括號編號是副本；空白隔開的數字也是 named', () => {
    check('lecture 3.pptx', 'named')
    check('lecture_3.pptx', 'named')
    check('HW (1).pdf', 'generic')
    check('作業1.pdf', 'named')
    check('作業 (1).pdf', 'generic')
  })

  test('籠統的字組合起來還是籠統；有一個具體的字就是 named', () => {
    check('final report.pdf', 'generic')
    check('期末報告.docx', 'named') // 跟表上的「期中考範圍 → named」一致：期中／期末是可以辨認的資訊
    check('報告_最終版.docx', 'generic')
    check('report_final_v2.1.docx', 'generic')
    check('資料結構報告.docx', 'named')
    check('期中考範圍.docx', 'named')
  })

  test('只有版本號', () => {
    check('v2.pdf', 'generic')
  })

  test('Office 預設字不帶數字：Document 是（表上 Document (3) 是 untitled），Book／Presentation 只算籠統', () => {
    check('Document.docx', 'untitled')
    check('Book.pdf', 'generic')
    check('Presentation.pptx', 'generic')
    check('簡報.pptx', 'generic')
  })

  test('Office 預設名只認「字＋數字」這個固定形式', () => {
    check('Book 1.pdf', 'named')
    check('Presentation-期末.pptx', 'named')
  })

  test('雜湊長度邊界：16 個 hex 以上才算', () => {
    check('a1b2c3d4e5f6a7b8.pdf', 'untitled', /雜湊/)
    check('a1b2c3d4e5f6a7b.pdf', 'named')
  })

  test('只有數字與分隔符號（日期、時間）', () => {
    check('2026-09-17 14.12.03.png', 'untitled', /數字/)
    check('112-1.pdf', 'untitled', /數字/)
  })

  test('雙重副檔名：下載中斷的檔、tar.gz', () => {
    check('Untitled.pdf.crdownload', 'untitled')
    check('IMG_2041.jpg.part', 'untitled', /相機/)
    check('report.final.pdf', 'generic')
  })

  test('副檔名只切一段，而且一定要有英文字母', () => {
    check('hw3.1', 'named')
    check('3.14.pdf', 'untitled', /數字/)
  })

  test('點後面是中文不是副檔名：不可以把使用者的字當副檔名切掉', () => {
    check('Untitled.資料結構', 'named')
    check('IMG_2041.王小明', 'named')
    check('report.資料結構', 'named')
  })

  test('截圖、掃描、通訊軟體前綴後面接英文字也是 named（不是只有中文）', () => {
    check('Screenshot of the error message.png', 'named')
    check('Screenshot 2026-09-19 login bug.png', 'named')
    check('capture the flag.pdf', 'named')
    check('Scan receipt.pdf', 'named')
    check('WhatsApp Image 2026-09-17 from mom.jpeg', 'named')
  })

  test('傳進來的是路徑時只看最後一段', () => {
    check('/tmp/x/Untitled.pdf', 'untitled')
    check('C:\\Users\\me\\IMG_2041.png', 'untitled', /相機/)
    check('/tmp/未命名/資料結構.pdf', 'named')
  })

  test('其他相機與掃描器', () => {
    check('DSCN0001.JPG', 'untitled', /相機/)
    check('_DSC1234.ARW', 'untitled', /相機/)
    check('Scan.jpeg', 'untitled', /掃描/)
    check('Scan 2.jpeg', 'untitled', /掃描/)
    check('Scanned Document.pdf', 'untitled', /掃描/)
  })

  test('常見 App 預設字不能太寬：有內容的字不可以被當成沒取名', () => {
    check('signal.pdf', 'named')
    check('filesystem.pdf', 'named')
    check('imagenet.pdf', 'named')
    check('download-資料結構.pdf', 'named')
    check('Untitled essay 王小明.docx', 'named')
    check('scanner 原理.pdf', 'named')
  })

  test('回傳值是新的物件，改它不會影響下一次', () => {
    const a = classifyName('Untitled.pdf')
    a.state = 'named'
    assert.equal(classifyName('Untitled.pdf').state, 'untitled')
  })
})

// 第二輪：對抗式驗證找到的問題。每一條都先寫成測試（當時是紅的）再修。
// 原則：拿不準就判 generic 或 named；untitled 只給「確定是系統或相機給的名字」。
describe('classifyName：第二輪（對抗式驗證的發現）', () => {
  // confirmed：Android 截圖名後面接任何英數字都被當成 App 名
  test('Android 截圖名後面接的是使用者的字（不是 App 名）→ named', () => {
    check('Screenshot_20260919-141203_midterm.png', 'named')
    check('Screenshot_20260919-141203_hw3.png', 'named')
    check('Screenshot_20260919-141203_bug.report.png', 'named')
    check('Screenshot_20260919_141203_final.png', 'named')
    check('Screenshot_20260919-141203_May.png', 'named')
    check('Screenshot_20260919-141203_資料結構.png', 'named')
  })

  test('Android 截圖名後面是系統加的 App 名或套件名 → untitled', () => {
    check('Screenshot_20260919-141203_Chrome.jpg', 'untitled', /截圖/)
    check('Screenshot_20260919-141203_LINE.jpg', 'untitled', /截圖/)
    check('Screenshot_20260919-141203_Samsung Internet.jpg', 'untitled', /截圖/)
    check('Screenshot_20260919_141203_com.android.chrome.jpg', 'untitled', /截圖/)
    check('Screenshot_20260919-141203_jp.naver.line.android.jpg', 'untitled', /截圖/)
    // 小米：日期時間用連字號、後面還有毫秒
    check('Screenshot_2026-09-19-14-12-03-123_com.android.chrome.jpg', 'untitled', /截圖/)
    // 套件名的第一段一定要像網域（com、org、jp……），「bug.report」不是
    check('Screenshot_20260919-141203_com.whatsapp.jpg', 'untitled', /截圖/)
  })

  // minor：通訊軟體與 LINE 的前綴後面只要一個數字就算 untitled
  test('通訊軟體、LINE 的前綴後面只有一兩個數字，不是時間 → named', () => {
    check('Signal-3.pdf', 'named')
    check('telegram 1.pdf', 'named')
    check('Line_1.pdf', 'named')
    check('photo_3.jpg', 'named')
    check('video_2.mp4', 'named')
    check('photo_may 2.jpg', 'named')
    check('photo_may.jpg', 'named')
  })

  test('截圖前綴後面只有月份字或時間字、沒有真的時間 → named', () => {
    check('Screenshot May.png', 'named')
    check('Screenshot 2026-09-19 May.png', 'named')
    check('Screenshot at.png', 'named')
    check('Scan May.pdf', 'named')
  })

  test('真的通訊軟體、LINE、掃描 App 的預設名（帶完整日期）還是 untitled', () => {
    check('signal-2026-09-17-141203.jpg', 'untitled', /通訊軟體/)
    check('photo_2026-09-17_14-12-03.jpg', 'untitled', /通訊軟體/)
    check('video_2026-09-17_14-12-03.mp4', 'untitled', /通訊軟體/)
    check('LINE_P20260917_141203.jpg', 'untitled', /LINE/)
    check('line_1726540000000.jpg', 'untitled', /LINE/)
    check('messageImage_12.jpg', 'named') // LINE 的是 13 位數的毫秒時間，太短不算
    check('Adobe Scan Sep 17, 2026.pdf', 'untitled', /掃描/)
    check('Adobe Scan 17 Sep 2026 (1).pdf', 'untitled', /掃描/)
  })

  // minor：測試缺口（驗證者植入後活下來的突變）
  test('相機名後面接英文字：只有 Android／Pixel 固定的幾個尾巴才算，iPhone 短編號後面接字是 named', () => {
    check('IMG_2041_midterm.jpg', 'named')
    check('IMG_2041_night.jpg', 'named')
    check('IMG_2041_cover.jpg', 'named')
    check('IMG_20260917_141203_midterm.jpg', 'named')
    check('IMG_20260917_141203_HDR.jpg', 'untitled', /相機/)
    check('IMG_20260917_141203_BURST001.jpg', 'untitled', /相機/)
    check('PXL_20260917_031415926.PORTRAIT.jpg', 'untitled', /相機/)
    check('PXL_20260917_031415926.MP.jpg', 'untitled', /相機/)
    check('PXL_20260917_031415926~2.jpg', 'untitled', /相機/)
    check('IMG_2041-edited.jpg', 'untitled', /相機/)
    check('DSC01234 2.JPG', 'untitled', /相機/)
  })

  test('中文版本號也是籠統的', () => {
    check('講義 第2版.pdf', 'generic')
    check('報告_版本2.docx', 'generic')
    check('講義第二版.pdf', 'generic')
    check('講義 2版.pdf', 'generic')
  })

  test('中間有兩個空白：合併成一個再比', () => {
    check('Untitled  2.pdf', 'untitled', /未命名/)
    check('新增  Microsoft Word 文件.docx', 'untitled', /Windows 右鍵新增/)
  })

  test('系統自動產生的檔（Thumbs.db、desktop.ini、.DS_Store）也是暫存，不建議改名', () => {
    check('Thumbs.db', 'named', /暫存/)
    check('desktop.ini', 'named', /暫存/)
    check('.DS_Store', 'named', /暫存/)
  })

  test('簡中 Windows 右鍵新增的預設名', () => {
    check('新建 Microsoft Word 文档.docx', 'untitled', /Windows 右鍵新增/)
    check('新建文本文档.txt', 'untitled', /Windows 右鍵新增/)
  })

  test('Facebook、Messenger、WeChat 存下來的預設名', () => {
    check('FB_IMG_1726540000000.jpg', 'untitled', /通訊軟體/)
    check('received_1234567890123.jpeg', 'untitled', /通訊軟體/)
    check('mmexport1726540000000.jpg', 'untitled', /通訊軟體/)
    check('微信图片_20260917141203.jpg', 'untitled', /通訊軟體/)
  })

  test('scanner 不是掃描器的預設名（前綴只認 scan、scanned）', () => {
    check('scanner.pdf', 'named')
    check('Scanner 2.pdf', 'named')
  })

  test('籠統字的段數上限：8 段以內是 generic，超過 8 段直接當 named（不再往下比）', () => {
    check('report final draft notes old new copy v2.pdf', 'generic')
    check('report final draft notes old new copy v2 報告.pdf', 'named')
  })

  test('簡中的籠統字', () => {
    check('报告.pdf', 'generic')
    check('笔记.docx', 'generic')
  })

  test('副本字尾後面接的不是 Mac 的「空白＋數字」就不剝', () => {
    check('IMG_2041 copy_2.png', 'named')
  })

  // minor：暫存鎖定檔要能用程式判斷
  test('isTempName：暫存鎖定檔可以用程式判斷，不用去比對中文理由', () => {
    for (const n of [
      '~$報告.docx', '.~lock.期末報告.docx#', '._IMG_2041.png', 'Thumbs.db', 'desktop.ini', '.DS_Store',
      '/Users/me/Desktop/~$報告.docx', 'C:\\Users\\me\\~$cument1.docx', ' ~$報告.docx', 'THUMBS.DB',
    ]) {
      assert.equal(isTempName(n), true, n)
      assert.equal(classifyName(n).state, 'named', n)
    }
    for (const n of ['報告.docx', 'Untitled.pdf', '$報告.docx', 'a~$b.docx', '.bashrc', '', 'thumbs.db.pdf']) {
      assert.equal(isTempName(n), false, n)
    }
    assert.throws(() => isTempName(42), err => err instanceof UntitledError && err.code === 'INVALID_INPUT')
    assert.throws(
      () => isTempName('a'.repeat(MAX_NAME_INPUT_LENGTH + 1)),
      err => err instanceof UntitledError && err.code === 'TOO_LONG',
    )
  })

  // nit：沒有副檔名的檔，最後一個點後面的英文字被當成副檔名切掉
  test('點後面是英文字、不是常見副檔名：切掉會判成沒取名的話就不切', () => {
    check('Untitled.Algebra', 'named')
    check('IMG_2041.Tokyo', 'named')
    check('Scan.Receipt', 'named')
    check('20260917.Tokyo', 'named')
    check('IMG_2041.jpg.Tokyo', 'named')
    // 真的副檔名照樣切
    check('Untitled.ipynb', 'untitled', /未命名/)
    check('Untitled Diagram.drawio', 'untitled', /未命名/)
    check('Untitled.psd', 'untitled', /未命名/)
    check('IMG_2041.HEIC', 'untitled', /相機/)
    check('Screenshot 2026-09-19 at 2.12.03PM', 'untitled', /截圖/)
  })

  // nit：前面有空白，點開頭的檔名認不出來
  test('前後空白不影響判斷（點開頭的檔也一樣）', () => {
    check(' .bashrc', 'named')
    check('\u3000.env', 'named')
    for (const [name] of TABLE) {
      assert.equal(classifyName(`  ${name}\u3000`).state, classifyName(name).state, JSON.stringify(name))
    }
  })

  // nit：結尾的分隔符號只有接副本字尾時才會去掉
  test('加一個 (1) 不會改變判斷（結尾的分隔符號不因為副本字尾而被吃掉）', () => {
    const pairs = [
      ['download_.pdf', 'download_ (1).pdf'],
      ['Document-.pdf', 'Document- (1).pdf'],
      ['IMG_2041_.jpg', 'IMG_2041_ (1).jpg'],
      ['Untitled_.pdf', 'Untitled_ (1).pdf'],
      ['download_.pdf', 'download_ - Copy.pdf'],
      ['IMG_2041_.jpg', 'IMG_2041_ copy.jpg'],
    ]
    for (const [a, b] of pairs) {
      assert.equal(classifyName(b).state, classifyName(a).state, `${a} vs ${b}`)
    }
    for (const [name] of TABLE) {
      const dot = name.lastIndexOf('.')
      const withCopy = `${name.slice(0, dot)} (1)${name.slice(dot)}`
      assert.equal(classifyName(withCopy).state, classifyName(name).state, `${name} vs ${withCopy}`)
    }
  })

  // nit：系統預設名漏認
  test('補認的預設名：LINE 的 S__、GNOME 截圖、語音備忘錄、Zoom 錄影', () => {
    check('S__12345678.jpg', 'untitled', /LINE/)
    check('S__12345678_0.jpg', 'untitled', /LINE/)
    check('Screenshot from 2026-09-19 14-12-03.png', 'untitled', /截圖/)
    check('New Recording 3.m4a', 'untitled', /錄音/)
    check('新錄音 3.m4a', 'untitled', /錄音/)
    check('GMT20260919-061203_Recording_1920x1080.mp4', 'untitled', /錄/)
    check('Screenshot from mom.png', 'named')
    // 「from」只在 GNOME 的「Screenshot from」前綴裡算，不是隨處都能接的時間字
    check('Screenshot 2026-09-19 141203 from.png', 'named')
    check('WhatsApp Image 2026-09-17 at 14.12.03 from.jpeg', 'named')
  })

  test('副本字尾剝完只剩分隔符號，就等於剝光，保持原樣', () => {
    check('- 複製.pdf', 'generic')
    check('_ - Copy.pdf', 'generic')
  })

  test('Mac 撞名的「X 2」：只有 X 本身是程式固定產生的序列才認，一般英文字接數字是 named', () => {
    check('Untitled 2.pdf', 'untitled', /未命名/)
    check('IMG_2041 2.jpg', 'untitled', /相機/)
    check('Scan 2.pdf', 'untitled', /掃描/)
    // image 2（第 2 張圖）、file 2、download 2、Document 2 可能是使用者自己打的，跟 lecture 3 一樣
    check('Document 2.docx', 'named')
    check('download 2.pdf', 'named')
    check('image 2.png', 'named')
    check('file 2.pdf', 'named')
  })

  test('可能是作品名的「無題」「Unknown」：拿不準，交給模型（generic），不判成沒取名', () => {
    check('無題.docx', 'generic')
    check('Unknown.mp3', 'generic')
    check('無題詩.docx', 'named')
  })
})

// 第三輪：第二輪驗證的發現。每一條都先寫成測試（當時是紅的）再修。
describe('classifyName：第三輪（第二輪驗證的發現）', () => {
  const SHOT = 'Screenshot_20260919-141203_'

  // confirmed：套件名的規則會把使用者用點連起來的字吞掉
  test('Android 截圖名後面用點連起來的是使用者的字，不是套件名 → named', () => {
    for (const w of [
      'us.history', 'app.bug', 'me.and.mom', 'io.lab3', 'tv.show', 'co.op', 'de.hw2', 'net.worth',
      'net.income.q3', 'org.chart', 'org.chart.draft', 'jp.trip.day1', 'tw.news.hw3', 'kr.drama.ep3',
      'cn.history.notes', 'app.bug.fix.v2',
    ]) {
      check(`${SHOT}${w}.png`, 'named')
    }
  })

  test('套件名一定要有點：只有頂層網域一段 → named', () => {
    check(`${SHOT}com.png`, 'named')
    check(`${SHOT}me.png`, 'named')
    check(`${SHOT}org.png`, 'named')
  })

  test('一般英文字接在常見的套件開頭後面，兩段、三段都不是套件名（只有 com 開頭的才看形狀）', () => {
    const words = [
      'and', 'mom', 'history', 'bug', 'lab', 'show', 'op', 'trip', 'notes', 'report', 'draft', 'midterm',
      'hw2', 'week3', 'photo', 'android', 'app', 'google', 'chrome', 'line',
    ]
    for (const tld of ['me', 'us', 'app', 'io', 'tv', 'co', 'de', 'net', 'org', 'jp', 'tw', 'cn', 'kr']) {
      for (const a of words) {
        assert.equal(classifyName(`${SHOT}${tld}.${a}.png`).state, 'named', `${tld}.${a}`)
        for (const b of words) {
          assert.equal(classifyName(`${SHOT}${tld}.${a}.${b}.png`).state, 'named', `${tld}.${a}.${b}`)
        }
      }
    }
  })

  test('com 開頭的套件名：至少兩個點，每段都是合法的識別字（英文字母開頭、不是 Java 保留字）', () => {
    check(`${SHOT}com.hw3.png`, 'named') // 只有一個點
    check(`${SHOT}com.hw.2026.png`, 'named') // 數字開頭的段
    check(`${SHOT}com.new.final.png`, 'named') // Java 保留字
    check(`${SHOT}com.do.not.share.png`, 'named') // Java 保留字
    check(`${SHOT}com..chrome.png`, 'named') // 空的段
    check(`${SHOT}com.my-app.x.png`, 'named') // 連字號
    check(`${SHOT}com.a.b.c.d.e.f.g.h.png`, 'named') // 太多段
    check(`${SHOT}com.android.chrome.jpg`, 'untitled', /截圖/)
    check(`${SHOT}com.google.android.apps.photos.jpg`, 'untitled', /截圖/)
  })

  test('真的套件名還是 untitled（com 以外的開頭只認寫死的清單）', () => {
    for (const p of [
      'com.android.chrome', 'com.google.android.youtube', 'com.instagram.android', 'com.tencent.mm',
      'com.sec.android.gallery3d', 'com.ss.android.ugc.trill', 'com.whatsapp', 'com.discord',
      'jp.naver.line.android', 'org.telegram.messenger', 'org.mozilla.firefox', 'tv.twitch.android.app',
      'tv.danmaku.bili', 'us.zoom.videomeetings', 'cn.wps.moffice_eng',
    ]) {
      check(`${SHOT}${p}.jpg`, 'untitled', /截圖/)
    }
  })

  // minor：新規則的數字門檻與防護沒有測試鎖住
  test('截圖、掃描前綴後面有時間字時，數字門檻是 4 個（3 個不算、4 個算）', () => {
    check('Screenshot at 3.png', 'named')
    check('截圖 下午 3.png', 'named')
    check('Adobe Scan May 2.pdf', 'named')
    check('Screenshot at 2.03.png', 'named') // 3 個數字
    check('截圖 下午2.03.png', 'named') // 3 個數字
    check('Screenshot at 12.03.png', 'untitled', /截圖/) // 4 個數字
    check('截圖 下午12.03.png', 'untitled', /截圖/) // 4 個數字
    check('Adobe Scan Sep 1, 26.pdf', 'named') // 3 個數字
    check('Adobe Scan Sep 12, 26.pdf', 'untitled', /掃描/) // 4 個數字
  })

  test('通訊軟體前綴後面要有完整的日期（8 個數字）：7 個不算、8 個算', () => {
    check('signal-2026-9-17.jpg', 'named')
    check('photo_2026-9-17.jpg', 'named')
    check('WhatsApp Image 2026-9-17.jpeg', 'named')
    check('signal-2026-09-17.jpg', 'untitled', /通訊軟體/)
    check('photo_2026-09-17.jpg', 'untitled', /通訊軟體/)
    check('WhatsApp Image 2026-09-17.jpeg', 'untitled', /通訊軟體/)
  })

  test('LINE 的數字門檻：LINE_、messageImage_、S__ 後面都要 6 個數字（5 個不算）', () => {
    check('Line_12345.jpg', 'named')
    check('LINE_26091_1.jpg', 'named')
    check('LINE_260917_1.jpg', 'untitled', /LINE/)
    check('LINE_P260917.jpg', 'untitled', /LINE/)
    check('messageImage_12345.jpg', 'named')
    check('messageImage_123456.jpg', 'untitled', /LINE/)
    check('S__12.jpg', 'named')
    check('S__12345.jpg', 'named')
    check('S__123456.jpg', 'untitled', /LINE/)
  })

  test('Facebook、Messenger、WeChat、WhatsApp 的數字門檻', () => {
    check('FB_IMG_1.jpg', 'named')
    check('FB_IMG_123456789.jpg', 'named')
    check('FB_IMG_1234567890.jpg', 'untitled', /通訊軟體/)
    check('received_1.jpeg', 'named')
    check('received_1234567.jpeg', 'named')
    check('received_12345678.jpeg', 'untitled', /通訊軟體/)
    check('mmexport123456789.jpg', 'named')
    check('mmexport1234567890.jpg', 'untitled', /通訊軟體/)
    check('微信图片_1234567.jpg', 'named')
    check('微信图片_12345678.jpg', 'untitled', /通訊軟體/)
    check('IMG-20260917-WA01.jpg', 'named')
    check('IMG-20260917-WA001.jpg', 'untitled', /通訊軟體/)
  })

  test('iPhone 短編號後面只接受「-edited」，其他英文字不管用什麼分隔都是 named', () => {
    check('IMG_2041-midterm.jpg', 'named')
    check('IMG_2041-night.jpg', 'named')
    check('IMG_2041-edit.jpg', 'named')
    check('IMG_2041.cover.jpg', 'named')
    check('IMG_2041~hdr.jpg', 'named')
    check('IMG_2041-edited.jpg', 'untitled', /相機/)
  })

  test('Android／Pixel 的英文尾巴最多 3 個', () => {
    check('IMG_20260917_141203.MP.HDR.NIGHT.jpg', 'untitled', /相機/)
    check('IMG_20260917_141203.MP.HDR.NIGHT.COVER.jpg', 'named')
  })

  test('中文版本號黏在籠統字後面（沒有分隔符號）也是籠統的', () => {
    check('報告版本2.pdf', 'generic')
    check('講義版本3.docx', 'generic')
  })

  test('Zoom 各種版面的錄影檔', () => {
    check('GMT20260919-061203_Recording_gallery_1920x1080.mp4', 'untitled', /錄/)
    check('GMT20260919-061203_Recording_avo_1280x720.mp4', 'untitled', /錄/)
    check('GMT20260919-061203_Recording.m4a', 'untitled', /錄/)
  })

  // nit：月份字要求單字邊界，只給確實會帶月份的 Adobe Scan
  test('月份字只給 Adobe Scan，其他掃描前綴後面接月份是 named', () => {
    check('Scan May 2026.pdf', 'named')
    check('掃描 May 2026.pdf', 'named')
    check('Scanned Jan 1234.pdf', 'named')
    check('CamScanner Sep 17, 2026.pdf', 'named')
    check('Adobe Scan Sep 17, 2026.pdf', 'untitled', /掃描/)
    check('Adobe Scan 17 Sep 2026.pdf', 'untitled', /掃描/)
  })

  test('時間字、月份字一定要是完整的一個字（前後不可以緊接英文字母）', () => {
    check('Scan marat 2026.pdf', 'named')
    check('Adobe Scan marat 2026.pdf', 'named')
    check('Adobe Scan Sept 17, 2026.pdf', 'named')
    check('Screenshot 2026-09-19 atpm 2.12.03.png', 'named')
    check('Screenshot 2026-09-19 at 2.12.03 pmx.png', 'named')
    check('Screenshotat 2026-09-19 2.12.03.png', 'named')
    check('Scanat 2026-09-17 14.12.pdf', 'named')
    check('Adobe Scanmay 17, 2026.pdf', 'named')
    check('WhatsApp Imageat 2026-09-17 14.12.03.jpeg', 'named')
    // 數字緊接時間字還是可以（Mac 的「2.12.03PM」、中文的「下午2.12.03」）
    check('Screenshot 2026-09-19 at 2.12.03PM.png', 'untitled', /截圖/)
  })

  // nit：「Screenshot from」後面沒有時間也算
  test('GNOME 的「Screenshot from」後面一定要有完整的日期時間', () => {
    check('Screenshot from.png', 'named')
    check('Screenshot from copy.png', 'named')
    check('Screenshot from 1.png', 'named')
    check('Screenshot from 2026-9-1.png', 'named')
    check('Screenshot from 2026-09-19 14-12-03.png', 'untitled', /截圖/)
    check('Screenshot from 2026-09-19 14-12-03 - 2.png', 'untitled', /截圖/)
  })

  // nit：副檔名清單擴充後，第二層會切掉使用者的字
  test('第二層副檔名只在外層是下載中、暫存、壓縮檔時才切', () => {
    for (const x of ['Java', 'C', 'R', 'one', 'log', 'part', 'go', 'ai', 'key', 'pages', 'fig']) {
      check(`IMG_20260917_141203.${x}.jpg`, 'named')
      check(`Untitled.${x}.pdf`, 'named')
    }
    check('Untitled.pdf.crdownload', 'untitled', /未命名/)
    check('IMG_2041.jpg.part', 'untitled', /相機/)
    check('IMG_2041.jpg.tmp', 'untitled', /相機/)
    check('download.pdf.download', 'untitled', /瀏覽器/)
    check('Untitled.tar.gz', 'untitled', /未命名/)
    check('IMG_20260917_141203.MP.jpg', 'untitled', /相機/)
    // 外層是下載中，但裡面那層不是常見副檔名：那一段是使用者的字，不切
    check('IMG_2041.Tokyo.crdownload', 'named')
    check('Untitled.Algebra.part', 'named')
  })

  // nit：真實系統的預設名漏認（錯在安全的那一邊），便宜能補的補
  test('補認的預設名：GNOME 中文翻譯、GNOME 螢幕錄影、Pixel RAW、Notion 匯出', () => {
    // gnome-screenshot 的翻譯：zh_TW「%s 的螢幕擷圖」「%s 的螢幕擷圖 - %d」、zh_CN「%s屏幕截图」「%s-%d屏幕截图」
    check('2026-09-19 14-12-03 的螢幕擷圖.png', 'untitled', /截圖/)
    check('2026-09-19 14-12-03 的螢幕擷圖 - 2.png', 'untitled', /截圖/)
    check('2026-09-19 14-12-03屏幕截图.png', 'untitled', /截圖/)
    check('2026-09-19 14-12-03-2屏幕截图.png', 'untitled', /截圖/)
    check('Screencast from 2026-09-19 14-12-03.webm', 'untitled', /截圖|錄影/)
    check('PXL_20260917_031415926.RAW-01.MP.COVER.jpg', 'untitled', /相機/)
    check('PXL_20260917_031415926.RAW-02.ORIGINAL.dng', 'untitled', /相機/)
    check('Untitled 3f2504e04f8911d39a0c0305e82c3301.md', 'untitled', /未命名/)
    // 使用者的字還是 named
    check('期中考 的螢幕擷圖.png', 'named')
    check('3 的螢幕擷圖.png', 'named')
    check('Screencast from lecture.webm', 'named')
    check('資料結構 3f2504e04f8911d39a0c0305e82c3301.md', 'named')
    check('Untitled 3f2504e0.md', 'named') // Notion 的頁面 ID 一定是 32 個 hex
    check('PXL_20260917_031415926.RAW-01.midterm.jpg', 'named')
  })
})

// 會出事的方向，一般化成性質：每一個系統預設名（不帶副檔名），
// （1）前面或後面接上使用者的字，就不可以是 untitled；
// （2）任何一個數字換成英文字母，就不可以是 untitled（系統名裡的數字位置不會出現字母）。
// 規則的字元類、錨點、「數字」被放寬時，這兩條會紅。
// （第四輪寫在第四輪的 describe 裡；第五輪也要用，所以放在最外層）
const SYSTEM_NAMES = [
  'Untitled', 'Untitled-1', 'Untitled 2', 'untitled (2)', '未命名', '未命名文件 (3)', '無標題', 'Untitled Diagram',
  'Untitled 3f2504e04f8911d39a0c0305e82c3301', '新增 Microsoft Word 文件', '新建文本文档',
  'Document1', 'Document', '文件1', 'Book1', '活頁簿1', 'Presentation1', '簡報1',
  'IMG_2041', 'IMG_E2041', 'IMG_2041 2', 'IMG_2041-edited', 'IMG_20260917_141203', 'IMG_20260917_141203_HDR',
  'IMG_20260917_141203_BURST001', 'VID_20260917_141203', 'PANO_20260917_141203', 'MOV_1234',
  'PXL_20260917_031415926', 'PXL_20260917_031415926~2', 'PXL_20260917_031415926.RAW-01.MP.COVER',
  'DSC01234', 'DSCN0001', '_DSC1234', '_MG_1234', 'P1000123', 'GOPR1234', 'GH011234', 'DJI_0001', 'IMGP1234',
  'CIMG1234', 'PICT0001', 'SAM_0001',
  'Screenshot 2026-09-19 141203', '螢幕擷取畫面 2026-09-19 141203', '截圖 2026-09-19 下午2.12.03',
  'Screen Shot 2026-09-19 at 2.12.03 PM', 'Screenshot 2026-09-19 at 2.12.03 PM (2)', 'Screenshot (12)',
  'Snipaste_2026-09-19_14-12-03', 'Screen Recording 2026-09-19 at 2.12.03 PM', 'Capture',
  'Screenshot_20260917-141203', 'Screenshot_2026-09-19-14-12-03-123', 'Screenshot_20260917-141203_Chrome',
  'Screenshot_20260919-141203_Samsung Internet',
  'Screenshot from 2026-09-19 14-12-03', 'Screenshot from 2026-09-19 14-12-03 - 2',
  'Screenshot From 2026-09-19 14-12-03-1', 'Screencast from 07-17-2013 10:00:46 PM',
  '2026-09-19 14-12-03 的螢幕擷圖', '2026-09-19 14-12-03 的螢幕擷圖 - 2', '2026-09-19 14-12-03屏幕截图',
  '螢幕快照 2026-09-19 14-12-03', '录屏 2026-09-19 14-12-03',
  'scan0003', '掃描_20260917', 'Scan', 'Scan 2', 'Scanned Document', 'Adobe Scan Sep 17, 2026',
  'Adobe Scan 17 Sep 2026 (1)',
  'WhatsApp Image 2026-09-17 at 14.12.03', 'WhatsApp Image 2026-09-17 at 14.12.03_a1b2c3d4', 'IMG-20260917-WA0001',
  'signal-2026-09-17-141203', 'photo_2026-09-17_14-12-03', 'FB_IMG_1726540000000', 'received_1234567890123',
  'mmexport1726540000000', '微信图片_20260917141203', '微信图片_20260917141203_1',
  'LINE_ALBUM_2026917_260917_1', 'messageImage_1726540000000', 'LINE_P20260917_141203', 'line_1726540000000',
  'S__12345678', 'S__12345678_0',
  'New Recording 3', '新錄音 3', 'GMT20260919-061203_Recording_1920x1080',
  'GMT20260919-061203_Recording_gallery_1920x1080', 'GMT20260919-061203',
  'download', 'download (3)', 'file', 'image (4)', 'unnamed', 'image3',
  'a1b2c3d4e5f6a7b8c9d0', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '20260917', '1726540000', '112-1',
  '2026-09-17 14.12.03',
]
const USER_WORDS = ['midterm', 'hw3', 'mom', 'trip', 'lecture 3']

// 第四輪：第三輪驗證的發現。
// minor：第三輪新加、改寫的防護沒有測試鎖住。下面每一個反例都是「使用者的字＋真的時間或真的系統名」，
// 防護被放寬時會安靜地變成 untitled（會出事的方向），所以每一條都要有測試會紅。
describe('classifyName：第四輪（第三輪驗證的發現）', () => {
  const SHOT = 'Screenshot_20260919-141203_'

  test('com 後面一定要緊接一個點：com 開頭的英文字（computer、comics）用點連起來是使用者的字 → named', () => {
    for (const w of [
      'computer.science.midterm', 'comics.and.more', 'compsci.hw3.notes', 'company.trip.day1', 'comment.on.draft',
    ]) {
      check(`${SHOT}${w}.png`, 'named')
    }
  })

  test('App 顯示名要整串相同：前後多接了字就是使用者的字 → named', () => {
    check(`${SHOT}chrome bug.png`, 'named')
    check(`${SHOT}line chat with mom.png`, 'named')
    check(`${SHOT}my chrome bug.png`, 'named')
    check(`${SHOT}settings page bug.png`, 'named')
    check(`${SHOT}Chrome_midterm.png`, 'named')
  })

  test('寫死的套件名要整串相同：後面多接一段就不是 → named', () => {
    check(`${SHOT}org.wikipedia.notes.png`, 'named')
    check(`${SHOT}jp.naver.line.android.chat.png`, 'named')
    check(`${SHOT}tv.twitch.android.app.clip.png`, 'named')
    check(`${SHOT}us.zoom.videomeetings.hw3.png`, 'named')
  })

  test('套件名每一段只能是英文小寫字母與數字（中文、重音字母都不是）', () => {
    check(`${SHOT}com.資料.結構.png`, 'named')
    check(`${SHOT}com.android.資料結構.png`, 'named')
    check(`${SHOT}com.café.notes.png`, 'named')
  })

  test('Java 的每一個保留字與字面值（true、false、null）都不能當套件名的一段', () => {
    for (const kw of [
      'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
      'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
      'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private',
      'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
      'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
    ]) {
      check(`${SHOT}com.${kw}.story.png`, 'named')
    }
    check(`${SHOT}com.trues.story.jpg`, 'untitled', /截圖/) // 只擋整段相同的字
  })

  test('com 開頭的套件名最多 8 段：8 段還是 untitled、9 段是 named', () => {
    check(`${SHOT}com.google.android.apps.docs.editors.sheets.beta.jpg`, 'untitled', /截圖/)
    check(`${SHOT}com.google.android.apps.docs.editors.sheets.beta.x.jpg`, 'named')
  })

  test('GNOME 的「Screenshot from」後面只能是時間：夾了使用者的字就是 named', () => {
    check('Screenshot from lecture 2026-09-19 14-12-03.png', 'named')
    check('Screencast from demo 2026-09-19 14-12-03.webm', 'named')
    check('Screenshot from 2026-09-19 14-12-03 midterm.png', 'named')
    // 前綴只有 screenshot、screencast 兩種
    check('Screen from 2026-09-19 14-12-03.png', 'named')
  })

  test('GNOME 中文翻譯：時間前面夾了使用者的字、撞名字尾不是編號 → named', () => {
    check('資料結構 2026-09-19 14-12-03 的螢幕擷圖.png', 'named')
    check('lecture 2026-09-19 14-12-03 的螢幕擷圖.png', 'named')
    check('期中考 20260919 屏幕截图.png', 'named')
    check('2026-09-19 14-12-03 的螢幕擷圖 - 期中考.png', 'named')
    check('2026-09-19 14-12-03 的螢幕擷圖 - hw3.png', 'named')
    // 撞名編號最多 3 位數：4 位數可能是使用者自己加的號碼
    check('2026-09-19 14-12-03 的螢幕擷圖 - 999.png', 'untitled', /截圖/)
    check('2026-09-19 14-12-03 的螢幕擷圖 - 1234.png', 'named')
  })

  test('Pixel RAW 的尾巴只認「RAW-兩位數」', () => {
    check('PXL_20260917_031415926.RAW-midterm.jpg', 'named')
    check('PXL_20260917_031415926.rawfootage.jpg', 'named')
    check('PXL_20260917_031415926.RAW.jpg', 'named')
  })

  test('Notion 的頁面 ID 只能是 32 個 hex（不是任何英數字）', () => {
    check('Untitled abcdefghijklmnopqrstuvwxyz012345.md', 'named')
    check('Untitled 3f2504e04f8911d39a0c0305e82c330g.md', 'named')
  })

  // 自己的性質測試找到的（會出事的方向）：使用者最常用底線把字接在系統名後面，
  // 「…_com.android.chrome_midterm」的 chrome_midterm 形狀上也是合法的套件名段落
  test('套件名後面用底線接上使用者的字 → named（com 開頭的形狀判斷不收底線）', () => {
    check(`${SHOT}com.android.chrome_midterm.png`, 'named')
    check(`${SHOT}com.google.android.youtube_bug.png`, 'named')
    check(`${SHOT}com.my_app.notes.png`, 'named')
    // 真的帶底線的套件名靠寫死的清單
    check(`${SHOT}cn.wps.moffice_eng.jpg`, 'untitled', /截圖/)
  })


  test('系統預設名清單本身都是 untitled（下面兩條性質的前提）', () => {
    for (const n of SYSTEM_NAMES) assert.equal(classifyName(n).state, 'untitled', n)
  })

  test('性質：系統預設名前面或後面接上使用者的字，就不是 untitled', () => {
    for (const n of SYSTEM_NAMES) {
      for (const sep of [' ', '_', '-', '.', '']) {
        for (const w of USER_WORDS) {
          for (const x of [`${n}${sep}${w}`, `${w}${sep}${n}`, `${n}${sep}${w}.png`]) {
            const got = classifyName(x)
            assert.notEqual(got.state, 'untitled', `${JSON.stringify(x)} 不可以是 untitled（${got.reason}）`)
          }
        }
      }
    }
  })

  test('性質：系統預設名裡任何一個數字換成英文字母，就不是 untitled', () => {
    for (const n of SYSTEM_NAMES) {
      for (let i = 0; i < n.length; i++) {
        if (n[i] < '0' || n[i] > '9') continue
        for (const letter of ['x', 'k']) {
          const x = `${n.slice(0, i)}${letter}${n.slice(i + 1)}`
          const got = classifyName(x)
          assert.notEqual(got.state, 'untitled', `${JSON.stringify(x)} 不可以是 untitled（${got.reason}）`)
        }
      }
    }
  })

  // 數字位數的邊界：固定格式的位數少一位、多一位都不是系統名；「編號」的上限以外可能是使用者的號碼
  test('系統名裡數字位數的邊界（剛好的是 untitled，多一位或少一位不是）', () => {
    const pairs = [
      // 每一組：剛好在邊界上（untitled）、超出邊界（不可以是 untitled）
      ['Untitled 1234.pdf', 'Untitled 12345.pdf'],
      ['Document1234.docx', 'Document12345.docx'],
      ['Book1234.xlsx', 'Book12345.xlsx'],
      ['download1234.pdf', 'download12345.pdf'],
      ['image1234.png', 'image12345.png'],
      ['New Recording 1234.m4a', 'New Recording 12345.m4a'],
      ['IMG_2041 123.jpg', 'IMG_2041 2026.jpg'], // Mac 撞名最多 3 位數；4 位數可能是使用者加的年份
      ['IMG_204.jpg', 'IMG_20.jpg'], // 相機編號至少 3 位數
      ['DSC012.jpg', 'DSC01.jpg'],
      ['_MG_1234.CR2', '_MG_123.CR2'],
      ['DJI_001.jpg', 'DJI_01.jpg'],
      ['P1000123.JPG', 'P100012.JPG'],
      ['P1000123.JPG', 'P10001234.JPG'],
      ['GOPR1234.MP4', 'GOPR123.MP4'],
      ['GOPR1234.MP4', 'GOPR12345.MP4'],
      ['GH011234.MP4', 'GH01123.MP4'],
      ['PXL_20260917_031415926~1234.jpg', 'PXL_20260917_031415926~12345.jpg'],
      ['IMG_2041~1234.jpg', 'IMG_2041~12345.jpg'],
      ['PXL_20260917_031415926.RAW-01.jpg', 'PXL_20260917_031415926.RAW-1.jpg'],
      ['IMG_20260917_141203_BURST0001.jpg', 'IMG_20260917_141203_BURST00001.jpg'],
      ['S__12345678_123.jpg', 'S__12345678_1234.jpg'],
      ['Screenshot_20260917-141203_Chrome.jpg', 'Screenshot_2026091-141203_Chrome.jpg'],
      ['Screenshot_20260917-141203_Chrome.jpg', 'Screenshot_20260917-14120_Chrome.jpg'],
      ['GMT20260919-061203_Recording.mp4', 'GMT2026091-061203_Recording.mp4'],
      ['GMT20260919-061203_Recording.mp4', 'GMT20260919-06120_Recording.mp4'],
      ['GMT20260919-061203_Recording_1280x720.mp4', 'GMT20260919-061203_Recording_1280x72.mp4'],
      ['GMT20260919-061203_Recording_1920x1080.mp4', 'GMT20260919-061203_Recording_1920x10800.mp4'],
      ['GMT20260919-061203_Recording_1920x1080.mp4', 'GMT20260919-061203_Recording_19200x1080.mp4'],
      ['IMG-20260917-WA0001.jpg', 'IMG-2026091-WA0001.jpg'],
      ['WhatsApp Image 2026-09-17 at 14.12.03_a1b2c3d4.jpeg', 'WhatsApp Image 2026-09-17 at 14.12.03_a1b2c3d.jpeg'],
      ['3f2504e0-4f89-11d3-9a0c-0305e82c3301.pdf', 'f2504e0-4f89-11d3-9a0c-0305e82c3301.pdf'],
      ['3f2504e0-4f89-11d3-9a0c-0305e82c3301.pdf', '3f2504e0-f89-11d3-9a0c-0305e82c3301.pdf'],
      ['3f2504e0-4f89-11d3-9a0c-0305e82c3301.pdf', '3f2504e0-4f89-1d3-9a0c-0305e82c3301.pdf'],
      ['3f2504e0-4f89-11d3-9a0c-0305e82c3301.pdf', '3f2504e0-4f89-11d3-a0c-0305e82c3301.pdf'],
      ['3f2504e0-4f89-11d3-9a0c-0305e82c3301.pdf', '3f2504e0-4f89-11d3-9a0c-305e82c3301.pdf'],
    ]
    for (const [at, beyond] of pairs) {
      assert.equal(classifyName(at).state, 'untitled', at)
      const got = classifyName(beyond)
      assert.notEqual(got.state, 'untitled', `${beyond} 不可以是 untitled（${got.reason}）`)
    }
    const more = [
      ['微信图片_20260917141203_123456.jpg', '微信图片_20260917141203_1234567.jpg'],
      // 相機短編號後面最多 3 段數字，再加一段撞名編號
      ['IMG_2041_1_2_3_4.jpg', 'IMG_2041_1_2_3_4_5.jpg'],
      [`IMG_2041_${'1'.repeat(20)}.jpg`, `IMG_2041_${'1'.repeat(21)}.jpg`],
      ['DJI_0001_1_2_3.jpg', 'DJI_0001_1_2_3_4.jpg'],
      [`DJI_0001_${'1'.repeat(20)}.jpg`, `DJI_0001_${'1'.repeat(21)}.jpg`],
      ['GMT20260919-061203_Recording_128x720.mp4', 'GMT20260919-061203_Recording_12x720.mp4'],
      [`${SHOT}com.android.${'a'.repeat(40)}.jpg`, `${SHOT}com.android.${'a'.repeat(41)}.jpg`],
    ]
    for (const [at, beyond] of more) {
      assert.equal(classifyName(at).state, 'untitled', at)
      assert.notEqual(classifyName(beyond).state, 'untitled', beyond)
    }
    // 小米截圖（時間用連字號、後面有毫秒、再接 App）：每一段的位數、每一個數字換成字母都不是
    const xiaomi = 'Screenshot_2026-09-19-14-12-03-123_com.android.chrome.jpg'
    check(xiaomi, 'untitled', /截圖/)
    for (const x of [
      'Screenshot_2026-09-19-14-12-03-1234_com.android.chrome.jpg',
      'Screenshot_2026-9-19-14-12-03-123_com.android.chrome.jpg',
      'Screenshot_226-09-19-14-12-03-123_com.android.chrome.jpg',
      'Screenshot_2026-09-19-14-12-123_com.android.chrome.jpg',
    ]) {
      assert.notEqual(classifyName(x).state, 'untitled', x)
    }
    for (let i = 'Screenshot_'.length; i < xiaomi.indexOf('_com'); i++) {
      if (xiaomi[i] < '0' || xiaomi[i] > '9') continue
      const x = `${xiaomi.slice(0, i)}x${xiaomi.slice(i + 1)}`
      assert.notEqual(classifyName(x).state, 'untitled', x)
    }
    // WhatsApp 的尾巴只能是 8 個 hex：只用 a～f 拼得出來的英文字（cafe、faded）是使用者的字
    check('WhatsApp Image 2026-09-17 at 14.12.03_cafe.jpeg', 'named')
    check('WhatsApp Image 2026-09-17 at 14.12.03_7f3a9c1e.jpeg', 'untitled', /通訊軟體/)
  })

  // 版本號只會讓名字從 named 變 generic（交給模型），不會變 untitled；邊界一樣鎖住，
  // 免得「vlog」「verb」這種 v 開頭的字、太長的號碼被當成版本號
  test('版本號的邊界：位數、段數、v 後面一定是數字', () => {
    const pairs = [
      // 每一組：剛好是版本號（generic）、超出邊界（named）
      ['v1234.pdf', 'v12345.pdf'],
      ['v1.1234.pdf', 'v1.12345.pdf'],
      ['v1.2.3.4.pdf', 'v1.2.3.4.5.pdf'],
      ['v2b.pdf', 'v2bc.pdf'],
      ['講義 第123版.pdf', '講義 第1234版.pdf'],
      ['報告_版本1234.pdf', '報告_版本12345.pdf'],
      ['講義第123版.pdf', '講義第1234版.pdf'],
      ['報告版本1234.pdf', '報告版本12345.pdf'],
    ]
    for (const [at, beyond] of pairs) {
      check(at, 'generic')
      check(beyond, 'named')
    }
    for (const n of ['vlog.mp4', 'verb.pdf', 'v1.mom.pdf', '講義 第ab版.pdf', '報告_版本ab.pdf', '講義第ab版.pdf', '報告版本ab.pdf']) {
      check(n, 'named')
    }
  })

  // nit：沒有副檔名、最後一段剛好是常見副檔名清單裡的英文字時，那段被當成副檔名切掉
  // 「Untitled.Java」「Scan.Log」的最後一段可能是使用者打的字；「Untitled.pages」「Untitled-1.ai」也可能是
  // Pages、Illustrator 真的預設名。兩種讀法都說得通、拿不準，所以不判 untitled，判 generic 交給模型。
  // 比對不分大小寫（預想表的規定），大寫、小寫都一樣。
  const WORD_EXT = [
    'ai', 'bat', 'bib', 'deb', 'dot', 'download', 'fig', 'go', 'java', 'key', 'log', 'numbers', 'one',
    'opus', 'pages', 'part', 'partial', 'sketch', 'swift', 'temp', 'tex', 'torrent',
  ]

  test('點後面是英文字的常見副檔名（Java、Log、Key），去掉會判成沒取名的話 → generic（拿不準，不判 untitled）', () => {
    check('Untitled.Java', 'generic', /拿不準/)
    check('Scan.Log', 'generic', /拿不準/)
    check('IMG_2041.Key', 'generic', /拿不準/)
    check('Document1.Pages', 'generic', /拿不準/)
    check('Untitled.Swift', 'generic', /拿不準/)
    check('Screenshot 2026-09-19 at 2.12.03 PM.One', 'generic', /拿不準/)
    check('.Key', 'generic', /拿不準/)
    // 不分大小寫：小寫、全大寫一樣
    check('Untitled.java', 'generic', /拿不準/)
    check('Untitled.pages', 'generic', /拿不準/)
    check('Untitled-1.ai', 'generic', /拿不準/)
    check('UNTITLED.KEY', 'generic', /拿不準/)
    // 去掉副檔名本來就不是 untitled 的，照原本的判斷
    check('期中考.key', 'named')
    check('report.pages', 'generic', /籠統/)
  })

  test('每一個是英文字的常見副檔名，接在沒取名的名字後面都是 generic；大小寫不影響', () => {
    for (const w of WORD_EXT) {
      for (const n of [`Untitled.${w}`, `Untitled.${w[0].toUpperCase()}${w.slice(1)}`, `IMG_2041.${w.toUpperCase()}`]) {
        check(n, 'generic', /拿不準/)
      }
    }
  })

  test('不是英文字的常見副檔名照切，大小寫也不影響（相機的 .JPG、剪取工具的 .PNG、RStudio 的 .R）', () => {
    check('IMG_2041.JPG', 'untitled', /相機/)
    check('Capture.PNG', 'untitled', /截圖/)
    check('Untitled.Pdf', 'untitled', /未命名/)
    check('Untitled.R', 'untitled', /未命名/)
    check('Untitled.tar', 'untitled', /未命名/)
    check('Untitled.jar', 'untitled', /未命名/)
    check('.PDF', 'untitled', /空/)
  })

  test('雙層副檔名：裡面那層是常見副檔名，外層的英文字（part、download）就確定是副檔名', () => {
    check('Untitled.pdf.part', 'untitled', /未命名/)
    check('Untitled.pdf.Part', 'untitled', /未命名/)
    check('download.pdf.download', 'untitled', /瀏覽器/)
    check('IMG_2041.JPG.part', 'untitled', /相機/)
    check('IMG_2041.JPG.BAK', 'untitled', /相機/)
    check('Untitled.PDF.CRDOWNLOAD', 'untitled', /未命名/)
    // 裡面那層也是英文字：一樣拿不準
    check('Untitled.key.crdownload', 'generic', /拿不準/)
    check('Untitled.Java.part', 'generic', /拿不準/)
    // 外層是英文字、裡面沒有副檔名：拿不準
    check('Untitled.part', 'generic', /拿不準/)
    // 裡面那層不是常見副檔名：是使用者的字，不切
    check('Untitled.Algebra.part', 'named')
    check('report.Tokyo.crdownload', 'named')
  })

  // nit：錯在安全那邊的漏認，便宜能補的補
  // gnome-shell（GNOME 42 以後內建的截圖）：「Screenshot From %s」，撞名在後面加「-1」；
  // 翻譯 zh_TW「螢幕快照 %s」、zh_CN「截图 %s」；螢幕錄影 zh_CN「录屏 %d %t」；
  // 舊版 gnome-shell 的螢幕錄影用 12 小時制：「Screencast from 07-17-2013 10:00:46 PM」
  test('補認的預設名：gnome-shell 的截圖、螢幕錄影（撞名、中文翻譯、舊版 12 小時制）', () => {
    check('Screenshot From 2026-09-19 14-12-03.png', 'untitled', /截圖/)
    check('Screenshot From 2026-09-19 14-12-03-1.png', 'untitled', /截圖/)
    check('Screencast From 2026-09-19 14-12-03.webm', 'untitled', /截圖|錄影/)
    check('螢幕快照 2026-09-19 14-12-03.png', 'untitled', /截圖/)
    check('螢幕快照 2026-09-19 14-12-03-1.png', 'untitled', /截圖/)
    check('截图 2026-09-19 14-12-03-1.png', 'untitled', /截圖/)
    check('录屏 2026-09-19 14-12-03.webm', 'untitled', /截圖|錄影/)
    check('Screencast from 07-17-2013 10:00:46 PM.webm', 'untitled', /截圖|錄影/)
    check('Screencast from 07-17-2013 10:00:46 AM.webm', 'untitled', /截圖|錄影/)
    // 使用者的字還是 named
    check('录屏 期中考.webm', 'named')
    check('录屏教学.mp4', 'named')
    check('Screencast from 07-17-2013 10:00:46 PM midterm.webm', 'named')
    check('Screencast from 07-17-2013 10:00:46 hw.webm', 'named')
    check('Screencast from lecture PM.webm', 'named')
  })
})

// 第五輪：第四輪驗證的發現。每一條都先寫成測試（當時是紅的，或在突變上是紅的）再修。
describe('classifyName：第五輪（第四輪驗證的發現）', () => {
  // nit：LibreOffice 繁中版把 Untitled 翻成「無題」，新文件叫「無題 1」「無題 2」
  // （/usr/lib/libreoffice/program/resource/zh_TW/LC_MESSAGES/fwk.mo、sfx.mo：STR_UNTITLED_DOCUMENT → 無題）。
  // 「無題」單獨一個還是 generic（李商隱〈無題〉），只認「無題＋一個空白＋編號」這個程式固定產生的形式。
  test('LibreOffice 三種語言的新文件名（Untitled 1、未命名 1、無題 1）都是 untitled，理由一樣', () => {
    const reason = classifyName('Untitled 1.odt').reason
    for (const n of ['Untitled 1.odt', '未命名 1.odt', '无标题 1.odt', '無題 1.odt', '無題 2.ods', '無題 1234.odp', '無題 1 (1).odt']) {
      check(n, 'untitled', /未命名/)
      assert.equal(classifyName(n).reason, reason, n)
    }
    // Mac 撞名在後面再加「 2」、中間多一個空白：一樣是 untitled
    check('無題  1.odt', 'untitled', /未命名/)
  })

  test('「無題」只認程式固定的形式：單獨一個是 generic，黏著數字、其他分隔、太長的編號、後面接字都不是 untitled', () => {
    check('無題.odt', 'generic')
    check('無題 (1).odt', 'generic')
    for (const n of ['無題1.odt', '無題-1.odt', '無題_1.odt', '無題 12345.odt', '無題 1 詩.odt', '無題 a.odt', '無題 一.odt', '無題詩 1.odt', '無題 1.2.odt']) {
      assert.notEqual(classifyName(n).state, 'untitled', n)
    }
  })

  // 同一批語言檔裡 gedit 的預設名（/usr/share/locale/zh_TW、zh_HK、zh_CN 的 gedit.mo）：
  // Untitled File → 無標題檔案、Untitled Folder → 未命名文件夹、Unsaved Document %d → 未儲存文件 %d
  test('gedit 的預設名：無標題檔案、未命名文件夹、未儲存文件 1（英文 Untitled File、Unsaved Document 1）', () => {
    for (const n of ['無標題檔案.txt', '無標題檔案 2.txt', '未命名文件夹', 'Untitled File.txt', '未儲存文件 1.txt', 'Unsaved Document 1.txt', 'Unsaved Document.txt']) {
      check(n, 'untitled', /未命名/)
    }
    for (const n of ['未儲存.txt', 'Unsaved.txt', '未儲存文件 期中.txt', 'Unsaved Document of mom.txt', '檔案.txt', 'Unsaved Documents.txt']) {
      assert.notEqual(classifyName(n).state, 'untitled', n)
    }
  })

  // minor：數字欄位被放寬成接受 a～f（最常見的 [0-9a-f]）或 a、p、m（上午下午）時，測試擋不住。
  // 第四輪的兩條性質只換成 x、k，使用者的字也都含 a～f 以外的字母。這裡用結構化生成補齊：
  // 每一個系統預設名、每一個數字位置（以及數字之間的分隔符號），各換成下面每一個字母一次，都不可以是 untitled。
  // 字母：a～f（hex）、m、p（上午下午）、o、l（看起來像 0、1）、x、k（跟任何格式都無關）
  const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'm', 'p', 'o', 'l', 'x', 'k']
  const HEX_LETTERS = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
  // 第五輪補的系統名：每一個數字欄位都至少有一個名字走得到
  // （Untitled 黏著數字、底線；相機的額外數字段、撞名尾巴；Fuji／DJI／GoPro 的其他型號；Zoom 沒有解析度）
  const EXTRA_NAMES = [
    'Untitled1', 'Untitled_12', 'Document1234', 'download12', 'IMG_20260917_141203_1', 'IMG_2041_1_2', 'IMG_2041~2',
    'DJI_0001_1', 'GX011234', 'GP011234', 'PXL_20260917_031415926.RAW-02.ORIGINAL', 'S__12345678_12',
    '微信图片_20260917141203_12', 'GMT20260919-061203_Recording', 'Screenshot_20260919-101530',
    '無題 1', '無標題檔案', '未命名文件夹', 'Untitled File', '未儲存文件 1', 'Unsaved Document 1',
  ]
  const NAMES = [...SYSTEM_NAMES, ...EXTRA_NAMES]
  // 本來就可以是 hex 的欄位：從這個位置到結尾都是 hex（Notion 頁面 ID、雜湊、UUID、WhatsApp 新版的尾巴）。
  // 這些位置換成 a～f 還是合法的 hex，本來就該是 untitled，所以只換不是 hex 的字母
  const HEX_FROM = new Map([
    ['Untitled 3f2504e04f8911d39a0c0305e82c3301', 9],
    ['a1b2c3d4e5f6a7b8c9d0', 0],
    ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', 0],
    ['WhatsApp Image 2026-09-17 at 14.12.03_a1b2c3d4', 38],
  ])
  // 換了一個字母剛好變成另一種真的系統名，本來就該是 untitled（下面另外檢查它們真的是 untitled）：
  // iPhone 編輯過的照片 IMG_E…（VID、PXL、PANO、MOV 同一條規則）、Pentax 的 IMGP…、Fuji 的 DSCF…、
  // LINE 的 LINE_P…、Panasonic 的 P＋7 位數
  const STILL_SYSTEM = new Set([
    'IMG_e041', 'IMG_e041 2', 'IMG_e041-edited', 'IMG_e0260917_141203', 'VID_e0260917_141203', 'PANO_e0260917_141203',
    'MOV_e234', 'PXL_e0260917_031415926', 'PXL_e0260917_031415926~2', 'IMG_e0260917_141203_1', 'IMG_e041_1_2',
    'IMG_e041~2', 'IMGp2041', 'IMGp2041 2', 'IMGp20260917_141203', 'IMGp20260917_141203_1', 'IMGp2041_1_2',
    'DSCf1234', '_DSCf234', 'line_p726540000000', 'p0260917',
  ])
  const SEP_CHARS = new Set([' ', '_', '-', '.', '~', ':', ','])

  /** 一個系統名的所有「換一個字母」的變體。 */
  function letterVariants(n) {
    const hexFrom = HEX_FROM.has(n) ? HEX_FROM.get(n) : Infinity
    const out = []
    for (let i = 0; i < n.length; i++) {
      const inHex = i >= hexFrom
      const ch = n[i]
      const isDigit = ch >= '0' && ch <= '9'
      if (!isDigit && !SEP_CHARS.has(ch) && !(inHex && HEX_LETTERS.has(ch))) continue
      for (const letter of LETTERS) {
        if (inHex && HEX_LETTERS.has(letter)) continue
        out.push(`${n.slice(0, i)}${letter}${n.slice(i + 1)}`)
      }
    }
    return out
  }

  test('系統預設名清單（含第五輪補的）本身都是 untitled；換字母剛好變成另一種系統名的也是', () => {
    for (const n of NAMES) assert.equal(classifyName(n).state, 'untitled', n)
    for (const n of STILL_SYSTEM) assert.equal(classifyName(n).state, 'untitled', n)
  })

  test('性質：系統預設名的每一個數字（和數字之間的分隔符號）換成 a～f、m、p、o、l、x、k，都不是 untitled', () => {
    let count = 0
    for (const n of NAMES) {
      for (const x of letterVariants(n)) {
        if (STILL_SYSTEM.has(x)) continue
        count++
        const got = classifyName(x)
        assert.notEqual(got.state, 'untitled', `${JSON.stringify(x)}（從 ${JSON.stringify(n)} 換來）不可以是 untitled（${got.reason}）`)
      }
    }
    assert.ok(count > 10000, `只產生了 ${count} 個變體`)
  })

  test('性質：數字整批換成長得像的字母（0 → O、1 → l）也不是 untitled', () => {
    check('Screenshot_20260919-101530.png', 'untitled', /截圖/)
    check('Screenshot_2026O919-1O153O.png', 'named')
    for (const n of NAMES) {
      const hexFrom = HEX_FROM.has(n) ? HEX_FROM.get(n) : n.length
      for (const [from, to] of [['0', 'O'], ['1', 'l']]) {
        const head = n.slice(0, hexFrom)
        if (!head.includes(from)) continue
        const x = head.split(from).join(to) + n.slice(hexFrom)
        assert.notEqual(classifyName(x).state, 'untitled', `${JSON.stringify(x)}（從 ${JSON.stringify(n)} 換來）`)
      }
    }
  })

  // 使用者的字：第四輪的字都含 a～f 以外的字母，擋不住 [0-9a-f] 的放寬；補只用 a～f 拼的（dad、cafe、bed）
  // 與只用 a、p、m 拼的（map、pam）
  const HEX_WORDS = ['dad', 'cafe', 'bed']
  const WORDS = [...USER_WORDS, ...HEX_WORDS, 'map', 'pam']

  test('性質：系統預設名前面或後面接上只用 a～f、a／p／m 拼的字，也不是 untitled', () => {
    for (const n of NAMES) {
      for (const sep of [' ', '_', '-', '.', '']) {
        for (const w of WORDS) {
          for (const x of [`${n}${sep}${w}`, `${w}${sep}${n}`, `${n}${sep}${w}.png`]) {
            // 純 hex 的名字直接黏上只用 a～f 拼的字，結果還是一串 hex：本來就是 untitled
            if (sep === '' && HEX_FROM.get(n) === 0 && HEX_WORDS.includes(w) && /^[0-9a-f]+(\.png)?$/.test(x)) continue
            const got = classifyName(x)
            assert.notEqual(got.state, 'untitled', `${JSON.stringify(x)} 不可以是 untitled（${got.reason}）`)
          }
        }
      }
    }
  })

  // com 開頭的 Android 截圖名：沒有副檔名時最後一段會被當成副檔名切掉（第四輪記過的限制），所以都帶 .jpg。
  // 用點接使用者的字是已經接受的設計取捨（跟真的四段套件名分不出來），這裡只用空白、底線、連字號
  const PACKAGE_SHOTS = [
    'Screenshot_20260919-141203_com.android.chrome',
    'Screenshot_20260919_141203_com.google.android.youtube',
    'Screenshot_2026-09-19-14-12-03-123_com.android.chrome',
  ]

  test('性質：com 開頭的 Android 截圖名，後面用空白、底線、連字號接使用者的字，或時間換成字母，都不是 untitled', () => {
    for (const n of PACKAGE_SHOTS) {
      check(`${n}.jpg`, 'untitled', /截圖/)
      for (const w of WORDS) {
        for (const sep of [' ', '_', '-']) {
          assert.notEqual(classifyName(`${n}${sep}${w}.jpg`).state, 'untitled', `${n}${sep}${w}`)
        }
        for (const sep of [' ', '_', '-', '.', '']) {
          assert.notEqual(classifyName(`${w}${sep}${n}.jpg`).state, 'untitled', `${w}${sep}${n}`)
        }
      }
      const app = n.indexOf('_com.')
      for (const x of letterVariants(n.slice(0, app))) {
        assert.notEqual(classifyName(`${x}${n.slice(app)}.jpg`).state, 'untitled', `${x}${n.slice(app)}`)
      }
    }
  })

  // 前幾輪的突變重跑時還活著、而且是往 untitled 方向的幾個：保留字只檢查第二段、App 名清單多收一個一般的字、
  // 時間和 App 名之間接受底線以外的分隔、App 名前後的空白被去掉
  test('Java 保留字出現在套件名的任何一段都不是套件名', () => {
    const SHOT = 'Screenshot_20260919-141203_'
    for (const kw of ['final', 'new', 'class', 'package', 'true']) {
      check(`${SHOT}com.${kw}.android.chrome.jpg`, 'named')
      check(`${SHOT}com.android.${kw}.chrome.jpg`, 'named')
      check(`${SHOT}com.android.chrome.${kw}.jpg`, 'named')
    }
  })

  test('Android 截圖名：App 名只認系統加的那種寫法（底線接在時間後面、前後沒有空白），一般英文字不是 App 名', () => {
    const SHOT = 'Screenshot_20260919-141203'
    check(`${SHOT}_Chrome.jpg`, 'untitled', /截圖/)
    for (const n of [`${SHOT} Chrome.jpg`, `${SHOT}-Chrome.jpg`, `${SHOT}.Chrome.jpg`, `${SHOT}_ Chrome.jpg`, `${SHOT}__Chrome.jpg`]) {
      assert.notEqual(classifyName(n).state, 'untitled', n)
    }
    for (const w of [
      'notes', 'report', 'homework', 'lecture', 'final', 'draft', 'summary', 'slides', 'exam', 'quiz', 'todo', 'photo',
      'screen', 'bug', 'error', 'login', 'map', 'chat', 'mom', 'dad', 'cafe', 'receipt', 'ticket', 'order', 'schedule',
    ]) {
      check(`${SHOT}_${w}.jpg`, 'named')
    }
  })

  test('套件名每一段都要英文字母開頭：段落開頭是空白、底線、連字號、數字 → named', () => {
    const SHOT = 'Screenshot_20260919-141203_'
    for (const bad of [' ', '_', '-', '1']) {
      check(`${SHOT}com.android.${bad}chrome.jpg`, 'named')
      check(`${SHOT}com.${bad}android.chrome.jpg`, 'named')
    }
  })

  // GNOME 舊版 12 小時制最後只能接 am、pm：把 P 換成其他字母（mm 可能是公釐）或分隔符號都不是
  test('GNOME 螢幕錄影最後的 am／pm 只能是這兩個字：換成其他字母、分隔符號都不是 untitled', () => {
    const base = 'Screencast from 07-17-2013 10:00:46 PM'
    check(`${base}.webm`, 'untitled', /截圖|錄影/)
    check('Screencast from 07-17-2013 10:00:46 AM.webm', 'untitled', /截圖|錄影/)
    const at = base.length - 2
    for (const c of [...'bcdefghijklmnoqrstuvwxyz', ' ', '_', '-', '.']) {
      const x = `${base.slice(0, at)}${c}${base.slice(at + 1)}`
      assert.notEqual(classifyName(`${x}.webm`).state, 'untitled', x)
    }
    check('Screencast from 07-17-2013 10:00:46 mm.webm', 'named')
    check('Screencast from 07-17-2013 10:00:46 m.webm', 'named')
  })

  // 相機前綴裡固定的字母（GoPro 的 GH／GX／GP、Nikon／Fuji 的 DSCN／DSCF）換成別的字母就不是相機名
  test('相機前綴的固定字母換成別的字母，都不是 untitled', () => {
    for (const c of 'abcdefgijklmnoqrstuvwyz') {
      assert.notEqual(classifyName(`G${c}011234.MP4`).state, 'untitled', `G${c}011234`)
    }
    for (const c of 'abcdeghijklmopqrstuvwxyz') {
      assert.notEqual(classifyName(`DSC${c}0001.JPG`).state, 'untitled', `DSC${c}0001`)
    }
    check('GX011234.MP4', 'untitled', /相機/)
    check('GP011234.MP4', 'untitled', /相機/)
  })

  // 版本號只會讓名字從 named 變 generic（不是 untitled 的方向），但數字放寬成字母一樣會把使用者的字吃掉
  // （「vamp」「講義 第ab版」）。最後一位不換：v 開頭的版本號本來就可以接一個字母（v2b）
  test('版本號裡的數字換成字母，就不是版本號（named）', () => {
    for (const n of ['v1234', 'v1.1234', 'v1.2.3.4', 'ver12', 'rev.12', '講義 第123版', '報告_版本1234', '講義第123版', '報告版本1234']) {
      check(`${n}.pdf`, 'generic')
      for (let i = 0; i < n.length - 1; i++) {
        if (n[i] < '0' || n[i] > '9') continue
        for (const letter of LETTERS) {
          const x = `${n.slice(0, i)}${letter}${n.slice(i + 1)}`
          check(`${x}.pdf`, 'named')
        }
      }
    }
  })

  // 副檔名只能是 1～10 個英數字：點後面接的是空白、底線、連字號隔開的字，或 11 個字母以上，都是使用者的字，不切
  test('點後面不像副檔名（有分隔符號、太長）就不切，整個名字一起判', () => {
    for (const n of ['report.midterm hw', 'report.midterm_hw', 'report.midterm-hw', 'report.x 資料', 'report.informatics']) {
      check(n, 'named')
    }
  })

  // hex 欄位（雜湊、UUID、WhatsApp 尾巴、Notion 頁面 ID）裡夾了空白、底線、連字號就不是：
  // 放寬成 [ 0-9a-f] 的話，「dead beef cafe babe」這種只用 a～f 拼的英文字會變成「雜湊」
  test('hex 欄位裡夾了分隔符號、只用 a～f 拼的英文句子，都不是 untitled', () => {
    for (const n of ['dead beef cafe babe.txt', 'dead_beef_cafe_babe.txt', 'bad cafe decaf face.txt', 'faded facade.txt']) {
      assert.notEqual(classifyName(n).state, 'untitled', n)
    }
    check('WhatsApp Image 2026-09-17 at 14.12.03_cafe bed.jpeg', 'named')
    for (const [n, from] of HEX_FROM) {
      for (let i = Math.max(from, 1); i < n.length - 1; i++) {
        if (!/[0-9a-f]/.test(n[i])) continue
        for (const sep of [' ', '_', '-']) {
          const x = `${n.slice(0, i)}${sep}${n.slice(i + 1)}`
          assert.notEqual(classifyName(x).state, 'untitled', JSON.stringify(x))
        }
      }
    }
  })
})

// 效能測試量的是牆鐘時間，門檻刻意放寬到「明顯的倍數」，而且取最多三次裡最快的一次：
// - 正常（線性時間）的輸入：10 萬字元最慢的是 NFKC 會展開 18 倍的 U+FDFA，單獨跑約 10～17 ms；
//   第三輪驗證在 20 核的機器上同時跑 40 份測試（機器超載兩倍），量到 51～67 ms。
// - 會回溯的正規式在 10 萬字元上一定是平方時間以上：植入的二次方正規式（M7b）第一輪量到 6.5 秒、第四輪 4.8 秒，
//   巢狀量詞（M16）直接卡住。平方時間是 10^10 步，就算一步 1 ns 也要 10 秒。
// 所以門檻取 250 ms：比超載時量到的最慢值還高將近 4 倍，比二次方的情況低將近 20 倍，兩邊都分得開。
// 取最快的一次是為了擋掉 GC、排程這種偶發的停頓；有一次超過門檻 10 倍就直接算失敗，不再重跑
// （那不是機器忙，是真的變慢了，重跑只會多等）。
const TIME_LIMIT_MS = 250
function fastestMs(fn) {
  let best = Infinity
  for (let i = 0; i < 3 && best >= TIME_LIMIT_MS; i++) {
    const t0 = performance.now()
    fn()
    const ms = performance.now() - t0
    best = Math.min(best, ms)
    if (ms > TIME_LIMIT_MS * 10) break
  }
  return best
}

describe('classifyName：錯誤', () => {
  test('不是字串丟 UntitledError（INVALID_INPUT）', () => {
    for (const bad of [undefined, null, 42, {}, ['Untitled.pdf'], Symbol('x')]) {
      assert.throws(() => classifyName(bad), err => {
        assert.ok(err instanceof UntitledError)
        assert.ok(err instanceof Error)
        assert.equal(err.code, 'INVALID_INPUT')
        return true
      })
    }
  })

  test('超過上限的長字串丟 TOO_LONG，而且很快', () => {
    const huge = 'a'.repeat(MAX_NAME_INPUT_LENGTH + 1)
    const ms = fastestMs(() => {
      assert.throws(() => classifyName(huge), err => err instanceof UntitledError && err.code === 'TOO_LONG')
    })
    assert.ok(ms < TIME_LIMIT_MS, `花了 ${ms.toFixed(1)} ms`)
  })

  test('上限剛好的長度還是會判斷，不丟錯', () => {
    const r = classifyName('1'.repeat(MAX_NAME_INPUT_LENGTH))
    assert.equal(r.state, 'untitled')
  })
})

describe('classifyName：不可以有 ReDoS（檔名是不可信的輸入）', () => {
  const N = 100_000
  const fill = (unit, tail = '') => {
    const s = unit.repeat(Math.ceil((N - tail.length) / unit.length)).slice(0, N - tail.length) + tail
    assert.equal(s.length, N)
    return s
  }
  const evil = [
    ['全部同一個字母', fill('a')],
    ['一長串 (1) 副本字尾', 'Untitled' + fill(' (1)').slice(8)],
    ['一長串 (1) 最後接一個字', fill(' (1)', 'x')],
    ['左括號後面一長串數字', fill('(') .slice(0, 10) + fill('1', ')').slice(10)],
    ['一長串左括號', fill('(', '1)')],
    ['一長串 copy', fill(' copy', ' 2')],
    ['一長串 - 複製', fill(' - 複製', 'x')],
    ['相機前綴＋一長串 1_', 'IMG_' + fill('1_', 'x').slice(4)],
    ['相機前綴＋一長串數字', 'IMG_' + fill('1', '_x').slice(4)],
    ['截圖前綴＋一長串時間字', 'Screenshot ' + fill('1 at ', 'x').slice(11)],
    ['Android 截圖＋一長串數字', 'screenshot_' + fill('1', '_chrome!').slice(11)],
    ['WhatsApp＋一長串時間字', 'WhatsApp Image ' + fill('1 at ', '_zzzzzzzz').slice(15)],
    ['LINE 相簿＋一長串 1_', 'line_album_' + fill('1_', 'x').slice(11)],
    ['一長串 0 最後不是 hex', fill('0', 'g')],
    ['一長串 hex', fill('a1', '.pdf')],
    ['UUID 的樣子重複', fill('3f2504e0-4f89-', 'x')],
    ['一長串籠統字', fill('報告 ', 'x')],
    ['籠統字黏在一起', fill('報告', 'x')],
    ['英文籠統字黏在一起', fill('notes', 'x')],
    ['一長串版本號', fill('v1.', 'x')],
    ['一長串 final_v', fill('final_v', '2')],
    ['一長串連字號', fill('-')],
    ['一長串空白', fill(' ', 'x')],
    ['一長串點', fill('.')],
    ['一長串 a.', fill('a.')],
    ['一長串零寬字元後面接 Untitled', fill('\u200b', 'Untitled')],
    ['NFKC 會展開 18 倍的字', fill('\ufdfa')],
    ['一長串全形括號編號', fill('（１）', 'x')],
    ['untitled 後面一長串數字', 'untitled' + fill('1').slice(8)],
    ['Windows 新增檔名後面一長串空白', '新增 Microsoft Word 文件' + fill(' ', 'x').slice(20)],
    ['一長串路徑分隔', fill('/\\', 'Untitled.pdf')],
    ['一長串 emoji', fill('🎉')],
    ['一長串 ~$', fill('~$')],
    // 第二輪新增的規則
    ['Android 截圖＋一長串套件名', 'screenshot_20260919-141203_com.' + fill('a.', '!').slice(31)],
    ['小米截圖＋一長串 -12', 'screenshot_2026' + fill('-12', '_x').slice(15)],
    ['LINE＋一長串數字', 'line_p' + fill('1', 'x').slice(6)],
    ['LINE S__＋一長串數字', 's__' + fill('1', '_x').slice(3)],
    ['Zoom＋一長串數字', 'gmt' + fill('1', '-x').slice(3)],
    ['掃描＋一長串月份', 'adobe scan ' + fill('sep 1 ', 'x').slice(11)],
    ['GNOME 截圖＋一長串 from', 'screenshot ' + fill('from ', 'x').slice(11)],
    ['通訊軟體＋一長串數字最後接字', 'photo_' + fill('1', ' may').slice(6)],
    ['一長串數字＋不認得的副檔名（會判兩次）', fill('1', '.tokyo')],
    ['相機＋一長串尾巴', 'img_20260917_141203' + fill('.mp', '!').slice(19)],
    ['一長串分隔符號再接副本字尾', fill('_', ' (1)')],
    ['一長串「 - 」再接 Copy', fill(' - ', 'copy')],
    // 第三輪新增的規則
    ['Android 截圖＋一長串 me.', 'screenshot_20260919-141203_' + fill('me.', 'x').slice(27)],
    ['Android 截圖＋一長串 com 套件段', 'screenshot_20260919-141203_com.' + fill('ab.', 'c').slice(31)],
    ['GNOME 中文＋一長串數字', fill('1', ' 的螢幕擷圖x')],
    ['GNOME 簡中＋一長串數字與空白', fill('1 ', '屏幕截图 - 2x')],
    ['GNOME＋一長串數字最後接字', 'screenshot from ' + fill('1', 'x').slice(16)],
    ['Adobe Scan＋一長串黏在一起的時間字', 'adobe scan ' + fill('marat ', '1').slice(11)],
    ['截圖＋一長串黏在一起的 at', 'screenshot ' + fill('at', ' 1').slice(11)],
    ['Untitled＋一長串 hex', 'untitled ' + fill('a').slice(9)],
    ['Pixel＋一長串 RAW 尾巴', 'pxl_20260917_031415926' + fill('.raw-01', '!').slice(22)],
    ['一長串數字＋下載中的雙層副檔名', fill('1', '.pdf.crdownload')],
    // 第四輪新增的規則
    ['一長串數字＋大寫開頭的英文字副檔名（會判兩次）', fill('1', '.Key')],
    ['一長串 Untitled. 再接大寫開頭的下載中副檔名', fill('Untitled.', 'pdf.Part')],
    ['一長串數字＋大寫開頭的雙層副檔名', fill('1', '.Key.crdownload')],
    ['GNOME 螢幕錄影＋一長串數字最後接 pm 和字', 'screencast from ' + fill('1', ' pmx').slice(16)],
    ['GNOME 螢幕錄影＋一長串 am', 'screencast from ' + fill('1 am', 'x').slice(16)],
    ['录屏＋一長串數字最後接字', '录屏 ' + fill('1', 'x').slice(3)],
    ['Android 截圖＋一長串 com 開頭的點與保留字', 'screenshot_20260919-141203_com.' + fill('true.', 'x').slice(31)],
    // 第五輪新增的規則
    ['無題＋一長串數字最後接字', '無題 ' + fill('1', 'x').slice(3)],
    ['未儲存文件＋一長串空白與數字最後接字', '未儲存文件' + fill(' 1', 'x').slice(5)],
    ['Unsaved Document＋一長串 file', 'unsaved document' + fill(' file', 'x').slice(16)],
    ['Untitled＋一長串 file 與空白', 'untitled' + fill(' file ', '1x').slice(8)],
  ]

  test(`每一個 10 萬字元的怪名字都要在 ${TIME_LIMIT_MS} ms 內回來（線性時間；門檻的理由見 TIME_LIMIT_MS）`, () => {
    classifyName('暖身 Untitled (1).pdf')
    for (const [label, name] of evil) {
      let got
      const ms = fastestMs(() => {
        got = classifyName(name)
      })
      assert.ok(['untitled', 'generic', 'named'].includes(got.state), label)
      assert.ok(ms < TIME_LIMIT_MS, `「${label}」花了 ${ms.toFixed(1)} ms`)
    }
  })
})
