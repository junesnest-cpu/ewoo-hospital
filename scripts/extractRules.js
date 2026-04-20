/**
 * Rules Snapshot Extractor (2026-04-20)
 * ------------------------------------------------------------
 * 3개 Firebase 프로젝트의 현재 운영 Rules를 로컬 파일로 덤프.
 * 배포 행위 없음 — 읽기 전용. 보안 스냅샷/커밋용.
 *
 *  - ewoo-hospital-ward → RTDB rules → ewoo-hospital/database.rules.json
 *  - ewoo-approval       → RTDB rules → ewoo-approval/database.rules.json
 *  - ewoo-clinical       → Firestore rules → ewoo-clinical/firestore.rules
 */
const fs   = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const REPO_ROOT = path.resolve(__dirname, '../..');

const targets = [
  {
    name: 'ward',
    type: 'rtdb',
    saPath: process.env.WARD_SA_PATH || path.join(process.env.USERPROFILE || process.env.HOME, '.firebase/ewoo-hospital-ward-sa.json'),
    dbUrl : 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
    out   : path.join(REPO_ROOT, 'ewoo-hospital/database.rules.json'),
  },
  {
    name: 'approval',
    type: 'rtdb',
    saPath: process.env.APPROVAL_SA_PATH || path.join(REPO_ROOT, 'ewoo-approval/serviceAccount-new.json'),
    dbUrl : 'https://ewoo-approval-default-rtdb.firebaseio.com',
    out   : path.join(REPO_ROOT, 'ewoo-approval/database.rules.json'),
  },
  {
    name: 'clinical',
    type: 'firestore',
    credentials: () => {
      require('dotenv').config({ path: path.join(REPO_ROOT, 'ewoo-clinical/.env.local') });
      return {
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key : process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      };
    },
    projectId: 'ewoo-clinical',
    out   : path.join(REPO_ROOT, 'ewoo-clinical/firestore.rules'),
  },
];

async function getToken(t, scopes) {
  const opts = { scopes };
  if (t.saPath)      opts.keyFilename = t.saPath;
  if (t.credentials) opts.credentials = t.credentials();
  const auth = new GoogleAuth(opts);
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function dumpRtdb(t) {
  const token = await getToken(t, [
    'https://www.googleapis.com/auth/firebase.database',
    'https://www.googleapis.com/auth/userinfo.email',
  ]);
  const r = await fetch(`${t.dbUrl}/.settings/rules.json?access_token=${token}`);
  if (!r.ok) throw new Error(`${t.name} rules fetch failed ${r.status}: ${await r.text()}`);
  const text = await r.text();
  fs.writeFileSync(t.out, text);
  console.log(`✅ ${t.name} RTDB rules → ${t.out} (${text.length} bytes)`);
}

async function dumpFirestore(t) {
  const token = await getToken(t, [
    'https://www.googleapis.com/auth/firebase',
    'https://www.googleapis.com/auth/cloud-platform',
  ]);
  const rel = await fetch(
    `https://firebaserules.googleapis.com/v1/projects/${t.projectId}/releases/cloud.firestore`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!rel.ok) throw new Error(`${t.name} release fetch failed ${rel.status}: ${await rel.text()}`);
  const relJson = await rel.json();
  const rulesetName = relJson.rulesetName;

  const rs = await fetch(
    `https://firebaserules.googleapis.com/v1/${rulesetName}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!rs.ok) throw new Error(`${t.name} ruleset fetch failed ${rs.status}: ${await rs.text()}`);
  const rsJson = await rs.json();
  const files = rsJson.source && rsJson.source.files;
  if (!files || !files.length) throw new Error(`${t.name} ruleset source empty`);
  fs.writeFileSync(t.out, files[0].content);
  console.log(`✅ ${t.name} Firestore rules → ${t.out} (${files[0].content.length} bytes)`);
}

(async () => {
  for (const t of targets) {
    try {
      if (t.type === 'rtdb') await dumpRtdb(t);
      else                    await dumpFirestore(t);
    } catch (e) {
      console.error(`❌ ${t.name}: ${e.message}`);
    }
  }
})();
