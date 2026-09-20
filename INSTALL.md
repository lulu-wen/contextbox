# Installing

**Want to see what it does without installing anything?** Build a fake home directory and run the demo —
not one byte of your own files is touched:

```bash
node tools/demo-setup.mjs --dir /tmp/contextbox-demo --seed-model
```

The step-by-step walkthrough is in [docs/DEMO.md](docs/DEMO.md). Below is how to install it for real.

---

## What you need

| | |
|---|---|
| **Node 24 or newer** | `node -v` has to say `v24` or higher |
| Disk | Quarantine holds the files you clean up, so **leave about as much room as your Downloads folder takes** |
| Network | **Not needed.** This version runs entirely on your machine and talks to no outside service |

**No `npm install`.** This project has zero external dependencies.

---

## Windows

### Run the demo first (your own files stay untouched, five minutes)

```powershell
winget install OpenJS.NodeJS          # Node 24 or newer; **open a new PowerShell window** afterwards
node --version                        # check for v24 or higher

git clone https://github.com/lulu-wen/contextbox
cd contextbox

node tools/demo-setup.mjs --dir $env:TEMP\contextbox-demo --seed-model
```

It prints **the environment variables to paste**. On Windows it prints them in PowerShell form, with
`$env:USERPROFILE` substituted — that is what the home directory is called there.
**Paste those lines into the same window, unchanged**, then:

```powershell
node cli.mjs cleanup scan     # look around
node cli.mjs cleanup list     # the three burst screenshots come back as one group
node cli.mjs cleanup apply    # moved to quarantine (not deleted)
node cli.mjs rename           # what the model would call the unnamed files
node cli.mjs file             # same course, filed into Courses/<course>/<kind>/
node cli.mjs pet              # open the panel (it prints the address, key included)
```

**The whole sandbox lives in `%TEMP%\contextbox-demo`. Delete that folder and nothing is left behind.**
The walkthrough with the expected output of every line is in [docs/DEMO.md](docs/DEMO.md); to ask a real
model instead, use `--live-model` (see [docs/model-setup.md](docs/model-setup.md)).

In `cmd.exe`, write the environment variables as `set NAME=value` — no quotes.

### Installing it for real

```powershell
cd contextbox
node cli.mjs doctor
```

`doctor` tells you which folder it intends to clean ("Cleanup scope"). That is always
`%USERPROFILE%\Downloads`, and it is **deliberately not switched to `%USERPROFILE%\OneDrive\Downloads`** —
moving a OneDrive-synced folder into quarantine deletes it in the cloud and on every other device you own.

**Check that it is the Downloads you actually use.** If it is not, change `cleanup.roots` in
`%USERPROFILE%\.contextbox\config.json` — cleanup looks at nothing else:

```json
{ "cleanup": { "roots": ["D:\\Downloads"] } }
```

> ⚠️ **The cleanup scope and quarantine have to be on the same drive.** Quarantine defaults to
> `%USERPROFILE%\.contextbox\quarantine`, which is usually on C:. Point the cleanup scope at `D:\` and every
> cleanup becomes a cross-device move — and this project **does not do copy-then-delete** (that is deleting),
> so those files fail one by one with a reason. To clean D:, move quarantine there too:
> `$env:CONTEXTBOX_QUARANTINE = "D:\.contextbox\quarantine"` (in the same window, or as a user-level
> environment variable).

**Not `watch`** — `watch` is the list of folders the screenshot feature watches. Changing it does not change
what gets cleaned. If your Downloads really is inside OneDrive and you really do want it cleaned, put that
path into `cleanup.roots` yourself.

```powershell
node cli.mjs pet
```

Install a Start Menu shortcut (**no administrator rights needed**):

```powershell
powershell -ExecutionPolicy Bypass -File os\windows\install.ps1
```

Add `-Startup` to start it at login. Details and how to remove it are in
[os/windows/README.md](os/windows/README.md).

> ⚠️ **OneDrive Files On-Demand is untested.** If your Downloads folder is full of online-only placeholders,
> scanning has to read contents to fingerprint them, and that may pull the whole folder down to your disk.
> Until someone has tested it, **do not put a OneDrive path into `cleanup.roots`.**

---

## macOS

```bash
brew install node
git clone https://github.com/lulu-wen/contextbox
cd contextbox
node cli.mjs doctor
node cli.mjs pet
```

The first run asks for permission to access your Downloads folder. Allow it.

> **On macOS the screenshot folder is the Desktop.** `cleanup.screenshots` in the config file is `false` by
> default. Turn it on and the Desktop joins the cleanup scope — but **only screenshots on the Desktop are
> ever listed** (names starting with `screenshot`, `screen shot`, `截圖`, `螢幕擷取` or `螢幕快照`, at least 30 days old). Archives,
> installers and documents on the Desktop are not. To clean the whole Desktop you have to put it into
> `cleanup.roots` yourself, and leave that switch off.

---

## Linux

```bash
git clone https://github.com/lulu-wen/contextbox
cd contextbox
node cli.mjs doctor
node cli.mjs pet
```

---

## Where things live

```
~/.contextbox/config.json      settings (created on first run)
~/.contextbox/data.db          the database, mode 0600
~/.contextbox/quarantine/      cleaned-up files land here; can be emptied after seven days
~/.contextbox/token            the local server's key
~/Documents/Filed/             the tree `node cli.mjs file` moves things into — it only ever moves inward
```

**On Windows, `~` is `%USERPROFILE%`.**

---

## Checking that it is working

```bash
node cli.mjs doctor
```

Three lines should be ✓: **Downloads exists**, **quarantine exists**, **the watcher is alive**. If the
watcher line says it never ran, you have not started `pet` or `watch` yet.

---

## Uninstalling

```bash
# 1. Rescue anything in quarantine you still want
node cli.mjs cleanup quarantine
node cli.mjs cleanup undo <plan-id>

# 2. Then delete the settings and the data
rm -rf ~/.contextbox
```

**Do not do it in the other order.** `~/.contextbox/quarantine/` holds your files. Deleting that folder
really does lose them — it is the one place in this project where a file can be lost for good.

---

## Still to do (M3)

- [ ] A LaunchAgent for macOS
- [ ] A clean-machine install log, once on Windows and once on macOS
- [ ] A verdict on OneDrive Files On-Demand
