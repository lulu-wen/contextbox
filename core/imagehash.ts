// 長相指紋與連拍分組（純函式、零依賴）。
//
// 輸入一律是已經解好的灰階圖 { width, height, gray }（解 PNG 是 core/png.ts 的事）。
//
// 兩張截圖比出三個等級（compareImages）：
//   same      全解析度上幾乎沒有任何像素變化：每個像素的灰階差都 ≤ SAME_TOL（只容忍解碼的四捨五入）→ 面板預設勾
//   similar   差不多：過了連拍的門檻，但有變化（短字串、勾選框、數字、游標、時鐘、按鈕跳動）→ 預設不勾，把外框給面板框出來
//   different 不一樣：不成組
// 不變量：
//   - different 絕對不成組。
//   - same 一定在全解析度上確認過，沒有任何例外：游標閃一下、時鐘跳一分鐘、按鈕跳 1 像素，都是 similar。
//   - 沒辦法在全解析度上確認的（只有簽章、沒有原圖灰階），一律 similar（reason 'unverified'，外框是空的）。
//     兩張的原圖灰階共用同一塊記憶體（同一個 ArrayBuffer、範圍重疊）也算沒辦法確認：其中一張可能已經被呼叫端的下一次解碼蓋掉。
//   - 只有拿到兩張原圖的 compareImages／burstGroups 能說 same；fineCompare 手上只有細比對，永遠不回 same（最多 similar）。
//   - similar 的外框涵蓋細比對上每一格變了的（每格不只 1 像素時差 ≠ 0；每格 1 像素時差 > SAME_TOL）；
//     細比對看不出差別、回原圖確認出來的 similar，外框涵蓋每一個差 > SAME_TOL 的像素。
//
// 判斷分三段：
//   1. 尺寸要完全一樣；粗指紋 dHash（9×8）漢明距離 ≤ DHASH_MAX。9×8 對文字截圖太粗，只能先篩。
//   2. 細比對（similar 與 different 的分法）：兩張都縮到長邊 640～960 格（每格最多 4×4 像素，見 fineDims），逐格比：
//      - 強格：一格的灰階差 > FINE_STRONG；淡變化：差 > FINE_FAINT（低對比的字也看得到）。
//      - 變化處：強格，加上離強格 ≤ FINE_GROW 格、差 > FINE_WEAK 的弱格，彼此距離 ≤ FINE_REACH 就連成一處；
//        同一橫排上、水平間隔 ≤ 較高那處的高度的，合併成一處（一行裡相鄰的幾個字）。
//      以下任何一條成立就是 different：
//      - 強格佔全部格子 > FINE_MAX_AREA_BP 萬分之，或淡變化 > FINE_MAX_FAINT_BP 萬分之。
//      - 某一處的寬超過高的 LINE_RATIO_W / LINE_RATIO_H 倍：一行字變了。
//      - 某一處裡面有 ≥ BAND_LINES 條「字行」：多行字變了。上下相鄰的幾行字會被連成一塊方的，
//        只看外框的寬高比會放過（第二輪驗證的 blocker），所以把每一處再切成橫帶：
//        （a）兩張圖在那一列都幾乎沒有邊（≤ BAND_BLANK_EDGES 個）的列是行距；
//        （b）行距太窄、格子太粗時沒有全空的列，改看相對的低谷：那一列兩張都有的邊數 ≤ 最多那一列的一半，
//            而且切出來的字行高度相差不到 1.5 倍（像段落，不像圖示）。
//        一條橫帶至少 BAND_MIN_ROWS 列高、寬至少是高的 BAND_WIDE 倍，才算一條字行。
//      - 變化處超過 FINE_MAX_SPOTS 處，或只有淡變化的塊超過 FINE_MAX_RAW_SPOTS 塊。
//      沒有被判 different、細比對上有任何強格或淡變化的，就是 similar。外框是那些變化處，再把細比對上旁邊變了的格子
//      （差 1～4，淡色小字平均下去常常只剩這麼多）連成塊併進去，所以整行字換掉時框的是整行，不是其中一兩格（第四輪驗證）。
//   3. 細比對看不出任何差別（沒有一格的差 > FINE_FAINT）時，才回到全解析度確認 same：
//      逐像素比，差 > SAME_TOL 的像素一個都沒有才是 same；有的話是 similar，並把那些像素框出來。
//      細比對每格是 2×2（1280 寬）～5.3×5.3（5120 寬）～8×8（7680 寬）像素的平均，淡色小字平均下去會看不到，
//      所以 same 一定要回到原圖確認（第三輪驗證：#eee 的小字在 2560 以上的 1x 螢幕整行換掉，細比對一格都沒變）。
//      原圖灰階從哪裡來：compareImages 用 a.gray、b.gray；burstGroups 用 item.gray，或 opts.loadGray(id)（只替候選的那幾對載入）；
//      長邊 ≤ 640 的圖，細比對就是原圖（每格 1 像素），不用另外給。
//
// 門檻與實測的距離（數字來自 test/imagehash-round4.test.mjs、make-synth4.py 逐像素算的最大差，與開發時的掃描）：
//   - same 的門檻 SAME_TOL = 2（兩張各自 ±1 的解碼誤差，相差最多 2），而且差 > 2 的像素要 0 個。
//     第三輪驗證者的淡色字 1176 組裡最淡的真實內容變化：白底 #eee 11px「3 則未讀 → 5 則未讀」，
//     最大像素差 16（門檻的 8 倍），差 > 2 的像素 10 個。各顏色最淡的一組：#eee 16、#e5e5e5 24、深色底 #3c 28、
//     #ddd 31、#44 35、#50 46、#ccc 47。要比門檻還淡，字色得跟底色差 ≤ 2（#fdfdfd 字在白底上），肉眼也看不到。
//   - 其他反例離門檻更遠：細長的字搬家最大差 ≥ 134、直條圖一票換邊 ≥ 124、按鈕旁的徽章 ≥ 146、一欄數字 ≥ 225、
//     真實 Chromium 截圖 ≥ 65；灰階亮度接近的換色（Bootstrap 紅 → 綠）9。
//   - 完全一樣（逐位元組相同，或各自加 ±1 雜訊）→ same；各自加 ±2 雜訊（相差到 4）→ similar（安全的方向）。
//   - similar 與 different 的分法跟第三輪一樣：
//     - 第 3 組（勾選框）不可以是 different：7 處（上限 8，差 1 處）；「8.8 KB → 5.9 KB」那處寬高比 1.86（門檻 2.2，1.18 倍）。
//     - 第 1 組（浮動按鈕在動）：離 different 還有 dH 1、強格 9.4‱（2.7 倍）、淡變化 43.2‱（3.5 倍）、3 處、字行 1 條（要 2 條）。
//     - 第二輪驗證的 322 組反例（fixtures/imagehash/synth3）：多行字 137 組全部 different，其中 9 組剛好切出 2 條字行（在門檻上）；
//       短回覆 170 組、行事曆 4 組、成績列 4 組、淺灰小字 7 組、游標與細長的字 80 組，沒有一組是 same。
//
// 已知限制：
//   - 灰階亮度一樣的換色（紅 #ff0000 → 綠 #008400、GitHub 紅 #cf222e → 綠 #1a7f37 的狀態點）灰階差 ≤ 2，判 same。
//     面板會並排顯示兩張縮圖，使用者看得到顏色；這一期不處理。
//   - 內容一樣、只有浮動按鈕在跳：similar；按鈕只移 1 像素左右時，圓形按鈕的上下緣會變成扁長的一條，被當成「一行字」
//     判 different（不成組；驗證者的真實 Chromium 截圖 8 對裡 3 對）。安全的方向：只是少問，不會誤清。
//     第 1 組標準答案「完全一樣」其實有三個浮動按鈕在動畫（垃圾桶變色、齒輪與復原按鈕上下跳，原圖上 4875 個像素差 > 2），
//     是 similar（第四輪規格；第五輪預想表把標準答案正式改成 similar）。真正逐位元組相同的一對（07-doc-a／08-text-a）是 same。
//   - 終端機的底線游標閃一下：判 different（不成組），不是規格說的 similar。底線游標是扁長的一條（寬超過高的 2.2 倍），
//     被當成「一行字」；方塊、直條游標是 similar。第四輪驗證者的 24 組終端機截圖裡，1280×800 與 Mac 2x 的底線游標 4 組是
//     different（第三輪也一樣，不是退化）。安全的方向：只是少問，不會誤清。
//   - 多行字整段不同，在 5120 寬以上的 1x 螢幕（每格 5.3 像素，12px 的字只有 2 列格子高，不到 BAND_MIN_ROWS）
//     或每行只有 3～4 個字時，常常切不出 2 條字行，掉到 similar（安全的方向：不預設勾，而且會框出來）。
//     驗證者的 360 組：similar 70 組（BAND_WIDE 改用 ≥ 之前是 83 組），same 0 組；5120 寬 72 組裡 35 組 similar。
//   - similar 的外框是細比對格子的精度（每格 2×2～8×8 像素，往外包整格）。細比對已經看到變化時不另外回原圖，
//     所以一格裡的變化平均下去剛好沒變（差 0：例如一個像素變亮、旁邊一個變暗，或差太小四捨五入掉）的那幾個像素不一定在框裡；
//     細比對上一格都沒變的另一處變化，也不會有框。實測（原圖上差 > 2 的像素沒框到的）：
//     synth4 的 W 類（淡色小字整行換掉）138 組 similar，框蓋住那行字最少 96%，有像素沒框到的 6 組、共 127 個像素
//     （第四輪：框蓋不到 80% 的 86 組，最少 3%；有像素沒框到的 105 組、共 62269 個）。
//     第四輪驗證者的 gen_low（淡色小字 1176 組，1280～7680 寬）重跑：similar 1163 組裡有像素沒框到的 75 組、共 810 個像素
//     （第四輪 795 組、99546 個）；最多的一組是 2560 寬 11px「10:41 → 10:47」，27 個變了的像素有 12 個沒框到
//     （框只包住「1 → 7」其中一欄格子，旁邊那一欄一亮一暗平均下去沒變）。
//   - 變了的格子零星到超過 FINE_MAX_RAW_SPOTS 塊時，變化處照原本的框，另外加一個涵蓋全部變了的格子的大框（可能框住大半個畫面）。

export class ImageHashError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ImageHashError'
    this.code = code
  }
}

export type GrayImage = { width: number; height: number; gray: Uint8Array }
export type FineSig = { w: number; h: number; px: Uint8Array }
/**
 * gray 可以不給：原圖灰階（長度 width × height），只拿來在全解析度上確認 same。
 * 每張的 gray（與 fine.px）要是各自獨立、比完之前不會被改的陣列：兩張的 gray 共用同一塊記憶體時不確認 same（unverified）；
 * fine.px 共用記憶體則偵測不到（長邊 ≤ 640 的圖，細比對就是原圖，會照細比對判）。
 */
export type HashedImage = { width: number; height: number; hash: string; fine: FineSig; gray?: Uint8Array | null }
export type BurstItem = HashedImage & { id: string; takenAt: number }
export type Level = 'same' | 'similar' | 'different'
/** 變化處的外框。compareImages／burstGroups 回的是原圖像素座標；fineCompare 的 regions 是細比對的格子座標。 */
export type Box = { x: number; y: number; w: number; h: number }
/**
 * different 的原因：尺寸不同、粗指紋太遠、面積太大、一行字變了、多行字變了、變化處太多。
 * similar 只有一種原因會寫出來：'unverified'（細比對看不出差別，但沒有原圖灰階可以確認，所以不能說 same）。
 */
export type DiffReason = '' | 'size' | 'hash' | 'area' | 'line' | 'lines' | 'spots' | 'unverified'
export type Comparison = { level: Level; reason: DiffReason; boxes: Box[] }
/** boxes 是空的 similar 表示「沒辦法確認」（沒有原圖灰階）；其他 similar 一定至少有一個框。 */
export type BurstMember = { id: string; level: 'same' | 'similar'; boxes: Box[] }
/** keep 留下；drop 由新到舊；members 跟 drop 同順序，每一張跟 keep 比的等級與外框；level 取成員最差的。 */
export type BurstGroup = { keep: string; level: 'same' | 'similar'; drop: string[]; members: BurstMember[] }
/**
 * burstGroups 的選項。
 * loadGray(id)：回那一張的原圖灰階 { width, height, gray }；讀不到（檔案不見、解不開、算完指紋之後改過）就回 null。
 * 只有「細比對看不出差別、要確認是不是 same」的那幾對才會呼叫，每一張最多呼叫一次。
 * 回傳的 gray 可以是 loadGray 重複使用的同一塊輸出緩衝：留下的那張載入後 burstGroups 會複製一份，成員載入後馬上比完。
 * 但 gray 不可以跟某一張 item.gray 共用記憶體（會當成沒辦法確認，判 similar）。
 */
export type BurstOptions = { maxGapMs?: number; loadGray?: (id: string) => GrayImage | null | undefined }
/**
 * 一處變化（格子座標）：change 有強格的內容變化、faint 只有淡變化（含旁邊差 1～4 的格子，或零星小變化的總框）、
 * pixels 細比對看不到但原圖上有像素變了。
 */
export type Region = Box & { strong: number; kind: 'change' | 'faint' | 'pixels' }
/** 細比對的完整結果（回報與測試用；判斷規則跟 compareImages 是同一份）。 */
export type FineReport = {
  /** 格數相同才能比；不同時其他欄位都是 0，level 是 different。 */
  comparable: boolean
  /** 全部格子數。 */
  cells: number
  /** 強格（灰階差 > FINE_STRONG）的格數。 */
  strong: number
  /** 淡變化（灰階差 > FINE_FAINT，含強格）的格數。 */
  faint: number
  /** 變化處的數目（同一行合併之後；超過 FINE_MAX_RAW_SPOTS 時不合併，是沒合併的數目）。 */
  spots: number
  /** 最像「一行字」的那一處（寬高比最大的）；沒有變化就是 0×0。 */
  widestW: number
  widestH: number
  /** 所有變化處裡，切出最多的字行數。 */
  lines: number
  /** 每格 1 像素（cellPx 是 1）時：灰階差 > SAME_TOL 的格數（就是原圖的像素數）；每格不只 1 像素時是 -1（這一步沒辦法做）。 */
  pixels: number
  /** fineCompare 永遠不回 same（最多 similar）：只有拿到兩張原圖的 compareImages 能說 same。 */
  level: Level
  /** level 是 different 時的原因。 */
  reason: '' | 'size' | 'area' | 'line' | 'lines' | 'spots'
  /**
   * level 是 similar 時，不是 same 的原因：change 有強格的變化、faint 只有淡變化、
   * pixels 細比對看不出來但原圖上有像素的差 > SAME_TOL（每格 1 像素時才看得到）、
   * unverified 細比對看不出任何差別，沒辦法確認（手上只有細比對，不知道原圖是不是也一樣）。
   */
  notSame: '' | 'change' | 'faint' | 'pixels' | 'unverified'
  /** level 不是 different 才有：每一處變化（依上緣、左緣排序）。 */
  regions: Region[]
  /** 等於 level !== 'different'（成組）。 */
  near: boolean
}

/** 粗指紋：漢明距離 ≤ 這個值才進細比對。 */
export const DHASH_MAX = 10
/**
 * 細比對縮圖的長邊格數：至少 FINE_LONG_SIDE、每格不超過 FINE_CELL_PX 像素，最多 FINE_LONG_SIDE_MAX。
 * 1280 寬 → 640（每格 2×2）；1920 → 640（3×3）；2560 → 640（4×4）；2880 → 720；3840 → 960（4×4）；5120 → 960（5.3×5.3）。
 */
export const FINE_LONG_SIDE = 640
export const FINE_CELL_PX = 4
export const FINE_LONG_SIDE_MAX = 960
/** 一格的灰階差「大於」這個值，才算明顯不同（強格）。 */
export const FINE_STRONG = 32
/** 一格的灰階差「大於」這個值，而且離強格夠近，就算同一處變化的一部分（弱格）。 */
export const FINE_WEAK = 12
/** 弱格離最近的強格最多幾格（切比雪夫距離）。 */
export const FINE_GROW = 4
/** 兩格距離 ≤ 這個值（切比雪夫距離）就算連在一起。 */
export const FINE_REACH = 2
/** 一處變化寬 × LINE_RATIO_H > 高 × LINE_RATIO_W（寬超過高的 2.2 倍）就是「一行字變了」。 */
export const LINE_RATIO_W = 11
export const LINE_RATIO_H = 5
/** 強格佔全部格子的萬分比（‱）≤ 這個值才可能成組。 */
export const FINE_MAX_AREA_BP = 25
/** 變化處 ≤ 這麼多處才可能成組。 */
export const FINE_MAX_SPOTS = 8
/** 沒合併前的變化處、或只有淡變化的塊，超過這麼多就不成組（也讓工作量有上限）。 */
export const FINE_MAX_RAW_SPOTS = 64
/** 細比對上一格的灰階差「大於」這個值就是看得到的變化（淡變化）。±1 的解碼誤差平均之後不會超過 1。 */
export const FINE_FAINT = 4
/** 淡變化佔全部格子的萬分比 ≤ 這個值才可能成組（整頁低對比的東西都變了 → 不一樣）。 */
export const FINE_MAX_FAINT_BP = 150
/**
 * same 的門檻：原圖上一個像素的灰階差「大於」這個值就是變化，一個都不可以有。
 * 2 = 兩張各自 ±1 的解碼誤差（不同解碼器 RGB→灰階的四捨五入）加起來的最大值。
 */
export const SAME_TOL = 2
/** 切字行時，相鄰兩格灰階差「大於」這個值算一個邊。 */
export const BAND_EDGE = 16
/** 一列在兩張圖裡的邊都 ≤ 這個數，這一列就是空白（行距）。 */
export const BAND_BLANK_EDGES = 3
/** 相對低谷：一列兩張都有的邊數 × DEN ≤ 最多那一列 × NUM（一半以下）算行距。 */
export const BAND_VALLEY_NUM = 1
export const BAND_VALLEY_DEN = 2
/** 一條字行至少幾列高。 */
export const BAND_MIN_ROWS = 3
/**
 * 一條字行的寬至少要是高的幾倍（≥）。比整處的「一行字」（> 2.2 倍）嚴：一個方塊字的上半、下半（例如「想」的「相」與「心」）
 * 各自也有 2.3 倍寬，用 2.2 倍會把一個字切成兩條字行。每行 3 個字的段落剛好是 3 倍，所以用 ≥。
 */
export const BAND_WIDE = 3
/** 一處裡面有幾條字行就算「多行字變了」。 */
export const BAND_LINES = 2
/** 連拍時間窗：跟留下的那張相隔 ≤ 5 分鐘。 */
export const DEFAULT_MAX_GAP_MS = 5 * 60 * 1000

/** 淡變化（或原圖上變了的像素）的塊離某一處 ≤ 這麼多格，就算那一處的一部分（併進它的外框，不另外框）。 */
const FAINT_JOIN = 2
/** resizeGray 輸出的像素上限（先擋，才不會配置一大塊記憶體）。 */
const MAX_RESIZE_PIXELS = 1 << 22
/**
 * resizeGray 的運算量上限：先橫再直約 H×(W＋tw)＋(H＋th)×tw 次，先直再橫約 W×(H＋th)＋(W＋tw)×th 次，取便宜的那個。
 * 要兩種都超過才擋，實際上只有遠超過 png.ts 上限（4000 萬像素）的輸入會碰到。
 */
const MAX_RESIZE_OPS = 2 ** 28
/** 座標乘積的上限：所有中間值都要是精確整數。 */
const MAX_EXACT = 2 ** 52
/**
 * burstGroups 的工作量上限，超過就丟 TOO_MUCH_WORK。
 * 單位：細比對每碰一格算 1（整張掃一次算 N；弱格、連成一處、切字行、淡變化每碰一格算 1）；
 * 擴大外框（第五輪）：再掃一次 N，每個變了的格子另外算 GROW_PER_CELL，連成塊每格 10；
 * 回原圖確認 same：每 4 個像素算 1（4 個位元組一起比），每個變了的像素再算 4；留下的那張由 loadGray 載入時，複製一份每 4 個像素算 1；
 * 每看一張（就算馬上因為尺寸或指紋不同而放棄）算 WORK_PER_VISIT。
 * 開發機（2026-09 的 GB10）實測，跑滿 12 億單位才丟錯的最壞情況要 2.7～4.7 秒：
 *   - 回原圖確認、每個像素都變了（棋盤紋）：7680×4320 約 2.7～3.4 秒，1280×860 約 3.3～4.7 秒（gray 沒對齊 4 位元組時較慢；
 *     第四輪驗證者與第五輪各量一次的範圍）；
 *   - 擴大外框、細比對上每一格都差 1：約 3.1～3.2 秒（GROW_PER_CELL 照這個校準；不另外算時要 4.8～5.1 秒）；
 *   - 同一張 640×430 一直比約 1.6 ns／單位；原圖一樣時約 0.6 ns／像素（≈ 2.4 ns／單位）。
 * 筆電可能慢 2～3 倍（10 秒以上），所以接線時要放在 worker thread 裡、設時間上限。
 * 一般情況：100 組 × 20 張 640×430 的連拍（1900 次整張比完）約 5.2 億單位、0.8 秒做完。
 * 一次呼叫做得完的量（一模一樣的截圖連拍、帶原圖，每一對都要回原圖確認；第四輪驗證者量的）：1920×1080 約 1600 張、
 * 2560×1440 約 1040 張、3840×2160 約 460 張（第三輪不回原圖時是 5209、5209、2315 張）。
 * 回原圖確認只發生在「會成組」的那幾對（每張最多一次），所以總量不超過所有圖的像素總和。
 */
const MAX_WORK = 1.2e9
const WORK_PER_VISIT = 16
/** 擴大外框時每個變了的格子另外算的工作量（見 fineCore 第 9 步；照實測校準，讓每單位的時間跟其他步驟差不多）。 */
const GROW_PER_CELL = 6

const HEX16 = /^[0-9a-fA-F]{16}$/

function isPosInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
}

function checkImage(img: unknown): GrayImage {
  if (typeof img !== 'object' || img === null) throw new ImageHashError('BAD_IMAGE', '灰階圖必須是 { width, height, gray } 物件。')
  const { width, height, gray } = img as GrayImage
  if (!isPosInt(width) || !isPosInt(height)) throw new ImageHashError('BAD_IMAGE', `灰階圖的寬高必須是正整數：${String(width)}×${String(height)}。`)
  if (!(gray instanceof Uint8Array)) throw new ImageHashError('BAD_IMAGE', '灰階圖的 gray 必須是 Uint8Array。')
  if (gray.length !== width * height) throw new ImageHashError('BAD_IMAGE', `灰階資料長度 ${gray.length} 跟寬高 ${width}×${height} 對不上。`)
  // 回傳驗證過的值組成的新物件（每個欄位只讀一次，getter 沒辦法驗證後換掉）
  return { width, height, gray }
}

/** 驗證細比對資料，回傳驗證過的值組成的新物件（每個欄位只讀一次，getter 沒辦法驗證後換掉）。 */
function checkSig(sig: unknown): FineSig {
  if (typeof sig !== 'object' || sig === null) throw new ImageHashError('BAD_SIG', '細比對資料必須是 { w, h, px } 物件。')
  const { w, h, px } = sig as FineSig
  if (!isPosInt(w) || !isPosInt(h)) throw new ImageHashError('BAD_SIG', `細比對的格數必須是正整數：${String(w)}×${String(h)}。`)
  if (!(px instanceof Uint8Array) || px.length !== w * h) throw new ImageHashError('BAD_SIG', '細比對的 px 必須是長度等於 w×h 的 Uint8Array。')
  return { w, h, px }
}

function checkHash(hash: unknown): string {
  if (typeof hash !== 'string' || !HEX16.test(hash)) throw new ImageHashError('BAD_HASH', `指紋必須是 16 個 hex 字元：${JSON.stringify(hash)}。`)
  return hash
}

/** 驗證並拍下快照：之後只用快照，getter 之類的東西沒辦法前後回不同的值。gray 只留參照，不複製。 */
function checkHashed(x: unknown): HashedImage {
  if (typeof x !== 'object' || x === null) throw new ImageHashError('BAD_INPUT', '比對對象必須是 { width, height, hash, fine } 物件。')
  const v = x as HashedImage
  const width = v.width
  const height = v.height
  if (!isPosInt(width) || !isPosInt(height)) throw new ImageHashError('BAD_INPUT', `寬高必須是正整數：${String(width)}×${String(height)}。`)
  const hash = checkHash(v.hash)
  const fine = checkSig(v.fine)
  const [ew, eh] = fineDims(width, height)
  if (fine.w !== ew || fine.h !== eh) {
    throw new ImageHashError('BAD_SIG', `細比對的格數 ${fine.w}×${fine.h} 跟 ${width}×${height} 應有的 ${ew}×${eh} 不同（可能是舊版算的，要重算）。`)
  }
  const g = v.gray
  let gray: Uint8Array | null = null
  if (g !== undefined && g !== null) {
    if (!(g instanceof Uint8Array) || g.length !== width * height) throw new ImageHashError('BAD_IMAGE', `gray 必須是長度 ${width}×${height} 的 Uint8Array（原圖灰階）。`)
    gray = g
  }
  return { width, height, hash, fine, gray }
}


// TypedArray 內建的 buffer／byteOffset／byteLength（不經過子類別可能改寫的 getter）
const TA_PROTO = Object.getPrototypeOf(Uint8Array.prototype) as object
function taGetter(name: string): (this: Uint8Array) => unknown {
  return (Object.getOwnPropertyDescriptor(TA_PROTO, name) as PropertyDescriptor).get as (this: Uint8Array) => unknown
}
const TA_BUFFER = taGetter('buffer')
const TA_OFFSET = taGetter('byteOffset')
const TA_LENGTH = taGetter('byteLength')

/** 非負整數的四捨五入除法 round(n / d)，結果精確（n、d 都是 2^53 以內的整數）。 */
function roundDiv(n: number, d: number): number {
  const num = 2 * n + d
  const den = 2 * d
  let q = Math.floor(num / den)
  while (q > 0 && q * den > num) q--
  while ((q + 1) * den <= num) q++
  return q
}

/**
 * 面積平均縮放（box filter），放大縮小都可以。
 * 以「來源長 × 目標長」為一條軸的總刻度：來源第 x 格佔 [x·tw, (x+1)·tw)，目標第 tx 格佔 [tx·W, (tx+1)·W)，
 * 重疊長度都是整數。每個目標格的值 = Σ 來源像素 × 重疊面積 ÷ 目標格面積（W·H），最後四捨五入（.5 進位）。
 * 全程精確整數，結果可重現；中間只配置 tw、th、tw×th 大小的陣列。
 * 兩種掃描順序（先橫再直、先直再橫）加總的是同一批整數，結果逐位元組相同；挑運算量小的那個，
 * 所以 1×4000 萬這種細長的圖也很快（先直再橫）。
 */
export function resizeGray(img: GrayImage, tw: number, th: number): Uint8Array {
  const { width: W, height: H, gray: g } = checkImage(img)
  if (!isPosInt(tw) || !isPosInt(th)) throw new ImageHashError('BAD_SIZE', `目標尺寸必須是正整數：${String(tw)}×${String(th)}。`)
  if (tw * th > MAX_RESIZE_PIXELS) throw new ImageHashError('TOO_LARGE', `目標尺寸 ${tw}×${th} 太大（上限 ${MAX_RESIZE_PIXELS} 像素）。`)
  if (W * tw > MAX_EXACT || H * th > MAX_EXACT || W * H * 512 > MAX_EXACT) throw new ImageHashError('TOO_LARGE', `尺寸 ${W}×${H} → ${tw}×${th} 超出精確整數運算的範圍。`)
  const rowsFirst = H * (W + tw) + (H + th) * tw
  const colsFirst = W * (H + th) + (W + tw) * th
  if (Math.min(rowsFirst, colsFirst) > MAX_RESIZE_OPS) throw new ImageHashError('TOO_LARGE', `尺寸 ${W}×${H} → ${tw}×${th} 的運算量太大。`)
  const acc = rowsFirst <= colsFirst ? resizeRowsFirst(g, W, H, tw, th) : resizeColsFirst(g, W, H, tw, th)
  const area = W * H
  const out = new Uint8Array(tw * th)
  for (let i = 0; i < out.length; i++) out[i] = roundDiv(acc[i], area)
  return out
}

/** 先橫再直：每一列先算出對每個目標欄的加權和，再加到它蓋到的目標列。 */
function resizeRowsFirst(g: Uint8Array, W: number, H: number, tw: number, th: number): Float64Array {
  const x0 = new Float64Array(tw)
  for (let tx = 0; tx < tw; tx++) x0[tx] = Math.floor((tx * W) / tw)
  const row = new Float64Array(tw)
  const acc = new Float64Array(tw * th)
  for (let y = 0; y < H; y++) {
    // 水平：這一列對每個目標欄的加權和（權重總和 = W）
    const base = y * W
    for (let tx = 0; tx < tw; tx++) {
      const lo = tx * W
      const hi = lo + W
      let s = 0
      for (let x = x0[tx]; x * tw < hi; x++) {
        const ov = Math.min((x + 1) * tw, hi) - Math.max(x * tw, lo)
        s += g[base + x] * ov
      }
      row[tx] = s
    }
    // 垂直：這一列蓋到的目標列（權重總和 = H）
    const ylo = y * th
    const yhi = ylo + th
    for (let ty = Math.floor(ylo / H); ty * H < yhi; ty++) {
      const ov = Math.min(yhi, (ty + 1) * H) - Math.max(ylo, ty * H)
      const o = ty * tw
      for (let tx = 0; tx < tw; tx++) acc[o + tx] += row[tx] * ov
    }
  }
  return acc
}

/** 先直再橫：每一欄先算出對每個目標列的加權和，再加到它蓋到的目標欄。跟先橫再直是同一個總和。 */
function resizeColsFirst(g: Uint8Array, W: number, H: number, tw: number, th: number): Float64Array {
  const y0 = new Float64Array(th)
  for (let ty = 0; ty < th; ty++) y0[ty] = Math.floor((ty * H) / th)
  const col = new Float64Array(th)
  const acc = new Float64Array(tw * th)
  for (let x = 0; x < W; x++) {
    // 垂直：這一欄對每個目標列的加權和（權重總和 = H）
    for (let ty = 0; ty < th; ty++) {
      const lo = ty * H
      const hi = lo + H
      let s = 0
      for (let y = y0[ty]; y * th < hi; y++) {
        const ov = Math.min((y + 1) * th, hi) - Math.max(y * th, lo)
        s += g[y * W + x] * ov
      }
      col[ty] = s
    }
    // 水平：這一欄蓋到的目標欄（權重總和 = W）
    const xlo = x * tw
    const xhi = xlo + tw
    for (let tx = Math.floor(xlo / W); tx * W < xhi; tx++) {
      const ov = Math.min(xhi, (tx + 1) * W) - Math.max(xlo, tx * W)
      for (let ty = 0; ty < th; ty++) acc[ty * tw + tx] += col[ty] * ov
    }
  }
  return acc
}

/**
 * 粗指紋：縮成 9×8，每列比較相鄰兩格，「左 < 右」（嚴格小於）記 1。
 * 列優先、高位先，輸出 16 個小寫 hex。
 * png.ts 上限（4000 萬像素）以內的圖，不論多細長都算得出來。更大的輸入會丟 TOO_LARGE；
 * 呼叫端（掃描器）遇到 dHash／fineSig 丟的任何 ImageHashError，都要把那一張當成「不比對」（不參加連拍分組），不要讓整批出錯。
 */
export function dHash(img: GrayImage): string {
  const p = resizeGray(img, 9, 8)
  let hex = ''
  for (let r = 0; r < 8; r++) {
    let byte = 0
    for (let c = 0; c < 8; c++) {
      byte = (byte << 1) | (p[r * 9 + c] < p[r * 9 + c + 1] ? 1 : 0)
    }
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

function popcount32(v: number): number {
  let x = v >>> 0
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

function hashHalves(hash: string): [number, number] {
  return [parseInt(hash.slice(0, 8), 16), parseInt(hash.slice(8), 16)]
}

/** 兩個 dHash 不同的位元數（0～64）。 */
export function hamming(a: string, b: string): number {
  const [ah, al] = hashHalves(checkHash(a))
  const [bh, bl] = hashHalves(checkHash(b))
  return popcount32(ah ^ bh) + popcount32(al ^ bl)
}

/**
 * 細比對縮圖的格數：長邊 S = ⌈長邊 ÷ FINE_CELL_PX⌉，夾在 FINE_LONG_SIDE～FINE_LONG_SIDE_MAX 之間；
 * 另一邊照比例（.5 進位，至少 1 格）；本來就不比 S 大的圖原樣。
 */
export function fineDims(width: number, height: number): [number, number] {
  if (!isPosInt(width) || !isPosInt(height)) throw new ImageHashError('BAD_INPUT', `寬高必須是正整數：${String(width)}×${String(height)}。`)
  const L = Math.max(width, height)
  const S = Math.min(FINE_LONG_SIDE_MAX, Math.max(FINE_LONG_SIDE, Math.floor((L + FINE_CELL_PX - 1) / FINE_CELL_PX)))
  if (L <= S) return [width, height]
  return [Math.max(1, roundDiv(width * S, L)), Math.max(1, roundDiv(height * S, L))]
}

/** 細比對用的縮圖（格數見 fineDims）。 */
export function fineSig(img: GrayImage): FineSig {
  const { width: W, height: H } = checkImage(img)
  const [w, h] = fineDims(W, H)
  return { w, h, px: resizeGray(img, w, h) }
}


// ── 細比對 ────────────────────────────────────────────────────────

// 共用的暫存（單執行緒，不會重入），用「戳記」避免每次清空：
//   regMark[k] === regStamp 表示在「變化範圍」裡還沒編號；regStamp + 1 + r 表示編進第 r 處（沒合併前）。
//   faintMark[k] === faintStamp 表示淡變化還沒走過；faintStamp + 1 表示走過。
const REG_SPAN = FINE_MAX_RAW_SPOTS + 2
let regMark = new Int32Array(0)
let regStamp = 0
let faintMark = new Int32Array(0)
let faintStamp = 0
function nextRegStamp(n: number): number {
  if (regMark.length < n) {
    regMark = new Int32Array(n)
    regStamp = 0
  }
  if (regStamp > 0x3fff0000) {
    regMark.fill(0)
    regStamp = 0
  }
  regStamp += REG_SPAN
  return regStamp
}
function nextFaintStamp(n: number): number {
  if (faintMark.length < n) {
    faintMark = new Int32Array(n)
    faintStamp = 0
  }
  if (faintStamp > 0x3fff0000) {
    faintMark.fill(0)
    faintStamp = 0
  }
  faintStamp += 2
  return faintStamp
}

type CellBox = { x0: number; x1: number; y0: number; y1: number }
type Group = CellBox & { raws: number[]; strong: number }
type FaintBlob = CellBox & { anchored: boolean }

function isStrong(d: number): boolean {
  return d > FINE_STRONG || d < -FINE_STRONG
}

/** 兩個外框的切比雪夫間隔（相鄰是 0、重疊也是 0）。 */
function boxGap(p: CellBox, q: CellBox): number {
  const gx = Math.max(q.x0 - p.x1, p.x0 - q.x1) - 1
  const gy = Math.max(q.y0 - p.y1, p.y0 - q.y1) - 1
  return Math.max(0, gx, gy)
}

/** 最近一次 fineCore／confirmFull 的工作量（burstGroups 累加用；單執行緒，不會被別的呼叫插隊）。 */
let lastCost = 0

/**
 * 零散的小塊併成外框（給面板框）：相距 ≤ FAINT_JOIN 格，或同一橫排、水平間隔 ≤ 較高那塊的高度，就併成一框（傳遞閉包）。
 * 工作量（塊數的平方）加在回傳值的第二項。
 */
function mergeBlobs(list: CellBox[]): [CellBox[], number] {
  const fp = list.map((_, i) => i)
  const ffind = (i: number): number => {
    while (fp[i] !== i) {
      fp[i] = fp[fp[i]]
      i = fp[i]
    }
    return i
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const P = list[i]
      const Q = list[j]
      const tall = Math.max(P.y1 - P.y0 + 1, Q.y1 - Q.y0 + 1)
      const sameRow = (P.y1 < Q.y1 ? P.y1 : Q.y1) >= (P.y0 > Q.y0 ? P.y0 : Q.y0)
      const gap = (P.x0 > Q.x0 ? P.x0 : Q.x0) - (P.x1 < Q.x1 ? P.x1 : Q.x1) - 1
      if (boxGap(P, Q) <= FAINT_JOIN || (sameRow && gap <= tall)) fp[ffind(i)] = ffind(j)
    }
  }
  const fbox = new Map<number, CellBox>()
  for (let i = 0; i < list.length; i++) {
    const r = ffind(i)
    const c = list[i]
    const m = fbox.get(r)
    if (m === undefined) fbox.set(r, { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 })
    else {
      if (c.x0 < m.x0) m.x0 = c.x0
      if (c.x1 > m.x1) m.x1 = c.x1
      if (c.y0 < m.y0) m.y0 = c.y0
      if (c.y1 > m.y1) m.y1 = c.y1
    }
  }
  return [[...fbox.values()], list.length * list.length]
}

/**
 * 有變化的格子（mask[k] 非 0）連成一塊一塊（相鄰 8 格）。cells 是全部有變化的格子。
 * 塊數超過 FINE_MAX_RAW_SPOTS（到處都有零星變化）就不再細分，整片回一個外框（第三項是 true）。
 * 回傳三項：塊的外框、工作量、是不是整片。mask 會被改掉（走過的格子歸零）。
 */
function maskBlobs(mask: Uint8Array, w: number, h: number, cells: number[]): [CellBox[], number, boolean] {
  let work = 0
  const blobs: CellBox[] = []
  const all = { x0: w, x1: -1, y0: h, y1: -1 }
  const stack: number[] = []
  let tooMany = false
  for (const start of cells) {
    const sx = start % w
    const sy = (start - sx) / w
    if (sx < all.x0) all.x0 = sx
    if (sx > all.x1) all.x1 = sx
    if (sy < all.y0) all.y0 = sy
    if (sy > all.y1) all.y1 = sy
    if (tooMany || mask[start] === 0) continue
    const blob = { x0: w, x1: -1, y0: h, y1: -1 }
    mask[start] = 0
    stack.push(start)
    while (stack.length > 0) {
      const j = stack.pop() as number
      const x = j % w
      const y = (j - x) / w
      if (x < blob.x0) blob.x0 = x
      if (x > blob.x1) blob.x1 = x
      if (y < blob.y0) blob.y0 = y
      if (y > blob.y1) blob.y1 = y
      const ya = y === 0 ? 0 : y - 1
      const yb = y === h - 1 ? y : y + 1
      const xa = x === 0 ? 0 : x - 1
      const xb = x === w - 1 ? x : x + 1
      for (let yy = ya; yy <= yb; yy++) {
        for (let xx = xa; xx <= xb; xx++) {
          const k = yy * w + xx
          if (mask[k] !== 0) {
            mask[k] = 0
            stack.push(k)
          }
        }
      }
      work += 9
    }
    blobs.push(blob)
    if (blobs.length > FINE_MAX_RAW_SPOTS) tooMany = true
  }
  work += cells.length
  if (tooMany) return [[all], work, true]
  return [blobs, work, false]
}

/** maskBlobs 連成的塊再用 mergeBlobs 併成外框。回傳外框與工作量（兩項的陣列）。 */
function maskRegions(mask: Uint8Array, w: number, h: number, cells: number[]): [CellBox[], number] {
  const [blobs, work, whole] = maskBlobs(mask, w, h, cells)
  if (whole) return [blobs, work]
  const [merged, cost] = mergeBlobs(blobs)
  return [merged, work + cost]
}

/**
 * 細比對本體。a、b 必須已驗證、格數相同。
 * full：每格就是原圖的 1 個像素（細比對就是原圖），細比對看不出差別時可以直接在這裡確認 same。
 * early 為 true 時（burstGroups），一確定 different 就停。工作量放在 lastCost。
 */
function fineCore(a: Uint8Array, b: Uint8Array, w: number, h: number, full: boolean, early: boolean): FineReport {
  const N = w * h
  const report: FineReport = {
    comparable: true, cells: N, strong: 0, faint: 0, spots: 0, widestW: 0, widestH: 0, lines: 0, pixels: -1,
    level: 'different', reason: '', notSame: '', regions: [], near: false,
  }
  let work = 0
  const finish = (): FineReport => {
    report.near = report.level !== 'different'
    lastCost = work
    return report
  }

  // 1. 強格、淡變化的面積（淡變化的位置記下來，第 7 步只從這些格子出發，不用再掃整張）；
  //    順便數「變了的格子」（同一個迴圈，不另外算工作量）：每格 1 像素時是原圖上差 > SAME_TOL 的像素，
  //    每格不只 1 像素時是差 ≠ 0 的格子（淡色小字平均下去常常只剩 1～4）。第 9 步的外框要涵蓋這些格子
  const seeds: number[] = []
  const faintCells: number[] = []
  let faint = 0
  let changed = 0
  const growTol = full ? SAME_TOL : 0
  const strongLimit = FINE_MAX_AREA_BP * N
  const faintLimit = FINE_MAX_FAINT_BP * N
  for (let i = 0; i < N; i++) {
    const d = a[i] - b[i]
    if (d > growTol || d < -growTol) changed++
    if (d > FINE_FAINT || d < -FINE_FAINT) {
      faint++
      if (faint * 10000 <= faintLimit) faintCells.push(i)
      if (d > FINE_STRONG || d < -FINE_STRONG) seeds.push(i)
      if (early && (seeds.length * 10000 > strongLimit || faint * 10000 > faintLimit)) {
        work += i + 1
        report.strong = seeds.length
        report.faint = faint
        report.reason = 'area'
        return finish()
      }
    }
  }
  work += N
  report.strong = seeds.length
  report.faint = faint
  if (full) report.pixels = changed
  if (seeds.length * 10000 > strongLimit || faint * 10000 > faintLimit) {
    report.reason = 'area'
    return finish()
  }

  // 2. 變化範圍：強格，加上離強格 ≤ FINE_GROW 格的弱格
  const stamp = nextRegStamp(N)
  const mark = regMark
  for (let s = 0; s < seeds.length; s++) {
    const i = seeds[s]
    const x = i % w
    const y = (i - x) / w
    const ya = y - FINE_GROW < 0 ? 0 : y - FINE_GROW
    const yb = y + FINE_GROW >= h ? h - 1 : y + FINE_GROW
    const xa = x - FINE_GROW < 0 ? 0 : x - FINE_GROW
    const xb = x + FINE_GROW >= w ? w - 1 : x + FINE_GROW
    for (let yy = ya; yy <= yb; yy++) {
      for (let xx = xa; xx <= xb; xx++) {
        const k = yy * w + xx
        const d = a[k] - b[k]
        if ((d > FINE_WEAK || d < -FINE_WEAK) && mark[k] < stamp) mark[k] = stamp
      }
    }
    work += (yb - ya + 1) * (xb - xa + 1)
  }

  // 3. 連成一處一處（從強格出發；距離 ≤ FINE_REACH 就相連）
  const boxes: CellBox[] = []
  const stack: number[] = []
  for (let s = 0; s < seeds.length; s++) {
    const seed = seeds[s]
    if (mark[seed] !== stamp) continue // 已經編進某一處
    if (boxes.length >= FINE_MAX_RAW_SPOTS) {
      report.spots = boxes.length + 1
      report.reason = 'spots'
      return finish()
    }
    const id = stamp + 1 + boxes.length
    const box = { x0: w, x1: -1, y0: h, y1: -1 }
    mark[seed] = id
    stack.push(seed)
    while (stack.length > 0) {
      const j = stack.pop() as number
      const x = j % w
      const y = (j - x) / w
      if (x < box.x0) box.x0 = x
      if (x > box.x1) box.x1 = x
      if (y < box.y0) box.y0 = y
      if (y > box.y1) box.y1 = y
      const ya = y - FINE_REACH < 0 ? 0 : y - FINE_REACH
      const yb = y + FINE_REACH >= h ? h - 1 : y + FINE_REACH
      const xa = x - FINE_REACH < 0 ? 0 : x - FINE_REACH
      const xb = x + FINE_REACH >= w ? w - 1 : x + FINE_REACH
      for (let yy = ya; yy <= yb; yy++) {
        for (let xx = xa; xx <= xb; xx++) {
          const k = yy * w + xx
          if (mark[k] === stamp) {
            mark[k] = id
            stack.push(k)
          }
        }
      }
      work += (yb - ya + 1) * (xb - xa + 1)
    }
    boxes.push(box)
  }

  // 4. 同一橫排、水平間隔 ≤ 較高那處的高度 → 同一處（傳遞閉包）
  const parent = boxes.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const P = boxes[i]
      const Q = boxes[j]
      if ((P.y1 < Q.y1 ? P.y1 : Q.y1) < (P.y0 > Q.y0 ? P.y0 : Q.y0)) continue // 沒有共同的列
      const gap = (P.x0 > Q.x0 ? P.x0 : Q.x0) - (P.x1 < Q.x1 ? P.x1 : Q.x1) - 1
      const tall = Math.max(P.y1 - P.y0 + 1, Q.y1 - Q.y0 + 1)
      if (gap <= tall) parent[find(i)] = find(j)
    }
  }
  work += boxes.length * boxes.length
  const groupOfRoot = new Map<number, number>()
  const groups: Group[] = []
  const rawGroup = new Int32Array(boxes.length)
  for (let i = 0; i < boxes.length; i++) {
    const r = find(i)
    const c = boxes[i]
    let gi = groupOfRoot.get(r)
    if (gi === undefined) {
      gi = groups.length
      groupOfRoot.set(r, gi)
      groups.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, raws: [], strong: 0 })
    } else {
      const m = groups[gi]
      if (c.x0 < m.x0) m.x0 = c.x0
      if (c.x1 > m.x1) m.x1 = c.x1
      if (c.y0 < m.y0) m.y0 = c.y0
      if (c.y1 > m.y1) m.y1 = c.y1
    }
    groups[gi].raws.push(i)
    rawGroup[i] = gi
  }
  // 每一處的強格（依編號歸屬，外框重疊的別處不算）
  const groupCells: number[][] = groups.map(() => [])
  for (let s = 0; s < seeds.length; s++) {
    const k = seeds[s]
    const gi = rawGroup[mark[k] - stamp - 1]
    groupCells[gi].push(k)
    groups[gi].strong++
  }
  work += seeds.length

  // 5. 形狀：一行字
  let line = false
  for (const g of groups) {
    const gw = g.x1 - g.x0 + 1
    const gh = g.y1 - g.y0 + 1
    // 寬高比最大的那一處（交叉相乘比較，不經浮點）
    if (report.widestW === 0 || gw * report.widestH > report.widestW * gh) {
      report.widestW = gw
      report.widestH = gh
    }
    if (gw * LINE_RATIO_H > gh * LINE_RATIO_W) line = true
  }
  report.spots = groups.length
  if (line) {
    report.reason = 'line'
    return finish()
  }

  // 6. 多行字：每一處切成橫帶
  for (let gi = 0; gi < groups.length; gi++) {
    const n = countLines(a, b, w, groups[gi], groupCells[gi])
    work += 2 * (groups[gi].x1 - groups[gi].x0 + 1) * (groups[gi].y1 - groups[gi].y0 + 1)
    if (n > report.lines) report.lines = n
  }
  if (report.lines >= BAND_LINES) {
    report.reason = 'lines'
    return finish()
  }
  if (groups.length > FINE_MAX_SPOTS) {
    report.reason = 'spots'
    return finish()
  }

  // 7. 淡變化連成一塊一塊（相鄰 8 格）；只有強格、沒有淡變化時不用走
  const blobs: FaintBlob[] = []
  if (faint > seeds.length) {
    const fs = nextFaintStamp(N)
    const fm = faintMark
    let loose = 0
    for (let c = 0; c < faintCells.length; c++) {
      const i = faintCells[c]
      if (fm[i] === fs + 1) continue
      const blob: FaintBlob = { x0: w, x1: -1, y0: h, y1: -1, anchored: false }
      fm[i] = fs + 1
      stack.push(i)
      while (stack.length > 0) {
        const j = stack.pop() as number
        const x = j % w
        const y = (j - x) / w
        if (isStrong(a[j] - b[j])) blob.anchored = true
        if (x < blob.x0) blob.x0 = x
        if (x > blob.x1) blob.x1 = x
        if (y < blob.y0) blob.y0 = y
        if (y > blob.y1) blob.y1 = y
        const ya = y === 0 ? 0 : y - 1
        const yb = y === h - 1 ? y : y + 1
        const xa = x === 0 ? 0 : x - 1
        const xb = x === w - 1 ? x : x + 1
        for (let yy = ya; yy <= yb; yy++) {
          for (let xx = xa; xx <= xb; xx++) {
            const k = yy * w + xx
            if (fm[k] === fs + 1) continue
            const d = a[k] - b[k]
            if (d > FINE_FAINT || d < -FINE_FAINT) {
              fm[k] = fs + 1
              stack.push(k)
            }
          }
        }
        work += 9
      }
      blobs.push(blob)
      if (!blob.anchored && !groups.some(g => boxGap(blob, g) <= FAINT_JOIN)) loose++
      if (loose > FINE_MAX_RAW_SPOTS) {
        report.reason = 'spots'
        return finish()
      }
    }
  }

  // 8. same 還是 similar：細比對上有任何強格或淡變化就是 similar；
  //    細比對看不出差別時，每格 1 像素才能在這裡確認（原圖上差 > SAME_TOL 的像素一個都沒有），否則要回原圖（unverified）
  let notSame: FineReport['notSame'] = ''
  if (groups.length > 0) notSame = 'change'
  else if (blobs.length > 0) notSame = 'faint'
  else if (!full) notSame = 'unverified'
  else if (changed > 0) notSame = 'pixels'
  report.notSame = notSame
  report.level = notSame === '' ? 'same' : 'similar'

  // 9. 外框：每一處變化（離它的外框 ≤ FAINT_JOIN 格的淡變化併進去，併完外框變大，再看一次，直到沒有可以併的）；
  //    其餘的淡變化另外併成外框；只有原圖上的小變化（pixels）時，框那些像素。
  //    外框要涵蓋細比對上每一格變了的（第 1 步的 changed）：還有比淡變化更小的變化時，把變了的格子全部連成塊，
  //    取代淡變化的塊（每一塊淡變化都在某一塊裡）。淡色小字整行換掉時，細比對上常常只有一兩格 > FINE_FAINT，
  //    其他格子只差 1～4，只框淡變化會只框到一個小角（第四輪驗證）。只影響外框，不影響等級（等級在上面已經定了）。
  //    變了的格子零星到超過 FINE_MAX_RAW_SPOTS 塊時，變化處與淡變化照原本的框，另外加一個涵蓋全部變了的格子的框。
  const regions: Region[] = []
  const out = groups.map(g => ({ x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1 }))
  let lone: CellBox[] = blobs
  let whole: CellBox | null = null
  if ((notSame === 'change' || notSame === 'faint') && changed > faint) {
    const gmask = new Uint8Array(N)
    const gcells: number[] = []
    for (let i = 0; i < N; i++) {
      const d = a[i] - b[i]
      if (d > growTol || d < -growTol) {
        gmask[i] = 1
        gcells.push(i)
      }
    }
    // 工作量：掃一次 N；每個變了的格子另外算 GROW_PER_CELL（放進清單、連成塊時的堆疊，實測比掃描貴），連成塊照 maskBlobs 算
    work += N + GROW_PER_CELL * gcells.length
    const [gb, gcost, tooMany] = maskBlobs(gmask, w, h, gcells)
    work += gcost
    if (tooMany) whole = gb[0]
    else lone = gb
  }
  for (let changedBox = groups.length > 0; changedBox; ) {
    changedBox = false
    const rest: CellBox[] = []
    for (const f of lone) {
      let gi = -1
      for (let j = 0; j < out.length && gi < 0; j++) if (boxGap(f, out[j]) <= FAINT_JOIN) gi = j
      if (gi < 0) {
        rest.push(f)
        continue
      }
      const o = out[gi]
      if (f.x0 < o.x0) o.x0 = f.x0
      if (f.x1 > o.x1) o.x1 = f.x1
      if (f.y0 < o.y0) o.y0 = f.y0
      if (f.y1 > o.y1) o.y1 = f.y1
      changedBox = true
    }
    work += lone.length * out.length
    lone = rest
  }
  for (let gi = 0; gi < groups.length; gi++) {
    const o = out[gi]
    regions.push({ x: o.x0, y: o.y0, w: o.x1 - o.x0 + 1, h: o.y1 - o.y0 + 1, strong: groups[gi].strong, kind: 'change' })
  }
  const [faintBoxes, mcost] = mergeBlobs(lone)
  work += mcost
  if (whole !== null) faintBoxes.push(whole)
  for (const f of faintBoxes) regions.push({ x: f.x0, y: f.y0, w: f.x1 - f.x0 + 1, h: f.y1 - f.y0 + 1, strong: 0, kind: 'faint' })
  if (notSame === 'pixels') {
    const mask = new Uint8Array(N)
    const cells: number[] = []
    for (let i = 0; i < N; i++) {
      const d = a[i] - b[i]
      if (d > SAME_TOL || d < -SAME_TOL) {
        mask[i] = 1
        cells.push(i)
      }
    }
    work += N
    const [pb, pcost] = maskRegions(mask, w, h, cells)
    work += pcost
    for (const f of pb) regions.push({ x: f.x0, y: f.y0, w: f.x1 - f.x0 + 1, h: f.y1 - f.y0 + 1, strong: 0, kind: 'pixels' })
  }
  regions.sort((p, q) => p.y - q.y || p.x - q.x)
  report.regions = regions
  return finish()
}

/**
 * 一處變化裡有幾條「字行」（兩種切法取多的）。cells 是這一處的強格。
 * （a）兩張圖在那一列的邊都 ≤ BAND_BLANK_EDGES 個 → 空白列；（b）兩張都有的邊數 ≤ 最多那一列的一半 → 相對低谷，
 *     而且切出來的字行高度相差不到 1.5 倍。字行：至少 BAND_MIN_ROWS 列、寬（那幾列強格的左右範圍）至少是高的 BAND_WIDE 倍。
 */
function countLines(a: Uint8Array, b: Uint8Array, w: number, g: CellBox, cells: number[]): number {
  const gh = g.y1 - g.y0 + 1
  const blank = new Uint8Array(gh)
  const act = new Int32Array(gh)
  const rx0 = new Int32Array(gh).fill(w)
  const rx1 = new Int32Array(gh).fill(-1)
  let peak = 0
  for (let y = g.y0; y <= g.y1; y++) {
    let ea = 0
    let eb = 0
    const base = y * w
    for (let x = g.x0; x < g.x1; x++) {
      const da = a[base + x + 1] - a[base + x]
      const db = b[base + x + 1] - b[base + x]
      if (da > BAND_EDGE || da < -BAND_EDGE) ea++
      if (db > BAND_EDGE || db < -BAND_EDGE) eb++
    }
    const r = y - g.y0
    blank[r] = ea <= BAND_BLANK_EDGES && eb <= BAND_BLANK_EDGES ? 1 : 0
    act[r] = ea < eb ? ea : eb
    if (act[r] > peak) peak = act[r]
  }
  for (const k of cells) {
    const x = k % w
    const r = (k - x) / w - g.y0
    if (x < rx0[r]) rx0[r] = x
    if (x > rx1[r]) rx1[r] = x
  }
  const split = (gapRow: (r: number) => boolean): number[] => {
    const heights: number[] = []
    let r = 0
    while (r < gh) {
      while (r < gh && gapRow(r)) r++
      if (r >= gh) break
      const r0 = r
      let bx0 = w
      let bx1 = -1
      while (r < gh && !gapRow(r)) {
        if (rx0[r] < bx0) bx0 = rx0[r]
        if (rx1[r] > bx1) bx1 = rx1[r]
        r++
      }
      const bh = r - r0
      const bw = bx1 - bx0 + 1
      if (bx1 >= 0 && bh >= BAND_MIN_ROWS && bw >= BAND_WIDE * bh) heights.push(bh)
    }
    return heights
  }
  const strict = split(r => blank[r] === 1).length
  const rel = split(r => act[r] * BAND_VALLEY_DEN <= peak * BAND_VALLEY_NUM)
  let relLines = 0
  if (rel.length > 0) {
    const hi = Math.max(...rel)
    const lo = Math.min(...rel)
    if (2 * hi <= 3 * lo) relLines = rel.length
  }
  return strict > relLines ? strict : relLines
}

/**
 * 回原圖確認 same：兩張原圖灰階逐像素比，差 > SAME_TOL 的像素一個都沒有才是 same；
 * 有的話是 similar，外框是那些像素（先標到細比對的格子上再連成塊，換回原圖座標時整格往外包）。
 * x 提供尺寸與細比對格數；ga、gb 必須是長度 width × height 的原圖灰階。工作量放在 lastCost。
 */
function confirmFull(x: HashedImage, ga: Uint8Array, gb: Uint8Array): Comparison {
  const W = x.width
  const H = x.height
  const w = x.fine.w
  const h = x.fine.h
  const n = W * H
  // 變了的像素標到細比對的格子上：第 px 個像素的左緣落在第 ⌊px × w ÷ W⌋ 格（toPixels 整格往外包，一定框得到這個像素）
  const mask = new Uint8Array(w * h)
  const colCell = new Int32Array(W)
  for (let c = 0; c < W; c++) colCell[c] = Math.floor((c * w) / W)
  const cells: number[] = []
  let changed = 0
  const mark = (i: number): void => {
    const d = ga[i] - gb[i]
    if (d <= SAME_TOL && d >= -SAME_TOL) return
    changed++
    const y = Math.floor(i / W)
    const k = Math.floor((y * h) / H) * w + colCell[i - y * W]
    if (mask[k] === 0) {
      mask[k] = 1
      cells.push(k)
    }
  }
  // 一樣的地方最多：4 個位元組一起比，不一樣才逐一看（兩個陣列都對齊 4 位元組時）
  let i = 0
  const ao = TA_OFFSET.call(ga) as number
  const bo = TA_OFFSET.call(gb) as number
  if (ao % 4 === 0 && bo % 4 === 0) {
    const q = n >>> 2
    const wa = new Uint32Array(TA_BUFFER.call(ga) as ArrayBuffer, ao, q)
    const wb = new Uint32Array(TA_BUFFER.call(gb) as ArrayBuffer, bo, q)
    for (let j = 0; j < q; j++) {
      if (wa[j] !== wb[j]) {
        const o = j << 2
        mark(o)
        mark(o + 1)
        mark(o + 2)
        mark(o + 3)
      }
    }
    i = q << 2
  }
  for (; i < n; i++) if (ga[i] !== gb[i]) mark(i)
  // 工作量：4 個像素一起比算 1；每個變了的像素另外算 4（要逐一換算格子）；建格子對照表算 W
  let work = Math.ceil(n / 4) + W + 4 * changed
  if (changed === 0) {
    lastCost = work
    return { level: 'same', reason: '', boxes: [] }
  }
  const [boxes, cost] = maskRegions(mask, w, h, cells)
  work += cost
  lastCost = work
  const regions: Region[] = boxes.map(f => ({ x: f.x0, y: f.y0, w: f.x1 - f.x0 + 1, h: f.y1 - f.y0 + 1, strong: 0, kind: 'pixels' }))
  regions.sort((p, q) => p.y - q.y || p.x - q.x)
  return { level: 'similar', reason: '', boxes: regions.map(r => toPixels(r, x)) }
}

/**
 * 兩份細比對資料的完整比較結果（格數不同就是不能比）。回報與測試用：每個欄位都算完、不提早停；批次請用 compareImages／burstGroups。
 * 永遠不回 same（最多 similar）：fineCompare 手上只有細比對，不知道它是不是原圖，細比對看不出差別時一律回
 * similar、notSame 'unverified'（外框是空的）。要確認 same 請用 compareImages（帶原圖灰階，或長邊 ≤ 640 的圖）。
 * cellPx：一格是原圖幾像素（原圖寬 ÷ 格數，預設 1）。1 的時候細比對就是原圖：pixels 回報差 > SAME_TOL 的格數，
 * 細比對看不到淡變化、但有格子差 > SAME_TOL 時回 similar／'pixels' 並框出那些格子；外框涵蓋差 > SAME_TOL 的格子。
 * 大於 1 時 pixels 是 -1，外框涵蓋差 ≠ 0 的格子。
 */
export function fineCompare(a: FineSig, b: FineSig, cellPx?: number): FineReport {
  const A = checkSig(a)
  const B = checkSig(b)
  let px = 1
  if (cellPx !== undefined) {
    if (typeof cellPx !== 'number' || !Number.isFinite(cellPx) || cellPx < 1) throw new ImageHashError('BAD_INPUT', `cellPx 必須是 ≥ 1 的有限數字：${String(cellPx)}。`)
    px = cellPx
  }
  if (A.w !== B.w || A.h !== B.h) {
    return { comparable: false, cells: 0, strong: 0, faint: 0, spots: 0, widestW: 0, widestH: 0, lines: 0, pixels: -1, level: 'different', reason: 'size', notSame: '', regions: [], near: false }
  }
  const r = fineCore(A.px, B.px, A.w, A.h, px === 1, false)
  if (r.level === 'same') {
    // 第四輪驗證：單獨呼叫（預設 cellPx = 1）時，拿一般截圖的細比對來比也會回 same，原圖其實不同
    r.level = 'similar'
    r.notSame = 'unverified'
  }
  return r
}

/** 格子座標的外框換成原圖像素座標（整格往外包）。 */
function toPixels(r: Region, x: HashedImage): Box {
  const W = x.width
  const H = x.height
  const w = x.fine.w
  const h = x.fine.h
  const px0 = Math.floor((r.x * W) / w)
  const py0 = Math.floor((r.y * H) / h)
  const px1 = Math.min(W, Math.ceil(((r.x + r.w) * W) / w))
  const py1 = Math.min(H, Math.ceil(((r.y + r.h) * H) / h))
  return { x: px0, y: py0, w: px1 - px0, h: py1 - py0 }
}

/**
 * 兩個陣列是不是共用同一塊記憶體：同一個 ArrayBuffer，而且範圍重疊（剛好相鄰不算）。
 * 共用的話，其中一張很可能已經被呼叫端的下一次解碼蓋掉（loadGray 重複用同一塊輸出緩衝），內容一樣也不能說 same。
 */
function sharesMemory(p: Uint8Array, q: Uint8Array): boolean {
  if (TA_BUFFER.call(p) !== TA_BUFFER.call(q)) return false
  const po = TA_OFFSET.call(p) as number
  const qo = TA_OFFSET.call(q) as number
  return po < qo + (TA_LENGTH.call(q) as number) && qo < po + (TA_LENGTH.call(p) as number)
}

/** 沒辦法確認 same：similar，外框是空的。 */
function unverified(): Comparison {
  return { level: 'similar', reason: 'unverified', boxes: [] }
}

/** 回原圖確認 same；兩張共用同一塊記憶體時沒辦法確認（unverified）。工作量放在 lastCost。 */
function confirmPair(x: HashedImage, ga: Uint8Array, gb: Uint8Array): Comparison {
  if (sharesMemory(ga, gb)) {
    lastCost = 0
    return unverified()
  }
  return confirmFull(x, ga, gb)
}

/**
 * 內部共用的判斷（compareImages、isNearDuplicate、burstGroups 都走這裡，規則只有一份）。
 * a、b 必須已經驗證過（checkHashed 的快照）；ah、bh 是先拆好的指紋上下 32 位元。工作量放在 lastCost。
 * 細比對看不出差別、兩張都有原圖灰階時，直接回原圖確認；少一張、或兩張共用同一塊記憶體，就回 similar／'unverified'
 *（burstGroups 會再用 loadGray 補）。
 */
function compareChecked(a: HashedImage, b: HashedImage, ah: [number, number], bh: [number, number], early: boolean): Comparison {
  lastCost = 0
  if (a.width !== b.width || a.height !== b.height) return { level: 'different', reason: 'size', boxes: [] }
  if (popcount32(ah[0] ^ bh[0]) + popcount32(ah[1] ^ bh[1]) > DHASH_MAX) return { level: 'different', reason: 'hash', boxes: [] }
  // 同尺寸、驗證過 → 細比對格數一定相同；還是再擋一次，別讓格數不同的資料混進來
  if (a.fine.w !== b.fine.w || a.fine.h !== b.fine.h) return { level: 'different', reason: 'size', boxes: [] }
  const full = a.fine.w === a.width && a.fine.h === a.height
  const r = fineCore(a.fine.px, b.fine.px, a.fine.w, a.fine.h, full, early)
  if (r.level === 'different') return { level: 'different', reason: r.reason, boxes: [] }
  if (r.notSame === 'unverified') {
    if (a.gray && b.gray) {
      const cost = lastCost
      const c = confirmPair(a, a.gray, b.gray)
      lastCost += cost
      return c
    }
    return unverified()
  }
  return { level: r.level, reason: '', boxes: r.regions.map(g => toPixels(g, a)) }
}

/**
 * 兩張截圖比出等級（same／similar／different）與每一處變化的外框（原圖像素座標；different 不回外框）。
 * 規則見檔頭。對稱：compareImages(a, b) 跟 compareImages(b, a) 的等級一樣。
 * same 要在原圖上確認：a、b 都要帶 gray（原圖灰階），長邊 ≤ 640 的圖不用帶（細比對就是原圖）。
 * 沒有帶、或兩張的 gray 共用同一塊記憶體（同一個 ArrayBuffer、範圍重疊），細比對又看不出差別
 * → { level: 'similar', reason: 'unverified', boxes: [] }。
 */
export function compareImages(a: HashedImage, b: HashedImage): Comparison {
  const A = checkHashed(a)
  const B = checkHashed(b)
  return compareChecked(A, B, hashHalves(A.hash), hashHalves(B.hash), false)
}

/** 兩張會不會成組（等級不是 different）。不需要原圖灰階。 */
export function isNearDuplicate(a: HashedImage, b: HashedImage): boolean {
  return compareImages(a, b).level !== 'different'
}

/**
 * 連拍分組。
 * 規則：由新到舊（時間一樣時 id 大的先）逐張當「留下的那張」；還沒分組的較舊的張，
 * 若跟它同尺寸、相隔 ≤ maxGapMs、而且等級不是 different，就歸進這一組。
 * 每一張都是跟留下的那張比，不串連（A 像 B、B 像 C 不代表 A 會跟 C 同組）。
 * 至少兩張才成組。輸出的組依留下那張由新到舊；drop 與 members 也由新到舊。
 * 每個成員帶跟留下那張比的等級與外框（原圖像素座標）；整組的等級取成員最差的（有一張 similar 就是 similar）。
 * id 的大小用字串的 UTF-16 碼位比較（不受語系影響）。
 *
 * same 的確認（原圖灰階）：
 *   - 細比對看不出差別的那幾對，才需要原圖。先用 item.gray；沒有的話呼叫 opts.loadGray(id)。
 *   - 留下的那張在第一次需要時載入，整組比完就放掉；成員載入、比完就放掉。會成組的才會載入，
 *     所以每一張最多載入一次（留下的那張不會再當成員，成員分組之後不會再被看到）。
 *   - loadGray 回 null（或沒給 loadGray、item 也沒有 gray）→ 那一對判 similar（外框是空的），不會是 same。
 *   - loadGray 回的寬高跟 item 不同 → 丟 BAD_IMAGE（指紋是舊的，要重算）。loadGray 自己丟的錯照原樣往外丟。
 *
 * 記憶體（細比對格數 N = fine.w × fine.h，最多 960 × 960 = 921,600 格：正方形或直式的大圖；長邊 ≤ 640 的圖 N 就是像素數，最多 409,600）：
 *   - 每張的細比對資料 N 位元組：1920×1080 → 640×360 約 230 KB、1280×860 → 640×430 約 275 KB、4K／5K → 960×540 約 518 KB，
 *     正方形或直式的大圖最多約 900 KB。
 *   - 回原圖確認時，同一時間最多握著兩張原圖灰階（留下的那張＋正在確認的那張），每張 width × height 位元組：
 *     1920×1080 約 2 MB、2880×1800 約 5.2 MB、3840×2160 約 8.3 MB、png.ts 的上限 4000 萬像素約 40 MB。
 *     留下的那張是 loadGray 載入的，會另外複製一份（loadGray 自己的緩衝還在它手上，所以連呼叫端算最多三份）。
 *     item.gray 與 loadGray 自己的快取是呼叫端握著的，不算在這裡。
 *   - 每次比對的暫存（比完就放掉）：
 *     - 標記表：Uint8Array(N)，最多 921,600 位元組（回原圖確認、框出變了的像素、擴大外框各一張，不會同時存在）。
 *     - 變了的格子清單、連成一處／一塊時的堆疊、強格清單：一般的 JS 陣列，每一項 8 位元組（陣列長大時多留一些容量），
 *       最壞（每一格都變了）各自可以到 N 項：960×960 時每個約 7.4～11 MB。burstGroups 一確定 different 就停，
 *       強格清單最多到面積上限（N 的萬分之 25）；compareImages／fineCompare 會算完。
 *     - 格子對照表：Int32Array，長度是原圖寬，7680 寬約 30 KB；切字行時每一處的列資料（那一處的高度 × 13 位元組）。
 *   - 常駐：細比對的兩張戳記表（Int32Array(N)，960×960 時各約 3.7 MB），模組載入後一直留著，只會變大、不會縮小。
 *   - 呼叫端可以先照時間排序，在相鄰兩張相隔 > maxGapMs 的地方切開分批呼叫（跨過這種空檔的兩張不可能同組，結果一樣），
 *     也可以只替「前後 maxGapMs 內有別張」的圖算細比對。
 * 工作量超過上限會丟 TOO_MUCH_WORK，呼叫端要接住並分批：先照時間空檔切；連續截圖（例如每 5 秒自動截一張）沒有空檔可切時，
 * 照張數切成連續的幾段（例如每段 300 張）。切點兩邊的兩張不會同組，只會少問、不會誤清。
 */
export function burstGroups(items: BurstItem[], opts?: BurstOptions): BurstGroup[] {
  if (!Array.isArray(items)) throw new ImageHashError('BAD_INPUT', 'items 必須是陣列。')
  let maxGap = DEFAULT_MAX_GAP_MS
  let loadGray: ((id: string) => GrayImage | null | undefined) | null = null
  if (opts !== undefined && opts !== null) {
    if (typeof opts !== 'object') throw new ImageHashError('BAD_INPUT', 'opts 必須是物件。')
    const m = opts.maxGapMs
    if (m !== undefined) {
      if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) throw new ImageHashError('BAD_INPUT', `maxGapMs 必須是 ≥ 0 的有限數字：${String(m)}。`)
      maxGap = m
    }
    const lg = opts.loadGray
    if (lg !== undefined && lg !== null) {
      if (typeof lg !== 'function') throw new ImageHashError('BAD_INPUT', 'loadGray 必須是函式。')
      loadGray = lg
    }
  }

  const n = items.length
  const ids = new Set<string>()
  const snap: HashedImage[] = new Array(n)
  const idOf: string[] = new Array(n)
  const timeOf = new Float64Array(n)
  const halves: [number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const it = items[i]
    if (typeof it !== 'object' || it === null) throw new ImageHashError('BAD_INPUT', `第 ${i} 筆不是物件。`)
    const id = it.id
    if (typeof id !== 'string') throw new ImageHashError('BAD_INPUT', `第 ${i} 筆的 id 必須是字串。`)
    if (ids.has(id)) throw new ImageHashError('BAD_INPUT', `id 重複：${id}。`)
    ids.add(id)
    const t = it.takenAt
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new ImageHashError('BAD_INPUT', `${id} 的 takenAt 必須是有限數字。`)
    snap[i] = checkHashed(it)
    idOf[i] = id
    timeOf[i] = t
    halves[i] = hashHalves(snap[i].hash)
  }

  let work = 0
  const tooMuch = (): ImageHashError => new ImageHashError('TOO_MUCH_WORK', '連拍分組的比對量超過上限，請分批呼叫。')

  /**
   * 第 i 張的原圖灰階：item.gray，否則 loadGray；讀不到回 null。
   * keep 為 true（留下的那張）時，loadGray 回的陣列複製一份：留下的那張要跟之後好幾個成員比，
   * 這段時間 loadGray 可能把同一塊輸出緩衝拿去解別張（第四輪驗證：這樣內容不同的兩張會被判 same）。
   * 複製算工作量（每 4 個像素算 1，跟原圖比對一樣快）。成員載入之後馬上比完，不用複製。
   */
  const grayOf = (i: number, keep: boolean): Uint8Array | null => {
    const s = snap[i]
    if (s.gray) return s.gray
    if (loadGray === null) return null
    const r = loadGray(idOf[i])
    if (r === null || r === undefined) return null
    const img = checkImage(r)
    if (img.width !== s.width || img.height !== s.height) {
      throw new ImageHashError('BAD_IMAGE', `loadGray(${idOf[i]}) 回的圖是 ${img.width}×${img.height}，跟指紋的 ${s.width}×${s.height} 不同（檔案改過，要重算指紋）。`)
    }
    if (!keep) return img.gray
    const n = s.width * s.height
    work += Math.ceil(n / 4)
    if (work > MAX_WORK) throw tooMuch()
    const own = new Uint8Array(img.gray)
    if (own.length !== n) throw new ImageHashError('BAD_IMAGE', `loadGray(${idOf[i]}) 回的灰階長度 ${own.length} 跟 ${s.width}×${s.height} 對不上。`)
    return own
  }

  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => {
    const d = timeOf[b] - timeOf[a]
    if (d !== 0) return d
    const ia = idOf[a]
    const ib = idOf[b]
    return ia < ib ? 1 : ia > ib ? -1 : 0
  })

  // skip[p]：從排序位置 p 往後第一個還沒分組的位置（路徑壓縮）。已分組的張之後完全不會再被看到。
  const skip = new Int32Array(n + 1)
  for (let p = 0; p <= n; p++) skip[p] = p
  const nextFree = (p: number): number => {
    let r = p
    while (skip[r] !== r) r = skip[r]
    while (skip[p] !== r) {
      const nx = skip[p]
      skip[p] = r
      p = nx
    }
    return r
  }

  const groups: BurstGroup[] = []
  for (let p = nextFree(0); p < n; p = nextFree(p)) {
    const ki = order[p]
    skip[p] = p + 1 // 自己成為留下的那張，之後不再被看到
    const k = snap[ki]
    const drop: string[] = []
    const members: BurstMember[] = []
    let level: 'same' | 'similar' = 'same'
    // 留下那張的原圖灰階：undefined 還沒載入；null 讀不到
    let keepGray: Uint8Array | null | undefined
    for (let q = nextFree(p + 1); q < n; q = nextFree(q + 1)) {
      const mi = order[q]
      // 由新到舊排好了：一旦超出時間窗，後面只會更舊
      if (timeOf[ki] - timeOf[mi] > maxGap) break
      work += WORK_PER_VISIT
      if (work > MAX_WORK) throw tooMuch()
      // 永遠跟留下的那張（k）比，不跟組裡其他張比
      let c = compareChecked(k, snap[mi], halves[ki], halves[mi], true)
      work += lastCost
      if (work > MAX_WORK) throw tooMuch()
      if (c.reason === 'unverified') {
        // 細比對看不出差別，但有一張沒有原圖灰階：補載入再確認；讀不到就維持 similar
        if (keepGray === undefined) keepGray = grayOf(ki, true)
        if (keepGray !== null) {
          const mg = grayOf(mi, false)
          if (mg !== null) {
            c = confirmPair(k, keepGray, mg)
            work += lastCost
            if (work > MAX_WORK) throw tooMuch()
          }
        }
      }
      if (c.level !== 'different') {
        drop.push(idOf[mi])
        members.push({ id: idOf[mi], level: c.level, boxes: c.boxes })
        if (c.level === 'similar') level = 'similar'
        skip[q] = q + 1
      }
    }
    if (drop.length > 0) groups.push({ keep: idOf[ki], level, drop, members })
  }
  return groups
}
