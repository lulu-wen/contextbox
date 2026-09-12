# How to Build Antifragile Agents with OpenRouter

 Kenny Rogers • DevRel Lead at OpenRouter • ⏱️ 16 min read

Kenny Rogers is DevRel Lead at OpenRouter.

On June 12, 2026, Anthropic suspended access to Fable 5 for all customers to comply with a US government directive. Access returned on July 1, leaving applications built around Fable with a 19-day gap to cover.

The interruption exposed a problem AI engineers need to plan for. Models can become unavailable without warning. The next interruption could come from a provider outage, a rate limit, a model retirement, or another policy decision.

An evaluated fallback can route around the failure, show operators which model answered, and change the model order without an application deploy.

That is what I mean by an antifragile agent. It keeps working when a model or provider disappears, while the same evals and routing layer make it easier to test new models as they arrive. A new release can become a fallback, replace the primary, or take over one narrow step when it improves quality, cost, or latency.

We’ll see that process emerge as we build the example.

I built a runnable subscription billing agent to show how that works. The agent helps a support team investigate billing tickets and recommend a refund, credit, denial, or manual review. It uses OpenRouter for inference and starts with Fable 5 as its production model.

From there, I evaluate Grok 4.5 as a possible fallback, move business rules into tested TypeScript, store the qualified model order in an OpenRouter preset, and trace production requests through Broadcast. I’ll explain each of those pieces as we build them.

The results gave me a reason to make Grok the primary and keep Fable as the fallback. Both models passed all 20 cases after I narrowed their job, but Grok cost 63% less across these 20-case runs.

This is a synthetic eval for one task, so it can’t compare Grok and Fable across every workload. It does show how to qualify a fallback for the job it may actually need to take over. In this case, the cheaper model handled the workflow just as well, so it became the primary and the more expensive model became the fallback.

## What we’re building

The billing agent sits between a support ticket and the system that would carry out a billing action. It doesn’t move money. It gathers the relevant account records and returns a recommendation that support can review or pass to a separately controlled payment workflow.

For each ticket, the agent receives the customer ID and the customer’s message. It can look up trusted records for subscriptions, invoices, cancellations, product usage, disputes, service incidents, previous refunds, and support notes.

Consider this ticket:

I cancelled after the outage last Tuesday, but I was charged $240 again yesterday. I only meant to keep the monthly workspace. Sarah said in the previous ticket that we could get something back for the downtime. Please refund the annual charge and leave the other workspace alone.

The customer mentions 2 workspaces, a cancellation, an outage, a renewal charge, and an earlier promise from support. The billing agent has to connect those claims to the right records before it can recommend an action.

It needs to identify the annual workspace and its invoice, check whether the cancellation happened before renewal, find Sarah’s support note, load the policy active on the charge date, check usage and disputes, calculate an amount, and leave the monthly workspace alone.

The sample data includes customers, subscriptions, invoices, versioned policies, incidents, usage records, disputes, previous refunds, and support notes. For each ticket, the resolver returns:

type Resolution = {
  action:
    | "approve_full_refund"
    | "approve_prorated_refund"
    | "issue_account_credit"
    | "deny"
    | "manual_review";
  invoiceId: string | null;
  amountCents: number | null;
  policyVersion: string;
  reasonCodes: string[];
  evidenceIds: string[];
};

A result can have the correct action and still be dangerous. Refunding the wrong invoice, using the current policy for an older charge, or returning $1,000 when support promised $3,000 all count as failures.

You can run the project with:

git clone <https://github.com/kenrogers/antifragile-refund-triage.git>
cd antifragile-refund-triage
npm install
npm test
OPENROUTER_API_KEY=... npm run eval

Here’s how the support triage system becomes an antifragile agent.

## Step 1: Move the model call to OpenRouter

Assume the billing agent currently calls Fable through Anthropic’s API. The first change is to send that same Fable request through OpenRouter. The behavior stays the same, but the application can now reach Fable, Grok, or another model through one API.

If you’re migrating an existing project, use the migration prompt. It finds the current model calls, moves them to OpenRouter, and runs the project’s checks. It keeps prompts, tools, streaming behavior, and response shapes wherever possible.

Here’s the Fable call in TypeScript:

import { OpenRouter } from "@openrouter/sdk";

const openRouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

const response = await openRouter.chat.send({
  chatRequest: {
    model: "anthropic/claude-fable-5",
    messages,
  },
});

Fable still answers the request. Model selection now lives behind one API, so adding a fallback doesn’t require rebuilding the workflow around another provider’s SDK.

## Step 2: Define what a correct answer includes

Before adding a fallback, we need a way to tell whether it can handle the billing workflow. The eval is a set of synthetic tickets, account records, and expected resolutions that both models will run against.

I wrote 12 initial cases to develop the workflow, then froze the prompt and added an 8-case holdout. The holdout checks whether the workflow carries over to ticket formulations that weren’t used while shaping the prompt. Together, the cases cover duplicate charges, cancellations before renewal, low usage, service incidents, active disputes, previous refunds, ambiguous workspaces, prompt injection, quoted instructions, and conflicts between customer claims and trusted billing data.

Each case specifies all 6 fields in the expected resolution:

{
  id: "cedar-duplicate",
  customerId: "cus_cedar",
  ticket: "Cedar Ops was charged twice for the same month. Refund the extra $50 charge.",
  expected: {
    action: "approve_full_refund",
    invoiceId: "inv_cedar_duplicate",
    amountCents: 5000,
    policyVersion: "billing-policy-2026-07",
    reasonCodes: ["duplicate_charge"],
    evidenceIds: [
      "inv_cedar_duplicate",
      "inv_cedar_original",
      "sub_cedar",
    ],
  },
}

The runner scores action, invoice, amount, policy version, reason codes, and evidence separately. A wrong action, invoice, or amount is marked as a critical failure.

A decision-only eval would treat “approve a refund” as correct even when the model refunded the original invoice instead of the duplicate. The structured contract catches the mistake before money moves.

The runner also records the model returned by OpenRouter, token counts, cost, latency, response IDs, and request errors. The raw results ship with the repo.

## Step 3: Run the full workflow through each model

The starting architecture puts the whole investigation in the model’s hands. It receives the customer ID and ticket, then gets one tool for retrieving the trusted billing context:

const billingContextTool = {
  name: "get_billing_context",
  description: "Fetch trusted subscriptions, invoices, usage, incidents, support notes, and versioned billing policies for a customer.",
};

The model calls the tool, reads the records, chooses the invoice, selects the policy, calculates the amount, and returns all 6 resolution fields. I call this the agentic configuration in the results because the model owns the full decision path.

I ran the same 20 cases through Fable and Grok with low reasoning effort.

 Configuration Exact cases Holdout Fields correct Total cost Median latency Example failure

 Fable 5, agentic 14/20 6/8 102/120 $0.6719 11.03 s Returned $1,000 instead of a promised $3,000 credit

 Grok 4.5, agentic 5/20 2/8 96/120 $0.0840 3.91 s Returned null instead of $0 on denials

The exact-case score is strict. All 6 fields have to match. The Fable agentic run also had 1 request-level parsing failure, which counts as a failed case.

Both models usually found the right action and invoice. The other misses came from policy details and audit fields. They omitted evidence, dropped reason codes, used null where the contract required $0, applied a percentage credit while overlooking a support promise, or resolved an ambiguous workspace instead of escalating it.

Grok’s 5/20 exact score rules it out as a safe fallback for the existing workflow. Fable is the starting model, but its 14/20 score exposes a broader problem with the architecture. Too much billing logic lives inside whichever model happens to answer.

## Step 4: Narrow the model’s job

The billing records already contain the facts needed to resolve the case. The model doesn’t need to calculate money or select the effective policy version.

Its useful job is smaller. It reads the customer’s language and extracts 3 fields:

type RequestIntent = {
  workspace: string | null;
  reason:
    | "duplicate_charge"
    | "unexpected_renewal"
    | "service_incident"
    | "other";
  scope: "full" | "partial" | "credit" | "unknown";
};

TypeScript handles the rest:

const intent = await extractBillingIntent(ticket);
const customer = getCustomerRecord(customerId);
const resolution = resolveBillingRequest(customer, intent);

resolveBillingRequest joins the workspace to its invoices, loads the policy version effective on the charge date, checks disputes and previous refunds, calculates refunds and credits, and returns the evidence IDs used.

The money and policy code has ordinary unit tests. One test confirms that May, June, and July invoices load different policy versions. Another confirms that an active dispute always blocks automatic money movement.

This split applies to plenty of agent workflows. Models are useful for reading messy language, matching fuzzy references, and turning requests into structured intent. Code is better for calculations, thresholds, permissions, idempotency, and policy branches.

It also makes the application more antifragile. A replacement model only has to satisfy the 3-field extraction contract and pass the workflow eval. Billing policy stays put when the model changes.

Decomposition has a cost. Every policy change and exception now belongs in application code, and the 3-field intent contract can discard details that matter in unusual tickets. The model can still misunderstand a workspace or extract a plausible intent that sends the resolver down the wrong branch. The resolver needs ambiguity handling, tests for schema-valid mistakes, and a manual-review path for requests the contract can’t represent.

For this billing workflow, the tradeoff is worth testing as a first cost optimization. It shrinks the model’s job while keeping consequential decisions in code. Start there, measure quality and manual-review rates, then add complexity when real tickets show that the contract is too narrow.

## Step 5: Qualify both models on the workflow we’ll ship

I reran the same 20 cases after decomposition. These are total inference costs for 20 single-run cases, not estimated production cost per ticket.

 Configuration Exact cases Holdout Fields correct Total cost Median latency Critical failure

 Fable 5, decomposed 20/20 8/8 120/120 $0.1492 5.81 s None

 Grok 4.5, decomposed 20/20 8/8 120/120 $0.0555 3.54 s None

Both models passed the initial cases and the frozen holdout. Grok cost 63% less than Fable across these runs and had 39% lower median latency.

The result supports 2 decisions. The evaluated Fable 5 model is a qualified fallback for the decomposed workflow, and Grok can sit first because it passed the same contract at a lower cost in this test.

Neither model missed a decomposed case. I stopped after the frozen holdout because adding cases until something failed would distort the experiment. In production, the suite should grow when reviewed support tickets, policy changes, and traced failures expose new cases.

## Step 6: Put the model order in a preset

An OpenRouter preset is a named model configuration stored outside the application. It can hold the primary model, fallbacks, provider preferences, system prompt, and generation parameters. The app calls the preset by name instead of hard-coding that configuration.

Fable is back now, but we can reconstruct the setup that would have covered its 19-day interruption. With both evaluated on the decomposed workflow, the preset could have kept Fable first and Grok second:

{
  "models": [
    "~anthropic/claude-fable-latest",
    "x-ai/grok-4.5"
  ],
  "reasoning_effort": "low",
  "max_tokens": 200
}

OpenRouter’s models parameter tries models in order. If Fable is down, rate-limited, or refuses the request, OpenRouter can try Grok next.

The eval qualified the pinned Fable 5 model. The ~anthropic/claude-fable-latest alias can point to a later model version, so rerun the eval when it changes. The current results support the opposite order:

{
  "models": [
    "x-ai/grok-4.5",
    "~anthropic/claude-fable-latest"
  ]
}

The app references the preset by name:

const response = await openRouter.chat.send({
  chatRequest: {
    model: "@preset/refund-triage",
    messages,
  },
});

You can update the preset in the OpenRouter dashboard or through the Presets API. An API update creates a new preset version and makes it active. The app keeps calling @preset/refund-triage, so changing the models, their order, or other preset settings doesn’t require an app code change or deploy.

## Step 7: Trace the model that answered

A fallback can take over without drawing attention. The request still succeeds, but a different model may now be handling production traffic with different latency, cost, and failure modes.

OpenRouter gives you 2 ways to see what happened. Router metadata adds routing details to one API response. Broadcast exports traces from production requests to observability tools such as Braintrust, Datadog, Langfuse, ClickHouse, or an OpenTelemetry collector.

Use Router metadata to debug an individual request. Use Broadcast to graph behavior across requests and set alerts.

### Inspect one routing decision

Set xOpenRouterMetadata to “enabled” when you need routing details in the API response. Attach names and IDs so the request is easy to find later:

const response = await openRouter.chat.send({
  xOpenRouterMetadata: "enabled",
  chatRequest: {
    model: "@preset/refund-triage",
    messages,
    trace: {
      traceId: `billing-${ticket.id}`,
      traceName: "billing-resolution",
      spanName: "intent-extraction",
      additionalProperties: {
        environment: "production",
        workflowVersion: "1",
      },
    },
  },
});

The response’s model field tells you which model produced the answer. Router metadata adds the requested preset, routing strategy, successful attempt number, selected provider, and status of each attempted endpoint.

If Grok fails and Fable answers, the actual model changes to Fable and the attempts array records what happened before the successful response. An attempt number above 1 means OpenRouter tried another provider or fallback before receiving a successful response.

A successful HTTP response only tells you the user received an answer. Router metadata tells you whether the intended model answered, whether fallback added latency, and whether the fallback chain is close to being exhausted.

Router metadata is opt-in per request. It is useful for debugging a specific request, recording routing details with an error report, or verifying a preset change during a rollout.

### Send traces to your observability system

Enable Broadcast in the OpenRouter dashboard and connect a destination. OpenRouter then exports a trace for each request without requiring tracing code around every model call.

A trace can include the request and response, actual model and provider, token usage, cost, timing, and tool calls. The traceId, traceName, and spanName fields group related calls into one workflow. Custom fields such as workflowVersion make it possible to compare traffic before and after a prompt, preset, or policy change.

The export happens asynchronously after the request finishes, so it doesn’t add latency to the response. If support tickets contain sensitive data, enable Privacy Mode for the destination. It removes prompts and completions while retaining operational metadata such as model, timing, tokens, cost, and custom fields.

### Monitor the fallback as its own production path

A fallback that passed a local eval can still behave differently under production traffic. Track it separately from the primary model.

For this billing workflow, I would start with:

-
 Requests, fallback rate, and errors grouped by preset, model, and provider

-
 P50 and P95 latency by actual model

-
 Cost per successful resolution

-
 Manual-review rate and resolution amounts by actual model

-
 Eval failures linked back to production trace IDs

A sudden increase in Fable traffic would show that Grok is failing or being skipped, even if customers still receive responses. A rise in manual review or a shift in refund amounts could expose a quality change that uptime monitoring would miss.

Set alerts around changes from your own baseline. The useful signal is that fallback traffic, cost, latency, action distribution, or refund amounts moved after a model, provider, prompt, or preset change.

The eval qualifies a fallback before it enters the preset. Tracing shows how it behaves under production traffic. Reviewed failures can become new eval cases before the next model change.

## The loop

The workflow is 7 steps:

-
 Move the model call to OpenRouter.

-
 Define the full output contract and build product-specific evals.

-
 Run candidate models on the existing workflow.

-
 Move deterministic policy and calculations into code.

-
 Qualify primary and fallback models on the workflow you’ll ship.

-
 Store the model order in a preset.

-
 Trace the actual model and workflow behavior in production.

Fable’s 19-day interruption is over, but this architecture is ready for the next gap. Grok handles the narrow extraction step, Fable 5 remains an evaluated fallback, and TypeScript owns the decisions that move money.

Evaluating Grok as a fallback showed that it could become the cheaper primary for this workflow. A future model only has to pass the same 3-field contract and workflow eval before it can enter the preset.

A model outage no longer requires an emergency application rewrite. Production failures become new eval cases, and new model releases become measured opportunities to improve the system.

The complete code, synthetic billing records, 20 eval cases, raw results, policy tests, tracing fields, and preset scripts are available at github.com/kenrogers/antifragile-refund-triage.

Ready to use OpenRouter to make your agent antifragile? Here’s three steps to get started.

 - Sign up here to get $10 in credits (limited to the first 100 redemptions)

-
 Point your agent at openrouter.ai/agents to teach it to become an OpenRouter expert

-
 Point it at this article and ask it to help make your system antifragile

More from Post-Training

## Keep reading practical field notes

 All posts

    Guest post

### What I Learned Giving Fable 5 a Face

Giving an avatar “a face” bottlenecks on interaction timing, not rendering: interruptions, turn-taking/ending cues (e.g., Turkish needed eager end-...

  Ben Carr · 11 minutes

    Guest post

### How to Write a Winning Agent Harness for Your Domain

If adding instructions makes your agent worse, it’s often a harness problem: we watched Reef/AlphaCumen collapse from a Vals v1 lead to zero on Val...

  Hitesh Jain · 13 minutes

    Guest post

### How to Run Open-Source LLMs Locally on a Mac with MLX-LM

Learn to run open-source LLMs locally on Mac Apple Silicon with Apple’s MLX-LM: install `pip install mlx-lm`, then `load()` a Hugging Face model an...

  Eric Fillion · 8 minutes
