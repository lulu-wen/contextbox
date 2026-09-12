# What I Learned Giving Fable 5 a Face

 Ben Carr • Technical Co-Founder at Anam.ai • ⏱️ 11 min read

Technical Co-Founder at Anam.ai, building real-time interactive avatars.

# What I Learned Giving Fable 5 a Face

The hardest part of giving an AI agent a face has almost nothing to do with the face.

I found this out properly last week, when I wired Fable 5, a model that pauses to reason, into an Anam real-time avatar to see how it behaves in a face-to-face conversation. The model integration took about an hour. Everything interesting happened in the layers around it: turn-taking, interruptions, latency, lip sync. The infra that decides whether talking to an avatar feels natural or broken, is what this piece is about.

If you want to skip ahead and reproduce the whole thing, the complete example is in “The build” below. It mirrors Anam’s custom-LLM cookbook, so it stays current as the SDK moves. Or explore Anam here.

## The bottleneck moved

Fable 5 and GPT-5.6 have made agent intelligence close to table stakes. Reasoning, tool use, long context: every serious agent has them now, and the gap between the smartest model and the second smartest matters less with each release.

Abandonment rates haven’t moved anywhere near as fast. People still hang up on voice bots. They still close the chat window. The metrics businesses actually get paid on, things like interview completion, sales conversion, and lesson adherence, all sit downstream of whether the user stays in the conversation at all.

There’s a boring neurological reason faces help here. Almost half the human brain is devoted to visual processing, and reading faces is one of the first things we learn to do. A furrowed brow, a glance away, a half-smile mid-sentence: there’s signal in a face that text and voice can’t carry. It’s why we turn our cameras on for calls that matter.

It shows up in production numbers too. Preply saw a 44% increase in engagement after putting an interactive avatar in front of their language tutoring. And an AI performance coach built by ReplicateLabs saw user engagement double after adding an interactive avatar; Glyphic shortened its sales cycle by 20%; and Colleva cut hiring costs by 70% and reached time-to-value 10× faster running avatar-led interviews at scale. None of that is because the underlying model got smarter. The interface changed what people were willing to sit through.

## Where a face makes things worse

A face is not a universal upgrade, and it’s worth drawing the boundary before going any further.

If your agent is essentially a form, something for booking, lookups, or transactional flows, a face adds latency and social ceremony to a thing that wanted a button. Nobody wants eye contact with a parcel tracker.

Avatars also aren’t for agents designed to pass as human. The whole premise of a face-to-face agent is that the user knows what they’re talking to and finds it engaging anyway. If your use case depends on the user not figuring out it’s AI, an avatar solves the wrong problem.

A rule of thumb I’ve found helpful: use a face where a human would have shown up on camera. Interviews, sales calls, tutoring, coaching. Anywhere the conversation is the product.

## “Feels human” is a systems problem

The common assumption is that avatars feel fake because rendering isn’t good enough, and that better pixels will fix it. Rendering matters, but it’s the ingredient everyone overrates. Perceived realism is mostly a timing problem: latency, turn-taking, and interruption handling. A photorealistic face that responds a beat too late reads as broken. A decent face that responds like a person reads as alive.

Consider what has to happen between you finishing a sentence and the avatar replying:

Every stage adds latency, and the whole chain has to fit inside the natural gap in human turn-taking, a budget of a few hundred milliseconds. Anam averages 180ms agent response time, with roughly 100ms time-to-first-frame for the face. Push much past half a second and people start reading the delay as hesitation, then start talking over the avatar to fill it.

Then there are the failure modes you only find in production, and almost none of them are about the face itself:

Interruptions. When a user barges in mid-sentence, stopping the audio isn’t enough. The face has in-flight video frames. It has to visibly stop talking and start listening without a jarring cut, and the conversation history has to record what the avatar actually said rather than what it was queued to say. We shipped a fix this year for personas “remembering” greetings a user had cut off. Interrupted speech is genuinely hard to get right.

Turn-taking isn’t universal. End-of-turn prediction models learn the rhythms of a language. We had to disable eager end-of-turn detection for Turkish because the model kept cutting speakers off. The prosodic cues that signal “I’m done” in English don’t transfer. If you’re building multilingual, budget for this.

Thinking time is visible. In a chat window, a three-second reasoning pause is a spinner you’ve learned to ignore. When a face is looking at you, three seconds is a long time. A voice agent can get away with a beat of dead air; a face cannot, because a frozen face turns uncanny almost instantly. The avatar has to keep being something while the model works: idle motion, a listening expression, the small movements a person makes when they’re considering an answer. With a model like Fable 5 that genuinely stops to think, this behavior did more for the sense of presence than anything about resolution.

Lip sync has to be generated, not dubbed. That audio-to-video step in the pipeline above is really two stages. First, a diffusion transformer converts the audio signal into motion embeddings covering head position, eye gaze, lip shape, and expression. Then a separate rendering model applies those embeddings to a reference image to produce video frames. Because expression is derived from the audio itself rather than pasted on top, the mouth and the voice can’t drift apart. Separating motion from rendering also means any face can be animated from a single image, with no retraining.

None of these problems get easier when the model gets smarter. Which brings me back to the build.

## The build

There are three shapes an integration can take. If you already run a voice agent on LiveKit, Pipecat, or an ElevenLabs stack, you keep your whole pipeline, STT, LLM, and TTS included and the avatar renders from the audio your agent produces. If you’re starting from scratch, the platform can run everything, model included. And in between sits bring-your-own-LLM: the platform handles transcription, voice, transport, and the face, and your code supplies only the text. Transcript in, response out.

I used bring-your-own-LLM, because it’s the fastest way to put one specific model behind a face. The full HTML and project scaffold live in Anam’s custom-LLM cookbook; the two files that matter are below.

### Server: mint the session token and stream Fable 5

The llmId: "CUSTOMER_CLIENT_V1" field is what tells the platform to expect an external brain and stop running its own. The second endpoint proxies Fable 5 so your API key never touches the browser.

// server.js
require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 1. Mint a session token with the bring-your-own-LLM id
app.post("/api/session-token", async (req, res) => {
  try {
    const r = await fetch("https://api.anam.ai/v1/auth/session-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.ANAM_API_KEY}`,
      },
      body: JSON.stringify({
        personaConfig: {
          name: "Fable",
          avatarId: "30fa96d0-26c4-4e55-94a0-517025942e18",
          avatarModel: "cara-4",
          voiceId: "6bfbe25a-979d-40f3-a92b-5394170af54b",
          llmId: "CUSTOMER_CLIENT_V1", // "I'll bring my own model"
        },
      }),
    });
    const data = await r.json();
    res.json({ sessionToken: data.sessionToken });
  } catch (err) {
    console.error("Session token error:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// 2. Stream Fable 5's response back to the client, chunk by chunk
app.post("/api/chat-stream", async (req, res) => {
  try {
    const { messages } = req.body;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await anthropic.messages.stream({
      model: "claude-fable-5",
      max_tokens: 1024,
      // Short prompt on purpose — see note below on why brevity protects rhythm
      system:
        "You are Fable, in a live face-to-face conversation. " +
        "Reply in one or two spoken sentences. No lists, no markdown.",
      messages, // [{ role: "user" | "assistant", content: "..." }]
    });

    stream.on("text", (delta) => res.write(JSON.stringify({ content: delta }) + "\n"));
    stream.on("end", () => res.end());
    stream.on("error", (err) => {
      console.error("Fable stream error:", err);
      res.end();
    });
  } catch (err) {
    console.error("LLM streaming error:", err);
    res.status(500).json({ error: "streaming failed" });
  }
});

app.listen(8000, () => console.log("http://localhost:8000"));

### Client: transcript → Fable → talk stream

This is the loop the whole piece is about. MESSAGE_HISTORY_UPDATED fires when the user finishes speaking and hands you the full transcript; you call Fable; you push its tokens into the avatar’s talk stream as they arrive.

// public/script.js
import { createClient } from "https://esm.sh/@anam-ai/js-sdk@latest";
import { AnamEvent } from "https://esm.sh/@anam-ai/js-sdk@latest/dist/module/types";

let anamClient = null;

async function start() {
  const { sessionToken } = await (await fetch("/api/session-token", { method: "POST" })).json();
  anamClient = createClient(sessionToken);

  anamClient.addListener(AnamEvent.SESSION_READY, () => {
    anamClient.talk("Hi — I'm Fable. What are we talking about today?");
  });

  // The core of it: user finished a turn → call Fable → stream the reply into the face
  anamClient.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, handleTurn);

  // Interruptions surface here so history stays honest about what was actually said
  anamClient.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, () =>
    console.log("user barged in")
  );

  await anamClient.streamToVideoElement("persona-video");
}

async function handleTurn(history) {
  // Only act when the last turn was the user's
  if (!history.length || history[history.length - 1].role !== "user") return;

  const messages = history.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  // Open a talk stream, then feed Fable's tokens into it as they arrive
  const talkStream = anamClient.createTalkMessageStream();
  const res = await fetch("/api/chat-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (talkStream.isActive()) talkStream.endMessage();
      break;
    }
    for (const line of decoder.decode(value).split("\n").filter(Boolean)) {
      try {
        const { content } = JSON.parse(line);
        if (content && talkStream.isActive()) talkStream.streamMessageChunk(content, false);
      } catch {
        /* partial line across chunk boundary — ignore */
      }
    }
  }
}

document.getElementById("start-button").addEventListener("click", start);

The HTML is just a <video id="persona-video" autoplay playsinline> and a start button; the cookbook has the full page. Then:

npm install express dotenv @anthropic-ai/sdk
node server.js   # open http://localhost:8000

Swapping Fable 5 for whatever your agent already runs on is a one-line change in server.js — point anthropic.messages.stream at a different model, or replace the whole endpoint with an OpenAI or Gemini call. The avatar side never changes; it only ever sees text.

Two things stood out once it was running.

First, streamed tokens and spoken sentences have different rhythms. Models emit text in bursts, but a face has to speak in complete, natural phrases, so the pipeline buffers the chunks you push through streamMessageChunk into speakable phrases before they hit TTS. When it works you don’t notice it at all, which is the point.

Second, a model that thinks changes how you prompt. Latency you’d tolerate in a chat window becomes awkward in person, which is why the system prompt above is deliberately short and asks for one or two sentences — purely to protect the conversational rhythm. The prompt isn’t just shaping what the agent says anymore. It’s shaping how the conversation feels.

The model swap was the trivial part. Everything hard lived in the layer underneath.

## Where this goes

Model choice hasn’t stopped mattering. The best agents in production are still the ones whose teams grind on evals, tune their models, and get context right, and none of that goes away when you add a face. But the interaction layer has been the underinvested one, and it’s a proper systems problem: latency budgets, turn-taking models, interruption handling, and motion generation, all running live over WebRTC.

Whether your agent should have a face is a real question, and I’ve tried to draw that map honestly above. Answering it for your own agent is an afternoon of work: the loop above drops on top of a LiveKit, Pipecat, or ElevenLabs pipeline, or runs standalone through the SDK.

If you’d like to see more of what we’re building at Anam, or you’re running into any of these:

-
 users hanging up on a voice bot or closing the chat before they convert

-
 an agent that would land better as a face: interviews, sales calls, tutoring, coaching

-
 the live-conversation problems this piece is about (latency budgets, turn-taking, interruption handling)

-
 rolling out across languages and needing end-of-turn detection that holds up

you can start building for free, or book a 30-minute demo with the team.

More from Post-Training

## Keep reading practical field notes

 All posts

    Guest post

### How to Build Antifragile Agents with OpenRouter

After Anthropic suspended Fable 5 (June 12–July 1, 2026), we built an antifragile billing agent that keeps working when models/providers fail by ro...

  Kenny Rogers · 16 minutes

    Guest post

### How to Write a Winning Agent Harness for Your Domain

If adding instructions makes your agent worse, it’s often a harness problem: we watched Reef/AlphaCumen collapse from a Vals v1 lead to zero on Val...

  Hitesh Jain · 13 minutes

    Guest post

### How to Run Open-Source LLMs Locally on a Mac with MLX-LM

Learn to run open-source LLMs locally on Mac Apple Silicon with Apple’s MLX-LM: install `pip install mlx-lm`, then `load()` a Hugging Face model an...

  Eric Fillion · 8 minutes
