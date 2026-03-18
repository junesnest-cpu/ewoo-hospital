import { ref, get, set } from 'firebase/database';
import { db } from '../../lib/firebaseConfig';

const WARD_ROOMS = {
  '201': 4, '202': 1, '203': 4, '204': 2, '205': 6, '206': 6,
  '301': 4, '302': 1, '303': 4, '304': 2, '305': 2, '306': 6,
  '501': 4, '502': 1, '503': 4, '504': 2, '505': 6, '506': 6,
  '601': 6, '602': 1, '603': 6,
};

async function parseMessageWithClaude(text) {
  const today = new Date();
  const month = today.getMonth() + 1;
  const year = today.getFullYear();

  const prompt = `오늘은 ${year}년 ${month}월입니다.
병원 병동 채팅 메시지에서 환자 정보를 추출하여 JSON만 반환하세요 (설명 없이).

메시지: "${text}"

반환 형식:
{
  "action": "discharge_update" | "transfer" | "admit_plan" | "update" | "ignore",
  "room": "병실번호 또는 null",
  "bedNumber": 병상번호 또는 null,
  "slotKey": "305-2 같은 직접 병상키 또는 null",
  "name": "환자명 또는 null",
  "dischargeDate": "M/D 형식 퇴원예정일 또는 null",
  "admitDate": "M/D 형식 입원예정일 또는 null",
  "transferToRoom": "전실할 병실번호 또는 null",
  "treatments": [],
  "dischargeNote": "퇴원약 정보 또는 null",
  "roomFeeType": "F" 또는 "O" 또는 null,
  "note": "기타 특이사항 또는 null",
  "scheduleAlert": false
}

파싱 규칙:
- "15일 퇴원예정" → dischargeDate: "${month}/15"
- "4/3퇴원" → dischargeDate: "4/3"
- "병실료F" → roomFeeType: "F", "병실료O" → roomFeeType: "O"
- "305-2 류미경님" → slotKey: "305-2", room: "305", bedNumber: 2
- "306호 안규자님" → room: "306", bedNumber: null, slotKey: null
- "퇴원후 501호 전실예정" → action: "transfer", transferToRoom: "501"
- 치료 항목(이뮤알파/메시마/고주파/자닥신/이스카도/림프도수/페인/셀레나제/페리주/싸이원 등) → treatments 배열
- 스케줄/일정 확인 필요 언급 → scheduleAlert: true
- action: 퇴원일 업데이트="discharge_update", 전실="transfer", 입원예약="admit_plan", 기타="update", 관계없는 메시지="ignore"`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(`Claude API 오류: ${data.error.message}`);

  const raw = data.content?.map((c) => c.text || '').join('') || '';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

function findPatientInRoom(slots, roomId, patientName) {
  const capacity = WARD_ROOMS[roomId] || 1;
  for (let i = 1; i <= capacity; i++) {
    const slotKey = `${roomId}-${i}`;
    const slot = slots[slotKey];
    if (!slot) continue;
    if (slot.current?.name === patientName) return slotKey;
    if ((slot.reservations || []).some((r) => r.name === patientName)) return slotKey;
  }
  return null;
}

function findEmptyBed(slots, roomId) {
  const capacity = WARD_ROOMS[roomId] || 1;
  for (let i = 1; i <= capacity; i++) {
    const sk = `${roomId}-${i}`;
    if (!slots[sk]?.current?.name) return sk;
  }
  return `${roomId}-1`;
}

export default async function handler(req, res) {
  // Naver Works webhook 검증 (GET)
  if (req.method === 'GET') {
    const challenge = req.query['hub.challenge'] || req.query.hub_challenge || 'OK';
    return res.status(200).send(challenge);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });

  try {
    const body = req.body;

    if (body?.type !== 'message' || body?.content?.type !== 'text') {
      return res.status(200).json({ status: 'ignored', reason: 'text message가 아닙니다.' });
    }

    const messageText = body.content.text?.trim();
    if (!messageText) return res.status(200).json({ status: 'ignored', reason: '빈 메시지' });

    // Claude로 파싱
    const parsed = await parseMessageWithClaude(messageText);

    if (parsed.action === 'ignore' || !parsed.name) {
      return res.status(200).json({ status: 'ignored', reason: '관련 없는 메시지', parsed });
    }

    // 예상 병상 계산 (현황판 표시용, 실제 반영 안 함)
    const snap = await get(ref(db, 'slots'));
    const slots = snap.val() || {};

    let suggestedSlotKey = parsed.slotKey;
    if (!suggestedSlotKey && parsed.room) {
      if (parsed.bedNumber) {
        suggestedSlotKey = `${parsed.room}-${parsed.bedNumber}`;
      } else if (parsed.name) {
        suggestedSlotKey =
          findPatientInRoom(slots, parsed.room, parsed.name) ||
          findEmptyBed(slots, parsed.room);
      }
    }

    // pendingChanges에 대기 상태로 저장 (현황판 직접 반영 안 함)
    const changeId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await set(ref(db, `pendingChanges/${changeId}`), {
      id: changeId,
      ts: new Date().toISOString(),
      status: 'pending',
      source: 'naver-works',
      userId: body.source?.userId || null,
      channelId: body.source?.channelId || null,
      message: messageText,
      parsed,
      suggestedSlotKey: suggestedSlotKey || null,
    });

    return res.status(200).json({
      status: 'pending',
      message: '변경 승인 대기 중입니다.',
      changeId,
      suggestedSlotKey,
      parsed,
    });
  } catch (err) {
    console.error('[naver-works-webhook] 오류:', err);
    return res.status(500).json({ error: `처리 중 오류: ${err.message}` });
  }
}
