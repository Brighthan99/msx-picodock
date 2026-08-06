// fusion_sdcccall0.h — declares only the Fusion-C functions menu.c uses, with
// the **old calling convention**.
//
// Why this is needed
// ------------------
// The Fusion-C 1.3 release library was built in the sdcccall(0) era (arguments
// on the stack), and its assembly modules have that convention baked into the
// code. For example locate.s reads its arguments with `ld h,4(ix)`.
//
// The sdcc 4.5 standard library (printf/strlen/division helpers), on the other
// hand, is built for sdcccall(1) (arguments in registers). Compiling menu.c
// entirely with `--sdcccall 0` would then break against the standard library —
// the linker only warns, but arguments are corrupted at run time.
//
// So menu.c is compiled with the default convention to match the standard
// library, and only the **call sites of Fusion functions** are switched to the
// old convention via the `__sdcccall(0)` attribute. Making just one side an
// exception keeps both correct.
//
// This replaces the original `<msx_fusion.h>`. menu.c only references the nine
// symbols below (confirmed from the undefined symbols in menu.rel).

#ifndef FUSION_SDCCCALL0_H
#define FUSION_SDCCCALL0_H

// Prototypes match Fusion-C 1.3's <msx_fusion.h>; only the convention differs.
void Screen(char mode) __sdcccall(0);
void Cls(void) __sdcccall(0);
void Locate(char x, char y) __sdcccall(0);
void PrintChar(char c) __sdcccall(0);
char Fkeys(void) __sdcccall(0);
char InputChar(void) __sdcccall(0);
char Vpeek(unsigned int address) __sdcccall(0);
void Vpoke(unsigned int address, char data) __sdcccall(0);
void MemCopy(unsigned int *dst, unsigned int *src, unsigned int n) __sdcccall(0);

// Provided as macros by Fusion (not library symbols, so convention is irrelevant).
#define Peek(address)        (*((volatile char *)(address)))
#define Poke(address, data)  (*((volatile char *)(address)) = (char)(data))

#endif // FUSION_SDCCCALL0_H
