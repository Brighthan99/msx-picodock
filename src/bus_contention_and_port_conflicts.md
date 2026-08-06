# Bus contention and I/O port conflicts

Written when PicoDock started answering reads of port 0x90, the standard MSX
printer status port, and therefore *driving the data bus*. It sets out when
"the cartridge answers a port read" is safe and when it is dangerous, the
general rule, how the platform itself guards against it, and what PicoDock does.

Read this before enabling `PD_P90_READ` on anything.

---

## 1. Driving vs not driving

`D0-D7` is eight wires shared by the CPU, the machine's internal devices and the
cartridge slot. At any instant each wire is a 1 (high) or a 0 (low).

- **Driving**: connecting the wire through a transistor to VCC (→ 1) or GND
  (→ 0), forcing the voltage. Low impedance.
- **Not driving** (tri-state / high impedance): the output is detached. If
  nobody drives, a pull-up resistor takes the line to 1 — so a floating bus
  reads as `0xFF`.

During `IN A,(port)` **the CPU is reading and does not drive the bus** (its data
pins are inputs). So *somebody* has to put the answer byte on `D0-D7` or the CPU
latches nothing meaningful.

**Contention** is two devices driving the same wire to *different* values — one
to VCC, one to GND. That is `VCC → transistor → transistor → GND`: effectively a
short circuit, with the current to match. Heat, and damaged parts. (FPGA I/O
pins are typically rated at an absolute maximum around 50 mA, and on a machine
like the OCM they are not replaceable.)

## 2. What PicoDock puts on the bus for 0x90: `0x00`

What the PIO program (`msx_p90_read_responder` in `msx_bus.pio`) does:

```
mov pins, null      ; put 0x00 on D0..D7 (all zero)
mov osr, ~null      ; 0xFFFFFFFF
out pindirs, 8      ; enable the outputs -> all eight driven to GND = 0x00
```

Only one bit of the printer status byte matters: **bit 1 = BUSY**, where `0`
means ready. `0x00` has bit 1 clear, so the BIOS's `LPTOUT` does
`IN A,(90H) : AND 2` → 0 → "ready" and printing proceeds. (If a more realistic
byte is ever wanted, `0xFD` leaves only bit 1 clear.)

## 3. `IN 0x90` vs `OUT 0x90` — who drives

Port 0x90 has two operations and they are easy to confuse:

- **`IN 0x90` (read)** — the CPU is reading BUSY. *Something must put a value on
  the bus.* This is the case where we would **drive**.
- **`OUT 0x90` (write)** — the CPU sends a strobe. The CPU drives, everyone else
  listens. Here we only **capture**, and never drive.

So "PicoDock drives 0x90" means *answering the read*, not the write.

**Who drives the bus during `IN 0x90`:**

| Machine | Us (the cartridge) | Who drives | What the CPU reads | Result |
|---|---|---|---|---|
| Real MSX (has printer LSI) | not driving | the LSI alone | the LSI's BUSY | ✅ fine, no contention |
| Real MSX (has printer LSI) | **driving** | **the LSI *and* us** | garbage | 🚨 **contention** |
| OCM (FPGA, no printer port) | not driving | **nobody** → floats | `0xFF` (busy) | ⚠️ hangs |
| OCM (FPGA) | **driving** | us alone | `0x00` (ready) | ✅ printing works |

- **Real hardware**: the LSI already drives it. Turning our responder on puts two
  drivers on the same wires. → **do not drive**; let the LSI answer, and force
  ready with a dummy plug instead (§6).
- **OCM**: the FPGA does not drive it. With our responder off the bus floats to
  `0xFF` = busy and software hangs. With it on we are the only driver and
  printing works.

**Detection is not the feature.** Working out *whether a given machine drives
0x90* only needs a read, which is passive and safe. `PDFRCPRN` does exactly that
before deciding whether to arm anything. Only the printing feature needs us to drive, and only on the OCM. Never
"test" by driving: the test would be the contention.

## 4. The general rule — this is not specific to 0x90

> **Exactly one driver per bus cycle.** For any port, if another device also
> drives the bus during that `IN`, that is contention.

- **Listening (sampling a write) is always safe** — high-impedance inputs, no
  driving. That is what our write capture does.
- Only **answering a read** is dangerous, and the entire question is whether
  *another device also drives that port*.
- Ordinary cartridges do this all the time (FM-PAC at 7C/7D, MSX-AUDIO at
  C0-C3, disk interfaces …) and it is safe because those are **dedicated ports
  nobody else claims**. Plug in two of the same device — two FM-PACs — and you
  get a real conflict.
- 0x90 is dangerous precisely because it is the **standard printer port**: on a
  real MSX with a physical printer port, the machine already owns and drives it.
  The OCM core has no printer port, so it is unclaimed, so we can be the only
  driver.

## 5. The platform's own defences

MSX has several conflict-avoidance mechanisms in the standard. Their existence
is the evidence that "two devices driving one port" is a genuine hazard.

1. **Interrupt vector conflicts** — if two devices put an interrupt vector on
   the bus at once there is "no way to prevent a bus conflict".

2. **Switched I/O ports `40h-4Fh`** — hardware arbitration so several devices
   can share one port range without conflict. Writing a device ID to port `40h`
   (1-127 internal, 128-254 external) selects which single device answers; the
   rest tri-state.

3. **System control register `F5h`** — bits to avoid conflicts between internal
   I/O devices and external cartridges, by disabling the internal one. At BIOS
   init, if an external cartridge provides the function, the internal device is
   switched off. This covers specific devices (kanji ROM, MSX-AUDIO,
   superimpose…) — **there is no such bit for the printer port.**

4. **The `/BUSDIR` signal** — on machines where the slot data bus is buffered by
   a 74LS245, a cartridge answering an **I/O read** must assert `/BUSDIR` to flip
   the buffer towards the computer. Memory accesses get their direction from
   `/RD`, `/WR` and `/SLTSL`; I/O does not, which is why BUSDIR exists.
   Implementing it is required for sound cartridges, memory mappers and anything
   else that answers I/O reads.

5. **The OCM `BUSDIR_n` patch (KdL, 2020)** — on the OCM, pin 10 (BUSDIR_n) of
   the two external slots is shorted where it reaches the FPGA, which confuses
   some cartridges; the fix adds a 74LS245 on slot 2's /BusDir to protect the
   Z80 data bus from a noisy expansion. Evidence that the OCM's slot data bus
   really does have direction/protection issues.

## 6. Ways to avoid a conflict

| Approach | What it is | In PicoDock |
|---|---|---|
| **Answer only dedicated ports** | Drive only ports nobody else claims | 0x90 is unclaimed on the OCM (confirmed in the core's VHDL) |
| **Verify before answering** | Prove from VHDL, schematics or a probe that this machine does not drive the port | `PDFRCPRN`'s OCM check, plus reading the core |
| **Address-filter in the PIO** | Drive only for exactly that port, tri-state otherwise | `msx_p90_read_responder` — 0x90 only |
| **Switched I/O (40-4F)** | Device ID picks one responder | standard mechanism, not used here |
| **F5h internal disable** | Turn the internal device off | no such bit for the printer |
| **Handle /BUSDIR properly** | Flip the buffer on buffered slots | PicoVerse wires D0-D7 directly, so it is unnecessary; GPIO29 stays an input |
| **Do not drive at all — dummy plug** | Never answer the read; make the machine's own port report ready | the answer for real MSX hardware |

**The dummy plug.** On a real MSX the safe configuration is to leave the read
responder off and let the machine's own printer LSI answer — but with nothing
plugged into the printer connector, BUSY reads as "not ready" and printing never
starts. A dummy plug is a Centronics connector that ties the BUSY line to the
ready level (and typically grounds the other handshake inputs), so the LSI
reports ready to a printer that is not there. The cartridge then only *captures*
what the machine writes, which needs no bus driving and is safe everywhere.

## 7. How printer-interface cartridges do it

Printer interfaces exist for MSX machines with **no** built-in printer port, and
they work on exactly the same principle:

- Answer `IN A,(90H)` by driving bit 1 (BUSY) from the real Centronics BUSY pin,
  latch the data written by `OUT (91H)` out to the connector, and pulse /STROBE
  from bit 0 of `OUT (90H)`.
- Safe **only on machines with no internal printer port**, i.e. when 0x90/0x91
  are unclaimed. Put one in a machine that has a printer port and two devices
  drive 0x90.

That is precisely what PicoDock does on the OCM, which is a good sign that the
approach is a standard one rather than a trick.

## 8. What PicoDock ships

- **OCM (FPGA)**: the FPGA tri-states 0x90, so we are the only driver — safe.
  There is no physical printer port either, so no dummy plug is needed. Verified
  on hardware for both read and write.
- **Older real MSX with a physical printer port**: the read responder would
  contend with the machine's own port. → leave it off; print with a **dummy
  plug** (BUSY = ready) plus **write capture**, which is safe.
- **The two are separate compile-time flags** so neither can be enabled by
  accident:
  - `PD_P90_READ` — the 0x90 read responder (drives the bus). **OCM only.**
  - `PD_STDPRINT_WRITE` — 0x90/0x91 write capture (snooping). **Safe
    anywhere.**
  - `PD_P90_STATUS` — convenience, both at once (the full OCM setup).
  - OCM: `-DPD_P90_STATUS=ON`. Real MSX + dummy plug:
    `-DPD_STDPRINT_WRITE=ON`, read responder left off.

---

## Sources

- MSX Wiki — [Printer port](https://www.msx.org/wiki/Printer_port),
  [Printer programming](https://www.msx.org/wiki/Printer_programming),
  [Switchable I/O ports](https://www.msx.org/wiki/Switchable_I/O_ports),
  [MSX Cartridge slot](https://www.msx.org/wiki/MSX_Cartridge_slot)
- Grauw — [MSX I/O ports overview](https://map.grauw.nl/resources/msx_io_ports.php)
- Konamiman — [MSX2 Technical Handbook, Appendix 6 I/O Map](https://konamiman.github.io/MSX2-Technical-Handbook/md/Appendix6.html)
- MSX Resource Center — [BUSDIR signal](https://www.msx.org/forum/msx-talk/hardware/busdir-signal),
  [How to use IO ports on MSX](https://www.msx.org/forum/msx-talk/hardware/how-use-io-ports-msx-personal-computers)
- MSX Resource Center — [OCM BUSDIR-n hardware patch (2020)](https://www.msx.org/news/en/hardware-patch-20200819-for-ocm-machines-aka-busdir-n-patch)
- Nocash — [Portar MSX Tech Doc](https://problemkaputt.de/portar.htm)
