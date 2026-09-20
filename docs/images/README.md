# Screenshots for the User Guide

Nine images, referenced from `docs/UserGuide.md` as `![…](images/Ui.png)`. The guide reads fine without
them, so adding them is not urgent — but every one of them replaces a paragraph of description.

**Take them yourself.** Nothing in this repo can drive a browser.

## Before you start

Build a demo sandbox and paste its environment variables, so nothing on screen is a real file of yours:

```bash
node tools/demo-setup.mjs --dir /tmp/contextbox-demo --seed-model
# paste the exported variables it prints
node cli.mjs cleanup scan
node cli.mjs pet            # open the address it prints
```

Rules for all nine:

* **The demo sandbox only.** Never a real Downloads folder, and never a real filename.
* **The address bar must not be in the shot**, or crop it out. The address carries the key.
* A browser window about 1280×800 keeps the text readable when the image is scaled down in the page.
* PNG. Crop to the part being discussed — a full-screen shot of a 4K monitor is unreadable inline.
* Light mode, so the images match each other.

## The list

| File | What is in it | Get the screen into this state first |
|---|---|---|
| `Ui.png` | The whole panel: pet, both tabs, the cleanup panel open with candidates in it. This is the one in Quick start, so it should look like the thing you just installed | `cleanup scan`, then `pet`, open the address, click the bin under the pet |
| `Tabs.png` | Just the two tabs at the top — **Files** and **Your details** — with Files selected. Crop tight; this illustrates one sentence | Open the panel. Default state |
| `Sections.png` | The five section tabs inside the cleanup panel — Cleanup / Bursts / Suggested names / Filing / Learned — with their counts, at least one of them showing 0 so the greyed-out state is visible | `cleanup scan` and `rename`/`file` listed at least once, so several sections have rows. Do not press D — demo mode hides this strip |
| `Burst.png` | The Bursts section: the three `Screenshot 2026-09-18 at 10.31.0*.png` side by side, newest marked "keep", the outlined differences visible on the other two | `cleanup scan` on the sandbox; open the panel and go to Bursts. Zoom in enough that the outline boxes are not one pixel |
| `Preview.png` | One row expanded by **View contents** — ideally a text file, so the extracted text is visible under the row | Open the cleanup panel, click View contents on `operating-systems-ch5-scheduling.txt` |
| `Rename.png` | The Suggested names section: `Untitled document (3).txt → Operating Systems_Deadlock.txt`, with the "The model thinks" line and the evidence quote | Sandbox built with `--seed-model`, then open the panel and go to Suggested names |
| `Filing.png` | The Filing section with the three suggestions and their target folders (`Courses/Operating Systems/Lecture/` and so on), plus the File / Undo filing buttons | Same sandbox, Filing section |
| `Learned.png` | The Learned section, with at least one "course" entry and one "turned down" entry, each with its Forget button | Run `node cli.mjs file --apply <id> --course OS`, then `node cli.mjs file --undo` on another one, then reload the panel |
| `Undo.png` | The **Undo recent actions** panel, listing at least two past cleanups with their checkboxes and file counts | Run `cleanup apply` twice (with `--skip` the second time so the two rows differ), then click the back-arrow icon under the pet |

## After you add them

Nothing else to change — `UserGuide.md` already points at these names. Check the page renders by pushing to
the branch GitHub Pages serves from and opening the published User Guide.
