#!/usr/bin/env python3
"""Picking the right cartridge when more than one is plugged in.

The failure this guards against is silent and destructive: two PicoDocks look
identical at the wire level, so a server that guesses can hand cartridge B the
disk image belonging to cartridge A and nothing anywhere reports a problem. So
the rule under test is not "pick well" - it is **never pick at all** unless the
choice is unambiguous.

pyserial is stubbed rather than mocked at the boundary, because what is being
tested is our selection logic, not that pyserial can enumerate USB.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from pdtest import Checks                                    # noqa: E402
import pd_port                                            # noqa: E402

c = Checks("multiple cartridges")

VID, PID = 0x2E8A, 0x000A


class FakePort:
    def __init__(self, device, vid, pid, serial_number, description="PicoDock"):
        self.device, self.vid, self.pid = device, vid, pid
        self.serial_number, self.description = serial_number, description


def plugged(*ports):
    """Pretend `ports` are what the machine can see."""
    pd_port.serial.tools.list_ports.comports = lambda: list(ports)


A = FakePort("/dev/cu.usbmodem1101", VID, PID, "E6614103E7654321")
B = FakePort("/dev/cu.usbmodem2201", VID, PID, "E6614103E7abcdef")
OLD1 = FakePort("/dev/cu.usbmodem3301", VID, PID, "123456")
OLD2 = FakePort("/dev/cu.usbmodem4401", VID, PID, "123456")
OTHER = FakePort("/dev/cu.usbserial-FT1", 0x0403, 0x6001, "FTABCD", "FT232R")

# --- one cartridge ---------------------------------------------------------
plugged(A, OTHER)
c("finds the cartridge, ignores unrelated USB serial",
  pd_port.find_devices(VID, PID) == [(A.device, A.serial_number)],
  pd_port.find_devices(VID, PID))
c("not ambiguous on its own", not pd_port.ambiguous(pd_port.find_devices(VID, PID)))

# --- two, distinguishable --------------------------------------------------
plugged(A, B)
found = pd_port.find_devices(VID, PID)
c("both are found", len(found) == 2, found)
c("two different serials is NOT ambiguous", not pd_port.ambiguous(found))

# A prefix is enough, because the full 16 hex digits are miserable to type.
c("selects by full serial",
  pd_port.find_devices(VID, PID, B.serial_number) == [(B.device, B.serial_number)])
c("selects by prefix",
  pd_port.find_devices(VID, PID, "E6614103E7a") == [(B.device, B.serial_number)])
c("prefix is case-insensitive",
  pd_port.find_devices(VID, PID, "e6614103e7a") == [(B.device, B.serial_number)])
c("a prefix matching both narrows to neither",
  len(pd_port.find_devices(VID, PID, "E6614103E7")) == 2)
c("a prefix matching none finds none",
  pd_port.find_devices(VID, PID, "ZZZZ") == [])

# --- two, indistinguishable (firmware older than v0.38.0) ------------------
# This is the case that used to be silently wrong: same VID, PID and serial, so
# the only thing separating them is enumeration order.
plugged(OLD1, OLD2)
found = pd_port.find_devices(VID, PID)
c("old firmware: both found", len(found) == 2, found)
c("old firmware: reported as ambiguous", pd_port.ambiguous(found))
c("--serial cannot save you there",
  len(pd_port.find_devices(VID, PID, "123456")) == 2)

# One old board on its own is fine - there is nothing to confuse it with.
plugged(OLD1)
c("a single old board is not ambiguous",
  not pd_port.ambiguous(pd_port.find_devices(VID, PID)))

# --- a board that reports no serial at all ---------------------------------
NONE1 = FakePort("/dev/cu.usbmodem5501", VID, PID, None)
NONE2 = FakePort("/dev/cu.usbmodem6601", VID, PID, None)
plugged(NONE1, NONE2)
c("two serial-less boards are ambiguous, not crashy",
  pd_port.ambiguous(pd_port.find_devices(VID, PID)))
plugged(NONE1, A)
c("one serial-less plus one identified is still ambiguous",
  pd_port.ambiguous(pd_port.find_devices(VID, PID)))

# --- the suggested prefix must actually select one board -------------------
# A fixed truncation looks tidy and is wrong: RP2040 board IDs come from the
# flash chip, so boards from one batch share a long leading run. A and B here
# differ only in the last six of sixteen digits, and an 8-character hint would
# have named both - printing advice that fails when followed.
plugged(A, B)
found = pd_port.find_devices(VID, PID)
shorts = pd_port.short_serials(found)
c("a prefix is offered for each", len(shorts) == 2 and all(s for _, _, s in shorts),
  shorts)
for dev, sn, short in shorts:
    c(f"the offered prefix selects exactly one ({short})",
      pd_port.find_devices(VID, PID, short) == [(dev, sn)],
      pd_port.find_devices(VID, PID, short))
c("prefixes are longer than the shared run",
  all(len(s) > len("E6614103E7") - 1 for _, _, s in shorts), shorts)

# Distinct serials need no growth beyond the readable minimum.
plugged(FakePort("/a", VID, PID, "AAAA1111"), FakePort("/b", VID, PID, "BBBB2222"))
c("unrelated serials stay short",
  [s for _, _, s in pd_port.short_serials(pd_port.find_devices(VID, PID))]
  == ["AAAA", "BBBB"])

# A board with no serial has no prefix to offer - and must not crash trying.
plugged(NONE1, A)
c("a serial-less board offers no prefix",
  ("", ) == tuple(s for d, _, s in pd_port.short_serials(
      pd_port.find_devices(VID, PID)) if d == NONE1.device))

# --- find_port stays usable for the single-device callers ------------------
plugged(A)
c("find_port returns the device", pd_port.find_port(VID, PID) == A.device)
plugged(OTHER)
c("find_port returns None when absent", pd_port.find_port(VID, PID) is None)

# --- describe_candidates names the serial, which is the point --------------
plugged(A, OTHER)
desc = dict(pd_port.describe_candidates())
c("description carries the serial", A.serial_number in desc[A.device], desc)

# --- the sticky serial has to exist before it is read ----------------------
# wait_for_port keeps the chosen board on itself as .locked_serial so that
# unplugging A and plugging in B cannot silently hand B the wrong image. It
# reads that attribute on the first pass through the loop and writes it only
# after a successful open, so an uninitialised one is an AttributeError on the
# very first thing an end user does: start the server with no cartridge
# attached. That is precisely the moment the server is supposed to sit and wait,
# so the crash landed on the least forgiving path.
import pd_diskserver                                         # noqa: E402

c("wait_for_port.locked_serial exists before any connection",
  hasattr(pd_diskserver.wait_for_port, "locked_serial"))
c("...and starts unset, so the first scan takes any cartridge",
  pd_diskserver.wait_for_port.locked_serial is None)


class Args:
    port = None
    serial = None
    image = "unused.img"


# One pass of the selection the loop performs, with nothing plugged in. Reaching
# the end without raising is the whole assertion.
plugged(OTHER)                              # a non-PicoDock, so nothing matches
try:
    want = Args.serial or pd_diskserver.wait_for_port.locked_serial
    found = pd_port.find_devices(VID, PID, want)
    c("a scan with no cartridge present raises nothing", found == [])
except AttributeError as e:
    c("a scan with no cartridge present raises nothing", False, e)

sys.exit(c.done())
