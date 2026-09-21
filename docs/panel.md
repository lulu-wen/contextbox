---
layout: default
title: The panel and the pet
---

What the page actually looks like (the address `node cli.mjs pet` prints), what the keys do, and which parts
are simulated and which are real. The README only gets as far as "open the panel"; the detail is here, and
`test/repo.test.mjs` checks this file against the implementation.

## Two halves

The page has **two halves**: Files (the default) and Your details, switched by the two tabs at the top.

Switching uses the fragment in the address (`#files` / `#facts`): **same page, no reload, no second key**.

Which half you were on last is kept in `localStorage` (if that cannot be read — a private window, say — it
falls back to the default).

The field progress bar and the section jumps (`#g0`, `#g1`, …) in Your details appear only there;
using a section jump scrolls to that group and does not throw you back to Files.

Files has two buttons, "Open cleanup panel" and "Undo recent actions", which open the two panels under the
croissant cat.

## The cat

The bottom right of the home page loads `core/assets/quaso_v10.glb`. Click the cat to toggle its speech
bubble; click outside or press Escape to close it.

**The animation follows the pet's state** — idle, found, thinking, cleaning, restoring, happy, worried —
rather than anything you pick. The gear button (or the **S** key) shows or hides the "Pet state" line, which
names the state the cat is in right now.

The model is drawn by `core/assets/pet-viewer.js`; after you update the server, restart it and reopen the
page from the address the server prints (or `node cli.mjs open`).
## Getting back in

The page removes the key from the address bar once it has loaded. **Reloading still works**: the visit that
carried the key also set a session cookie (`HttpOnly`, `SameSite=Strict`, this browser only, gone when the
server restarts). That cookie opens the page and nothing else — every route that touches a file still wants
the token in a header, so it is not a way in for another site.

To open it in another browser, or to bookmark it, use the full address `node cli.mjs open` prints —
the key itself is stable (it lives in `~/.contextbox/token` and is generated once), so that address keeps
working. To supply your own instead (shared between the sandbox and the real thing, and portable between
machines), set `CONTEXTBOX_TOKEN` (at least 16 characters).
## The two hidden keys

On Windows and macOS alike, **D** swaps in four sample candidates (`core/assets/demo-candidates.json`) and
**O** simulates the backend being offline; press the same key again to turn it off. Neither fires while you
are typing in a field, in a menu, or composing text.

Nothing on the page advertises these keys, and the sample list never turns on by itself.
## The three icons

Three small icons sit under Quaso: a **bin** with the candidate count in the middle, blinking when there is
something there, which opens the cleanup panel; a **back arrow** with the number of still-undoable actions in
its corner, which opens the undo panel; and a **gear**, which shows or hides the "Pet state" line (same as
pressing **S**). Finding
candidates no longer pops the big speech bubble open on its own.

With the sample list on, the number is the sample count; otherwise it is the local one. Hover for the source
and the full count.
## When the backend goes away

If the backend goes away after the page has loaded, the cat turns worried, pauses its idle animation, and
shows a disconnected bubble next to itself.

The connection message and the "retry" button only appear when you click that bubble; clicking outside closes
it, and the bubble disappears on its own once the connection is back.

It checks every 5 seconds, and you can retry by hand; when the connection returns, the list is kept and
everything goes back to normal.

If the server never started at all, the browser cannot load the local page, so you still have to start the
server first.

To see the worried state, leave the server running and press O, or add `&mockBackend=offline` to the address
with the key in it (`http://127.0.0.1:7391/?k=…&mockBackend=offline`, with the key from `node cli.mjs open`).

While that is simulated, retrying stays offline; pressing O again rechecks the real backend. The page's data
API sends nothing while the simulation is on.

You can tick items one by one, confirm a simulated cleanup, undo it or skip it; "Run the demo again" restarts
the flow.

Turning D off keeps the current sample list, so turning it back on carries on where you were. A simulated
cleanup moves no real file;
the record of what you did goes into a separate `cleanup_demo_history` table in the local database, so it
survives closing the tab and reopening with `node cli.mjs open`, and it survives restarting the server.

After "Finish this cleanup" closes the panel, the back arrow still opens "Undo recent actions",
which lists the history from what is actually in the database (20 per page); you can tick several cleanups
and put back every file from each of them.

A record you successfully undo leaves the list at once, and the count only includes actions that can still be
undone;
the database keeps a flag saying it was undone, so it cannot run twice.

"Run the demo again" only resets the sample list; it does not clear the record of what you did. Demo runs that
only ever existed in memory are not backfilled.

## The model's opinion, and what is ours

On a rename, filing or candidate row the model's **evidence** is a quote pulled out of your file, so it is
drawn as one: indented behind a rule. The sentence under it — "this is the model's opinion, not a fact…" —
is the panel's own words, and is set smaller and greyer so the two never read as one paragraph. They used to
be a single run of text, which made our promise look like part of whatever the file happened to say.

## What a burst group says

A group's heading names how many shots it holds, **how long the batch spans**, and which one is being kept:
"3 shots look like one burst · taken within 7s · keeping “Screenshot … 10.31.09.png” (the newest)".

The span is there because "these are one burst" is a claim about *time*, and the thumbnails alone give you no
way to check it — three shots seconds apart and three shots hours apart look identical on screen. It comes
from `spanSec` on `GET /cleanup/bursts`; under a minute it reads in seconds, then minutes, then hours. An
older backend does not send it, and then the heading simply leaves the span out rather than guessing.

Every frame carries its own size, **the kept one included** — without it the shot you are comparing the
others against is the one you cannot compare.

Every row in the cleanup panel — a candidate, something that needs your eye, each frame of a burst, a rename
suggestion, a filing suggestion — has a **"View contents"** button.

It expands under that row and collapses when you click it again. The contents come from
`GET /cleanup/preview/:itemId`:
text from the `file_texts` the scan already extracted (2000 characters at most; a truncated one says there is
more),
and images from the existing thumbnail endpoint (`/cleanup/thumb/…`, long edge ≤ 480, fetched as a blob
through the token-carrying api, with no key in the URL).

When there is neither, it still gives you the size, the last-modified time and "why this was listed", so you
can decide for yourself;
a file whose contents have not been read yet says so, and **it is not read on the spot**.

It fetches when you click, once per file. Demo mode has no such button (the list on screen is a fixture
there).

With D off the page is in local mode, and the cleanup panel and "Undo recent actions" are wired to the real cleanup API:
ticked files in the watched folders (`cleanup.roots`) move to quarantine, and can be put back
within seven days (the matching CLI commands are in [the CLI reference](cli.html)).

The cat's mood is worked out by the page itself from `/health` (candidate count, whether the watcher is
running, whether anything answers).

From the backend's `GET /pet/state` the page reads only `burst.newGroups` — when there is a **new** group of
burst screenshots,
the cat asks "these look like one batch, keep just the newest?" of its own accord (once per group).

The mood itself is still not read from there.

The 3D view uses a copy of Three.js 0.180.0 (MIT) kept in this repo, the one exception to the zero-dependency
rule below;
the backend still has no dependencies, there is still no `npm install`, and the page loads nothing from a CDN.

## The six section tabs in the panel

The cleanup panel has six sections: **Cleanup / Bursts / Suggested names / Filing / Learned / Settings**.

They used to be stacked on one scrollbar, so the filing suggestions were a long way down. Now you see one at
a time.

- It opens on "Cleanup"
- The number on a tab is how many rows that section has; **a tab showing 0 is visible but not clickable**
  (you should know the feature exists)
- **The action buttons follow the section**: in Filing you only see "File" and "Undo filing"
- When the section you are on empties out because you finished it, it moves to the first one that still has
  something
- **Demo mode (press D) hides the tab strip entirely** — only the cleanup section is real there

**Settings is not a list, so it behaves differently from the other five.** It carries no count ("Settings0"
reads like your settings were wiped), it is always clickable, and it takes no part in the jumping rule above
— being thrown onto the Settings page when everything else empties would hide the "nothing to clean up right
now" line that belongs on Cleanup.

What it changes is the config file itself, five fields of it: read-only mode, the model endpoint, the model
name, the name of the environment variable holding the key, and whether screenshots are included in cleanup.
The first four are re-read on every request, so saving them is enough; the fifth is worked out when the pet
starts, so it says so and keeps running with the old value until you restart. The folders are shown on the
same page but not editable here — where the scanner points deserves more than a text box.

**The key box wants the NAME of an environment variable, never the key.** The page says so under the box,
and it only ever tells you whether that variable has something in it. The key is not written to the config
file, not rendered on the page and not sent back in any response.
