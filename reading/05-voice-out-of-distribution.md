# Your Conversation Is Out Of Distribution

Deep Dive

## Your Conversation Is Out Of Distribution

Expert Deep Dive · Guest Post · September 11, 2025

 Kwindla Hultman Kramer • CEO at Daily • ⏱️ 8 min read

Co-founder of Daily and contributor to Pipecat

The big thing on my Twitter feed last week was people yelling at each other about evals. You need evals. You don’t need evals. Evals work. Evals don’t work.

As far as I can tell, @swyx both kicked off the evals conversation and had the most nuanced Tweet-sized take on the whole thing.

 https://x.com/swyx/status/1963725773355057249

My own take is informed by building lots of conversational voice agents, starting right after GPT-4 was first released, and helping lots of people go from proof-of-concept to voice agents in production at scale.

From an inference predictability and evals perspective, voice agents are different from other AI agents in a couple of important ways:

-
 Almost all voice agent use cases involve long, multi-turn conversations.

-
 People do not talk the same way they write.

Voice agents are hard to prompt engineer effectively, and hard to evaluate. Voice use cases are always right at the edge of Ethan Mollick’s “jagged frontier.”

Today’s SOTA LLMs are amazing. They’re capable of open-ended, human-like conversation. You can throw a bunch of unstructured data at them and they can extract, structure, categorize, and summarize accurately.

But the performance of even the best LLMs degrades noticeably in multi-turn conversations.

For a very good empirical analysis of this, check out a paper published earlier this year, LLMs Get Lost In Multi-Turn Conversation.

To build up an intuition about why multi-turn is hard for LLMs, think about the data that big models are trained on.

-
 All of the publicly accessible text on the Web (loosely speaking)

-
 A great deal of audio and video from sources like Youtube

-
 Scanned books

-
 Human- and synthetically generated conversations in multi-turn format

Type 4 (conversations) is a small percentage of the data used to train today’s LLMs and most of that data doesn’t look much like how people interact with LLMs in business use cases like customer support.

Now think about how people talk, compared to how they write. Until very recently, LLM training included very little conversational audio data.

One of the amazing things about today’s LLMs is how good they are at transfer learning – at generalizing between tasks. This is a big part of why we can use LLMs at all for these voice conversation use cases. But when we’re relying so heavily on the LLM’s ability to generalize, rather than asking it to operate in a domain where it has seen a lot of relevant data, it’s not surprising that performance is relatively poor.

There are a couple of pieces of good news, though.

First, models continue to get better at multi-turn, and multi-turn audio, use cases. All of the frontier labs invest heavily in data generation and labeling. Real-world voice AI use is growing fast and conversational voice is now a priority in SOTA model training.

Second, we have developed good techniques to implement reliable conversational workflows using today’s LLMs.

If the tokens you are handing your LLM are a little bit “out of distribution” relative to the training data, you can try to give the LLM better tokens! In other words, focus the LLM’s attention on what you really need it to do and remove unnecessary information.

This general idea is something that many AI engineers have converged on. Dex Horthy coined the perfect term for it: context engineering.

I find it useful to design complex voice AI workflows as (simple, flexible) state machines. For each big thing I want a voice agent to do, my goal is to prompt the LLM with:

-
 A specific system prompt focused primarily on that thing.

-
 A contextually relevant summary of the conversation up to this point. This summarization “cleans up” a lot of the messiness of a natural language multi-turn conversation, and is an opportunity to remove context that’s not relevant to the task at hand.

-
 The list of tools that are useful in this part of the workflow. Having fewer tool choices improves LLM tool use performance considerably.

-
 A description of possible next states to transition to.

This is just one possible way of thinking about how to get the most out of your LLM inference calls. I’m a fan of state machines in many programming contexts, so this set of ideas is helpful to me. But however you think about your workflows, the general context engineering principles are applicable: each time you ask the LLM for a response, give it the most useful tokens you possibly can.

If you are interested in the state machines approach to voice conversations, the open source Pipecat Flows library is a set of helper functions for building realtime conversational state machines. Pipecat Flows is built on top of Pipecat, a flexible, open source, vendor neutral, and very widely used voice agent framework.

Let’s wrap back around to evals.

You don’t have to create or use evals, per se. But you do need to understand whether your AI agents are working the way you want them to.

There are a few (complementary) ways to approach this:

-
 Use your agents yourself, as much as you possibly can, in earnest. This works well if you are the target market for your own product. It’s hard to do if you’re not.

-
 Test heavily, manually, thoughtfully, consistently. Really, there’s no substitute for this. The best evals are only possible if you’re already doing manual testing. You need to understand your data and agent performance intuitively in order to know whether your evals are useful at all!

-
 Build very simple “evals” that help you test manually. Start to scaffold your testing. Use spreadsheets to track a few things.

-
 Build evals that you can run repeatably. This is actually quite hard and time consuming, even with the best available eval tooling today. It’s definitely worth aspiring to this. But it’s only worth doing after you are really, truly doing the previous three things well.

-
 Develop large-scale testing that leverages techniques like simulation. Again, very much worth doing, but again, a necessary prerequisite to doing this well is that you understand your data and your agent performance intuitively.

I’ll close with the results of the AI Engineer World’s Fair Voice Agent Benchmark, code I wrote to test instruction following, function calling, and tool use in a 30-turn voice conversation scenario.

This benchmark grew out of a voice assistant project we did for the 2025 AI Engineer World’s Fair. The idea was to use a pre-release Gemini Live speech-to-speech model and show people at the conference what the newest generation of native audio LLMs could do.

For a knowledge base, we used the very large llms.txt file that listed every event and session, and just passed the full content into the Gemini Live API as a system instruction. The agent was pretty good! But the pre-release model, working with a very large context of about 75k tokens, did make some funny mistakes occasionally.

It occurred to me that this was an interesting multi-turn agent test. The idea is that we’re testing LLM performance without doing any context engineering. No state machine workflow design or any other fancy techniques. And we’re using the same prompt for every model we test. (Which you would not do for a production application.)

As you can see from the results below, this benchmark is far from saturated. No model performs perfectly, or even close to perfectly. The table shows the number of errors in an average 30-turn conversation.

On the other hand, it’s possible to use RAG, careful prompt tuning, and context engineering to build sophisticated, reliable voice agents with all of these models. (Well, maybe not the cloaked prerelease Sonoma Dusk Alpha model, which I threw in as an interesting comparison. That model is a fun conversationalist but clearly suffers from the tool calling issues that we see in most alpha models and inference stacks.)

The usual caveats about benchmarks apply here: this is a contrived test that doesn’t overlay perfectly with any production use case. Your mileage will vary. But the results do broadly align with my experience using these models, and with the results of other benchmarks like the Berkeley Function-Calling Leaderboard.

A lot of the value of writing a benchmark like this is that it forces you to look hard at the data you’re sending to and receiving from the LLMs you are testing. As with many things in engineering, you are likely to understand the problem differently after you struggle through the implementation.

Hamel Husain maintains a FAQ about LLM evals that is an excellent resource. My thinking about evals is heavily influenced by Hamel’s approach, which I think of as the “look at your data” mindset. I recorded a video with Hamel showing how I build lightweight evals by hand for voice agents early in the development process.

All of which brings us back around to the Swyx tweet we started with. Spending a lot of time on evals may be anti-correlated with building successful AI products, because evals aren’t an end in themselves. They are one facet of the testing and iteration process necessary to get these new, complex, non-deterministic tools to behave the way you want them to.

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

### This isn't a newsletter. It's a build log.

AI Tinkerers is a global community of people who ship real stuff with AI.
 Find your local chapter →

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

### Comments

Loading comments...

 Characters remaining: 5000
