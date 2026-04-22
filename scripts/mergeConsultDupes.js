/**
 * 중복 consultation 병합 (P4)
 *
 * 병합 대상:
 *   같은 chartNo 에 2건 이상 + admitDate 집합 크기 ≤ 1 (D 재입원 케이스 제외)
 *
 * 대표 선정:
 *   - createdAt 가장 이른 것
 *   - 동률 시 import_ 접두어 우선 (역사적 뿌리)
 *
 * 병합 처리:
 *   - 비대표 : { mergedInto: repId, mergedAt: ISO, status: '취소' } 마킹
 *             (물리 삭제 안 함 → 감사 추적 유지)
 *   - 대표   : 비대표의 필드 중 대표에 비어있는 것만 이관.
 *             status 는 상담중<예약완료<입원완료 중 최고값.
 *             note 는 서로 다른 내용이면 '\n---\n' 으로 연결.
 *   - slot 참조 : slots/{k}/current/consultationId 및
 *                  slots/{k}/reservations[].consultationId 가 비대표를 가리키면
 *                  대표 ID 로 재연결.
 *   - 백업 : 실행 전 consultations 전체를 _backup_YYYY-MM-DDTHH-mm/consultations 에 저장.
 *
 * 사용법:
 *   node scripts/mergeConsultDupes.js           # dry-run (기본)
 *   node scripts/mergeConsultDupes.js --apply   # 실제 실행
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

const APPLY = process.argv.includes('--apply');

const normMD = (s) => {
  if (!s) return '';
  const t = String(s).trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${+iso[2]}/${+iso[3]}`;
  const md = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) return `${+md[1]}/${+md[2]}`;
  return t;
};
const STATUS_ORDER = { '상담중': 1, '예약완료': 2, '입원완료': 3 };

(async () => {
  console.log(APPLY ? '🚀 APPLY 모드' : '👀 DRY-RUN (변경 없음) — --apply 로 실제 실행\n');

  const [conSnap, slotsSnap] = await Promise.all([
    db.ref('consultations').once('value'),
    db.ref('slots').once('value'),
  ]);
  const cons  = conSnap.val()   || {};
  const slots = slotsSnap.val() || {};

  // 유효 consultation 을 chart 별로 그룹
  const byChart = new Map();
  for (const [id, c] of Object.entries(cons)) {
    if (!c) continue;
    if (c.status === '취소') continue;
    if (c.mergedInto) continue; // 이미 병합된 건 스킵
    if (!c.chartNo) continue;
    if (!byChart.has(c.chartNo)) byChart.set(c.chartNo, []);
    byChart.get(c.chartNo).push({ id, ...c });
  }

  // 병합 대상 선별 (D 제외)
  const mergeGroups = [];
  let skippedD = 0;
  for (const [chart, arr] of byChart.entries()) {
    if (arr.length < 2) continue;
    const admits = new Set(arr.map(c => normMD(c.admitDate)).filter(Boolean));
    if (admits.size > 1) { skippedD++; continue; } // MULTI_ADMISSION
    // 대표 선정: createdAt ASC, tiebreak import_ 우선
    const sorted = [...arr].sort((a, b) => {
      const tA = a.createdAt || '';
      const tB = b.createdAt || '';
      if (tA !== tB) return tA.localeCompare(tB);
      const iA = a.id.startsWith('import_') ? 0 : 1;
      const iB = b.id.startsWith('import_') ? 0 : 1;
      return iA - iB;
    });
    mergeGroups.push({ chart, rep: sorted[0], nonReps: sorted.slice(1) });
  }

  const totalNonReps = mergeGroups.reduce((s, g) => s + g.nonReps.length, 0);
  console.log(`📊 대상 그룹: ${mergeGroups.length}개 → 비대표 ${totalNonReps}건 병합 (D 재입원 ${skippedD}건 제외)\n`);

  const updates = {};
  const now = new Date().toISOString();

  for (const g of mergeGroups) {
    // 대표 필드 병합 계산
    const repMerged = { ...g.rep };
    delete repMerged.id;
    for (const nr of g.nonReps) {
      for (const [k, v] of Object.entries(nr)) {
        if (k === 'id') continue;
        if (repMerged[k] == null || repMerged[k] === '') {
          repMerged[k] = v;
        } else if (k === 'note' && v && v !== repMerged[k] && !String(repMerged[k]).includes(v)) {
          repMerged[k] = `${repMerged[k]}\n---\n${v}`;
        }
      }
      // status 진행 단계 최고값
      if ((STATUS_ORDER[nr.status] || 0) > (STATUS_ORDER[repMerged.status] || 0)) {
        repMerged.status = nr.status;
      }
    }
    // 변경된 필드만 updates 에 반영
    for (const [k, v] of Object.entries(repMerged)) {
      if (g.rep[k] !== v) {
        updates[`consultations/${g.rep.id}/${k}`] = v;
      }
    }
    // 비대표 마킹
    for (const nr of g.nonReps) {
      updates[`consultations/${nr.id}/mergedInto`] = g.rep.id;
      updates[`consultations/${nr.id}/mergedAt`]   = now;
      updates[`consultations/${nr.id}/status`]     = '취소';
    }
  }

  // slot 참조 재연결
  const nonRepToRep = new Map();
  for (const g of mergeGroups) {
    for (const nr of g.nonReps) nonRepToRep.set(nr.id, g.rep.id);
  }
  let slotRefCount = 0;
  for (const [sk, slot] of Object.entries(slots)) {
    const curCid = slot?.current?.consultationId;
    if (curCid && nonRepToRep.has(curCid)) {
      updates[`slots/${sk}/current/consultationId`] = nonRepToRep.get(curCid);
      slotRefCount++;
    }
    const res = slot?.reservations || [];
    if (res.length > 0) {
      let changed = false;
      const newRes = res.map(r => {
        if (r?.consultationId && nonRepToRep.has(r.consultationId)) {
          changed = true;
          return { ...r, consultationId: nonRepToRep.get(r.consultationId) };
        }
        return r;
      });
      if (changed) {
        updates[`slots/${sk}/reservations`] = newRes;
        slotRefCount++;
      }
    }
  }
  console.log(`🔗 slot 참조 재연결: ${slotRefCount}건`);
  console.log(`🔧 총 업데이트 키: ${Object.keys(updates).length}개\n`);

  // 샘플 (처음 10건 + 모든 비대표가 3 이상인 특수 케이스)
  console.log('─ 병합 샘플 (처음 10건) ─');
  mergeGroups.slice(0, 10).forEach(g => {
    console.log(`  chart=${g.chart} rep=${g.rep.id} ("${g.rep.name || ''}", admit=${g.rep.admitDate || '-'}, createdAt=${g.rep.createdAt || '-'})`);
    g.nonReps.forEach(nr => {
      console.log(`     ← ${nr.id} status=${nr.status || ''} createdAt=${nr.createdAt || '-'}`);
    });
  });

  const tripleGroups = mergeGroups.filter(g => g.nonReps.length >= 2);
  if (tripleGroups.length > 0) {
    console.log(`\n─ 3건 이상 중복 그룹 ${tripleGroups.length}개 ─`);
    tripleGroups.forEach(g => {
      console.log(`  chart=${g.chart} rep=${g.rep.id}`);
      g.nonReps.forEach(nr => console.log(`     ← ${nr.id}`));
    });
  }

  if (!APPLY) {
    console.log('\n👀 DRY-RUN 완료. --apply 붙여 실행');
    process.exit(0);
  }

  // 백업
  const backupTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  console.log(`\n💾 백업 중... _backup_${backupTs}/consultations`);
  await db.ref(`_backup_${backupTs}/consultations`).set(cons);
  console.log(`   완료`);

  // 배치 적용
  const entries = Object.entries(updates);
  for (let i = 0; i < entries.length; i += 500) {
    await db.ref('/').update(Object.fromEntries(entries.slice(i, i + 500)));
    process.stdout.write(`\r   적용 ${Math.min(i + 500, entries.length)} / ${entries.length}`);
  }
  console.log(`\n✅ 병합 완료`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
