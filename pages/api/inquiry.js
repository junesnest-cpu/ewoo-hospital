import crypto from 'crypto';
import { checkRateLimit, checkDedup, getClientIp } from '../../lib/rateLimit';
import { wardAdminDb } from '../../lib/firebaseAdmin';
import { logSecurityEvent } from '../../lib/securityLog';

// ── 회귀 fix (2026-04-26 firebase 12 업그레이드 직후 표면화) ─────────────────
// 이전: 자체 admin.initializeApp default app 호출. lib/firebaseAdmin 이 named app
//   (approval-admin, ward-admin) 만 init 하므로 cold start 운에 따라 admin.apps.length
//   가 0 이거나 2 였음. 0 일 때만 default app init 성공 → warm lambda 에서 inquiry 가
//   처음 호출되면 admin.database() 가 default app 없어 throw → 500.
// 이제: lib/firebaseAdmin 의 wardAdminDb (named app) 를 직접 사용. cold/warm 무관.
// safeInit 패턴 덕에 wardAdminDb 가 null 일 수 있으니 503 fallback.

// 문의유형 → 메모 접두사
const TYPE_LABELS = {
  medical: '진료문의',
  admission: '입퇴원문의',
  etc: '기타문의',
};

// CORS allowlist (2026-04-26 정확 매칭으로 강화)
// 이전: origin.includes('imweb') 패턴이 imweb.attacker.com 도 통과 — 우회 가능했음.
// 현재: 정확 호스트 매칭 + 'https://*.imweb.me' 만 suffix 매칭 (아임웹 표준 호스팅).
// origin 없는 호출(서버-서버, CURL): CORS 헤더 부여 안 함. 처리는 하되 브라우저 CORS 차단됨.
//   봇 spam 은 rate limit + dedup 으로 방어.
const ALLOWED_EXACT_ORIGINS = new Set([
  'https://www.ewoohospital.com',
  'https://ewoohospital.com',
  'https://ewoo-hospital.vercel.app',
]);
const ALLOWED_HOST_SUFFIXES = ['.imweb.me'];

function resolveAllowedOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_EXACT_ORIGINS.has(origin)) return origin;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return null;
    // hostname 이 정확히 ".imweb.me" 가 아니라 그 아래 서브도메인이어야 함 (예: foo.imweb.me)
    if (ALLOWED_HOST_SUFFIXES.some(s => url.hostname.endsWith(s) && url.hostname.length > s.length)) {
      return origin;
    }
  } catch {}
  return null;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = resolveAllowedOrigin(origin);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { name, phone, inquiryType, content, privacyAgreed, website } = req.body;

    // Honeypot 검증 (2026-04-26):
    //   폼에 display:none 으로 숨겨진 'website' 필드가 있음. 사람은 안 보여서 안 채움,
    //   봇은 자동으로 채움 → 비어있지 않으면 봇 판정.
    //   봇 학습 차단을 위해 정상 응답({success}) 으로 위장하고 DB 저장 skip.
    //   서버 로그에는 IP·값 일부 기록해 향후 패턴 분석.
    const ip = getClientIp(req);
    if (typeof website === 'string' && website.trim()) {
      console.warn(`[inquiry][honeypot] 봇 의심 제출 from IP=${ip}, hp_value="${website.slice(0, 80)}"`);
      logSecurityEvent({
        type: 'inquiry-honeypot',
        ip,
        hpValue: String(website).slice(0, 80),
        ua: (req.headers['user-agent'] || '').slice(0, 200) || null,
        origin: origin || null,
      });
      // 200 + fake id — 봇이 "성공"으로 인식하지만 DB 저장 안 됨
      return res.status(200).json({ success: true, id: `hp-${Date.now()}` });
    }

    // 필수값 검증
    if (!name?.trim()) return res.status(400).json({ error: '이름을 입력해주세요.' });
    if (!phone?.trim()) return res.status(400).json({ error: '연락처를 입력해주세요.' });
    if (!content?.trim()) return res.status(400).json({ error: '문의내용을 입력해주세요.' });
    if (!privacyAgreed) return res.status(400).json({ error: '개인정보 수집에 동의해주세요.' });

    // 연락처 정규화
    const normPhone = phone.replace(/[^0-9]/g, '');

    const db = wardAdminDb;
    if (!db) {
      console.error('[inquiry] wardAdminDb 미초기화 — env 점검 필요');
      return res.status(503).json({ error: '서비스가 일시적으로 사용 불가합니다.' });
    }

    // Rate limit: IP 당 1시간 10회 (정상 사용자는 평생 0~1회 제출이 일반적)
    const rl = await checkRateLimit({ key: `inquiry/${ip}`, max: 10, windowMs: 60 * 60 * 1000, db });
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: '문의가 너무 자주 들어왔습니다. 잠시 후 다시 시도해주세요.' });
    }

    // Dedup: 동일 phone + content 해시 1시간 내 중복 거부 (오타 정정 외엔 중복 의미 없음)
    const dedupKey = crypto.createHash('sha256')
      .update(`${normPhone}|${content.trim()}`)
      .digest('hex')
      .slice(0, 16);
    const dup = await checkDedup({ key: dedupKey, windowMs: 60 * 60 * 1000, db });
    if (dup.duplicate) {
      return res.status(409).json({ error: '동일한 문의가 이미 접수되었습니다.' });
    }

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
      recontact: true,
      recontactDate: createdAt.slice(0, 10),
      recontactMemo: `홈페이지 ${typeLabel}`,
      isNewPatient: true,
      source: 'website',
    };

    const newRef = db.ref('consultations').push();
    await newRef.set(consultation);

    return res.status(200).json({ success: true, id: newRef.key });
  } catch (e) {
    console.error('문의 접수 오류:', e);
    return res.status(500).json({ error: '접수 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
}
