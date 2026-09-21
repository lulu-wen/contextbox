---
layout: default
title: 讓每個檔都有資料夾可以放（P7）
---

# 讓每個檔都有資料夾可以放

**狀態：做完了，實機跑過。** 純邏輯在 `core/grouping.ts`，有副作用的那半邊在
`core/grouping-run.ts`，指令是 `node cli.mjs group`；測試在 `test/grouping.test.mjs`（36 條）
與 `test/grouping-run.test.mjs`（26 條）。

這份規格改過三次，三次都是**實機資料推翻了紙上的假設**。最後一節記了改的過程 ——
那幾個假設錯得很典型，值得留著。

---

## 問題

使用者 2026-09-21：

> rename 或 file 的清單應該還要根據 agent 自己讀到的所有檔案去做總結說可以歸類成哪些。
> 而不是因為 rule 裡面只有要歸類 course 就其他都不幫忙分類？
>
> 不一定要課程名稱? 像是 CV 就是 personal file 之類的阿? 如果只用學校 課程當然分不出來

**這個工具只有「課程」一個分類軸。** `filing.ts` 一行就把不屬於任何課的檔全部放棄：

```js
const course = cleanCourse(opinion.course)
if (!course) continue          // 課名說不出來 → 整個檔放棄
```

而使用者的 Downloads 裡大半是 CV、自傳、推薦書、獎學金表單、法規、論文、規格書 ——
**它們本來就不屬於任何一堂課**。實機量出來：202 筆答案裡 186 筆 `course=Unknown`，
其中 145 筆連 `topic` 都是 Unknown，而真正拿到建議的只有 3 個。

問題不是模型看不懂，是**被問錯問題**。

---

## 設計

### 一、逐檔一次呼叫，兩個軸

| 欄位 | 說明 |
|---|---|
| `whatItIs` | **一定有。** 這是什麼文件，模型自己的話（`resume`／`lab handout`／`feasibility study`） |
| `subject` | 關於什麼 |
| `course` | **只在真的屬於某門課或專案時才填**，否則 `Unknown` |
| `kind` | 固定 enum，留著（`Courses/<課名>/<kind>` 的第二層要用） |
| `confidence` | 對 `whatItIs` 的把握 |

**`course=Unknown` 不再是失敗**，只是「這不是課程教材」。

實測（使用者的端點，一次呼叫就同時拿到兩個軸）：

```
2026-lab1-subnet-arp.pdf      → lab handout                | course=CS3103 (high)
Introduction to Database…pdf  → course syllabus            | course=Introduction to Database Systems (high)
Peng-Ju_Wen_CV_1.docx         → resume                     | course=Unknown (high)
cuBB-GB10-可行性評估.pptx       → feasibility study          | course=Unknown (high)
NUS-Biz-Exchange-Factsheet    → exchange program factsheet | course=Unknown (high)
team19_assignment3_report2    → coursework report          | course=Unknown (high)
```

六個全部拿到可用的 `whatItIs`。

### 二、分類從 whatItIs 長出來（centroid）

使用者：

> 像是 centroid 的感覺一樣，看那些檔案都比較靠近哪一個點? 以那個點來做分類之類的
> 所以應該是要根據 whatItIs 來看要如何衍生出新的分類

**不是對檔案分群，是對「不重複的 whatItIs 說法」分群：**

```
1164 個檔  →  取 distinct whatItIs  →  一兩百種說法
              →  一次呼叫，收斂成 ~8 個資料夾
              →  「說法 → 資料夾」的對照表
```

「點」是**從資料自己長出來的**，不是預先寫死的。而且因為對象是說法不是檔案，
**1164 個檔跟 100 個檔成本一樣**，都是一次呼叫。

每個檔跟著自己的 `whatItIs` 走 → **每個讀得懂的檔都有資料夾可以放**。這是這一期的目標。

### 三、歸檔的路徑

```
course 說得出來  →  Courses/<課名>/<kind>     完全不變，learned 偏好照舊
course 說不出來  →  Filed/<分類>/              新的，分類來自上面那張對照表
```

兩條路互斥，一個檔只會走一條 —— 不然使用者會看到兩個互相矛盾的目的地。

### 為什麼不用 embeddings

使用者的端點上有 `bge-m3`，真的算距離做得到。**但不做**：那會讓這個功能依賴
「端點剛好有 embedding 模型」，而這個 repo 的底線是沒有模型也要能跑，
有模型的人也不該被要求要有第二個模型。

之後要加是很容易的加速路徑：新的 `whatItIs` 出現時不必重問整張表，直接算它最近的點。

---

## 預想的預期行為

### 送出去的東西

1. 分類那一次送的是**不重複的 `whatItIs` 說法**，一行一個。
   **不送檔名、不送 evidence、不送 file_texts 的原文** —— 分類只需要「模型自己的說法」。
   （測試逐字比對：`test/grouping-run.test.mjs` 的「送出去的東西不含檔名、不含原文」。）
2. 逐檔那一次照舊送檔名與內文（檔名進 prompt 是 v3-en 的事，見 commit 2419b14），
   照樣過機密防線。

### 分類的形狀

3. 一組分類包含：`name`（資料夾名）、`why`（一句人話）、`members`（哪些說法）。
4. **`name` 會變成磁碟上的資料夾名** → 走 `cleanGroupName`：
   去路徑分隔符號、控制字元、Windows 保留名與不合法字元、前後的點、截到 40 碼位。
   洗完是空的就整組丟掉。
5. **一個說法最多只能對到一個資料夾**，重複的留第一個 —— 跨批也一樣。
5b. **什麼都裝得下的名字不算資料夾**（`Misc`／`Other`／`Documents`／`Technical`⋯）。
   提示詞裡講了，但**叫了不等於守了**：實機第一次跑就回了一個 `Miscellaneous`，
   裡面塞了九種毫不相干的東西。所以 `cleanGroupName` 直接把這些名字洗成空的，整組丟掉，
   它的說法算「沒對到」。只擋**整個名字就是那些字**的 —— `Lecture materials`、
   `Application forms` 照過，因為它們真的說得出裡面是什麼。
6. **沒對到的說法就是沒對到**，畫面要講出來有幾個，不可以安靜消失。
7. 組數上限 `MAX_GROUPS`（12）。超過就取涵蓋說法最多的前 12 組，其餘算「沒對到」，
   而且數字加起來要等於總數。

### 安全性（跟這個專案其他部分同一條線）

8. **提議不是動作。** `group` 指令**一個檔都不動**，只寫一張對照表。
9. 套用走**既有的歸檔執行層**（`filing.ts` 的搬移與 journal）—— 先寫 journal、再動檔案、
   七天內可復原、跨磁碟不支援。不新開一條搬檔的路。
10. **模型碰不到路徑。** 它回的是分類名稱，路徑一律由程式組、洗過、再檢查一次
    在不在 `filed` 底下。跟 P3／P4 同一條不變量。
11. 對照表存進資料庫，**重新分類會整份取代**，不會累積出兩份互相矛盾的。

### 指令與畫面

12. `node cli.mjs group` —— 問模型、產生對照表並印出來（**不動檔案**）
13. `node cli.mjs group --show` —— 只看上一次那張表（不問模型、什麼都不寫，唯讀模式也看得到）
14. `node cli.mjs group --apply [分類名…]` —— 套用；不給名字就是全部。
    復原用 `node cli.mjs file --undo`（**同一條路徑、同一本 journal**，不另開一套）
15. 唯讀模式：`group` 與 `group --apply` 不做（離開碼 1），`group --show` 照樣看得到。
16. 面板多一區「提議的分法」，跟改名／歸檔同一種列：勾選框、理由、View contents、
    一組一顆按鈕，旁邊永遠有「復原」。空的時候整區不顯示。**（還沒做。）**

---

## 釘住的那幾條

純邏輯在 `test/grouping.test.mjs`（36 條）：

1. 分類名稱是 `../../etc` → `etc`；`/etc/passwd` → `⋯`（`cleanField` 更早就擋掉）
2. Windows 保留名（`CON`／`NUL`／`COM1`）→ 空字串 → 整組丟掉
3. 一個成員出現在兩組裡 → 只進第一組
4. 組數超過 12 → 取前 12 大，**數字加起來等於總數**
5. 模型回的不是陣列／壞掉 → 空陣列，不丟例外
6. 每個自由文字欄位都有 `maxLength`（2026-09-21 的教訓，見下）

有副作用的那半邊在 `test/grouping-run.test.mjs`（26 條）：

7. 分類那一次的 payload **不含檔名、不含 evidence、不含原文**（逐字比對送出去的 body）
8. `group` 跑完，磁碟上**一個檔都沒動**，`filed` 底下也沒多出東西
9. `course` 說得出來的檔不會進分類那一份
10. 重新分類一次 → 舊對照表整份被取代（上一輪的說法查不到了）
11. 一個檔的 `whatItIs` 不在對照表裡 → 它算「沒對到」，不會被塞進隨便一組
12. 一批失敗 → 其他批照樣寫得進去；**全部失敗 → 一個字都不寫**，舊表還在
13. 被切成半截的 JSON 是失敗，不是半筆資料
14. 什麼都裝得下的名字（`Miscellaneous`）→ 整組丟掉，它的說法算沒對到
15. **整條線**：分類 → 建議 → 真的搬進 `filed/<分類>/`。
    同一條測試先釘住「不把 folder 帶下去就會被『沒有可用的課名』擋掉」——
    那正是接線時真的漏掉的一行

---

## 這份規格改過三次，四個假設錯了

留著是因為錯的方式很典型。

**假設一：「模型早就分類好了，是規則層把它丟掉的。」**
只對了一部分。`kind` 是有值的，但 `topic` 在 84 筆殘料裡只有 8 筆有 ——
逐檔的 prompt 把 `course` 與 `topic` 綁在同一個問題上，答不出課名就整組欄位一起空掉。
所以原本設計的摘要行 `檔名 | kind | topic` 對 76/84 的檔等於送
`某檔.docx | Other | Unknown`，**分組那一次拿不到任何信號**。

**假設二：「那就多一道 describe pass，只跑殘料。」**
方向對，但多花一趟。實測發現**一次呼叫就能同時問兩件事**，
所以那 ~650 次額外呼叫整個不需要。`core/describe.ts` 的 prompt 與 schema
直接併進 `model.ts` 的主 schema。

**假設三：「`PROMPT_VERSION` 不用換，快取全部留著。」**
換了。查 syllabus 為什麼認不出課名的時候發現**檔名從來沒進過 prompt**
（commit 2419b14），那個必須換版本。既然已經換了，這一期把兩個軸一起併進去
就不再有額外的快取成本 —— 反而是**現在改最划算**。

**假設四：「一次呼叫就分得完，一千個檔跟一百個檔同價。」**
一半對。對象是「說法」不是檔案這件事是對的 —— 1266 個檔收斂成 177 種說法。
但**一次問 177 行行不通**：實機（Qwen3-VL-8B）171 秒回來的答案在 `max_tokens` 被切成半截；
把上限拉到 4000 就變成 307 秒、閘道直接斷線。而且沒被切掉的那部分也不能看 ——
模型把 18 到 120 號連號的一整段倒進同一個 `Technical Reports`，**那不是分類，那是切蛋糕**。

改成 40 個一批：一批 42 秒，名字變成 `Lab reports`／`Exams`／`Scholarship applications`
這種真的像資料夾的名字。後面幾批帶著前面已經取好的名字（`carryOver`），
能沿用就沿用，最後照名字折大小寫併起來（`mergePhraseGroups`）。
**分批不是為了省錢，是因為分批的答案才是對的。**

實機最後的結果：354 個不屬於任何課的檔、177 種說法、5 批、約 4 分鐘 → 12 個資料夾。

順帶在查的路上撞到兩個會吃掉答案的 bug，都修了：
`evidence` 沒有長度上限（模型把整份文件倒進去，JSON 撐爆，整筆丟掉，
而且那三個檔每輪重問、每次燒 50 秒，commit bb301b1）；
以及引文裡一個**裸 TAB** 就讓 `JSON.parse` 失敗、整筆答案被當成失敗
（表格與投影片抄出來的引文很常帶 TAB，commit 2419b14）。
**所以新的 schema 每一個自由文字欄位都有 `maxLength`** —— 同一個坑不踩第二次。
