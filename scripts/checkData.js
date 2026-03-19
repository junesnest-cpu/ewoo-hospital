require("dotenv").config({ path: ".env.local" });
const admin = require("firebase-admin");
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey }), databaseURL: "https://ewoo-hospital-ward-default-rtdb.firebaseio.com" });
const db = admin.database();

(async () => {
  // 상담일지 샘플
  const cSnap = await db.ref("consultations").limitToFirst(5).once("value");
  const cons = Object.values(cSnap.val() || {});
  console.log("=== 상담일지 필드 ===");
  if (cons[0]) console.log(Object.keys(cons[0]).join(", "));
  if (cons[0]) console.log("샘플:", JSON.stringify(cons[0]).slice(0, 400));

  // slots 현황
  const sSnap = await db.ref("slots").once("value");
  const slots = sSnap.val() || {};
  const currents = [], reservations = [];
  Object.entries(slots).forEach(([k,v]) => {
    if (v?.current?.name) currents.push({ key:k, ...v.current });
    (v?.reservations||[]).forEach(r => reservations.push({ key:k, ...r }));
  });
  console.log("\n=== 병실 현황 ===");
  console.log("현재 입원:", currents.length, "명");
  console.log("예약:", reservations.length, "건");
  if (currents[0]) console.log("current 필드:", Object.keys(currents[0]).join(", "));
  if (reservations[0]) console.log("reservation 필드:", Object.keys(reservations[0]).join(", "));

  // 상담일지 총수
  const cAllSnap = await db.ref("consultations").once("value");
  const cAll = cAllSnap.val() || {};
  console.log("\n=== 상담일지 총수 ===", Object.keys(cAll).length, "건");

  // 상담일지에 phone 필드 있는지 확인
  const withPhone = Object.values(cAll).filter(c => c.phone || c.tel || c.mobile || c.contact).length;
  const allFields = new Set();
  Object.values(cAll).slice(0,20).forEach(c => Object.keys(c).forEach(k => allFields.add(k)));
  console.log("상담일지 전체 필드:", [...allFields].join(", "));
  console.log("전화번호 있는 상담:", withPhone, "건");

  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
