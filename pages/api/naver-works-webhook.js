import admin from 'firebase-admin';

// ── Firebase Admin SDK 초기화 (싱글턴) ───────────────────────────────────────
function getAdminDb() {
  if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!privateKey || !process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL) {
      throw new Error('Firebase 환경변수 미설정: FIREBASE_PRIVATE_KEY / FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
      databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
    });
  }
  return admin.database();
}

const WARD_ROOMS = {
  '201': 4, '202': 1, '203': 4, '204': 2, '205': 6, '206': 6,
  '301': 4, '302': 1, '303': 4, '304': 2, '305': 2, '306': 6,
  '501': 4, '502': 1, '503': 4, '504': 2, '505': 6, '506': 6,
  '601': 6, '602': 1, '603': 6,
};

// 배열 형태로 여러 액션 반환
async function parseMessageWithClaude(text) {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day   = today.getDate();
  const year  = today.getFullYear();

  const prompt = `오늘은 ${year}년 ${month}월 ${day}일입니다.
병원 병동 채팅 메시지에서 환자/액션별로 분리하여 JSON 배열만 반환하세요 (설명 없이).

규칙:
- 환자가 여러 명이면 각각 별도 항목
- 한 환자에게 액션이 여러 개면(예: 퇴원+재입원) 항목을 분리
- 치료계획 변경 시 treatments 배열에 치료명 기재, weeklySchedule에 요일 기재
- 병원 업무와 무관한 메시지는 빈 배열 [] 반환

메시지: "${text}"

반환 형식 (배열):
[
  {
    "action": "discharge_update" | "transfer" | "admit_plan" | "update" | "ignore",
    "room": "병실번호 또는 null",
    "bedNumber": 병상번호 또는 null,
    "slotKey": "305-2 형식 또는 null",
    "name": "환자명 또는 null",
    "dischargeDate": "M/D 형식 퇴원예정일 또는 null",
    "admitDate": "M/D 형식 입원예정일 또는 null",
    "transferToRoom": "전실할 병실번호 또는 null (예: \"301\" 또는 병상 지정 시 \"301-2\")",
    "treatments": [],
    "weeklySchedule": "반복 요일 치료: 요일은 쉼표 없이 붙여쓰기 (예: 고주파 주3회, 자닥신 월목, 이스카도 목토월)",
    "specificDates": [],
    "dischargeMeds": [],
    "sessionCount": [],
    "dischargeNote": "퇴원약 중 수량 불명이거나 개수 없는 메모만",
    "roomFeeType": "F" 또는 "O" 또는 null,
    "note": "기타 특이사항 또는 null",
    "scheduleAlert": false
  }
]

specificDates 형식:
[{ "treatments": ["치료명1","치료명2"], "qty": "1", "dates": ["M/D","M/D"] }]

파싱 예시:
- "305-2 류미경님" → slotKey: "305-2", room: "305", bedNumber: 2
- "306호 안규자님" → room: "306"
- "15일 퇴원예정" → dischargeDate: "${month}/15"
- "오늘 퇴원" → dischargeDate: "${month}/${day}"
- "내일 퇴원" → dischargeDate: 오늘 기준 다음날 M/D 형식
- "다음주 입원" → admitDate: 오늘(${month}/${day})로부터 7일 후 M/D 형식 계산
- "퇴원 후 재입원" → 퇴원(discharge_update) + 재입원(admit_plan) 2개 항목
- "전실/이동/자리이동/병실이동" → action: "transfer"
- "305-2 류미경 301호로 전실" → action:"transfer", slotKey:"305-2", name:"류미경", transferToRoom:"301", admitDate: null (오늘)
- "305-2 류미경 301-2로 이동" → action:"transfer", slotKey:"305-2", name:"류미경", transferToRoom:"301-2", admitDate: null
- "305-2 류미경 25일 301호 전실예정" → action:"transfer", slotKey:"305-2", transferToRoom:"301", admitDate:"${month}/25"
- "306호 안규자 다음주 화요일 501호로 전실" → action:"transfer", room:"306", transferToRoom:"501", admitDate: 날짜 계산
- 전실일이 오늘이거나 날짜 없으면 admitDate: null, 미래 날짜면 admitDate에 M/D 형식 기재
- "병실료F" → roomFeeType: "F"
- 치료 항목 → treatments 배열에 아래 정규 명칭으로 기재:
  고주파 | 자닥신 | 이뮤알파 | 싸이원 | 이스카도M | 이스카도Q | 메시마 | 셀레나제 | 셀레나제정 | 셀레나제필름 | 페인 | 도수1 | 도수2 | 고압산소치료 | 글루타치온 | 마이어스1 | 마이어스2 | 셀레늄 | 비타민D | 고용량비타민C | 페리주 | 페리주560 | 리쥬더마 | 티옥트산 | 닥터라민 | G+T
- 별칭 규칙(→ 정규명칭): 리쥬더마크림→리쥬더마, 마이어스2→마이어스2, 마이어스→마이어스1, 도수2/도수치료2→도수2, 도수1/도수치료1/림프도수→도수1, 세파셀렌정→셀레나제정, 고함량비타민C/IVC→고용량비타민C, 이스카도→이스카도M, 페리주 단독→페리주, 고주파온열치료→고주파
- "자닥신 - 11일 24일 27일" → specificDates: [{ treatments:["자닥신"], qty:"1", dates:["${month}/11","${month}/24","${month}/27"] }]
- "메시마30개 - 16일 23일" → specificDates: [{ treatments:["메시마"], qty:"30", dates:["${month}/16","${month}/23"] }]
- "이뮤알파, 이스카도 - 11일" → specificDates: [{ treatments:["이뮤알파","이스카도"], qty:"1", dates:["${month}/11"] }]
- "이뮤알파, 이스카도 - 목,토,월" → weeklySchedule: "이뮤알파 목토월, 이스카도 목토월" (요일 공유 시 각각 펼쳐서 기재)
- "고주파 주3회 자닥신 월목 이스카도 월수금" → weeklySchedule: "고주파 주3회, 자닥신 월목, 이스카도 월수금"
- 특정 날짜 지정이면 specificDates, 반복 요일이면 weeklySchedule
- "퇴원약 메시마 11개" → dischargeMeds: [{"name":"메시마","qty":"11"}] (수량 있을 때만)
- "퇴원약 셀레나제160개, 메시마39개" → dischargeMeds: [{"name":"셀레나제","qty":"160"},{"name":"메시마","qty":"39"}]
- "퇴원시 부족분 셀레나제 있습니다" → dischargeNote (수량 불명)
- "도수2 2회" (날짜/요일 없이 횟수만) → sessionCount: [{"name":"도수2","count":"2"}]
- "고주파3회" (날짜/요일 없이 횟수만) → sessionCount: [{"name":"고주파","count":"3"}]
- 스케줄/일정 확인 필요 → scheduleAlert: true`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(`Claude API 오류: ${data.error.message}`);

  const raw = data.content?.map((c) => c.text || '').join('') || '';

  // 배열 [ ... ] 또는 객체 { ... } 추출
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const result = JSON.parse(arrMatch[0]);
    return Array.isArray(result) ? result : [result];
  }
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) return [JSON.parse(objMatch[0])];
  throw new Error(`JSON 블록 없음. 응답: ${raw.slice(0, 200)}`);
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

// payload에서 텍스트 메시지를 유연하게 추출
function extractTextMessage(payload) {
  // 표준 Naver Works 형식
  if (payload?.content?.type === 'text' && payload?.content?.text) {
    return { text: payload.content.text.trim(), type: payload.type, source: payload.source };
  }
  // 일부 구버전 형식
  if (payload?.message?.type === 'text' && payload?.message?.text) {
    return { text: payload.message.text.trim(), type: 'message', source: payload.source };
  }
  // content 없이 text 바로 있는 경우
  if (payload?.text) {
    return { text: payload.text.trim(), type: payload.type || 'message', source: payload.source };
  }
  return null;
}

export default async function handler(req, res) {
  // Naver Works 웹훅 검증 (GET)
  if (req.method === 'GET') {
    const challenge = req.query['hub.challenge'] || req.query.hub_challenge || 'OK';
    return res.status(200).send(challenge);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const changeId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = new Date().toISOString();

  // raw body를 최대한 파싱
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    payload = null;
  }

  // ── Firebase 초기화 ─────────────────────────────────────────────────────
  let db;
  try {
    db = getAdminDb();
  } catch (initErr) {
    console.error('[webhook] Firebase 초기화 실패:', initErr.message);
    // Firebase 없이도 200 반환 (Naver Works 재시도 방지)
    return res.status(200).json({ status: 'error', error: initErr.message });
  }

  // ── 진단용 raw 로그 먼저 저장 (어떤 payload가 오는지 확인) ──────────────
  try {
    await db.ref(`webhookLogs/${changeId}`).set({
      ts,
      method:      req.method,
      contentType: req.headers['content-type'] || null,
      rawPayload:  payload ? JSON.stringify(payload).slice(0, 2000) : null,
      payloadType: payload?.type || null,
      contentSubType: payload?.content?.type || null,
    });
  } catch (logErr) {
    // 로그 실패는 무시하고 계속
    console.error('[webhook] raw 로그 저장 실패:', logErr.message);
  }

  try {
    // 텍스트 메시지 추출 (유연한 파싱)
    const extracted = payload ? extractTextMessage(payload) : null;

    if (!extracted || !extracted.text) {
      await db.ref(`webhookLogs/${changeId}`).update({ status: 'ignored', reason: '텍스트 메시지 아님' });
      return res.status(200).json({ status: 'ignored', reason: '텍스트 메시지 아님' });
    }

    const messageText = extracted.text;

    // Claude로 파싱
    let parsed     = null;
    let parseError = null;

    if (!process.env.ANTHROPIC_API_KEY) {
      parseError = 'ANTHROPIC_API_KEY 미설정';
    } else {
      try {
        parsed = await parseMessageWithClaude(messageText);
      } catch (e) {
        parseError = e.message;
      }
    }

    // 파싱 결과 정규화 (배열 보장)
    const parsedItems = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);

    // 전부 ignore면 저장 안 함
    const actionable = parsedItems.filter(p => p?.action !== 'ignore' && p?.name);
    if (parsedItems.length > 0 && actionable.length === 0) {
      await db.ref(`webhookLogs/${changeId}`).update({ status: 'ignored', reason: '관련 없는 메시지' });
      return res.status(200).json({ status: 'ignored', reason: '관련 없는 메시지' });
    }

    // 파싱 실패 시 빈 항목 하나 생성 (직접 입력용)
    const itemsToSave = (parseError || actionable.length === 0) ? [null] : actionable;

    // slots 한 번만 조회
    let slots = {};
    try {
      const snap = await db.ref('slots').once('value');
      slots = snap.val() || {};
    } catch { /* 무시 */ }

    const savedIds = [];
    for (let i = 0; i < itemsToSave.length; i++) {
      const item = itemsToSave[i];
      const itemId = i === 0 ? changeId : `${changeId}-${i}`;

      let suggestedSlotKey = null;
      if (item?.name) {
        if (item.slotKey) {
          suggestedSlotKey = item.slotKey;
        } else if (item.room) {
          suggestedSlotKey = item.bedNumber
            ? `${item.room}-${item.bedNumber}`
            : findPatientInRoom(slots, item.room, item.name) ||
              findEmptyBed(slots, item.room);
        }
      }

      await db.ref(`pendingChanges/${itemId}`).set({
        id:               itemId,
        messageId:        changeId,       // 같은 메시지에서 온 항목끼리 연결
        itemIndex:        i,
        totalItems:       itemsToSave.length,
        ts,
        status:           'pending',
        source:           'naver-works',
        userId:           extracted.source?.userId    || null,
        channelId:        extracted.source?.channelId || null,
        message:          messageText,
        parsed:           item             || null,
        suggestedSlotKey: suggestedSlotKey || null,
        parseError:       item ? null : (parseError || '파싱 결과 없음'),
      });
      savedIds.push(itemId);
    }

    await db.ref(`webhookLogs/${changeId}`).update({
      status:     'saved',
      savedCount: savedIds.length,
      savedIds:   savedIds.join(','),
    });

    return res.status(200).json({
      status:     parseError ? 'pending_no_parse' : 'pending',
      savedCount: savedIds.length,
      savedIds,
      parseError,
    });

  } catch (err) {
    console.error('[naver-works-webhook] 오류:', err);
    try {
      await db.ref(`webhookLogs/${changeId}`).update({ status: 'error', error: err.message });
    } catch { /* ignore */ }
    return res.status(200).json({ status: 'error', error: err.message });
  }
}
