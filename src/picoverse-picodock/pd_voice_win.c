// pd_voice_win.c — see pd_voice_win.h.

#include <string.h>
#include "pd_protocol_ids.h"
#include "pd_voice_win.h"

#define MASK  (PD_VOICE_RING - 1u)

void pd_voice_reset(pd_voice_t *v)
{
    v->head = v->tail = 0u;
    v->armed = 0u;
    v->closed = 0u;
    v->hold = PD_VOICE_SILENCE;
    v->starved = 0u;
    v->stopped = 0u;
    v->fed = v->played = 0u;
}

static inline uint32_t level(const pd_voice_t *v)
{
    // Free-running counters, so this is right across the wrap without a
    // full/empty flag. Unsigned arithmetic wraps the way we want.
    return v->head - v->tail;
}

uint32_t pd_voice_room(const pd_voice_t *v)
{
    return PD_VOICE_RING - level(v);
}

uint32_t pd_voice_feed(pd_voice_t *v, const uint8_t *data, uint32_t n)
{
    uint32_t room = pd_voice_room(v);
    if (n > room)
        n = room;
    // Two memcpys rather than a loop: the ring wraps at most once.
    uint32_t at = v->head & MASK;
    uint32_t first = PD_VOICE_RING - at;
    if (first > n)
        first = n;
    memcpy(&v->buf[at], data, first);
    if (n > first)
        memcpy(&v->buf[0], data + first, n - first);
    // **head moves last.** The consumer may read it at any instant; until it
    // moves, the bytes above are not visible, and after it moves they all are.
    v->head += n;
    v->fed += n;
    return n;
}

void pd_voice_close(pd_voice_t *v)
{
    v->closed = 1u;
}

uint32_t pd_voice_status_frame(const pd_voice_t *v, uint8_t *out)
{
    const uint32_t room = pd_voice_room(v);
    const uint32_t played = v->played;
    uint8_t flags = 0u;
    if (v->armed)
        flags |= PD_VOICE_ST_ARMED;
    if (v->starved)
        flags |= PD_VOICE_ST_STARVED;
    // **Ended is queued-out, not closed.** The host stops when it hears this,
    // and stopping while the ring still has a tail in it cuts the last word.
    //
    // The MSX switching itself off counts too, and it has to: `stop` clears
    // `closed`, so a run that ended normally would report "still going" from
    // the moment the player tidied up - which is what left the first working
    // run wedged, with every later word refused as "still saying the last one".
    if ((v->closed && level(v) == 0u) || v->stopped)
        flags |= PD_VOICE_ST_ENDED;

    out[0] = PD_SOF;
    out[1] = PD_CMD_VOICE_STAT;
    out[2] = 7u;
    out[3] = 0u;
    out[4] = (uint8_t)(room & 0xFFu);
    out[5] = (uint8_t)((room >> 8) & 0xFFu);
    out[6] = (uint8_t)(played & 0xFFu);
    out[7] = (uint8_t)((played >> 8) & 0xFFu);
    out[8] = (uint8_t)((played >> 16) & 0xFFu);
    out[9] = (uint8_t)((played >> 24) & 0xFFu);
    out[10] = flags;
    uint8_t chk = 0u;
    for (int i = 1; i < 11; i++)
        chk ^= out[i];
    out[11] = chk;
    return PD_VOICE_STAT_FRAME;
}

uint8_t PD_VOICE_FUNC(pd_voice_read)(pd_voice_t *v, uint16_t addr)
{
    if (addr == PD_VOICE_STATUS) {
        uint8_t st = 0u;
        if (level(v) != 0u)
            st |= PD_VOICE_READY;
        if (v->closed && level(v) == 0u)
            st |= PD_VOICE_ENDED;
        if (v->starved)
            st |= PD_VOICE_UNDERRUN;
        return st;
    }
    if (addr != PD_VOICE_DATA)
        return 0xFFu;                 // CTRL is write-only; reads mean nothing

    if (!v->armed)
        return v->hold;               // not started: no data moves
    if (level(v) == 0u) {
        // **Hold the last level, do not drop to zero.** This is a DAC; zero is
        // the bottom of the swing, so a gap would be a click rather than a
        // pause. The host is told it happened, and that is what the flag is
        // for - a run that never starves is a run that kept up.
        if (!v->closed)
            v->starved = 1u;
        return v->hold;
    }
    uint8_t b = v->buf[v->tail & MASK];
    v->tail += 1u;                    // tail moves after the byte is taken
    v->played += 1u;
    v->hold = b;
    return b;
}

bool PD_VOICE_FUNC(pd_voice_write)(pd_voice_t *v, uint16_t addr, uint8_t data)
{
    if (addr != PD_VOICE_CTRL)
        return false;
    if (data) {
        // Starting clears the marks but **not the queue** - the host may have
        // fed ahead of the MSX getting round to arming, and throwing that away
        // would lose the beginning of the word.
        v->armed = 1u;
        v->starved = 0u;
        v->stopped = 0u;
    } else {
        // Stopping throws away what is queued. A stop that let the rest trickle
        // out is not a stop, which is the same rule the printer's "off" follows.
        v->armed = 0u;
        v->tail = v->head;
        v->closed = 0u;
        v->stopped = 1u;
        v->hold = PD_VOICE_SILENCE;
    }
    return true;
}
