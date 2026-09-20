---
layout: default
title: ContextBox
---

ContextBox is a local assistant that reads the files in your Downloads folder, works out what they are, and
puts them where they belong. It runs on your own machine. Nothing is deleted — cleanup means "moved to
quarantine", reversible for seven days — and nothing moves until you approve it.

It has two faces, a command-line tool and a local web panel, over one backend. There are no dependencies:
Node 24 and nothing else.

Try it without touching your own files:

```bash
node tools/demo-setup.mjs --dir /tmp/contextbox-demo --seed-model
```

That builds a fake home directory with 14 realistic files in it and prints the environment variables to
paste. Every path stays inside that one folder, and deleting it leaves nothing behind.

## Documentation

* **[User Guide](UserGuide.html)** — start here. Quick start, every feature with real command output, an FAQ,
  known issues and a command summary.
* [Five minutes with ContextBox](DEMO.html) — the demo sandbox, step by step, with what each command prints.
* [Choosing a model](model-setup.html) — local, self-hosted or cloud, and the three things your endpoint has
  to support.
* [The panel and the pet](panel.html) — what the page does, key by key.
* [Installing it for real](https://github.com/lulu-wen/contextbox/blob/main/INSTALL.md) — Windows, macOS and
  Linux, and which folder actually gets cleaned.
* [README](https://github.com/lulu-wen/contextbox/blob/main/README.md) — what this project is and why it is
  built the way it is.

Reference, for anything talking to the local server or reading the code:

* [CLI reference](cli.html) — every command, every exit code, every environment variable.
* [HTTP API](https://github.com/lulu-wen/contextbox/blob/main/docs/api/README.md) — the local server's routes
  and error codes.

## Source

[github.com/lulu-wen/contextbox](https://github.com/lulu-wen/contextbox) — Apache 2.0. The backend has no
third-party code at all; the 3D pet in the browser uses a vendored copy of Three.js 0.180.0 (MIT).
