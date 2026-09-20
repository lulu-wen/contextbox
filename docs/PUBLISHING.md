---
layout: default
title: Publishing the site
---

# Publishing this site

The `docs/` folder **is** the site. GitHub builds it with Jekyll; there is no build step to run
locally, no Gemfile and nothing to install.

## 1. Take the screenshots first

The User Guide references nine images that are not in the repo yet. Publishing without them gives
judges a page with nine broken-image placeholders, one of them in Quick start.

What to shoot, and the state to set up before each one, is in
[images/README.md](https://github.com/lulu-wen/contextbox/blob/main/docs/images/README.md).
Use a demo sandbox, never your real Downloads:

```bash
node tools/demo-setup.mjs --dir /tmp/contextbox-demo --seed-model
# paste the environment variables it prints, then:
node cli.mjs cleanup scan
node cli.mjs pet            # open the address it prints
```

Save them into `docs/images/` under exactly these names:

```
Ui.png  Tabs.png  Sections.png  Burst.png  Preview.png  Rename.png  Filing.png  Learned.png  Undo.png
```

Then commit and push them.

## 2. Turn Pages on

1. Repo → **Settings** → **Pages**
2. **Build and deployment → Source**: `Deploy from a branch`
3. **Branch**: `main`, folder: **`/docs`** → **Save**
4. Watch **Actions** → `pages-build-deployment` until it goes green (a minute or two)
5. Open `https://lulu-wen.github.io/contextbox/`

Check three things on the live site: the User Guide's table of contents rendered, the pages have the
theme's styling (not bare HTML), and the nine images load.

## 3. Optional

* Repo home page → the **About** gear → **Website** → paste the Pages URL, so the link sits next to
  the description.
* **Settings → Pages → Custom domain**, if the demo runs on one.

## Things worth knowing before you publish

* **A private repo needs GitHub Pro for Pages.** On a free account the repo has to be public first.
* **Publishing makes the whole history public, not just the current files.** Anything ever committed
  stays reachable.
* Two folders under `docs/` are still in Chinese and will be published too: `docs/api/` (the HTTP
  reference) and `docs/reading/` (notes on prior art). Neither is linked from the User Guide, but both
  get a URL.
* The 3D model `core/assets/quaso_v10.glb` has no stated licence yet — see
  [ASSETS.md](https://github.com/lulu-wen/contextbox/blob/main/core/assets/ASSETS.md). Artwork does not
  inherit the repo's Apache 2.0 licence automatically; settle where it came from before going public.

## If something looks wrong

| Symptom | Cause |
|---|---|
| Every page is unstyled text | A `layout:` that the theme does not have. `jekyll-theme-minimal` only ships `default` and `post` |
| The table of contents is literally `{:toc}` | kramdown is not the markdown engine — check `_config.yml` |
| A link 404s | Links inside `docs/` use `.html`; links to files at the repo root (README, INSTALL) must be full GitHub URLs, because they are not part of the site |
| Images are broken | They are not committed yet, or the filename case does not match |
