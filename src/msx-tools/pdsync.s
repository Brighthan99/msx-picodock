;-----------------------------------------------------------------------------
; PLSYNC.COM - make files added from the host visible without resetting the MSX
;
; The problem
;   Files copied into the disk image by the host do not appear on the MSX until
;   it is reset. Nothing is wrong with the transfer: Nextor caches the directory,
;   the FAT and the drive's disk parameters, and nothing tells it the media
;   changed underneath. A real disk does not have this problem because the same
;   OS wrote the files and invalidated its own cache.
;
; The fix
;   Nextor's _LOCK (77h) documentation states:
;
;     "Locking and unlocking operations cause all the buffers for the drive to
;      be flushed and invalidated. Also, cached disk parameters for the media
;      are deleted so the next access to the media will re-read them."
;
;   So locking then immediately unlocking is a cache flush. This does that for
;   whichever drive is current, after which DIR shows the new files.
;
;       A>PLSYNC
;
; Build
;   ./src/msx-tools/build.sh        (sdasz80 + sdldz80, both come with sdcc)
;
;   make_plsync.py produces the same bytes without needing an assembler, and
;   build.sh compares the two - if they ever disagree, one of them was edited
;   without the other.
;
; (c) 2026 - part of the msx-serial project
;-----------------------------------------------------------------------------

        .area _CODE

BDOS     = 0x0005
F_TERM   = 0x00                 ; terminate process
F_STROUT = 0x09                 ; print $-terminated string
F_CURDRV = 0x19                 ; get current drive -> A (0 = A:)
F_LOCK   = 0x77                 ; Nextor: lock/unlock drive; flushes buffers

;-----------------------------------------------------------------------------
; Which drive are we on? _LOCK wants a physical drive number in E.
;-----------------------------------------------------------------------------
        ld      c,#F_CURDRV
        call    BDOS
        ld      e,a                     ; E = current drive (0 = A:)

;-----------------------------------------------------------------------------
; Lock it. The flush happens on this transition.
;   C = 77h, E = drive, A = 01h (set lock status), B = FFh (lock)
;-----------------------------------------------------------------------------
        push    de                      ; BDOS may not preserve E
        ld      c,#F_LOCK
        ld      b,#0xFF
        ld      a,#0x01
        call    BDOS
        pop     de

;-----------------------------------------------------------------------------
; Unlock it again, so the drive is left as we found it and Nextor keeps doing
; its normal media-change checking afterwards. This flushes a second time.
;-----------------------------------------------------------------------------
        ld      c,#F_LOCK
        ld      b,#0x00
        ld      a,#0x01
        call    BDOS

;-----------------------------------------------------------------------------
; Report and exit.
;-----------------------------------------------------------------------------
        ld      de,#msg
        ld      c,#F_STROUT
        call    BDOS

        ld      c,#F_TERM
        jp      BDOS

msg:
        .ascii  "Disk buffers flushed - new files are visible now."
        .db     0x0D, 0x0A
        .ascii  "$"
