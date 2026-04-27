/**
 * Android 앱이 폰 주소록 동기화용으로 호출.
 *
 * 인증: X-Incoming-Secret 헤더 (env INCOMING_CALL_SECRET 공유).
 * 응답: 환자 phone 기준 평탄화 배열. patients 마스터 + consultations 의 진단·병원 fallback 결합.
 *
 * 폰 측 사용:
 *   - 결과를 ContactsContract 의 "이우병원" Account 에 add/update/delete 동기화
 *   - 이름·나이·진단(가능시 + 병원) 을 Contact 표시 이름으로 결합
 */
import { wardAdminDb } from '../../lib/firebaseAdmin';

function normalizePhone(s) {
  return String(s || '').replace(/\D/g, '');
}

function calcAge(birthDate, birthYear) {
  let y = null;
  if (birthDate) {
    const m = String(birthDate).match(/^(\d{4})/);
    if (m) y = parseInt(m[1]);
  }
  if (!y && birthYear) {
    const m = String(birthYear).match(/(\d{4})/);
    if (m) y = parseInt(m[1]);
  }
  if (!y) return null;
  const age = new Date().getFullYear() - y + 1;
  return (age > 0 && age < 130) ? age : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const secret = req.headers['x-incoming-secret'] || '';
  const expected = process.env.INCOMING_CALL_SECRET || '';
  if (!expected || secret !== expected) {
    // 디버그 로깅 (2026-04-27)
    console.warn(`[patients-sync] secret mismatch (got len=${secret.length} prefix=${secret.slice(0,4)} suffix=${secret.slice(-4)} | expected len=${expected.length} prefix=${expected.slice(0,4)} suffix=${expected.slice(-4)})`);
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!wardAdminDb) return res.status(503).json({ error: 'admin not initialized' });

  try {
    const [pSnap, cSnap] = await Promise.all([
      wardAdminDb.ref('patients').once('value'),
      wardAdminDb.ref('consultations').once('value'),
    ]);
    const patients = pSnap.val() || {};
    const consultations = cSnap.val() || {};

    const consByPhone = {};
    for (const c of Object.values(consultations)) {
      if (!c?.phone) continue;
      const digits = normalizePhone(c.phone);
      if (!digits) continue;
      const at = c.createdAt ? new Date(c.createdAt).getTime() : 0;
      if (!consByPhone[digits] || at > consByPhone[digits].at) {
        consByPhone[digits] = { at, c };
      }
    }

    const out = [];
    const seen = new Set();
    for (const p of Object.values(patients)) {
      if (!p?.phone) continue;
      const digits = normalizePhone(p.phone);
      if (!digits || seen.has(digits)) continue;
      seen.add(digits);
      const matchedC = consByPhone[digits]?.c;
      out.push({
        phone: digits,
        name: p.name || matchedC?.name || '',
        age: calcAge(p.birthDate, p.birthYear) ?? calcAge(matchedC?.birthDate, matchedC?.birthYear),
        diagnosis: p.diagName || p.diagnosis || matchedC?.diagnosis || '',
        hospital: matchedC?.hospital || '',
        chartNo: p.chartNo || '',
      });
    }
    for (const [digits, { c }] of Object.entries(consByPhone)) {
      if (seen.has(digits)) continue;
      seen.add(digits);
      out.push({
        phone: digits,
        name: c.name || '',
        age: calcAge(c.birthDate, c.birthYear),
        diagnosis: c.diagnosis || '',
        hospital: c.hospital || '',
        chartNo: c.chartNo || '',
      });
    }

    return res.json({ patients: out, ts: Date.now(), count: out.length });
  } catch (e) {
    console.error('[patients-sync] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
