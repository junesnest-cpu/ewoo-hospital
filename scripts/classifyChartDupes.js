/**
 * 같은 chartNo 에 연결된 여러 consultation 을 패턴별로 분류
 *
 * 분류 카테고리:
 *   A. IMPORT_ONLY    : 모두 import_ ID (과거 이전 데이터). 같은 사람이 여러 번 import 된 정황
 *   B. IMPORT_PLUS_NEW: import_ + 새 push ID 혼재. 이전 후 사용자가 수동 입력 추가
 *   C. NEW_ONLY       : 모두 push ID. 사용자가 수동으로 여러 번 등록
 *   D. MULTI_ADMISSION: admitDate 가 서로 다름 (재입원 상담이 각각 생성됨)
 *   E. SAME_CYCLE_DUP : 같은 admitDate + 같은 reservedSlot + 같은 상태 (진짜 중복)
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

(async () => {
  const conSnap = await db.ref('consultations').once('value');
  const cons = conSnap.val() || {};

  // chart → [ {id, ...c} ]
  const byChart = new Map();
  for (const [id, c] of Object.entries(cons)) {
    if (!c || c.status === '취소') continue;
    if (!c.chartNo) continue;
    if (!byChart.has(c.chartNo)) byChart.set(c.chartNo, []);
    byChart.get(c.chartNo).push({ id, ...c });
  }

  const dups = [...byChart.entries()].filter(([, arr]) => arr.length > 1);
  console.log(`같은 chartNo 에 여러 consultation 연결: ${dups.length}건 (환자 기준)\n`);
  console.log('─'.repeat(72));

  const categorized = { A: [], B: [], C: [], D: [], E: [] };

  const normMD = (s) => {
    if (!s) return '';
    const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${+iso[2]}/${+iso[3]}`;
    const md = String(s).match(/^(\d{1,2})\/(\d{1,2})$/);
    if (md) return `${+md[1]}/${+md[2]}`;
    return s;
  };

  for (const [chart, arr] of dups) {
    const ids = arr.map(c => c.id);
    const imports = ids.filter(i => i.startsWith('import_'));
    const pushes  = ids.filter(i => !i.startsWith('import_'));

    const admits = new Set(arr.map(c => normMD(c.admitDate)).filter(Boolean));
    const slots  = new Set(arr.map(c => c.reservedSlot).filter(Boolean));
    const statuses = new Set(arr.map(c => c.status || '상담중'));

    let cat;
    if (imports.length >= 2 && pushes.length === 0) cat = 'A';
    else if (imports.length >= 1 && pushes.length >= 1) cat = 'B';
    else if (pushes.length >= 2) cat = 'C';
    else cat = 'A'; // fallback

    // D/E 판정은 cat 위에 덧씌우기 (같은 admit 인데 중복이면 E, 다르면 D)
    if (admits.size > 1) cat = 'D';
    else if (admits.size === 1 && slots.size <= 1) cat = cat === 'D' ? 'D' : 'E';
    // else 유지

    categorized[cat].push({ chart, arr, imports: imports.length, pushes: pushes.length, admits: [...admits], slots: [...slots], statuses: [...statuses] });
  }

  const label = {
    A: 'IMPORT_ONLY (모두 import — 과거 중복 이전)',
    B: 'IMPORT_PLUS_NEW (import + 수동입력 혼재)',
    C: 'NEW_ONLY (모두 수동입력)',
    D: 'MULTI_ADMISSION (재입원마다 상담일지 생성)',
    E: 'SAME_CYCLE_DUP (같은 입원 사이클에 진짜 중복)',
  };

  for (const k of ['A', 'B', 'C', 'D', 'E']) {
    const list = categorized[k];
    console.log(`\n[${k}] ${label[k]}: ${list.length}건`);
    console.log('─'.repeat(72));
    list.slice(0, 10).forEach(x => {
      console.log(`  chart=${x.chart} · ${x.arr.length}건 (import=${x.imports}, push=${x.pushes})`);
      x.arr.forEach(c => {
        const ts = c.createdAt || '';
        console.log(`     ${c.id.padEnd(24)} name="${c.name || ''}" status="${c.status || ''}" admit=${c.admitDate || '-'} slot=${c.reservedSlot || '-'} createdAt=${ts}`);
      });
    });
    if (list.length > 10) console.log(`  ...외 ${list.length - 10}건`);
  }

  console.log('\n' + '═'.repeat(72));
  console.log('💡 카테고리별 권장 병합 정책');
  console.log('═'.repeat(72));
  console.log(`  A·B·E : 대표 1건만 남기고 나머지 "병합"(mergedInto 필드) 처리. slot·치료계획 참조는 대표로 유지.`);
  console.log(`  D     : 각 입원 사이클의 독립 기록 — 병합 금지. 오히려 정상적 상태.`);
  console.log(`  C     : 사용자 확인 후 수동 판정 — 다른 방문(예약 취소 후 새 예약)일 수 있음.`);

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
