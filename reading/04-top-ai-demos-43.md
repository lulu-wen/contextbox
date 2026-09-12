# Top AI Demos #43: Adaptive Math, Agent Tool Security, and Local Search

## Top AI Demos #43: Adaptive Math, Agent Tool Security, and Local Search

Issue #43 · Week of September 7

 Joe Heitzeberg • Founder at AI Tinkerers • ⏱️ 1 min read

Creating space for leading builders to share ideas, grow, and make an impact.

This week’s top pick has a demanding audience: primary school children. In Hong Kong, Natalia Kojoukhova’s MathCat turns curriculum-aligned math and science practice into a bilingual game, complete with fish coins, streak bonuses, and a climb from Kitten to Invincible. Underneath the cats is an adaptive learning platform. The product challenge is wonderfully concrete: give a child a reason to try the next problem.

Several other standouts tackle frustrations anyone building with agents will recognize. Matheus Kemer measured that 22% of his agent’s shell commands were spent trying to find things. His response, lux_find, searches roughly 35,000 documents, including code, notes, and agent transcripts, in about 25 milliseconds using a single SQLite file. In Missoula, Ryan Morton showed how he uses scheduled Claude Code loops to build and maintain myIO, an open-source visualization package with 17 chart types.

And before you put your own coding agent on a schedule, spend a few minutes with Brad Milne’s Who do you trust with the keys. His worked example uses a separate macOS user to contain Claude Code at the operating-system level. An agent’s apology is much less useful than a boundary it cannot cross.

Top 5 Picks (September 7)

 1 TOP PICK

 ###
MathCat: Adaptive Learning Platform

####
Natalia Kojoukhova

Global Head of Change - Digital Business Solutions
at
BAT

 📍
AI Tinkerers - Hong Kong

•

Aug 31

 Natalia Kojoukhova walked through MathCat, an adaptive learning platform for Hong Kong primary students delivered as a bilingual Progressive Web App. It uses game modes such as Cat Randomizer and Fast Cat, and ties progress to fish coins with +10 per correct answer plus streak bonuses, along with XP Stars that level from Kitten to Invincible. A leaderboard and Rewards Shop sit on top of curriculum-aligned bilingual math and science quizzes.

Read more →

TECH STACK

 Gemini-2GPT-5SupabaseCursorOpenAI

PROJECT LINKS

mathcat.fun

 2 RUNNER UP

 ###
myIO: AI-utomated open source

####
Ryan Morton

President
at
Morton Analytics LLC

 📍
AI Tinkerers - Missoula

•

Aug 26

 Ryan Morton of Morton Analytics LLC walked through an AI-automated open source workflow that uses scheduled loops with Claude Code to build and maintain his myIO R package for interactive d3.js visualizations via htmlwidgets. In the repo, myIO composes charts with `myIO() |> addIoLayer()`, supports 17 chart types, and includes bidirectional interactions such as `setBrush()`, which maps rectangular selections to rows, and `setAnnotation()`, which exports annotations as CSV. A live demo viewer is available for myIO charts.

Read more →

TECH STACK

 Claude Code runs scheduled loops for ideasdesign and development of d3Rand Python code work

PROJECT LINKS

github.com

 3 COMMUNITY FAVORITE

 ###
UKPT: Architecture Testing Agents

####
Isaac Udy

Founder
at
Reglyph

 📍
AI Tinkerers - Wellington

•

Aug 26

 Isaac Udy, Reglyph founder, presented UKPT, a Kotlin Multiplatform project template that enforces project architecture with an architecture testing framework built on Konsist. This framework allows a catalog of architecture rules to serve as strict tests that can be enforced in CI and as the source of generated markdown documentation for both humans and agents to consume. This framework is published as part of Isaac's udytils library group, with the UKPT template serving as a template and example for the architecture testing framework and other udytils-sourced libraries.

Read more →

TECH STACK

 Kotlin MultiplatformKonsistGradleClaude CodeCodex

PROJECT LINKS

github.com

github.com

 4 STANDOUT

 ###
Agentic Tool Security

####
Brad Milne

Founder
at
Symbiant Systems

 📍
AI Tinkerers - Wellington

•

Aug 26

 Brad Milne of Symbiant Systems showed "local agentic tool use" still breaking trust boundaries, then walked through user-level containment. He used a second-user sandbox on macOS and published a worked example for running Claude Code with OS-level isolation. He contrasted that setup with credential misuse and unintended production touches, keeping the focus on preventing boundary overruns rather than improving model reasoning, in line with the "Oops you're right" prompt scenario from the proposal.

Read more →

TECH STACK

 macOSShell scriptingAccess control lists (ACLs)User account ACLsProduction data security

PROJECT LINKS

medium.com

@wellybrad

 5 NOTABLE

 ###
Buscador Local: Salve Tudo

####
Matheus Kemer

CTO
at
Kolabs

 📍
AI Tinkerers - Curitiba

•

Aug 26

 Matheus Kemer of Kolabs demoed a local search engine that indexes everything his AI system produces — code, personal notes, project decisions, and the agent transcripts themselves — and answers from the terminal in about 25ms. It runs on a single SQLite FTS5 file over roughly 35,000 documents, with no server, no cloud and no runtime dependencies. Kemer built it after measuring that 22% of his agent's shell commands were brute-force "go find the thing", and he walked through the file layout and indexing choices behind persistent agent context. The engine is now open source as lux_find.

Read more →

TECH STACK

 SQLite FTS5BM25PythonClaude Codelaunchd

PROJECT LINKS

github.com

Video

More Great Builds

Quick hits from the community: demos worth bookmarking.

The Constraint: Agent Competition

Jose Angel Lopez • AI Tinkerers - Mexico City • Aug 28

Jose Angel Lopez, "The Constraint," ran an agent competition in the live arena at "theconstraint.run". Builders execute real AI agents under fixed constraints: MODEL_LOCK with run-locked Llama-3.2-3B-Instruct weights, an 8,192-token context ceiling, and a 64k-token cap per episode with 2,048 tokens of output. The tasks are multi-goal and partially observable, with GOALS_VERIFY. The site keeps an append-only public archive of labeled, logged runs in "proving-ground.log".

 Loading tech tags...

theconstraint.run

ChatGPT: Emerging Channel Ads

Andrea Tortella • AI Tinkerers - San Francisco • Aug 26

Andrea Tortella of Thrads.ai presented "ChatGPT ads - How to grow on emerging channels," describing how Thrad runs contextual, native placements inside AI conversations. The system analyzes user prompts and conversational signals, scores and ranks candidate ads for intent relevance, then deploys the winning creative via real-time bidding with millisecond latency. Thrads positions itself as a DSP and SSP for LLMs, with "ChatGPT Ads" as a named product surface and docs plus an SSP SDK for integration.

 Loading tech tags...

thrad.ai

Paperclip: Hermes Agent Org Chart

Louis Marcondes • AI Tinkerers - Curitiba • Aug 26

Louis Marcondes, founder of KOER, presented "Contratando o Hermes para o organograma de agentes do Paperclip." He ran a Paperclip agent "company" with seven Claude Code agents, including CEO, CRO, DEV, and SRE roles, under shared budget governance, task tracking, and approval gates. He then added an eighth Hermes Agent on a separate host through the Paperclip hermes_gateway adapter over HTTPS, using Traefik with Let's Encrypt TLS.

 Loading tech tags...

ast-grep: Agent Usage Analysis

Alessandro Cuppari • AI Tinkerers - Dublin • Aug 26

Alessandro Cuppari of Toast presented an OpenCode setup that adds ast-grep and analyzes how coding agents use it across 2,299 real development sessions. ast-grep handles AST-aware structural search, and he showed structural matches, a repository-specific lint rule, and a multi-file code replacement. He reported 1,406 ast-grep invocations, with 89% used for retrieval, though one lookup was simpler with ripgrep. The artifacts live in the opencode-config repo.

 Loading tech tags...

 github.comVideo

Linr: DeepSeek no Cursor

Luiz Goncalves • AI Tinkerers - Curitiba • Aug 26

Luiz Goncalves built Linr, an online visual timeline editor, and in his live demo used DeepSeek V4 inside Cursor by wiring Cline as the harness because Cursor's native agent would not route to the DeepSeek API key. He started from an unfinished Linr state, gave the running agent a concrete fix and feature task, then reported the token and dollar cost to reach the result. The team’s notes say BYOK works in Cursor, but Auto mode breaks it.

 Loading tech tags...

linr.cc

Insider: WhatsApp Talent Matching

Pierre Huchot • AI Tinkerers - Valencia • Aug 25

Pierre Huchot, WeGravel’s CTO, ran an "Insider" talent recruiter matching agent demo that runs the hiring flow inside a WhatsApp thread. A company shares a role, and the system scouts and scores candidates, pings them, and books a call through WhatsApp. Candidates connect LinkedIn and GitHub in chat to fill briefing criteria like stage, stack, salary floor, and cities, then see roles with a compensation floor and "Accept intro."

 Loading tech tags...

insider.works

Café com o Candidato RAG

RAPHAEL NUGAS • AI Tinkerers - São Paulo • Aug 27

Raphael Nugas of CodeCollie presented "Café com o Candidato," an open-source site where users chat with an AI simulation of a 2026 Brazilian presidential candidate. It uses RAG over public documents, labels each answer as "Simulação por IA," and never ties replies to campaigns. The repo describes a strict "RAG estrito, sem alucinação" flow with a persona file per candidate, a validated corpus document schema, and local operation via `servidor_local.py` and `chat_test.py`.

 Loading tech tags...

github.com

Mafagrafos: Canva com Fable 5

Aline Borges • AI Tinkerers - Curitiba • Aug 26

Aline Borges of Mafagrafos presented a "Canva-like" workflow for creating custom 3D-printable models in Fable 5. The catalog UI lets users personalize templates with text, names, and images, then download ready-to-print files. Mafagrafos' "Modelos 3D" collection lists generator-style types such as QRCode plates, PIX plates, and image-to-3D variants, with selectable layers and colors, so the interface favors parameterized presets over freeform modeling.

 Loading tech tags...

mafagrafos.com

Goals MCP: Preventing Fake Done

Jurden Bruce • AI Tinkerers - Missoula • Aug 26

Jurden Bruce showed goals_mcp, an MCP server that manages an agent’s long-lived goals alongside a human-facing Kanban board to prevent "Fake Done" closes. It runs on SQLite by default and stores goals, board cards, and a conscience nag file in the same store. A separate conscience_agent ranks goals by priority, tracks days_idle, and queries an OpenAI-compatible endpoint, often a local model, to write nag_output.txt.

 Loading tech tags...

github.com

Kiro: Spec-Driven Development

Diego Gomes • AI Tinkerers - Dublin • Aug 26

Diego Gomes from AWS presented Spec-Driven Development with Kiro, starting from a single natural-language prompt and ending with production-ready, tested, documented code. Kiro generates structured requirements and a technical design, then sequences implementation tasks and adds event-driven hooks so code, tests, and docs stay in sync. He also framed when to use specs, event-driven consistency, or freeform exploration, a useful contrast for anyone trying to move past the "vibe-coding to production gap."

 Loading tech tags...

Oh Ashley · Video

#### The AI Agent Forgot Someone's Laundry for Two Days | Oh, Ashley! Ep. 3

Joe Heitzeberg and Alexander Liteplo discuss an AI laundry agent that forgot to follow up for two days, and the scheduled wake-ups and regression tests added to catch missed work in this episode of "Oh, Ashley!", a series about agent fails.
 Watch latest episode → ·View the playlist →

Post-Training · 14 min

#### How to Build Antifragile Agents with OpenRouter

After Anthropic suspended Fable 5 June 12–July 1, 2026, we built an antifragile billing agent that keeps working when models/providers fail by routing through OpenRouter
 Read Now →

Community Job Board

### Three roles for AI builders

 Co-Founder & CTO: Build the Coordination Layer for AI Agents    Summoner • New York, NY

 CTO Co-Founder: Embedded / Edge AI for Acoustic Measurement    Sonalyze • Paris (Station F), on-site • Double-digit co-founder equity + salary from grants/seed

 Staff Engineer at Anthropic's Eng Serv Subsidiary    Ode with Anthropic • San Francisco, New York, Durham • $275,000 - $400,000

 Browse jobs →
 Post a role →

You are one of 110,000+ readers from OpenAI, Anthropic, Mistral AI, Google DeepMind, Scale AI, Databricks, Hugging Face, ElevenLabs, xAI, LMArena, Fireworks AI, Together AI, and others, spanning frontier labs, big tech, startups, and top universities.

See you at the next one.

Find the next AI Tinkerers meetup and keep building.

 Upcoming meetups →

Reach serious AI builders:
Sponsor this newsletter

More from Post-Training

## Keep reading practical field notes

 All posts

    Guest post

### How to Build Antifragile Agents with OpenRouter

After Anthropic suspended Fable 5 (June 12–July 1, 2026), we built an antifragile billing agent that keeps working when models/providers fail by ro...

  Kenny Rogers · 16 minutes

    Guest post

### What I Learned Giving Fable 5 a Face

Giving an avatar “a face” bottlenecks on interaction timing, not rendering: interruptions, turn-taking/ending cues (e.g., Turkish needed eager end-...

  Ben Carr · 11 minutes

    Guest post

### How to Write a Winning Agent Harness for Your Domain

If adding instructions makes your agent worse, it’s often a harness problem: we watched Reef/AlphaCumen collapse from a Vals v1 lead to zero on Val...

  Hitesh Jain · 13 minutes
