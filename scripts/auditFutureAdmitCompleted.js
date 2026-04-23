/**
 * "미래 입원 예정인데 status='입원완료'" 상담 전수 조사
 *
 * syncEMR Phase 2.6 이름 폴백 매칭 버그로 덮어쓰였을 가능성이 있는 케이스:
 *   - status='입원완료'
 *   - admitDate 가 오늘 이후
 *   - (신호) chartNo/patientId 는 없거나, 있어도 EMR 현재 입원 차트와 불일치
 *   - (신호) reservedSlot 이 남아있음
 *
 * 출력만 하고 수정은 하지 않음.
 */
require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
  databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
});
const db = admin.database();

const today = new Date(); today.setHours(0, 0, 0, 0);
const parseDate = (s) => {
  if (!s) return null;
  const t = String(s).trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { const d = new Date(+iso[1], +iso[2]-1, +iso[3]); d.setHours(0,0,0,0); return d; }
  const md = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) { const d = new Date(today.getFullYear(), +md[1]-1, +md[2]); d.setHours(0,0,0,0); return d; }
  return null;
};
const baseName = (n) => (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim();

(async () => {
  const [conSnap, slotSnap] = await Promise.all([
    db.ref('consultations').once('value'),
    db.ref('slots').once('value'),
  ]);
  const cons  = conSnap.val()  || {};
  const slots = slotSnap.val() || {};

  // EMR 현재 입원 chartNo 집합 (slots/*/current.chartNo)
  const emrChartSet = new Set();
  const emrSlotByChart = new Map();
  for (const [sk, slot] of Object.entries(slots)) {
    const ch = slot?.current?.chartNo;
    if (ch) { emrChartSet.add(ch); emrSlotByChart.set(ch, sk); }
  }

  const suspects = [];
  for (const [id, c] of Object.entries(cons)) {
    if (!c) continue;
    if (c.status !== '입원완료') continue;
    if (c.mergedInto) continue; // 이미 병합된 건 스킵
    const ad = parseDate(c.admitDate);
    if (!ad || ad <= today) continue; // 오늘 이후 입원만
    // chartNo 연결 상태 분류
    const linkedToActive = c.chartNo && emrChartSet.has(c.chartNo);
    suspects.push({
      id, ...c,
      admitDateParsed: ad,
      linkedToActive,
    });
  }

  suspects.sort((a, b) => a.admitDateParsed - b.admitDateParsed);

  console.log(`\n═ 미래 입원예정인데 status='입원완료' 인 상담: ${suspects.length}건 ═\n`);
  suspects.forEach(s => {
    const flag = s.chartNo
      ? (s.linkedToActive ? '🟢 현재 입원중 차트와 연결' : '🟡 차트 있으나 현재 입원중 아님')
      : '🔴 chartNo 없음 (이름 폴백 의심)';
    console.log(`${flag}  ${s.id}`);
    console.log(`     name="${s.name}" admit=${s.admitDate} discharge=${s.dischargeDate || '-'}`);
    console.log(`     chartNo=${s.chartNo || '-'} pid=${s.patientId || '-'} reservedSlot=${s.reservedSlot || '-'}`);
    console.log(`     createdAt=${s.createdAt || '-'}\n`);
  });

  const byFlag = {
    red:   suspects.filter(s => !s.chartNo).length,
    yellow:suspects.filter(s => s.chartNo && !s.linkedToActive).length,
    green: suspects.filter(s => s.linkedToActive).length,
  };
  console.log(`요약: 🔴 ${byFlag.red}건 (차트없음·이름폴백 의심) · 🟡 ${byFlag.yellow}건 (차트있으나 현재 비입원) · 🟢 ${byFlag.green}건 (실제 입원중)`);

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
