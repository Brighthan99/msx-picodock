######################################################################
# picodock-menu - the MSX-side boot menu (32KB ROM at 0x4000)
#
# The first thing the MSX runs. It reads the flash config area, lists what is
# there (ROMs, and the Nextor entry that boots the virtual disk), and writes the
# chosen index back for the firmware to act on.
#
# Original: MSX PicoVerse multirom.pio/msx/  (c) Cristiano Goncalves
#
# Differences from the original Makefile (changes needed to build on macOS):
#   1. The fusion-c path was hardcoded to /DevArea/...; it is now the FUSION variable.
#   2. The `fusion_min_printf.lib` the original links against exists in no official
#      release (it appears to be a variant the author built). Replaced with
#      `fusion-ROM.lib`, the ROM build. menu.c implements its own putchar() via
#      BIOS CALSLT, so printf routes through that.
#   3. hex2bin is not available on macOS (no brew formula) — replaced by
#      ../tools/ihx2rom.mjs (Node, which the host side needs anyway)
######################################################################

FUSION  ?= $(HOME)/work/fusion-c/WorkingFolder/fusion-c
CC       = sdcc
PLATFORM = -mz80

FUSIONINC    = $(FUSION)/include
FUSIONHEADER = $(FUSION)/header
FUSIONLIB    = lib/fusion_min_printf.lib
CRT0         = $(FUSIONINC)/crt0_MSX32k_ROM4000.rel

SRCDIR = src
BINDIR = build
DISDIR = dist

# 32K ROM @ 0x4000 - crt0 occupies 0x4000-0x404F (header + init), so code starts at 0x4050
ADDR_CODE = 0x4050
ADDR_DATA = 0xC000
ROM_START = 0x4000
ROM_SIZE  = 0x8000

# C5: the boot screen's version is the project's version. It used to be a
# constant here (v0.10) that nobody remembered to move, so the MSX announced a
# version no bug report could be matched against. Read the root VERSION file
# instead - the same number the server prints and the TUI shows.
#
# Located from this makefile rather than the working directory, so it is right
# whether you run `make` in here or make_uf2.sh runs it from the repo root.
# A missing file is not fatal: it degrades to 0.0.0-unknown, exactly as
# pd_version.py does, because an obviously absent version beats a wrong one.
MENU_MK_DIR := $(dir $(lastword $(MAKEFILE_LIST)))
ROOT_VERSION := $(MENU_MK_DIR)../../VERSION
VERSION ?= v$(or $(strip $(shell cat $(ROOT_VERSION) 2>/dev/null)),0.0.0-unknown)

CCFLAGS  = --code-loc $(ADDR_CODE) --data-loc $(ADDR_DATA) --disable-warning 196
CCDEFS   = -DPICODOCK_VERSION=\"$(VERSION)\"

OUTFILE = menu.rom

.PHONY: all compile package clean

all: clean compile package

compile: $(BINDIR)/$(OUTFILE)

# vpeek/vpoke in the Fusion release library were built before sdcc 4.2 and carry
# no calling-convention tag. The linker cannot verify them, warns, and sdcc then
# exits non-zero. Compiling them from source with `--sdcccall 0` makes the tag
# explicit. It is also the accurate choice: the other Fusion functions they call
# (SetVDPread/SetVDPWrite) use the same old convention.
FUSIONSRC = $(FUSION)/source/lib_rom
LOCALOBJ  = $(BINDIR)/vpeek.rel $(BINDIR)/vpoke.rel

$(BINDIR)/%.rel: $(FUSIONSRC)/%.c
	@mkdir -p $(BINDIR)
	@echo "Compiling $@ (sdcccall 0)"
	@$(CC) -c --sdcccall 0 $(PLATFORM) --disable-warning 196 \
		-I $(FUSIONHEADER) $< -o $@

$(BINDIR)/menu.ihx: $(SRCDIR)/menu.c $(SRCDIR)/menu.h $(SRCDIR)/bios.h \
                    $(SRCDIR)/fusion_sdcccall0.h $(LOCALOBJ)
	@mkdir -p $(BINDIR)
	@echo "Compiling $@"
	@$(CC) $(CCFLAGS) $(CCDEFS) $(PLATFORM) --use-stdout --no-std-crt0 \
		$(CRT0) $(LOCALOBJ) $(FUSIONLIB) -I $(FUSIONHEADER) $(SRCDIR)/menu.c -o $@ \
		> $(BINDIR)/link.log 2>&1; \
	node ../tools/check_sdcc_link.mjs $(BINDIR)/link.log $@

$(BINDIR)/$(OUTFILE): $(BINDIR)/menu.ihx
	@echo "Building $(OUTFILE)"
	@node ../tools/ihx2rom.mjs $< $@ --start $(ROM_START) --size $(ROM_SIZE)

package: $(BINDIR)/$(OUTFILE)
	@mkdir -p $(DISDIR)
	@cp $(BINDIR)/$(OUTFILE) $(DISDIR)/$(OUTFILE)
	@echo "Packaged $(DISDIR)/$(OUTFILE)"

clean:
	@rm -rf $(BINDIR)
