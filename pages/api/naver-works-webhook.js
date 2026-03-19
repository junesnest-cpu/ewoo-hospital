import admin from 'firebase-admin';

// ── Firebase Admin SDK 초기화 (싱글턴) ───────────────────────────────────────
if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
  });
}
const adminDb = admin.database();

const WARD_ROOMS = {
  '201': 4, '202': 1, '203': 4, '204': 2, '205': 6, '206': 6,
  '301': 4, '302': 1, '303': 4, '304': 2, '305': 2, '306': 6,
  '501': 4, '502': 1, '503': 4, '504': 2, '505': 6, '506': 6,
  '601': 6, '602': 1, '603': 6,
};

async function parseMessageWithClaude(text) {
  const today = new Date();
  const month = today.getMonth() + 1;
  const year  = today.getFullYear();

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

  const raw     = data.content?.map((c) => c.text || '').join('') || '';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

function findPatientInRoom(slots, roomId, patientName) {
  const capacity = WARD_ROOMS[roomId] || 1;
  for (let i = 1; i <= capacity; i++) {
    const slotKey = `${roomId}-${i}`;
    const slot    = slots[slotKey];
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
  // Naver Works 웹훅 검증 (GET)
  if (req.method === 'GET') {
    const challenge = req.query['hub.challenge'] || req.query.hub_challenge || 'OK';
    return res.status(200).send(challenge);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;

    // Naver Works 메시지 타입 확인 (문자열 body 대비 파싱)
    const payload = typeof body === 'string' ? JSON.parse(body) : body;

    if (payload?.type !== 'message' || payload?.content?.type !== 'text') {
      return res.status(200).json({ status: 'ignored', reason: 'text message가 아닙니다.' });
    }

    const messageText = payload.content.text?.trim();
    if (!messageText) return res.status(200).json({ status: 'ignored', reason: '빈 메시지' });

    const changeId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const baseEntry = {
      id:        changeId,
      ts:        new Date().toISOString(),
      status:    'pending',
      source:    'naver-works',
      userId:    payload.source?.userId    || null,
      channelId: payload.source?.channelId || null,
      message:   messageText,
    };

    // Claude로 파싱 (실패 시 raw 메시지만이라도 저장)
    let parsed = null;
    let suggestedSlotKey = null;
    let parseError = null;

    if (!process.env.ANTHROPIC_API_KEY) {
      parseError = 'ANTHROPIC_API_KEY 미설정';
    } else {
      try {
        parsed = await parseMessageWithClaude(messageText);

        if (parsed.action !== 'ignore' && parsed.name) {
          const snap  = await adminDb.ref('slots').once('value');
          const slots = snap.val() || {};
          if (parsed.slotKey) {
            suggestedSlotKey = parsed.slotKey;
          } else if (parsed.room) {
            suggestedSlotKey = parsed.bedNumber
              ? `${parsed.room}-${parsed.bedNumber}`
              : findPatientInRoom(slots, parsed.room, parsed.name) ||
                findEmptyBed(slots, parsed.room);
          }
        }
      } catch (e) {
        parseError = e.message;
      }
    }

    // action=ignore 이면 저장하지 않음
    if (parsed?.action === 'ignore') {
      return res.status(200).json({ status: 'ignored', reason: '관련 없는 메시지', parsed });
    }

    // Firebase Admin SDK 로 pendingChanges 저장
    await adminDb.ref(`pendingChanges/${changeId}`).set({
      ...baseEntry,
      parsed:           parsed            || null,
      suggestedSlotKey: suggestedSlotKey  || null,
      parseError:       parseError        || null,
    });

    return res.status(200).json({
      status: parseError ? 'pending_no_parse' : 'pending',
      message: '변경 승인 대기 중입니다.',
      changeId,
      suggestedSlotKey,
      parsed,
      parseError,
    });

  } catch (err) {
    console.error('[naver-works-webhook] 오류:', err);
    return res.status(500).json({ error: `처리 중 오류: ${err.message}` });
  }
}
