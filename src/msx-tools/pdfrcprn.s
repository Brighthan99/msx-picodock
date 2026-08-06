;-----------------------------------------------------------------------------
; PDFRCPRN.COM - force the standard printer port (0x90) READY. OCM ONLY.
;
;       A>PDFRCPRN
;
; Why this exists
;   The standard MSX printer routines poll BUSY at port 0x90 before every byte.
;   On OCM the port floats (0xFF = "busy forever"), so LPRINT / COPY PRN / direct
;   word processors hang. This tells the PicoDock firmware to answer 0x90 reads
;   with "ready", so native printing works and is captured to the host.
;
; Why it refuses on a real MSX
;   Driving 0x90 is SAFE ONLY on OCM: its FPGA core has no printer port, so
;   nothing else drives 0x90. A real MSX drives 0x90 from its own printer LSI, and
;   our driving it would clash on the data bus (contention / overcurrent). So this
;   runs only after it POSITIVELY identifies an OCM (KdL firmware); otherwise it
;   prints an error and aborts without enabling anything.
;
;   OCM detection - switched-I/O device ID 0xD4 (KdL):
;       out (40h),0D4h  ;  in (40h) == ~0D4h (0x2B)  ->  it is an OCM
;
;   Enable - a 4-byte "knock" (F0 90 0F A5) to unused port 0x2E, which the
;   firmware's I/O write captor watches; on the full sequence it enables the
;   0x90 read responder (a PD_P90_READ build). See src/picoverse-picodock.
;
; Build: ./src/msx-tools/build.sh   ->  dist/PDFRCPRN.COM
;
; (c) 2026 - part of the msx-serial project
;-----------------------------------------------------------------------------

        .area _CODE

BDOS      = 0x0005
F_STROUT  = 0x09                ; print $-terminated string
F_TERM    = 0x00                ; terminate process

SIOSEL    = 0x40                ; switched-I/O device select register
OCM_ID    = 0xD4                ; KdL OCM device ID
OCM_ACK   = 0x2B                ; ~0xD4, what IN (40h) returns when an OCM answers

KNOCKPORT = 0x2E                ; unused I/O port the firmware watches for the knock

;-----------------------------------------------------------------------------
; Identify the machine: select the OCM device ID on the switched-I/O port and
; read it back. An OCM answers with the complement of the ID.
;-----------------------------------------------------------------------------
        ld      a,#OCM_ID
        out     (SIOSEL),a
        in      a,(SIOSEL)
        cp      #OCM_ACK
        jr      nz,not_ocm

;-----------------------------------------------------------------------------
; OCM confirmed: knock to enable the 0x90 responder (interrupts off so the four
; writes go out back-to-back), tidy up, and report success.
;-----------------------------------------------------------------------------
        di
        ld      a,#0xF0
        out     (KNOCKPORT),a
        ld      a,#0x90
        out     (KNOCKPORT),a
        ld      a,#0x0F
        out     (KNOCKPORT),a
        ld      a,#0xA5
        out     (KNOCKPORT),a
        ei
        xor     a
        out     (SIOSEL),a              ; deselect switched-I/O (clean state)
        ld      de,#msg_ok
        jr      report

not_ocm:
        xor     a
        out     (SIOSEL),a
        ld      de,#msg_no

report:
        ld      c,#F_STROUT
        call    BDOS
        ld      c,#F_TERM
        jp      BDOS

;-----------------------------------------------------------------------------
msg_ok:
        .ascii  "PDFRCPRN: OCM detected."
        .db     0x0D, 0x0A
        .ascii  "Port 0x90 forced READY - native printing now works,"
        .db     0x0D, 0x0A
        .ascii  "captured to the host (LPRINT / COPY PRN / word processors)."
        .db     0x0D, 0x0A
        .ascii  "$"

msg_no:
        .ascii  "PDFRCPRN: this is NOT an OCM (real MSX)."
        .db     0x0D, 0x0A
        .ascii  "The machine drives port 0x90 itself; forcing it would clash"
        .db     0x0D, 0x0A
        .ascii  "on the data bus. ABORTED - use a dummy plug instead."
        .db     0x0D, 0x0A
        .ascii  "$"
