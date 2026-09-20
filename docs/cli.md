---
layout: default
title: CLI reference
---

**This is an interface contract, not a tutorial.** It pins down the shape first, so the implementation, the
context menu and the nightly smoke run all line up against the same thing.
Rewritten on 2026-09-19 to match the behaviour audit RC13 found (the previous version described things the
implementation did not have, and missed things it did); checked again the same day in the third wave (C8):
the exit code for CONFLICT, the suggestion for `unknown`, how long an id is, the exit code for `open`,
the environment variables, and what happens to a plan that stopped partway. The "docs/cli.md (RC13)" group in
`test/repo.test.mjs` holds these.
Third wave, part two: the "Plans in the way" examples now match what the CLI really prints (that test runs the
CLI and compares line by line), and what `pet` does when the port is taken.
Second round (audit "root causes, round two"): every cleanup command tidies up first, exit codes follow the
per-item results, only screenshots are cleaned in the screenshots folder, `doctor` lists interrupted plans and
scan problems, `open` and `pet` identify the pet with a proof, and the background scan times out. The
`cleanup list` example is also a real run compared line by line.

---

## Every command

```bash
node cli.mjs doctor                          # how things are: where the config, database, cleanup folders and quarantine are
node cli.mjs pet                             # start the server and the cleanup watcher; print the address with the key (?k=)
node cli.mjs open                            # open the pet and the cleanup panel in a browser (address with the key)

node cli.mjs cleanup scan                    # scan the cleanup folders once by hand (Downloads only, by default)
node cli.mjs cleanup list                    # see the cleanup candidates
node cli.mjs cleanup apply                   # build a plan from the ✔ rows on the list and apply it
node cli.mjs cleanup apply --skip <id>,…     #   the same, but leave these ✔ ones out
node cli.mjs cleanup apply --also <id>,…     #   the same, plus these ☐ ones
node cli.mjs cleanup apply <plan-id>         # apply (or re-send) one particular plan
node cli.mjs cleanup undo [plan-id]          # undo; no id means the most recent one that can still be undone
node cli.mjs cleanup release <plan-id>       # drop a plan that never started; no file moves
node cli.mjs cleanup quarantine              # see quarantine
node cli.mjs cleanup quarantine --empty      # preview emptying it (seven days old), and print a confirmation token
node cli.mjs cleanup quarantine --empty --yes <token>   # really empty the files in that preview

node cli.mjs think                           # let the model read a round of unread files (P2)
node cli.mjs think --limit <n>               #   how many at most this round (1–500, default 20)

node cli.mjs rename                          # list the files that could be renamed (the model's suggestions, P3)
node cli.mjs rename --apply [id…]            #   rename (no id means everything on the list, except what you turned down)
node cli.mjs rename --apply <id> --to <name> #   name it yourself (a name unlike the suggestion gets remembered, P5)
node cli.mjs rename --undo [record id…]      #   undo a rename (no id means the most recent)

node cli.mjs file                            # list the files that belong in a course folder (the model's suggestions, P4)
node cli.mjs file --apply [id…]              #   file them (no id means everything on the list, except what you turned down)
node cli.mjs file --apply [id…] --course <course> [--kind <kind>]
                                             #   name the course/kind yourself (unlike the suggestion gets remembered, P5)
node cli.mjs file --undo [record id…]        #   undo a filing (no id means the most recent)

node cli.mjs learned                         # what it learned from your changes (P5; it touches no file)
node cli.mjs learned --forget <id…>          #   forget those entries
node cli.mjs learned --forget-all            #   forget everything

node cli.mjs watch                           # stay watching in the foreground (the screenshot feature, as before)
```

`cleanup dismiss` **does not exist**: it prints "there is no such command" and exits 1.

**An id** is the few characters in square brackets at the start of each `cleanup list` row (`[e2dc]`, say), and
is **at least 4 characters**; when it would collide with the start of another file's id it gets longer until it
does not (`[abcd1]`, `[abcd2]`).
`--skip` and `--also` take several ids separated by commas, each at least 4 characters. If any one of them is
shorter than 4, matches no row, or matches several rows → exit code 1 and nothing moves (when it matches
several, the ids that would tell them apart are printed).

**Flags that take a value** (`--to`, `--course`, `--kind`, `--forget`) must be followed by one. Ids are read
**up to the next flag**, so in `file --apply a1b2 --course OS` the `OS` is the course name, not a second id.
A flag with nothing after it (or another flag) → exit code 1 and nothing moves.
`--to`, `--course` and `--kind` **only work together with `--apply`**; `--to` names one file at a time
(renaming several files to the same name would only produce `X`, `X-2`, `X-3`, which is nobody's intention).

### The cleanup scope

Cleanup looks at `cleanup.roots` in the config file and nothing else. **By default that is Downloads under
your home directory only** (on Windows, `%USERPROFILE%\Downloads`, and deliberately not the OneDrive one:
moving a file out of a OneDrive-synced folder into quarantine deletes it in the cloud and on every device;
round two, R2-11).
`watch` is the list of folders the screenshot feature watches and has nothing to do with cleanup — on macOS
`watch` includes the Desktop by default, and cleanup must never follow it (audit RC15).
Only `cleanup.screenshots: true` adds the screenshots folder to the cleanup scope, and **only screenshots are cleaned there** (the screenshot rules; other files are neither listed nor moved).
On macOS the screenshots folder is the Desktop, so even with that switch on, an old archive or installer on the Desktop is not treated as junk (round two, R2-8).
`pet` says which folder that is at startup, and so does `doctor`.

### `think`: let the model understand the contents (P2)

`think` runs one round by hand; `pet` runs one in the background every 10 minutes. They do the same thing:

- **With no model configured it does nothing** (`model.baseUrl` or `model.name` empty, or the key's
  environment variable empty): it says how to configure one and exits **0** — that is not a failure, it is
  simply not connected. Scanning, cleanup and the panel all carry on.
- It only asks about two kinds of file: **documents with at least 30 characters of text**, and **PNG
  screenshots with a visual fingerprint**. Nothing else.
- **Filtered before anything is sent**: names that look like secrets (`.env`, `id_rsa`, `*.key`,
  `credentials`, `token`, `secret`, `password`, wallets…) and contents that look like secrets
  (`BEGIN PRIVATE KEY`, `AKIA…`, `ghp_…`, `sk-…`, national id numbers, credit card numbers) are **never
  sent**, and a note is recorded saying it looked like a secret and was not sent.
  `doctor` says how many files were held back for that reason.
- **One at a time, 60 seconds each.** A document sends at most 2000 characters; a screenshot is scaled to a
  greyscale PNG with its long edge at most 1344.
- **The same contents are only asked about once** (the cache key is the sha256 of the contents plus the prompt
  version): a second copy hits the cache, and changed contents get asked again.
- **Three failures in a row end the round**, recorded as the last error (kind `model`), exit code **2**. The
  next round tries again.
- Ctrl+C stops it wherever it is, **with no half-written records**.

What the model says is an **opinion**, not a fact: the panel always writes "The model thinks: … (confidence …)"
with the evidence, and **nothing** is ticked, renamed or moved because it said so. Answers seeded by
`tools/demo-setup.mjs --seed-model` are marked "[demo answer]".

### `rename`: rename the files that have no real name (P3)

**There is no automatic renaming path.** `rename` only lists; `--apply` is what touches a file, and every one
is recorded so `--undo` puts it back.

- It only suggests files whose `naming` is untitled or generic. **A name you chose yourself (named) is never
  touched.**
- Suggestions the model is "low" confidence about are not listed (that usually means "cannot tell"). For files
  the model has not read yet, run `think` first.
- The suggested name is **sanitised**: path separators, control and direction characters, leading and trailing
  spaces and dots, Windows reserved names, and a limit of 80 code points. **The extension is always the one
  the file already had** (the model says `x.pdf`, the file was `.txt` → `x.txt`). If sanitising leaves
  nothing, nothing is suggested.
- **Nothing is overwritten**: if the target name is taken (**including taken by a name that differs only in
  case**) it becomes `…-2`, `…-3` and so on, up to 99.
- It renames **within the same folder**; it never moves a file.
- These are not renamed, and it says why: files that changed in the last ten minutes, files in a plan that has
  not been applied, files in quarantine, and protected filenames.
- 100 at a time at most; beyond that it says "N more, run it again".
- If the old name has been taken by another file at `--undo` time, the one being put back gets a suffix **and
  the CLI prints what it is called**.
- Killed halfway through: the next `rename` tidies up first (deciding from where the file actually is whether
  that record is done or not done), and does not rename twice.

- `--apply <id> --to <new name>`: name this one file yourself (one at a time).
  If it differs from the suggestion, **the wording of the course part is remembered** (P5, see `learned`).
- **`--apply` with no ids skips the ones you turned down last time** (P5) and prints their ids — naming an id
  still works, turning something down is not a ban.

Exit codes: nothing to rename is **0** (that is not a failure); a bad id, an unknown flag, or read-only mode is
**1**; some files not renamed is **3**.

### `file`: put a course together into a structured folder (P4)

**There is no automatic filing path.** `file` only lists; `--apply` is what moves a file, and every one is
recorded so `--undo` moves it back.

- Files go to `<filed>/Courses/<course>/<kind>/`. `filed` is the filing folder from the config file
  (`~/Documents/Filed` by default), and **files only ever move inside that tree**; nothing goes up out of it.
  The kind is the `kind` field of the model's six: Lecture / Homework / Exam / Notes / Code / Report / Form /
  Chat / Other, and anything unrecognised becomes Other.
- The `topic` **does not go in the path**: too fine-grained, and it would produce a pile of folders with one
  file each. It is kept in the record.
- It only suggests files the model can place: "low" confidence is not listed, and neither is a course of
  "Unknown". **Files that already have a good name are still listed** — having a name and belonging somewhere
  are two different things.
- The course name goes through **the same sanitiser as renaming** (path separators, control characters,
  Windows reserved names) with a limit of 40 characters. If sanitising leaves nothing, nothing is suggested.
  A model answering `../../etc` only produces an ordinary folder name under `filed`.
- **One folder per course**: before comparing, full-width characters, spaces and case are folded together
  (`Operating Systems ` and `Operating Systems`, `ＯＳ` and `OS`, are the same course). An existing folder is
  reused; the first spelling seen is only used when one really has to be created.
- **Nothing is overwritten**: if the target folder already holds that name (including one differing only in
  case) it becomes `…-2` and so on, up to 99.
- These are not moved, and it says why: files that changed in the last ten minutes, files in a plan that has
  not been applied, files in quarantine, protected filenames, symlinks and hard links, and anything already
  under `filed`.
- **`filed` on another drive** (rename returns EXDEV): that item fails and says why, and the others carry on.
  It does **not** fall back to copy-then-delete — that is deleting.
- 100 at a time at most; beyond that it says "N more, run it again".
- **What has been filed is not suggested for cleanup again** — as long as `filed` is not under
  `cleanup.roots`, which is the default (filing to `~/Documents/Filed`, cleanup looking only at
  `~/Downloads`). Put `filed` somewhere inside the cleanup scope, like `~/Downloads/Filed`, and the scan still
  reaches it, so filed material turns up as a candidate again later — `doctor` speaks up about that setting.
- `--undo` moves a file back to **the folder it came from** (even a folder outside the cleanup scope, the
  Desktop for instance). If something with that name is already there, the one being put back gets a suffix
  **and the CLI prints what it is called**; if the original folder is gone, it is recreated inside the cleanup
  scope (outside it, it is not recreated, and it says so).
- **Empty folders are not deleted**: a subfolder left empty by the move stays. This project moves, it does not
  delete.
- Killed halfway through: the next command of any kind (`file`, `doctor`, `pet` starting up) tidies up first —
  it decides from where the file actually is whether that record is done, not done, or needs a human, and does
  not move it twice.

- `--apply <id…> --course <course> [--kind <kind>]`: say where it should go yourself.
  If that differs from the suggestion **it is remembered** (P5, see `learned`), and the next file from the
  same course uses your wording straight away.
- **`--apply` with no ids skips the ones you turned down last time** (P5) and prints their ids — naming an id
  still works, turning something down is not a ban.

Exit codes: nothing to file is **0** (that is not a failure); a bad id, an unknown flag, or read-only mode is
**1**; some files not moved is **3**.

### `learned`: what it learned from your changes (P5)

**It only learns from something you actually did**: the values you passed to `rename --apply` and
`file --apply`, and the `--undo` of either. Not from scanning, not from the model, not from guessing. What it
learns **only changes suggestions**; it never moves a file by itself.

- It only learns from the moment **the value you sent differs from the one suggested**. Accepting a suggestion
  unchanged (no `--to` / `--course` / `--kind`) records nothing — that is not new information, and recording
  it would only inflate the "used N times" count. Once it has learned, clicking the wording it filled in for
  you is not new information either.
- **Once is enough**; you do not have to change it three times. That is an explicit instruction, not a
  statistic. The second file from the same course is listed with the new wording (marked "the way you changed
  it last time").
- It learns three things:
  - **What a course is called** (`Operating Systems` → `OS`). Renaming and filing share this, and on the
    renaming side **only the course part changes**: `Operating Systems_Scheduling` becomes `OS_Scheduling`,
    and names without that part are untouched.
  - **The kind for that course** (you keep changing Operating Systems "Notes" to "Lecture"). **Not globally**
    — globally would drag Data Structures along with it.
  - **Suggestions you turned down** (the `--undo`). The list still shows them, but **`--apply` with no ids
    does not do them**, and the row is marked `⟲ You turned this suggestion down last time`. Do it
    successfully once and the mark goes.
- There is **one entry per key**, and **the last one wins** (`times` goes up by one). Changing back to what the
  model said also counts as one, and the suggestion changes back with it.
- A learned course name is **sanitised on the way in and again on the way out** (the same sanitiser as
  renaming). Type `--course ../../etc` yourself and this time it files into `Filed/Courses/etc/` as P4 says
  (never leaving that tree), but **it is not remembered** — the sanitised form is not what you typed, so that
  was not the wording you asked for.
- **Existing folders are neither moved nor renamed.** Files filed into `Courses/Operating Systems/` before it
  learned `OS` stay there and later ones go to `Courses/OS/`; the list says "You used to call it Operating
  Systems; that folder is still there, untouched". Whether to merge them is your call — this project moves, it
  does not delete.
- **The cap is 500 entries.** When it is full the oldest and least used go first (low `times`, old `at`), and
  `learned` tells you how many were dropped. The one just learned is always kept.
- **Read-only mode (`CONTEXTBOX_READONLY=1`) learns nothing**, and does not do `--forget` or `--forget-all`
  either (exit code 1). `learned` itself still lists.
- **If the table is gone** (an old database, or someone deleted it) it behaves as though nothing had ever been
  learned: `learned` says it has not learned anything yet, `rename` and `file` still make suggestions, and
  nothing throws a stack trace.
- The list carries **no path, no filename and no file contents**: only the course, the kind, and for filing
  the `Courses/<course>/<kind>` string. A turned-down **rename** suggestion only says you turned a rename
  suggestion down last time — the summary behind it is a real filename and is not printed (the id on that row
  is all you need to forget it).
- **A typo in the kind is not learned**: `--kind Lectrue` files into Other this time as P4 says, but it does
  not turn every later "Notes" for that course into "Other".

Exit codes: listing (including "nothing learned yet") is **0**; a bad id, an unknown flag, or forgetting in
read-only mode is **1**.

### Environment variables

| Variable | What it does |
|---|---|
| `CONTEXTBOX_CONFIG` | where the config file is (default `~/.contextbox/config.json`) |
| `CONTEXTBOX_DB` | where the database is (default `~/.contextbox/data.db`) |
| `CONTEXTBOX_QUARANTINE` | where quarantine is (default `~/.contextbox/quarantine`) |
| `CONTEXTBOX_TOKEN_PATH` | where the key file is (default `~/.contextbox/token`) |
| `CONTEXTBOX_TOKEN` | **the panel's key, given directly** (beats the key file). At least 16 characters; anything shorter counts as unset. Supply your own and the sandbox and the real thing can share one, so the address stays the same and can be bookmarked |
| `CONTEXTBOX_READONLY=1` | read-only mode: it only says what it would do — no plans, no moves, no deletes, **and no tidying up either** (round three, R3-9) |
| `CONTEXTBOX_PORT` | the port for `pet` and `open` (default 7391; `0` lets the system pick a free one, and `pet` records the real port for `open`) |
| `CONTEXTBOX_RESCAN_MS` | how often `pet` rescans everything, in milliseconds (default 30 minutes; minimum 100) |
| `CONTEXTBOX_SCAN_TIMEOUT_MS` | how long `pet`'s background scan may run, in milliseconds (default 10 minutes; minimum 100). Beyond that it is killed and recorded as the last error |
| `CONTEXTBOX_THINK_MS` | how often `pet` lets the model read a round, in milliseconds (default 10 minutes; minimum 100). With no model configured, none of it runs |
| `CONTEXTBOX_OPENER` | the program `open` uses to open an address (default per OS: `xdg-open`, `open`, `start`) |

`test/smoke-cleanup.md` uses these to keep the whole smoke run inside a sandbox. Tests that spawn the CLI must
always give the child a fake `HOME`; `pet` always runs with `CONTEXTBOX_PORT=0` (never taking 7391), and `open`
always gets a `CONTEXTBOX_OPENER` (so no real browser opens).

### Every cleanup command tidies up first

At the start of `cleanup scan` / `list` / `apply` / `undo` / `release` / `quarantine` and `doctor`, and when
`pet` starts up and before each background rescan, two things happen (round two, R2-1a / R2-5):

- **Close out records of a move that was interrupted** (the core's `recoverInterrupted`). For an item killed
  between the rename and the record being written (kill -9, a power cut, Ctrl+C), it judges from the file
  evidence only: the file is in quarantine and the fingerprint matches → recorded as in quarantine; still in
  place → recorded as not moved; anything uncertain stays "state unknown". **No file is moved.** Before this,
  a single-file plan killed at that instant was invisible: `undo` could not find it and `quarantine` said
  quarantine was empty, so as far as the user was concerned the file was gone.
- **Automatically drop plans older than 60 minutes that never started** (the core's `releaseStalePlans`, the
  same as `release`: candidates are untouched). Plans that did start (any move record at all) are left alone —
  they can only be finished or put back.

While another cleanup action is running (the cleanup lock is held), this tidying up is skipped and the command
carries on; if the tidying up itself fails it prints one warning line and the command carries on.

Round three added three more:

- **Read-only mode (`CONTEXTBOX_READONLY=1`) does none of it** (R3-9). Both of those write to the database —
  a `cleanup list` that only lists, or even a purely diagnostic `doctor`, must not invalidate a pending plan
  the user left there. In read-only mode `doctor` prints an extra line saying it does not tidy up, so the
  numbers below it are not mistaken for a tidied-up state.
- **The plan you named is not invalidated by this run's tidying up** (R3-6b). `cleanup apply <an id two hours
  old>` used to drop it automatically first, then print "already dropped… nothing happened this time" and
  return **0** — a script wrapping this CLI would read that as "cleanup finished". When an id is named, the
  tidying up only drops plans **older than it** (more precisely, created more than five minutes before it).
- **A record that cannot be closed out is not retried every time** (R3-11). The core deliberately leaves an
  "uncertain" move record (neither fingerprint matches) as "state unknown" forever. Any such record used to
  make every cleanup command and every `pet` round take the cleanup write lock and recompute SHA-256 over
  those files. It now remembers how that row looked (the size and mtime of the quarantine copy and of the copy
  in place) and does not try again while neither has changed; as soon as a file changes (or a new record
  appears) it tries again as usual.

---

## Exit codes are a contract

**Context menus and scripts decide success from the exit code.** Print ✓ on screen and return non-zero and
Windows pops up an error box.

| Code | Meaning |
|---|---|
| 0 | It worked, **including "nothing to clean up" and a read-only dry run** |
| 1 | Bad input: no such plan, an argument that makes no sense, a wrong confirmation token, **or an action that conflicts with the current state (CONFLICT)** |
| 2 | Backend failure: the database will not open, another cleanup action is running, `pet` is not running, the port is taken by something else |
| 3 | **Some files did not move, or did not come back** (including none of them) |

The rule: **1 means change what you are asking for; 2 means the action did not run at all and retrying later
usually works; 3 means it ran but did not entirely succeed.** Callers decide from that whether to retry
automatically — a CONFLICT is the same on the hundredth try, so it is 1 and not 2, and a 3 needs a person to
look at those files.

One by one:

| Situation | Exit code |
|---|---|
| Everything worked; nothing to clean up (Downloads is tidy); a read-only dry run | 0 |
| `cleanup apply <a plan already applied>`: idempotent, prints the same results, moves nothing a second time | 0 |
| `cleanup apply <a plan already undone>`: prints "this one has already been undone", **without a row of ✘** | 0 |
| A default cleanup of more than 1000 files: this run clears 1000 and says plainly "N left for next time" | 0 |
| `pet`: a real pet is already running on that port (prints the same address with the key, and opens a browser) | 0 |
| `cleanup undo <a plan interrupted partway>`: everything already moved comes back | 0 |
| `cleanup undo`: everything that moved comes back, even when the plan's `status` is `partial` (the exit code follows the per-item results) | 0 |
| No such plan id (**including read-only mode's `apply <a nonexistent id>`**) | 1 |
| A `--skip` / `--also` id that matches nothing or is shorter than 4; an argument that makes no sense; an unknown subcommand | 1 |
| `cleanup undo` with no id, and no plan can be undone | 1 |
| `cleanup undo <a plan that never started>` (use `release`); `cleanup release <a plan that has started>` (use `undo` or `apply`) | 1 |
| `quarantine --empty --yes` with no token, or a wrong or expired one (**including read-only mode**) | 1 |
| `cleanup dismiss` (no such command yet) | 1 |
| The ticked files are held by a plan that has not been applied (CONFLICT, see "Plans in the way") | 1 |
| Another cleanup action is running; the database will not open | 2 |
| `open`: the pet is not running, or whatever answers on that port cannot prove it is your pet (neither prints the address with the key) | 2 |
| `pet`: that port is taken, and not by a real pet (no address is printed) | 2 |
| Files that did not move (`failed`), were interrupted partway (`unknown`), or were not handled this time (`cancelled`) | 3 |
| `cleanup apply <a partial/error plan>`: returned as-is, and the exit code follows the per-item results (the row above) | 3 |
| `cleanup undo`: some files did not come back (still in quarantine, already purged, state unknown) | 3 |
| `cleanup apply` or `quarantine --empty --yes` gets partway and another cleanup action takes the lock, **and this run really did touch something** | 3 |
| The same, but this run **touched nothing at all** (the lock was already held by someone else) | 2 |

**"Interrupted partway" must not return 2** (round three, R3-3b). A 2 means "the action did not run at all",
and by then the files are already in quarantine (worse for emptying: some are already permanently deleted). A
nightly script reading 2 concludes nothing happened and retries. The test is **whether this run really touched
anything** (whether `cleanup_journal` gained a record): if it did it is 3, and only if it did not is it 2.

---

## What it looks like

### `cleanup list`

```
3 things can be cleaned up, roughly 75 B

  [4d1d] ✔ smoke-report.pdf
             34 B  duplicate  Downloads
         · A duplicate — same contents (1 other file has the same sha256; “smoke-report (1).pdf” is the one being kept)

  [e2dc] ✔ smoke-assets.zip
             19 B  archive  Downloads
         · Old archives are usually one-off downloads (.zip archive, and untouched for 60 days)

  [c136] ☐ smoke-old.bin
             22 B  old-download  Downloads
         · A download nobody has touched in a long time (untouched for 200 days, and .bin is not on the protected list)

☐ means it stays put unless you say otherwise. cleanup apply clears the 2 ticked files, 53 B.
  Skip a few of them: node cli.mjs cleanup apply --skip <id>
  Also clear some ☐ ones: node cli.mjs cleanup apply --also <id>

1 more needs your eyes:
  backup.tar  65 KB  — This file is too large for this tool to handle. Whether to keep it is your call.
```

This is what the CLI really prints (`test/repo.test.mjs` lays out a Downloads folder like this example, runs
`cleanup list` for real, swaps only the ids for the example ones, and compares the whole thing line by line).
For instance `node cli.mjs cleanup apply --skip e2dc` leaves smoke-assets.zip alone, and `--also c136` clears
smoke-old.bin as well.

- **Every row has a reason and evidence.** With no reason it should not be on the list at all (spec §6).
- The footer's "clears the N ticked files" uses the backend's `defaultCheckedCount`, which is **all** the
  ticked ones, not just the ones shown on screen.
- Protected files (`.ini`, `.lnk`, `.pem`…) and files too large to fingerprint are **not** candidates; the
  large ones are listed under "needs your eyes".
- Control characters and newlines in a filename are printed as "·" — a filename is untrusted input and must
  not be able to forge a line of output (audit RC14).
  U+2028 / U+2029 and the bidi controls (U+061C, U+200E, U+200F, U+202A–202E, U+2066–2069) are replaced too:
  a name containing U+202E, `invoice<U+202E>fdp.exe`, prints as a PDF but is an executable (third wave, C5).

### `cleanup apply`

```
Plan 9923e5b9-792b-43eb-9dd8-f4f13255a03f
  ✔ smoke-report.pdf  34 B
  ✘ smoke-assets.zip  19 B  — The file changed, or is still downloading. Scan again and build a new plan.

Moved 1 file (34 B) to quarantine.
Changed your mind? node cli.mjs cleanup undo 9923e5b9-792b-43eb-9dd8-f4f13255a03f

⚠ The ✘ files above did not move. Every original is still where it was — nothing was deleted.
```

Per-item results are printed **for every kind of `outcome` the backend gives**, never inferred:

| `outcome` | Printed as |
|---|---|
| `moved` | `✔ name  size` |
| `skipped` | `- name  size  (you skipped it)` |
| `failed` | `✘ name  size  — reason` |
| `restored` | `↩ name  size  (put back as …)` |
| `purged` | `⌫ name  size  (emptied)` |
| `pending` | `○ name  size  (not done yet)` |
| `cancelled` | `⊘ name  size  (not handled: the plan stopped or was dropped; the file never moved)` |
| `unknown` | `? name  size  — state unknown: …` and the reason (interrupted mid-move; no telling whether the file is in place or in quarantine) |

- When there is a ✘, a "state unknown" or a "not handled", **the exit code is 3**, and whatever did move
  **can still be undone**.
  **The exit code follows the per-item results, not the plan's `status`** (round two, R2-1): every item moved
  means 0.
- `cancelled` has two causes: the plan was dropped, or the plan ran and this item was never touched (the lock
  was taken mid-apply, for instance). Neither has any move record and the file is where it always was, so it
  does not say "cause unknown".
- "Every original is still where it was" **is only said when every unsuccessful item is `failed`.** With an
  `unknown` it must not be said — the file may already be in quarantine (audit RC17). The reason on that row
  comes from the core:

  ```
  Interrupted mid-move, so there is no telling whether the file is where it was or in quarantine. “Undo” puts back whatever is in quarantine; you can also run node cli.mjs doctor to check.
  ```

  (**It does not tell you to "apply again to finish it off"**: applying a `partial` or `error` plan again
  returns it as-is, and a journal deliberately left at `started` — where the verification after the rename
  failed and it could not be moved back — is not touched by applying again either. That item is one for
  `doctor` to look at and `undo` to put back.) The last line prints:

  ```
  ⚠ 1 file interrupted mid-move and may already be in quarantine. Run node cli.mjs doctor to check.
  ```
- When nothing moved at all it prints no ✔ and offers no undo command.
- A default cleanup takes at most 1000 files at a time; the rest wait, the last line says "N left for next
  time", and the exit code is 0.
- Read-only mode (`CONTEXTBOX_READONLY=1`): it prints "Read-only mode: this would clean up N files" and the
  list, **builds no plan and moves nothing**, exit code 0.
  For `apply <a plan already applied>` (`applied` / `partial` / `error`) that N is 0: applying it for real also
  returns it as-is (see the next point), and for `partial` / `error` it additionally explains
  "Applying again does not retry what failed" and how to retry.
- `apply <a plan already dropped>`: it prints "was dropped (someone dropped it, or it sat unapplied for over an
  hour and was dropped automatically)", touches no file, exit code 0. Automatic dropping is under "Every
  cleanup command tidies up first".
- **A plan runs once** (round two, R2-3): applying an `applied` / `partial` / `error` plan again with
  `apply <id>` **moves no file at all** and **does not retry** the ones that failed — the user may have just
  put some of those files back, and a late re-send must not move them away again.
  Only a `proposed` plan interrupted partway (see "Plans in the way") is carried on by `apply <id>`.

  When a run does nothing, the screen has to say so (round three, R3-2b / R3-15). The per-item results are
  still printed (that is what the plan looks like now), but it **does not print "Moved N files to quarantine"
  and does not print "Changed your mind?"** — those would suggest a cleanup just happened. Instead:

  ```
  This plan had already run, so nothing happened this time — no file was moved and nothing was deleted.
  Applying again does not retry what failed — a plan runs once. To clean again: node cli.mjs cleanup scan, then node cli.mjs cleanup apply, which builds a new plan from the current list.
  The 1 file moved to quarantine earlier is still there. To put it back: node cli.mjs cleanup undo <id>
  ```

  The exit code follows the per-item results (all moved → 0; any `failed` / `unknown` / `cancelled` → 3).
  **This does not count as one successful cleanup**: if the pet was worried about an unresolved apply error,
  re-sending an old plan must not clear that (it used to, so any re-send marked a permanently broken error as
  fixed).
- **Interrupted partway by another cleanup action** (round three, R3-3b): when the cleanup lock is taken away,
  the per-item results and the plan id are printed as usual, and the end says "⚠ Another cleanup action
  interrupted this one, so it stopped partway", how many are already in quarantine, and the two ways on
  (running `cleanup apply <id>` again picks up where it stopped, or `cleanup undo <id>` puts back what already
  moved). For the exit code see "Exit codes are a contract".

### `cleanup undo`

```
Undoing the most recent cleanup: plan 9923e5b9-792b-43eb-9dd8-f4f13255a03f (18s ago)
Put 1 file back.
  ↩ smoke-report.pdf  → a file of that name was already there, so this one is called smoke-report.pdf.restored (nothing was overwritten)
  - smoke-assets.zip  (never moved in the first place; it is where it always was)
```

- It only lists what **really went back**; the number always matches the ↩ rows.
- It does not name folders: the scope files go back to is **the cleanup scope ∪ `watch`, counting only folders
  that exist now** (third wave, C4). An older CLI cleaned using `watch`, so a file from the Desktop may still
  be in quarantine — putting a file back does not widen the cleanup scope, which is why only `undo` uses this
  scope; `apply` and emptying still look only at `cleanup.roots`.
  A file whose folder is in neither cannot go back (that row prints "not put back", exit code 3). If one
  folder in `cleanup.roots` or `watch` is missing (an external drive unplugged), that one is skipped and the
  files going back to other folders are unaffected.
- **A plan interrupted partway** (still `proposed`, but with files already in quarantine) can be undone too:
  what moved comes back, and what did not was never out of place. All back → 0, anything not back → 3. For an
  item killed just after the rename, the tidying-up records it as already in quarantine first, so `undo` with
  no id finds it as well (round two, R2-1a).
- Anything that did not come back (the quarantine copy was modified, it has been purged…) is listed separately
  as "not put back: name — reason", exit code 3.
  There are three messages: everything back, some back, none back — **and when none came back it must not say
  they all did** (audit RC9).
- **The exit code follows the per-item results, not the plan's `status`** (round two, R2-1, audit A-exp2): a 3
  is only for files that really did not come back (still in quarantine, already purged, state unknown). An
  item that never moved at the apply, or whose original was deleted afterwards, does not count as not back.
  When the core says `partial` but per item nothing that moved is left in quarantine (the quarantine slot's
  contents do not match, say, so it was not touched), it prints the core's reason and exits 0.
- Per-item results **do not say "it will not be suggested again"**: a file put back under a `.restored` name
  when its old place was taken is a different file, and after a rescan it is ticked again as a duplicate.
  Saying it properly means saying all of it (only a file back in its own place, and only until a new reason
  turns up), which is said once, in the `undo` suggestion under "Plans in the way".
- With no id: it undoes the most recent plan that can still be undone (its files are still in quarantine).
  None at all → exit code 1.

### Plans in the way

When the files you ticked are held by a plan that **has not been applied** (only a `proposed` plan holds files;
an applied one does not), it prints that plan and its files and offers two ways on. **Exit code 1** (CONFLICT:
the same on the hundredth try, so change what you are asking for).

That plan **never started** (no journal at all, the same test as the core's `releasePlan`):

```
This file already belongs to a pending cleanup plan.

In the way is a plan that was never applied, 5c1e… (created 3 min ago), holding 2 files:
  …

Two choices:
  Carry on with that plan: node cli.mjs cleanup apply 5c1e…
  Drop that plan (nothing moves; its files stay candidates): node cli.mjs cleanup release 5c1e…
```

"Drop that plan" is **`release`** (drop the plan, move no file), **not `undo`** — undo on a plan that already
moved files puts them back; undo on a plan that never started returns 1 and tells you to use `release`.

That plan **was interrupted partway** (Ctrl+C during the apply, a crash, killed: the plan is still `proposed`,
but files are already in quarantine). This kind **cannot be released** (the core refuses: it has started
moving files, and there is no pretending otherwise), so with release ruled out there are two ways on:

```
This file already belongs to a pending cleanup plan.

In the way is a plan interrupted partway, 5c1e… (created 3 min ago): of its 300 files, 20 are already in quarantine:
  …

This plan has started moving files, so it cannot be dropped (release). Two choices:
  Put back what already moved: node cli.mjs cleanup undo 5c1e…
    Files put back are not suggested again unless a new reason turns up; one renamed on the way back counts as a new file.
  Finish it: node cli.mjs cleanup apply 5c1e…
```

Running `cleanup release` on that kind also returns 1 and prints the same two ways on.

The sentence under undo is the truth, not reassurance: a file put back is recorded as restored, and a rescan
does not turn the same file with the same reason back into a candidate (the core's `upsertCandidate`); only a
new reason (it later becomes a duplicate, the rules change) brings it back. A file put back under a
`.restored` name is a different file in the database and is judged by the rules from scratch.

### `cleanup quarantine --empty`

```
These files have been in quarantine for seven days. Confirm again and they are deleted for good.
This will permanently delete 1 file, 19 B.
If you are sure, run: node cli.mjs cleanup quarantine --empty --yes 80d5b71a-bb89-456d-b941-d7a81c92238a
```

- Nothing seven days old yet: it prints "No file is seven days old yet. The oldest has N days to go." and
  exits 0.
- **The second confirmation has to be typed again.** This is the only path in the whole project that deletes a
  file.
- The run carrying `--yes <token>` **does not produce a new preview**; it confirms that one token.
  No token, a wrong one, or an expired one (five minutes) → exit code 1 and nothing is deleted.
- Read-only mode: `--empty` only says how many are old enough and produces no token;
  `--empty --yes <token>` still checks the token first (wrong or expired → 1), and only for a good one prints
  that read-only mode deletes nothing and returns 0. Nothing is deleted either way.
- **Interrupted partway by another cleanup action** (round three, R3-3b): what is already deleted **cannot be
  recovered**, so the count has to be said out loud:

  ```
  Deleted 3 files, 12 B.

  ⚠ Interrupted by another cleanup action and stopped partway (another cleanup action took the cleanup lock, so this step stops here. …).
  What was deleted cannot be brought back. To carry on with the rest: run node cli.mjs cleanup quarantine --empty --yes <the same token> again (if the token has expired, preview again: node cli.mjs cleanup quarantine --empty).
  ```

  Exit code 3 (it ran, but did not finish). Re-sending the same token within five minutes **carries on from
  where it stopped**, and the total includes what was already deleted.

### `doctor` (the blocks this section adds)

A real run in a sandbox holding an interrupted plan and a folder the scan could not open (paths shortened, the
plan id replaced by `5c1e…`):

```
ContextBox check

Config      /home/alice/.contextbox/config.json
Database    /home/alice/.contextbox/data.db
Read-only   off

Watched folders (screenshots and intake)
  ✓  /home/alice/Downloads
Cleanup scope (only files in here are ever cleaned)
  ✓  /home/alice/Downloads
Files to    /home/alice/Documents/Filed (created when you accept the first suggestion)

Watcher     ✗ never ran. To keep an eye on things, open a terminal and run `node cli.mjs watch`.
Quarantine  /home/alice/.contextbox/quarantine
            2 files, 28 B, the oldest is not yet seven days old
Candidates  5
Interrupted 1 plan stopped partway (killed mid-apply, a crash, or Ctrl+C):
            5c1e… (created 0s ago): 7 files, 2 already in quarantine
              Put back what already moved: node cli.mjs cleanup undo 5c1e…
              Finish it: node cli.mjs cleanup apply 5c1e…
Scan issues The last scan reported 2 problems:
          ⚠ 1 folder inside “Downloads” could not be opened (no permission?), so the files in it were not scanned.
          ⚠ 1 known files in “Downloads” could not be read this time (no permission, or a disk error), so they are still treated as present.
Last error  none
```

With something to report, the last error block looks like this instead:

```
Last error  0s ago (20/09/2026, 18:18:00): This cleanup moved nothing: No permission to move this file. Check the permissions and try again.
            The pet is still worried: this came from a cleanup, and there has been no successful one since.
```

- The "could not be read or moved" and "too large" counts are worked out over **everything** (the backend's
  `needsHumanCounts`), not just the first 50 rows `cleanup list` shows (third wave, C7).
- **Interrupted plans** (round two, R2-5): plans still `proposed` but with move records. Such a plan holds its
  files (a default cleanup hits CONFLICT) and what already moved is in quarantine; it lists the id, how many
  are already in quarantine, and the two ways on (put back, finish). Plans that never started are not listed
  here. Before this, no command printed that id at all.
- **Scan issues** (round two, R2-10): the problems the last full scan reported (fuses, folders it could not
  open), without full paths. `pet`'s background rescan used to print these only to the stderr of a minimised
  window, where nobody saw them. A clean scan clears the block.
  **From round three, R3-12, the pet sees them too**: with a scan problem, or a cleanup folder that does not
  exist, `GET /pet/state` returns `worried` and "a cleanup folder seems to have gone missing; have a look at
  doctor" (with a count when there are several), carrying those sentences in `scanProblems`. Before, only
  someone running `doctor` found out — a user with it sitting in the system tray was told "all fine, just
  idling" while the tool was in fact scanning nothing. The pet's **message itself carries no detail** from the
  problem (filenames and folder names only appear in `scanProblems`).
- **Read-only mode** (round three, R3-9): two extra lines under the "Read-only" line saying it does not tidy
  up (see "Every cleanup command tidies up first"). A read-only `doctor` writes nothing at all to the
  database.
- The line under **Last error** uses the same test as the pet (the core's `errorStillActive`): errors have
  kinds (a scan, a cleanup, an undo, emptying quarantine), and only a later success **of the same kind** makes
  it say the pet has stopped worrying; otherwise it says the pet is still worried. A successful scan does not
  paper over an apply that is permanently broken (round two, R2-10).
- A cleanup scope inside OneDrive (a path with a OneDrive component, or under the folder a OneDrive
  environment variable points at) gets an extra line under it: "⚠ This folder is inside OneDrive: moving a file to quarantine deletes it in the cloud and on every device…" (round two, R2-11).
- With `cleanup.screenshots` on, the cleanup scope says which one is the screenshots folder and that only
  screenshots are cleaned there.

### `pet` and `open`

`pet` starts the server (port 7391) and the cleanup watcher, and prints the address **with the key in it**,
`http://127.0.0.1:7391/?k=…`. That address without `?k=` is a 401 (no other local program can get the key,
audit RC16).

If that port is already taken, it first asks — with the same test `open` uses (below) — whether a real pet is
on it, and **only then prints the address** (third wave, part two).

- It is a real pet: it says ContextBox is already running, prints the same address with the key, **and opens a
  browser**, exit code 0 (round two, R2-9: the Windows shortcut opens a minimised window, so clicking the
  shortcut again while the pet was running used to flash a window and open no panel).
- It is not (the answer is not ContextBox, it cannot prove it is your pet, or nothing answers): it **does not
  print the address**, tells you to see what is holding that port or to pick another one with
  `CONTEXTBOX_PORT`, and exits 2.

`pet` scans everything once at startup and again every 30 minutes (`CONTEXTBOX_RESCAN_MS`), tidying up before
each round (see "Every cleanup command tidies up first" — `pet` does it itself, not via the scan child
process). **A full scan runs in a child process** (`cleanup scan --json`, used internally by pet: stdout is one
line of JSON, problems still go to stderr and are stored for `doctor`), so the server never blocks — a
thousand files take nearly twenty seconds, and `/health` answers instantly throughout (third wave, C2). There
is at most one scan child at a time and it is cleaned up when `pet` exits; a child that dies without reporting
(killed, crashed) is recorded as the last error, `pet` survives, and the next round scans as usual.
**The child has a timeout** (round two, R2-10): more than 10 minutes (`CONTEXTBOX_SCAN_TIMEOUT_MS`) without
finishing — a cleanup scope on a disconnected network drive, where readdir hangs — and it is killed and
recorded as a scan error, "the background scan timed out (the folder may be stuck)", with the next round
carrying on as usual. Before this it simply never rescanned again, silently.
When the startup scan finishes it prints "Startup scan: looked at N files; M can be cleaned up." `pet` clears
the port it recorded when it exits.

`open` opens that address with the key in your default browser. The page removes the `k` from the address bar
once it has loaded.
**It only hands the address to a real pet** (third wave C3, round two R2-9): it sends a fresh nonce (32 hex
characters) to `/health?nonce=` (without the key — it does not yet know who is answering), and a real pet
answers with a `proof` = HMAC-SHA256 keyed by the key over "the port it is really listening on:nonce".
`open` computes the same thing using **the port it is about to connect to** and compares. Only the holder of
the key can produce it:

- A shape can be imitated, so it does not hand over the key on shape alone. It used to also require a live
  recorded process id, so an impostor that happened to have one got the key, while a real server started
  directly with `node core/server.ts` (which records nothing) was always refused. The pid is no longer looked
  at.
- **The port is bound into the proof**: an impostor that forwards the nonce to a real pet on another port and
  hands the proof back unchanged computes against the wrong port, and still gets no key.

- The pet is not running (nothing answers on that port): it does not print the address with the key, does not open a browser, exit code 2.
  (Whoever takes that port afterwards would get the key from a pasted address; `pet` prints it itself when it
  starts.)
- Whatever answers on that port is not ContextBox, or cannot prove it is your pet (an impostor, another
  account's, an older pet): **it does not even print the address**, does not open anything, exit code 2.
- The browser will not open (no `xdg-open` or equivalent): it prints the address for you to paste, exit
  code 0.

---

## The agreement with A and B

**1. `--skip` and `--also` take the ids printed on the list, not filenames.** Filenames repeat, ids do not; an
id that matches nothing means the whole thing is refused (exit code 1), never guessed.

**2. `cleanup apply` with no plan-id means "build a new plan from the ✔ rows and apply it"**, not "apply the
most recent plan". To re-send an existing plan, name its id — re-sending an applied plan is **idempotent**: the
same results, exit code 0, nothing moved a second time (a script retrying after a CLI timeout is normal).

**3. A plan runs once.** An applied plan (all succeeded, partly failed, all failed) no longer holds its files;
applying a `partial` / `error` plan again with `apply <id>` returns it as-is and retries nothing (round two,
R2-3).
The files that failed are still candidates: to retry them, `cleanup scan` again and then `cleanup apply` to
take them into a new plan. Retrying means a new plan.
The one exception is a `proposed` plan interrupted partway: it has not finished, so `apply <id>` carries it on.
