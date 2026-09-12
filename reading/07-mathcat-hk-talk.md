# MathCat（AI Tinkerers 香港場 · Top AI Demos #43 本期首選）

講者：Natalia Kojoukhova（BAT，Global Head of Change - Digital Business Solutions）
場次：AI Tinkerers Hong Kong 八月聚會（與 OAX Foundation、GM.Asia 合辦）· 2026-08-31
專案：<https://mathcat.fun/>
影片：會員限定，抓不到；以下摘要為講者自己寫的 talk 說明（由 lulumi 提供）

## 講者原文（verbatim）

> MathCat.fun is an adaptive, bilingual math and science practice platform for Hong Kong
> primary school children, aligned to the EDB curriculum and playable as a Progressive Web App.
>
> For this demo, I'll walk through the full stack, not just the game UI. Live, I'll briefly show
> the working app (different play modes, leaderboard, rewards shop, etc); but will focus more on
> the backend:
> (1) the question-generation and validation workflow – the balance between deterministic and
>     probabilistic models to achieve the best outcome and my learnings;
> (2) talk about the AI critic pipeline (Gemini + GPT-5) that scores each question template on
>     Cantonese naturalness, HK school terminology, hint quality, and age fit;
> (3) the adaptive progression architecture—mastery gates, recent-accuracy windows, skill unlocks, etc;
> (4) the overall architecture.

技術棧（來自 Top AI Demos #43 條目）：Gemini 2、GPT-5、Supabase、Cursor、OpenAI
遊戲層細節：Cat Randomizer／Fast Cat 等模式、答對 +10 魚幣加連勝加成、
XP Stars 從 Kitten 升到 Invincible、排行榜、Rewards Shop、雙語課綱對齊題庫。

---

## 為什麼這篇是首選（四個可抄的點）

### 1. 他選擇講後端，不講畫面

「I'll walk through the full stack, not just the game UI... but will focus more on the backend.」
遊戲 UI 只是「briefly show」。這是刻意的取捨，而且贏了。

**推論**：這個社群（以及這次黑克松的評審池）獎勵的是**背後的工程判斷**，
不是漂亮的截圖。demo 腳本要照這個比例分配時間。

### 2. deterministic 與 probabilistic 的分工

他把「題目生成與驗證」的核心描述成 **the balance between deterministic and
probabilistic models**——確定性（寫死的規則、模板、程式）與機率性（LLM）之間的平衡。

注意：講者說明沒有寫出他最後的分配比例，那部分在影片裡（會員限定）。
我們知道的是：**他把這件事框成「平衡問題」，並且當成整場最重要的第一點來講。**

這和 [01](01-openrouter-antifragile-agents.md)、[02](02-agent-harness-for-your-domain.md)
是同一個結論的第三次獨立出現：

| 來源 | 同一件事的說法 |
|---|---|
| 01 OpenRouter | 模型只出 3 欄位意圖，算錢與政策交給有測試的 TypeScript（14/20 → 20/20） |
| 02 Reef harness | 領域慣例寫成有型別的函式，不要寫成 prompt 句子（44.87% → 82.6%） |
| 07 MathCat | question generation 的核心是 deterministic 與 probabilistic 的平衡 |

小學數學題特別適合這個切法：題目結構、數字範圍、難度階梯、答案正確性
全都可以用程式產生並驗證；LLM 只負責它真正擅長的——把題目講成自然的人話。

### 3. AI critic 打分在「模板」上，不是在每一題上

Gemini + GPT-5 組成 critic pipeline，對**每個題目模板**（question template）打分，四個面向：

- Cantonese naturalness（廣東話自然度）
- HK school terminology（香港學校用語）
- hint quality（提示品質）
- age fit（年齡合適度）

這個設計很省。評分跑在模板上（數量有限、離線跑一次），
不是跑在每次出的題目上（數量無限、即時、要花錢又會慢）。
產出的題目由確定性的模板保證品質，模板本身由 LLM critic 把關。

**這招在黑克松很好用**：你可以在活動前就把 critic 跑完，
現場的即時路徑完全不含 LLM 評分，快又穩。

### 4. 適性難度全靠確定性邏輯

mastery gates（精熟門檻）、recent-accuracy windows（近期正確率視窗）、
skill unlocks（技能解鎖）——這些都是可預測的程式邏輯，不是叫模型「判斷這孩子準備好了嗎」。

呼應 [02](02-agent-harness-for-your-domain.md) 的 runtime constraint：
會出事的決策用程式強制，不要用 prompt 拜託。

---

## 兩個額外的觀察

**PWA，不是 App。**
Progressive Web App = 用網頁技術做、可以加到手機桌面、不用上架商店的應用。
對這次黑克松的「in your pocket」方向很實用：零安裝摩擦，
評審打開連結就能玩，不用 TestFlight、不用側載。

**贏在地方性，不是贏在技術新奇。**
對齊香港 EDB 課綱、廣東話自然度、香港學校用語——這些是全球任何一隊都複製不了的東西。
它不是「又一個 AI 家教」，它是「香港小學生的 AI 家教」。

編輯給它的評語點出了同一件事：
> 「產品挑戰非常具體：給小孩一個理由去試下一題。」

**這條對 [[rokid-sign-language-project]] 的台灣手語路線直接適用**——
TSL、繁體中文、台灣本地情境，同樣是 53 個城市裡沒人能碰的地方性優勢。
在全球評審池裡，地方性是差異化，不是限制。
