# Agents, Everywhere: Bots, Channels, & More — 全球黑克松（新加坡場）

整理日期：2026-09-08　狀態：已收到 Invitation Confirmed，位子確定

## 一、基本資料

| 項目 | 內容 |
|---|---|
| 日期 | 2026-09-12（六） |
| 時間 | 10:00–19:00（GMT+8） |
| 地點 | 新加坡，場地錄取後才公布（venue partner：LorongAI） |
| 規模 | 全球 53 城同日開跑；新加坡 200 席 |
| 主辦 | Georgian 主辦、Human Feedback Foundation 製作、AI Tinkerers 承辦 |
| 資格 | builders-only、申請制、審核後 RSVP |
| 隊伍人數 | **無限制**（原文：Come with a team, come solo, or find collaborators at the event） |
| 費用 | 頁面未提（未列票價） |

活動頁：<https://singapore.aitinkerers.org/p/agents-everywhere-bots-channels-more-global-hackathon>
全球頁：<https://aitinkerers.org/hackathons/global/agents-everywhere>
題目說明最完整的版本（NYC 場）：<https://nyc.aitinkerers.org/p/agents-everywhere-beyond-the-chatbot-global-hackathon-with-openai>

> 註：新加坡場的 hackathon 細節頁 <https://singapore.aitinkerers.org/hackathons/h_vcU0_9d1qqI>
> 被 Cloudflare 的機器人驗證擋住，程式抓不到。裡面可能有評分細則、starter repo、
> 贊助商 credit 兌換碼——需要本人登入瀏覽器看，或複製內容貼出來。

## 二、當天流程

| 時間 | 事項 |
|---|---|
| 10:00–10:30 | 報到、吃東西、找隊友 |
| 10:30–11:00 | 講者：Gabriel Chua（OpenAI）、Bryan Seah（ClickHouse）、Gladys（Airwallex） |
| 11:00–11:30 | 組隊 |
| **11:30–15:30** | **實作（只有 4 小時）** |
| 15:30–16:30 | 分三組向評審 demo |
| 16:30–17:30 | 入圍名單、pitch |
| 17:30–18:30 | 評審討論、宣布 |
| 18:30–19:00 | 頒獎 |

## 三、題目

一句話：**Build a working agent that belongs somewhere new.**
翻譯：做一個「住在人們原本就在用的地方」的 agent。不要再做獨立聊天機器人。

官方給四個方向（是靈感，不是分組、不用選邊）：

- **At work** — Slack、Teams、email、文件、行事曆、工單、客服、即時協作
- **In your pocket** — 即時訊息、手機、通知、短的非同步時刻
- **On the web** — 瀏覽器與軟體裡，agent 能查、能導覽、能交易、能動手
- **In the room** — 語音、視覺、穿戴裝置、機器人、其他實體介面

官方唯一的取向提示：**A sharp, working demo beats a broad concept.**
（一個小而能跑的 demo 勝過一個大概念。）

## 四、評分與獎

- 全球共用**一個**評審池，所有城市的作品一起比。
- **現場沒有正式評審**——當天的 demo 只是互相分享學習。
- 評分細則（rubric）與獎項分類：官方說「活動前公布」，目前**尚未公布**。
- 新加坡場獎品：第一名 1,000 美元 Codex credits + ChatGPT Pro 3 個月；
  第二名 500 美元 + 3 個月；第三名 250 美元 + 3 個月。

新加坡場評審 7 人（看得出偏企業／金融／政府應用）：
Danny Thien（SMBC Group）、Neelesh Bhatia（InnovNation CEO）、JJ（Onloop CEO）、
Sai Visesh Suresh（OpenAI）、Peng Ong（MHV）、Hongyi Li（GovTech Singapore）、
Sam Waldo（Airwallex）。

## 五、交件

截止：**2026-09-12 17:00 EDT ＝ 2026-09-13 05:00 台北／新加坡時間**
（新加坡場 19:00 結束後還有約 10 小時緩衝。）

1. 專案名稱
2. 文字說明（做了什麼、給誰用、為什麼這個情境重要）
3. 公開 GitHub repo，程式可執行
4. 2 分鐘 demo 影片
5. 社群貼文，tag 贊助商

## 六、贊助商與工具

Marquee：**OpenAI**
Sponsors：CopilotKit、OpenRouter、Exa、Auth0、Ambiguous AI、ClickHouse、Trigger.dev、Mozilla、Google Cloud Run
Community partners：LorongAI（場地）、Asia-AI、JobsTaylor、Airwallex

各家負責的那一塊：

- **CopilotKit / Channels SDK** — 把 agent 送進 Slack、Teams、Discord、Telegram，
  帶原生互動 UI（按鈕、表單），不只純文字。活動名稱裡的「Channels」幾乎就是指這個。
  <https://github.com/CopilotKit/channels-sdk>
  需 Node.js 22+、TypeScript。`npm install @copilotkit/channels @copilotkit/runtime`
  吃任何 AG-UI 相容 agent（LangGraph、CrewAI、Mastra、Pydantic AI、Google ADK）。
  需要的憑證：OpenAI API key、CopilotKit Intelligence API key、Channel Code、
  Slack/Teams 的 bot token 與 signing secret。
- **AG-UI** — agent 後端與前端畫面雙向溝通的開放協定（串流對話、前端 tool call、狀態共享、
  human-in-the-loop）。<https://www.copilotkit.ai/ag-ui>
- **OpenRouter** — 一個 key 打各家模型，可設 fallback 順序（preset）。
  <https://openrouter.ai>
- **Exa** — 給 agent 用的搜尋 API。
- **Auth0 Token Vault** — 讓 agent 代替使用者存取 Gmail、Slack 等第三方 API；
  agent 拿不到 root 憑證，只在需要時換一張短命 token。
  <https://auth0.com/ai/docs/intro/token-vault>
- **Trigger.dev** — TypeScript 的長時間背景工作／durable agent，內建重試、
  human-in-the-loop 審核、可觀測性。<https://trigger.dev/product/ai-agents>
- **ClickHouse** — 存 log、事件分析。
- **Google Cloud Run** — 部署。
- **OpenAI AgentKit** — ChatKit 可把 agent 對話介面嵌進自己的產品。
  注意：Agent Builder（視覺化 canvas）官方宣布 2026-11-30 關閉，別把它當地基。
  <https://openai.com/index/introducing-agentkit/>

## 七、主辦真正交代要事先做的事

只有三件：

1. 申請 + RSVP（已完成）。
2. 等官方 starter repo：原文「We will share the final starter repo and access details
   ahead of the event.」——目前尚未發布，要回去刷頁面。
3. 組隊隨意，不用事前揪。

頁面**完全沒提**：要帶什麼、軟硬體規格、事前 Discord/Slack 群、贊助商 credit 要不要先領、
報到證件、飲食表、行為準則。

**重要**：頁面沒有任何禁止事先寫程式的規定，也沒說程式必須當天寫。
所以事前準備 skeleton 是合規的。

## 八、自己的準備清單（非主辦要求）

- [ ] 開好 public GitHub repo 並先 push（交件要公開 repo）
- [ ] 測試用 Slack workspace + bot token + signing secret（現場設定 OAuth 很吃時間）
- [ ] 申請 API key：OpenAI、OpenRouter、Exa、CopilotKit Intelligence、Auth0、Trigger.dev
- [ ] Channels SDK 在本機跑通一次 hello world
- [ ] 裝好錄影工具、寫好 2 分鐘 demo 腳本
- [ ] 社群貼文草稿寫好，贊助商 tag 先列出來
- [ ] **測 Tailscale**：spark／porin 是 `100.88.x.x` 內網，新加坡場地 wifi 很可能不通
      （之前遇過 UDP DNS 被攔回 10.0.0.1）。準備一條完全走雲端的後路（OpenRouter）。
- [ ] 在台灣先錄一段「能動」的 demo 影片當保險，尤其走硬體路線時

## 九、題目候選

**A. In the room — 眼鏡上的 agent**
沿用 Rokid 手語翻譯專案。agent 看得到你看的、聽得到現場，答案回到鏡片上。
優點：53 城裡幾乎不會有第二隊做穿戴，評審記得住。
風險：硬體 demo 會爆，4 小時修不完，要帶硬體出國。
必備保險：台灣先錄好能動的影片 + 一條只用筆電 webcam 就能跑的退路。

**B. At work — Slack／Teams channel agent**
用 Channels SDK。住在工作頻道裡、真的動手辦事（開單、改狀態、要人按核准），不是問答。
優點：4 小時做得完，正中贊助商靶心，評審一半是企業／金融／政府背景。
風險：撞題率最高。

目前傾向 A，但一定要有 B 的保險機制。
