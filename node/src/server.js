// SPDX-License-Identifier: GPL-2.0-only
//
// server.js — 프레임을 받아 답하는 고리. src/host/pd_diskserver.py 의 serve()
// 를 옮긴 것이고, **분기 순서까지 같다.**
//
// 링크를 스트림으로 받는다. 시리얼 포트도, 시험용 TCP 소켓도 Node 에서는
// 둘 다 Duplex 라 같은 코드가 돈다 - 하드웨어 없이 서버를 통째로 검증할 수
// 있는 것이 이 구조 덕이다.

import {
  BLK_INFO_REQ, BLK_INFO_RESP, BLK_READ_REQ, BLK_READ_RESP,
  BLK_WRITE_REQ, BLK_WRITE_RESP, MB_TO_HOST, MB_TO_MSX, PRINT_DATA, PSG_FRAME,
  SECTOR, ST_OK, ST_ERR, VOICE_STAT,
} from './protocol.js';
import { buildFrame, FrameParser } from './frame.js';
import { CH_DISK, CH_IO, CH_PRINT, CH_ASK } from './hub.js';

export function serve(link, disk, hub, opts = {}) {
  const parser = new FrameParser();
  const stats = { r: 0, w: 0 };
  const printer = opts.printer || null;
  const onPrint = opts.onPrint || null;
  const onPsg = opts.onPsg || null;
  const ask = opts.ask || null;
  const voice = opts.voice || null;

  // 메일박스의 나가는 쪽. pd_ask 는 포트를 아예 모른다 - 페이로드만 건네고,
  // 선에 쓰는 것은 여기 한 군데다.
  const toMsx = (payload) => link.write(buildFrame(MB_TO_MSX, payload));

  // 음성 프레임은 **이미 조립된 채로** 온다 - voicestream 이 buildFrame 을
  // 직접 쓰기 때문이다. 메일박스와 달리 페이로드만 오는 것이 아니다.
  const toCart = (frame) => link.write(frame);

  // PDVOICE 가 보낸 문장을 음성으로 잇는다. 없으면 ask 가 MSX 에게 거절을
  // 보낸다 - 잠자코 있으면 MSX 는 오지 않을 소리를 기다린다.
  if (ask && voice) {
    ask.onSpeak = (text) => voice.speak(text, toCart);
    // 답을 소리로도 보내는 길. PDASK 가 물으면 ask 가 이것을 부른다.
    // `interrupt` 는 echo 가 아직 질문을 읽는 중일 때를 위한 것이다 - 답이
    // 이긴다. 그 반대(echo 가 나가던 말을 자르는 것)는 그냥 방해다.
    ask.onSay = (text, what) =>
      voice.speak(text, toCart, { interrupt: what === 'answer' });
  }

  // 파이썬은 시리얼 루프를 돌 때마다 ask.pump() 를 불렀다. Node 에는 그 루프가
  // 없으므로 타이머로 대신한다. 청크는 ACK 를 받은 자리에서 곧바로 이어 보내니
  // 이 타이머가 처리량을 정하지는 않는다 - **ACK 가 영영 안 올 때 포기하는
  // 것**과, 비동기 answerer 가 뒤늦게 답했을 때 첫 청크를 띄우는 것이 일이다.
  // 프린터의 작업 끝도 여기서 본다. MSX 에는 "다 찍었다" 가 없어서 **조용한
  // 시간**으로 가르는데, 조용하다는 것은 아무 이벤트도 안 온다는 뜻이라
  // 들어오는 바이트로는 알 수 없다. 누군가 주기적으로 시계를 봐야 한다.
  let ticker = null;
  if (ask || printer || voice) {
    if (ask) ask.linkReset();
    ticker = setInterval(() => {
      if (ask) ask.pump(toMsx);
      if (printer) printer.flushIfIdle();
      // **자리 소식이 끊겨도 말은 이어져야 한다.** 흐름 제어는 카트리지의
      // 상태 프레임을 따르지만, 그것이 한 번 사라지면 여기서만 다시 움직인다.
      if (voice) voice.pump(toCart);
    }, 100);
    const stop = () => { if (ticker) { clearInterval(ticker); ticker = null; } };
    link.on('close', stop);
    link.on('error', stop);
    link.on('end', stop);
  }

  link.on('data', (data) => {
    for (const { cmd, payload } of parser.feed(data)) {
      // 프린터와 메일박스는 디스크와 무관하다. 이미지가 멈춰 있어도 처리한다 -
      // CALL PDASK 에 답하는 데는 디스크가 필요 없고, 빌려간 동안 거절하면
      // 어리둥절한 실패가 된다.
      if (cmd === MB_TO_HOST) {
        hub.emit(CH_ASK, 'bytes', { n: payload.length });
        // 먹인 자리에서 바로 뽑는다. ACK 가 방금 들어왔다면 다음 청크가
        // 타이머를 기다리지 않고 나간다.
        if (ask) { ask.feed(payload); ask.pump(toMsx); }
        continue;
      }
      if (cmd === PRINT_DATA) {
        if (printer) printer.feed(payload);
        if (onPrint) onPrint(payload);
        hub.emit(CH_PRINT, 'bytes', { n: payload.length });
        continue;
      }

      // PSG 원음. 디스크와 **동시에** 온다 - 카트리지는 블록 프레임이 반쯤
      // 나가 있는 동안에만 비켜서므로, 바쁠 때 몇 틱이 빠질 뿐 끊기지 않는다.
      if (cmd === PSG_FRAME) { if (onPsg) onPsg(payload); continue; }

      // 링에 자리가 얼마나 남았는지. **디스크가 멈춰 있어도 처리한다** -
      // 흐름 제어가 이것 하나에 달려 있어서, 여기서 걸러지면 말이 그 자리에서
      // 끊긴다. 아래 disk.paused 분기보다 위에 있는 이유다.
      if (cmd === VOICE_STAT) { if (voice) voice.onStatus(payload, toCart); continue; }

      if (disk.paused) {
        // 답은 하되 오류로. 가만히 있으면 카트리지가 시간만 끌다 죽은 링크처럼
        // 보인다.
        const resp = { [BLK_INFO_REQ]: BLK_INFO_RESP,
                       [BLK_READ_REQ]: BLK_READ_RESP,
                       [BLK_WRITE_REQ]: BLK_WRITE_RESP }[cmd];
        if (resp) {
          link.write(buildFrame(resp, Buffer.from([ST_ERR])));
          // **거절한 것을 남긴다.** 여기서 조용히 continue 하고 있었고, 그
          // 때문에 "멈춘 동안 디스크를 건드린 적 없다" 는 답이 나왔다 -
          // 건드린 적이 없는 것이 아니라 세지 않고 있었다. MSX 에게는 이
          // 한 줄이 "Not ready reading drive A:" 로 보인다.
          hub.emit(CH_DISK, 'refused', {
            cmd: cmd.toString(16),
            lba: (cmd === BLK_READ_REQ || cmd === BLK_WRITE_REQ)
                 && payload.length >= 4 ? payload.readUInt32LE(0) : null,
            why: 'the image is lent out',
          });
        }
        continue;
      }

      if (cmd === BLK_INFO_REQ) {
        const b = Buffer.alloc(7);
        b[0] = ST_OK;
        b.writeUInt32LE(disk.blocks, 1);
        b.writeUInt16LE(SECTOR, 5);
        link.write(buildFrame(BLK_INFO_RESP, b));
        hub.emit(CH_DISK, 'info', { blocks: disk.blocks, sector: SECTOR, readonly: !!disk.readonly });

      } else if (cmd === BLK_READ_REQ && payload.length >= 5) {
        const lba = payload.readUInt32LE(0);
        const count = payload[4] || 1;
        if (lba + count > disk.blocks) {
          link.write(buildFrame(BLK_READ_RESP, Buffer.from([ST_ERR])));
          hub.emit(CH_IO, 'read_error', { lba, count });
          continue;
        }
        const buf = disk.read(lba, count);
        link.write(buildFrame(BLK_READ_RESP, Buffer.concat([Buffer.from([ST_OK]), buf])));
        stats.r += count;
        hub.emit(CH_IO, 'read', { lba, count });

      } else if (cmd === BLK_WRITE_REQ && payload.length >= 5) {
        const lba = payload.readUInt32LE(0);
        const count = payload[4] || 1;
        const body = payload.subarray(5, 5 + SECTOR * count);
        if (disk.readonly) {
          link.write(buildFrame(BLK_WRITE_RESP, Buffer.from([ST_ERR])));
          hub.emit(CH_IO, 'write_refused', { lba });
        } else if (lba + count > disk.blocks || body.length < SECTOR * count) {
          link.write(buildFrame(BLK_WRITE_RESP, Buffer.from([ST_ERR])));
          hub.emit(CH_IO, 'write_error', { lba, count, length: body.length });
        } else {
          disk.write(lba, body);
          link.write(buildFrame(BLK_WRITE_RESP, Buffer.from([ST_OK])));
          stats.w += count;
          hub.emit(CH_IO, 'write', { lba, count });
        }
      }
    }
  });

  return stats;
}
