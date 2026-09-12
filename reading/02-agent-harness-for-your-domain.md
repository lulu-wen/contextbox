# How to Write a Winning Agent Harness for Your Domain

 Hitesh Jain • Founder and CEO at Coral Bricks AI • ⏱️ 13 min read

Focuses on AI inference and distributed systems. Ex-Meta, Principal Engineer Meta AI & Distributed Systems. Ex-IIT Roorkee.

If your agent improves when you add instructions, then suddenly gets worse, you may not have a prompting problem. You may have a harness problem.

We saw this firsthand while we were building a finance research harness steering Kimi K2.6. We were about to announce our finance harness during the week of the Opus 4.8 launch, riding a wide lead on the then-leading benchmark, Vals AI v1. Then Vals AI released v2 and Anthropic showcased Opus 4.8 on it - moving the spotlight to the harder benchmark overnight. On v2, we scored identical to the Vals reference harness. Our edge had collapsed to zero. The v1 lead alone didn’t matter anymore: v2 expected multi-file retrieval with deep reasoning.

We started debugging. We spent more money on the workload, but the answers were either not generating or were poor quality. Digging deeper, we found v2 queries were making our model think longer, taking more turns, and running out of token budget. Our prompts had grown past 2,500 lines of instructions and 50+ tool definitions, many overlapping or conflicting. Adding more instructions wasn’t moving the needle.

That’s when Reef – a lightweight, domain-agnostic skills-first, git-native harness framework – was born.

We developed Reef and adopted it into our finance harness to beat public financial benchmarks as of June 2026 at 10x lower cost (at Opus 4.8 rates).

In this article, we share our benchmark details, but more importantly the technical primitives and the open-source code to enable anyone to replicate these gains for their own agents.

Read more »

Sponsored by Kiro

New in Kiro CLI 2.0

Prompt, code, and deploy with more control and less friction. New in Kiro CLI 2.0: native Windows support, enhanced subagents, and headless mode for CI/CD automation beyond the terminal.

## What You’ll Build

The simple reference harness (Equities) built on Reef running locally, plus a working mental model of how Reef works. A template you can adapt piece-by-piece to whatever your domain is - legal, finance, marketing, ops.

Equities is the deliberately skinned-down hello-world. The same repo ships our benchmark-winning finance harness (AlphaCumen) as the scale-up reference.

Prerequisites: Python 3.10+ and an OpenAI-compatible LLM provider API key. Default below uses openai/gpt-5-mini.

### 5-minute quickstart

git clone https://github.com/Coral-Bricks-AI/coral-ai.git
cd coral-ai
python -m venv .venv
source .venv/bin/activate
pip install -e .
export LLM_API_KEY=sk-... # LLM provider API key

python reef/examples/equities/ask.py --model openai/gpt-5-mini "How has NVDA performed over the last year?"

Expected output:

Q: How has NVDA performed over the last year?

A: NVIDIA (NVDA) returned +63.0% over the trailing 12 months
   ($89.10 → $145.20). Price return only; does not include dividends.

The rest of the post walks through what just happened, turn by turn - Steps 1-4 introduce each primitive using finance examples that scale up to AlphaCumen, and Step 5 closes the loop with the exact code you just ran.

## What is the recipe?

To make this work, you’ll need a harness framework to organize the conditional logic in domain-specific agents built to keep prompts lean and avoid drifting prompts and Python code. You build sub-agents that run in parallel or serially on one reasoning LLM - each a ReAct loop over its own skill roster. Three primitives compose it: skills, agent types, and runtime constraints.

Our implementation, Reef, is a minimal Python agent harness for rule-heavy domains and is open source. It organizes capabilities into version-controlled skill folders (SKILL.md for procedural instructions + impl.py with @skill_fn functions). Skills are indexed compactly in the system prompt and loaded lazily. A single readable ReAct loop manages LLM calls (OpenAI, Anthropic, Bedrock, proxies), tool dispatch, retries, and runtime constraints. It prioritizes Git-native maintainability, narrow composable skills, and low overhead.

## Step 1 - Design a skill

A skill is the unit of reusable domain competence - the procedural instructions the model loads into its thread plus optional code. In code: a markdown file and (optionally) a Python module beside it.

### Skill markdown

Skills carry principles, not many-shot prompts. Hard rules generalize across shapes the model has never seen. N-shot examples teach the model to pattern-match on the examples, miss anything that doesn’t look like them, and leak test-set wording into prompts.

Bound to an agent. Each skill declares which agent owns it (applies_to:) and when to invoke it (when:). At build time, the harness assembles each agent’s index from those tags.

applies_to: [sector_analyst]
when: Cross-ticker, multi-window price-performance question
HARD RULE 0 - multi-ticker × N-date price-return questions:
call `compute_price_returns_multi` ONCE as your FIRST tool call.
NON-NEGOTIABLE.

E̶X̶A̶M̶P̶L̶E̶ ̶1̶:̶ ̶Q̶:̶ ̶"̶c̶o̶m̶p̶a̶r̶e̶ ̶N̶O̶W̶,̶ ̶H̶U̶B̶S̶,̶ ̶T̶O̶S̶T̶ ̶f̶r̶o̶m̶ ̶1̶2̶/̶3̶1̶/̶2̶5̶ ̶t̶o̶ ̶0̶2̶/̶2̶7̶/̶2̶6̶"̶
 ̶ ̶ ̶ ̶ ̶ ̶ ̶ ̶ ̶ ̶ ̶A̶:̶ ̶<̶3̶0̶0̶ ̶l̶i̶n̶e̶s̶ ̶o̶f̶ ̶d̶u̶m̶m̶y̶ ̶r̶e̶t̶r̶i̶e̶v̶a̶l̶>̶
E̶X̶A̶M̶P̶L̶E̶ ̶2̶:̶ ̶.̶.̶.̶

Skills are organized on disk as:

skills/
  executive_compensation.md    # just procedural instructions
  headcount_trend/             # instructions + Python callables
    SKILL.md
    impl.py

### Skill impl.py

The Python function retrieves data and implements the domain-specific convention (formula, basis, filter, rounding) and returns a structured envelope that the skill body tells the model to echo in its tool calls:

@skill_fn(
    skill_id="headcount_trend",
    description="Per-FY employee headcount + YoY % for one ticker.",
    parameters={
        "type": "object",
        "properties": {
            "ticker": {"type": "string"},
        },
        "required": ["ticker"],
    },
)
def headcount_trend(*, ticker):
    ...
    return {"answer_summary_block": "FY22 154,000; FY23 161,000 (+4.5%);..."}

One decorator binds three things - prompt instructions, JSON Schema, Python function - at import time. (More ergonomic than vanilla ReAct: one edit per skill instead of three drifting files.)

### Skill index and dispatch

Each agent sees a skill index up front - available skills and when to use them. When the agent decides a skill is needed, it lazy-loads the body. (More accurate and token-efficient than vanilla ReAct, which hands every agent every tool’s full schema in its system prompt.)

Loaded into context on demand. Agents don’t see the full skill bodies up front - only the index. When the agent needs a skill, it calls load_skill(skill_id=...) and the body renders into its thread for the rest of the run.

Invoked in-process. When a skill with a bound Python function is loaded, the loaded block also carries the function’s JSON Schema (from @skill_fn’s parameters). The model dispatches via invoke_skill_fn(skill_id, fn, args) - a typed function dispatch with args validated against the schema. (Faster than the bash-subprocess-per-call pattern in Claude Code skills.)

## Step 2 - Compose skills into a specialist

A specialist is a persona prompt plus a skills index. The persona sets the voice and analytical posture:

You are Toni Sacconaghi - meticulous, quantitative, deep domain expertise. You care about specifics: supplier shifts, gross-margin mix, segment disclosures…

The skills index lists what and when this specialist can load. A few representative entries:

- `headcount_trend` - per-FY employee headcount + YoY %

- `executive_compensation` - top-5 named-officer pay from the latest proxy

Why a persona? It’s not theater - the persona narrows the model’s prior over how to respond to the prompt.

## Step 3 - Add a planner for multi-step work

Once you outgrow one specialist, you need a planner. A planner is itself a ReAct agent, but with a different job description and its own skill folder.

Every step, the planner:

 - Decomposes - one unit per ticker / per entity.

 - Dispatches specialists in parallel with outcome-framed instructions (“produce X”), not tool prescriptions.

 - Prunes - flags dead ends and contradictions on the shared thread so the next step avoids them.

 - Converges - stops dispatching once findings are sufficient; a step-count ceiling nudges termination if it doesn’t.

The planner’s own skills folder handles routing rules no single specialist owns - calendar/period mapping, vocabulary translation between how users ask and how documents read:

planner_skills/
  fiscal_period_resolution.md       # "as of" vs "for the period"
  multi_issuer_serial.md            # one dispatch per ticker, no joint queries
  dedicated_specialist_dispatch.md  # tool-intent → specialist routing

In finance these handle fiscal-period semantics and the gap between journalism vocabulary (“tailwind”, “next year”) and SEC vocabulary. Every domain has its own version of this gap - clinical research vs. ICD-coded reality, sales pipeline vocabulary vs. CRM stage names, legal-brief language vs. statute citations.

Why split? A specialist with a focused skill roster routes more accurately, costs fewer tokens per turn, and is easier to evaluate in isolation. The planner coordinates across the specialists.

## Step 4 - Add runtime constraints

LLMs are stochastic; constraints bring operational predictability and protect against unwanted data access. Violations are propagated back to the LLM as tool-call responses. The harness gives a different primitive per constraint type.

### Data-access constraint - Python decorator

Tool authors declare the data-access contract inline; the runtime enforces it on every call.

@time_bounded(asof_arg="as_of_iso", filter_field="filing_date", mode="inject")
def get_recent_filings(ticker: str, as_of_iso: str | None = None):
    ...

 - mode="inject|clamp" overwrites the model’s as_of_iso with the run’s cutoff.

This is how you prevent leaking future data into date-sensitive eval, without trusting the model to honor a prompt-level “do not use data after X.” and rebuilding your knowledge base for every eval.

### Convergence constraint - config fields

Most ReAct loops let the model exit whenever it stops emitting tool calls. The harness provides three constraints inside the specialist’s max_steps budget:

SpecialistConfig(
    ...
    max_steps=8,
    min_tool_calls_before_final=1,   # anti-hallucination constraint
)

 - Anti-hallucination. Refuses a no-tool answer from a persona whose contract requires retrieval first. When the model tries to exit prematurely, the runtime injects a coercion system message and the loop continues. The differentiator vs. vanilla ReAct.

 - Penultimate-round warning. One round before final step, a soft system message tells the model this is its last tool-call opportunity.

 - Last-step synthesis-forcer. On the final step, the runtime drops the tools schema and tells the model to emit the JSON answer envelope with whatever it has.

## Step 5 - Wire it up and fork

The primitives come together quickly. Load your skills folder, render the index into the persona prompt, hand the model two tools (load_skill, invoke_skill_fn), and run the ReAct loop. This is the wire-up from the Equities hello-world you ran in the quickstart (the actual file also has a small argparse CLI wrapping ask() - omitted here for clarity):

# reef/examples/equities/ask.py

from reef.react import run_react
from reef.skills_loader import load_skills, render_index, render_loaded
from reef.skill_tools import INVOKE_SKILL_FN, make_load_skill_tool

# Load this example's skills folder. Importing impl.py registers
# each @skill_fn-decorated callable into the global dispatch registry.
SKILLS = load_skills("./skills")

# Wraps your skills into an LLM tool. The model passes skill_ids
# at call time; the runtime looks them up in the SKILLS registry and
# returns the rendered bodies into the model's thread for the rest of the run.
LOAD_SKILL = make_load_skill_tool(
    lambda ids: render_loaded(list(ids), skills=SKILLS),
)

PROMPT = open("analyst.md").read().replace("{skill_index}", render_index(SKILLS))

def ask(question, model="openai/gpt-4o-mini"):
    traj = run_react(
        model=model,
        system_prompt=PROMPT,
        user_message=question,
        tools=[LOAD_SKILL, INVOKE_SKILL_FN],
        max_steps=6,
    )
    return traj.final_message["content"]

print(ask("How has NVDA performed over the last year?"))

That’s the whole hello-world - same ~50 lines whether your specialist is an equity analyst, a tax analyst, or a code reviewer. AlphaCumen adds a planner over the same run_react loop, six specialists each with their own PROMPT + SKILLS, and a SpecialistConfig for the runtime constraints from Step 4 - but the wire-up shape is identical.

The repo ships both as reference harnesses you can fork:

    Equities - hello-world  AlphaCumen - finance

 Sub-agents 1 (equity analyst, no planner) 6 specialists + planner

 Skills 2 69

 Skills with Python bindings 2 ~40

 Planner skills 0 ~25

 Retrieval one in-memory JSON 6 indexed corpora (EDGAR + sector + transcripts)

 Runtime constraints none (defaults)  asof, tool_budget, token_budget

Start from Equities if you’ve never built a harness before - it’s the smallest thing that exercises all the primitives. Start from AlphaCumen if your domain is already at the “20+ skills, multi-entity questions” complexity tier; copy the planner and specialist scaffolding and swap the skill bodies.

(Go to GitHub to clone, modify, and run.)

## Results

Our finance harness’s summary results are below.

### Retrieval vs. structure (controlled ablation)

Three configurations on Vals AI Finance Agent v2 - same model (Kimi K2.6), same data, same judge. Pass rate over n=239:

 Config LLM harness Retrieval Skills + computation Pass-rate

  A Vals reference Vals AI Tavily / EDGAR / HTML calculator + price_history 44.87%

  B Retrieval only Vals AI 6 AlphaCumen indices calculator only 49.8%

  C Full harness Reef / AlphaCumen 6 indices 69 skills + dedicated tools 82.6%

Better retrieval alone moves pass rate ~5 points; the remaining ~33 points come from harness structure. The skill stack makes the loop finish and answers better.

The 33-point structural lift decomposes as ~55% finance-conventions-in-code (Step 1’s @skill_fn), ~28% multi-filing orchestration (Step 3’s planner), and the rest data coverage and retrieval ranking. Whatever your domain’s conventions are, encode them as typed functions, not prompt sentences the model can paraphrase its way around.

Cost: 620k tokens per query at $0.13 on Kimi K2.6 routed through Coral vs. $1.35 for Opus 4.7 on the same workload - ~10× lower bill at higher accuracy.

You can reproduce these numbers with the open-source evals in alphacumen/evals/, which submit to the hosted AlphaCumen pipeline and grade with Claude. Setup is in the eval folder’s README.

## Common pitfalls

Mistakes we made on the way here, in order of how much they cost us:

 - N-shot examples in skill bodies. AI-assisted coding encourages that. But the model overfits to the examples and misses any input that doesn’t look like them. Prefer one crisp hard rule and zero examples.

 - Letting the model exit without a tool call. Default ReAct lets the LLM emit a final answer whenever it wants. For any persona whose job description is “retrieve first,” set hallucination prevention constraints and let the runtime guide the loop.

 - Trusting the model to honor “do not use data after X” in the prompt. It won’t, reliably. Decorate the tool, inject/clamp the cutoff dates.

 - Dumping the whole tool schema into the system prompt. Token-expensive and routing-corrosive. Use the skill-index pattern and lazy-load skill bodies on demand.

## Try it on your domain

Implement the primitives in your own stack or clone Reef, swap the example skills for one of your own, and see how it works on your domain. Issues and PRs welcome.

## Join the discussion

Share reactions, questions, and counterpoints with the AI Tinkerers community.

Open in Message Center

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

### How to Run Open-Source LLMs Locally on a Mac with MLX-LM

Learn to run open-source LLMs locally on Mac Apple Silicon with Apple’s MLX-LM: install `pip install mlx-lm`, then `load()` a Hugging Face model an...

  Eric Fillion · 8 minutes
