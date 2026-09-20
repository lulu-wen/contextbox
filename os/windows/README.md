# Windows install

## One line

Open PowerShell in the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File os\windows\install.ps1
```

Add `-Startup` to also start it when you log in:

```powershell
powershell -ExecutionPolicy Bypass -File os\windows\install.ps1 -Startup
```

**No administrator needed.** Both shortcuts live in your own profile.

To remove:

```powershell
powershell -ExecutionPolicy Bypass -File os\windows\uninstall.ps1
```

---

## What it actually does

| | Where |
|---|---|
| Start menu shortcut | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\ContextBox Pet.lnk` |
| Start at login (optional) | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ContextBox Pet.lnk` |

Both point at `os\windows\contextbox-pet.cmd`, which does nothing more than `cd` into the repo and run
`node cli.mjs pet`.

**No registry keys, no service, no elevation.** If you would rather not run a script, make a shortcut to
that `.cmd` by hand and drop it in the Start menu — same result.

---

## The uninstaller never touches your files

`uninstall.ps1` deletes those two shortcuts and nothing else.

Everything under `%USERPROFILE%\.contextbox\` stays, in particular:

```
%USERPROFILE%\.contextbox\quarantine\
```

**Those are your files** — cleaned up but not yet seven days old — not the program's. The uninstaller tells
you how many are in there and how large they are. To get them back:

```powershell
node cli.mjs cleanup quarantine
```

Delete that folder by hand only once you are sure you do not want them.

---

## Two encoding traps (read before editing these files)

**`.cmd` files stay pure ASCII.** `cmd.exe` reads them in the console code page, and anything else turns
into mojibake on plenty of machines. That is why every message in `contextbox-pet.cmd` is English.

**`.ps1` files must be saved as UTF-8 with BOM.** Windows PowerShell 5.1 reads a file without a BOM as ANSI.
Both `.ps1` files here have one — **do not let your editor strip it**.

To check:

```powershell
# the first three bytes should be 239 187 191
(Get-Content os\windows\install.ps1 -Encoding Byte -TotalCount 3)
```

---

## When it will not run

| Symptom | Cause |
|---|---|
| `cannot be loaded because running scripts is disabled` | The `-ExecutionPolicy Bypass` part is missing |
| The window flashes and disappears | The `.cmd` pauses on failure, so this should not happen. Run `node cli.mjs pet` in PowerShell directly and read the message |
| `Node.js not found` | `winget install OpenJS.NodeJS`, then **open a new window** so PATH is reloaded |
| The shortcut does nothing | Right-click → Properties → check that "Start in" is the repo root |

---

## Still to do

- [ ] Run it once on a clean Windows machine and write down what happened
- [ ] An icon (the shortcut currently uses the default `cmd` one)
- [ ] Check what `doctor` says on a machine where Downloads has been moved into OneDrive. The cleanup scope
      already defaults to `%USERPROFILE%\Downloads` and never picks `OneDrive\Downloads` on its own; what
      needs testing is whether `doctor` says clearly that the folder is missing and that `cleanup.roots`
      should be changed
