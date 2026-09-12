# What I Learned Deploying OpenClaw Beyond Demos

 Kaya Jones • Founder & CEO at Forever 22 • ⏱️ 11 min read

Building cool stuff with cool people

I’ve been deep into OpenClaw for three months now. Deploying it for clients, building custom skills and CLI tools around it, breaking things, fixing them, and figuring out what actually holds up when the novelty wears off.

That’s the part I care about.

There are plenty of agent demos online. Most are fun for five minutes and useless by the end of the week. The interesting question is whether people keep using them after the first setup high wears off.

In my experience, the OpenClaw workflows that stick all have the same shape:

-
 They live inside tools people already use.

-
 They carry context forward instead of starting from zero every time.

-
 They save time without demanding constant babysitting.

This post is about four systems I built that made that pattern obvious to me: a research agent, a knowledge system, a backup layer for agent state, and a physical robot interface. None of them are perfect. All of them changed how I think about where agents become real.

## What People Actually Use OpenClaw For

Before getting into the builds, here is the broader pattern I keep seeing in client work.

 Workflow What it does Why it sticks

 Daily briefings Pulls calendar context, surfaces the most important items for the day, and sends a digest. It reduces planning overhead first thing in the morning.

 Personal CRM Stores rich context on people and relationships in Obsidian. It turns scattered notes into something you can actually use before a call.

 Family scheduling bot Handles back-and-forth logistics inside an iMessage group chat. Nobody has to open a separate scheduling tool.

 Restaurant phone booking Calls restaurants directly when Resy or OpenTable are incomplete. It does something the standard apps often cannot.

 Pre-call dossiers Compiles key context on a person or company before a meeting. It saves tab-hopping and helps you show up prepared.

 Network mapping Maps who knows whom across founder and investor networks. It makes warm intros easier to spot.

The common thread is simple: OpenClaw gets valuable when it stops acting like a toy chat interface and starts behaving more like background infrastructure.

Read more »

Sponsored by TinyFish

TinyFish Accelerator: 9 weeks to $2M Seed

A YC-style agent accelerator with $2M seed pool from Mango Capital. In partnership with Vercel, ElevenLabs, Fireworks AI, and 15+ comapnies. 1500+ people applied, 14 already in. Admissions open now!

## Before You Build Anything

This is not a two-hour side quest.

Required tools

-
 OpenClaw installed and configured (installation guide)

-
 Node.js 18+ for CLI tools

-
 A code editor

-
 Git

Time commitment

- A weekend if you want something real, not just a demo

Accounts

-
 An LLM provider

-
 Telegram for notifications

-
 Obsidian if you want the knowledge system workflow

OpenClaw is powerful, but it is not plug-and-play. Expect setup work, iteration, and the occasional mess.

## A Research Agent That Actually Helps

The first workflow that stuck for me was a research agent.

The problem was not lack of information. It was too much of it. ArXiv alone publishes more papers than I can reasonably scan, and I was probably missing good ones entirely while still feeling like I was “keeping up.” I did not want another feed. I wanted something that filtered for me and only interrupted me when there was a good reason.

So I built Robin, a nightly research agent.

The job is narrow on purpose:

-
 search a small set of topics

-
 filter hard

-
 summarize what matters

-
 stay quiet if the result is weak

Here is the core instruction file:

# ~/.openclaw/agents/robin/research-instructions.md

You are Robin, my research agent.

1. Search arXiv for recent papers in:

- AI agents

- multi-agent systems

- LLM reasoning

2. Keep only papers that are both novel and useful to builders.

3. Write a brief under 200 words.

4. If fewer than 3 good papers make the cut, send "NO_REPLY".

Filter rules:

- Skip surveys and small benchmark bumps.

- Prefer papers with practical implications.

- Assume I care more about leverage than completeness.

One thing I like about OpenClaw here is that I do not have to start with raw cron syntax. I can describe the schedule in plain English and let OpenClaw generate the wiring:

Run my research agent every night at 11pm and follow research-instructions.md to search arXiv, filter papers, and send me a brief.

That turns into:

openclaw cron add \

--name "Robin Research" \

--schedule "0 23 * * *" \

--task "Do nightly research following your research-instructions.md. Search, filter, synthesize, quality control."

What makes this useful is restraint. The best version of this agent is opinionated, repetitive, and a little boring. It should know what counts as signal, what to ignore, and when not to bother you.

If I were copying this workflow again, I would keep three rules:

-
 Start with one source that is structured and predictable.

-
 Make silence an acceptable output.

-
 Tune the filter before adding more data sources.

That was the difference between a fun demo and a tool I actually kept running.

## A Knowledge System That Learns From Decisions

The second system was less flashy, but honestly more important.

Most tools are fine at storing facts. What they usually miss is the part people actually want later: why a decision got made, what tradeoff mattered, and what happened the last time something similar came up.

That is the gap I wanted to close. I did not want a smarter notebook. I wanted something that could remember how decisions got made.

### Step 1: Store basic facts in Obsidian

I use Obsidian as the layer for durable, human-readable facts:

-
 people pages

-
 project notes

-
 relationship context

-
 links between conversations

This is the boring but necessary layer. If the agent cannot keep the basic facts straight, the rest does not matter.

### Step 2: Store decision reasoning in Honcho

Honcho is useful here because it is built around long-term memory for agents. I use it to capture the part that usually gets lost:

-
 the decision

-
 the context

-
 the reasoning

-
 the precedent

That means the system can remember not just what happened, but why it happened.

### Step 3: Query both layers together

When the agent gets a question like:

-
 “Who should I introduce Sarah to?”

-
 “How should I handle this pricing negotiation?”

-
 “What did we learn from the last vendor selection?”

it can pull basic facts from Obsidian, pull decision patterns from Honcho, and answer from both.

### Step 4: Test it on a real decision

The fastest way to know whether this system is useful is to feed it an actual decision and see what it captures:

I decided to use Stripe for payments instead of Square because the API docs were better and we had a good experience with Stripe on the last project.

The agent should be able to store:

 - Decision: use Stripe for payments

 - Context: new project needs a payment processor

 - Reasoning: documentation quality and prior success mattered

 - Precedent: Stripe worked well before

That may not sound glamorous, but this is where the compounding starts. Six months later, the value is not that your agent remembers names. It is that it can say: “We have seen a version of this before. Here is what worked, here is what failed, and here is why.”

That is what I mean by institutional memory. Not a scrapbook. A working record of decisions.

## SnapshotClaw: Backups for Your Agent’s Brain

For me, that moment was a broken config at 2 AM. The agent came back in a bad state. Skills were missing. Cron jobs were gone. Memory had drifted. It was the kind of failure that makes you realize your agent is no longer just a prompt. Its brain becomes valuable state, and that state needs a recovery plan.

That is why I built SnapshotClaw.

The shortest description is this: it is version control for your OpenClaw environment.

What needs backing up?

~/.openclaw/config/ # agent configurations
~/.openclaw/cron/ # scheduled automations
~/.openclaw/skills/ # installed capabilities
~/.openclaw/memory/ # conversation and state data
~/.openclaw/plugins/ # extensions

Setup is simple:

brew tap kayacancode/snapshotclaw
brew install snapshotclaw

cd ~/.openclaw
snapshotclaw init

Create a baseline snapshot:

snapshotclaw create --name "baseline-setup"

Then when something breaks, you can inspect and recover:

snapshotclaw list --limit 5
snapshotclaw diff 2026-03-05-backup current
snapshotclaw restore 2026-03-05-backup

This changed how I work because it removed some of the fear. I am much more willing to mess around when I know I can get back to a known-good state.

If you are serious about running agents over time, this matters. The hard part is rarely generating text. The hard part is keeping the whole system stable enough that you trust it after a bad day.

## Putting an OpenClaw Brain in a Robot

The most obviously fun project was also the one that made the broader point clearest.

At AI Tinkerers NYC, I demoed a Hugging Face Reachy Mini robot with an OpenClaw brain.

Reachy Mini is an expressive desktop robot. It has articulated movement, microphones, cameras, and enough personality to make the interaction feel different from a browser tab.

What made this demo interesting to me was not the hardware by itself. It was that the robot was not a standalone toy with canned responses. I connected it to Botwick, John Borthwick’s OpenClaw agent, so it could inherit memory, context, and personality from an existing agent system.

That meant the robot could do more than talk:

-
 remember prior conversations

-
 recognize known people

-
 express emotion through movement

-
 bridge voice input into the same OpenClaw workflows I was already using elsewhere

The voice pipeline looked like this:

Mic -> VAD -> STT (Nemotron / Whisper) -> Claude via OpenClaw -> ElevenLabs TTS -> Speaker

What made it feel real was not the demo itself. It was the next day.

After the event, I connected the system to a Spotify controller, and now it can handle music in the office. I can tell it to stop, skip, or play something that matches the mood. That is a small use case, but it matters because it moved the robot from “showpiece” to “thing I actually use.”

That is the pattern again. The magic is not in embodiment alone. The magic is when the physical interface plugs into a persistent digital system that already knows your context.

You can watch the desk demo here: Reachy Mini Demo

Repository: kayacancode/reachy-brain

## What These Projects Changed for Me

These four systems look different, but they taught me the same lesson.

 System What it proved

 Research agent Agents are useful when they filter aggressively and stay quiet when the result is weak.

 Knowledge system Long-term value comes from preserving reasoning, not just storing facts.

 SnapshotClaw Agent workflows need recovery and versioning once they become part of real work.

 Reachy integration A physical interface gets interesting when it plugs into the same memory and workflows as the rest of your stack.

I do not think the future here is “everyone chats with a better assistant.”

I think we are watching personal AI start to move into the background. It reads with you, remembers for you, watches your calendar, keeps track of relationships, survives config failures, and eventually shows up through whatever interface is most convenient: your terminal, your phone, your notes app, your voice, or a robot on your desk.

OpenClaw is messy, powerful, occasionally frustrating, and genuinely ahead of its time. It still asks for too much setup. It still breaks in ways that would scare off most non-technical users. But I keep coming back to it because the underlying model is right.

Once an agent has memory, context, and access to the tools you already live in, it stops feeling like a one-off product. It starts to feel like part of your environment.

You do not log into it. You live with it.

Like this and want to read more? follow Kaya Jones

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
