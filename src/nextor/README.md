# src/nextor — everything Nextor, redistributed

All of it ships with the repository, so a fresh clone can build a flashable UF2
*and* a bootable disk with nothing downloaded.

| File | What | From |
|---|---|---|
| `Nextor-2.1.4.SunriseIDE.MasterOnly.ROM` | the kernel the cartridge boots; `make_uf2.sh` embeds it in the UF2 | 2.1.4 distribution, `kernel-roms/` |
| `NEXTOR.SYS` | needed to boot into the DOS prompt; `make_disk.sh --bootable` writes it | 2.1.4 distribution, `extras/` |
| `COMMAND2.COM` | the command interpreter (MSX-DOS 2's, version 2.44) | 2.1.4 distribution, `extras/tools.zip` |

**These are one set.** All three came from the same 2.1.4 distribution and move
together, which is why they sit in one folder rather than next to whichever tool
consumes them. Leaving the system files for each user to find invites pairing a
2.1.4 kernel with system files from some other release, and that combination
fails as "the MSX hangs part way through boot" — a symptom that points at
nothing in particular.

## Why there is no MSXDOS2.SYS

Nothing loads it. From the Nextor manual:

> "starting with Nextor 2.1.0 beta 2, the kernel will try to load MSXDOS2.SYS
> **if NEXTOR.SYS is not found**."

With `NEXTOR.SYS` present it is only reached by an explicit `CALL SYSTEM2` from
BASIC. Nextor's own `tools.zip` does not contain it either — only `MSXDOS.SYS`,
which is the DOS 1 file. If you want it, drop it in `resources/assets/` (make
the folder; it is gitignored) and it is picked up like any other override.

## Using different versions

Anything in `resources/assets/` with the same name wins; `make_disk.sh` looks
there first.

```sh
cp ~/downloaded/NEXTOR.SYS resources/assets/
./src/host/make_disk.sh 128m picodock.img --bootable    # uses yours
```

## Licence

Nextor is published with permission from the MSX Licensing Corporation. The
licence permits redistribution but forbids **commercial use** (selling copies)
and **derivative works** (forks of the source). This repository is
non-commercial, so those terms are met. See the top-level
[`NOTICE.md`](../../NOTICE.md).

`COMMAND2.COM` is not Nextor's own work — it is MSX-DOS 2's command interpreter,
redistributed here exactly as Konamiman ships it inside the Nextor `tools.zip`.
The manual says any version from 2.20 will do.
