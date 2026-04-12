import admin from 'firebase-admin';

// ── Firebase Admin SDK 초기화 (싱글턴) ───────────────────────────────────────
function getAdminDb() {
  if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!privateKey || !process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL) {
      throw new Error('Firebase 환경변수 미설정');
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

// 문의유형 → 메모 접두사
const TYPE_LABELS = {
  medical: '진료문의',
  admission: '입퇴원문의',
  etc: '기타문의',
};

export default async function handler(req, res) {
  // CORS — 아임웹 도메인 허용
  const origin = req.headers.origin || '';
  const allowed = ['https://www.ewoohospital.com', 'https://ewoohospital.com', 'https://ewoo-hospital.vercel.app'];
  if (allowed.some(o => origin.startsWith(o)) || origin.includes('imweb')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { name, phone, inquiryType, content, privacyAgreed } = req.body;

    // 필수값 검증
    if (!name?.trim()) return res.status(400).json({ error: '이름을 입력해주세요.' });
    if (!phone?.trim()) return res.status(400).json({ error: '연락처를 입력해주세요.' });
    if (!content?.trim()) return res.status(400).json({ error: '문의내용을 입력해주세요.' });
    if (!privacyAgreed) return res.status(400).json({ error: '개인정보 수집에 동의해주세요.' });

    // 연락처 정규화
    const normPhone = phone.replace(/[^0-9]/g, '');

    // 상담일지 데이터 구성
    const now = new Date();
    const createdAt = now.toISOString();
    const typeLabel = TYPE_LABELS[inquiryType] || '기타문의';
    const memo = `[홈페이지 ${typeLabel}]\n${content.trim()}`;

    const consultation = {
      name: name.trim(),
      birthYear: '', age: '',
      phone: normPhone, phoneNote: '',
      phone2: '', phone2Note: '',
      diagnosis: '', hospital: '',
      admitDate: '', admitTime: '', dischargeDate: '', dischargeTime: '', roomTypes: [],
      surgery: false, surgeryDate: '',
      chemo: false, chemoDate: '',
      radiation: false, radiationDate: '',
      memo,
      createdAt,
      status: '상담중',
      recontact: inquiryType === 'admission',
      recontactDate: inquiryType === 'admission' ? createdAt.slice(0, 10) : '',
      recontactMemo: inquiryType === 'admission' ? '홈페이지 입퇴원문의' : '',
      isNewPatient: true,
      source: 'website',
    };

    const db = getAdminDb();
    const newRef = db.ref('consultations').push();
    await newRef.set(consultation);

    return res.status(200).json({ success: true, id: newRef.key });
  } catch (e) {
    console.error('문의 접수 오류:', e);
    return res.status(500).json({ error: '접수 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
}
