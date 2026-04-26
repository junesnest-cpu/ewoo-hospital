import crypto from 'crypto';
import { requireAuth } from '../../lib/verifyAuth';
import { checkRateLimit, getClientIp, sanitizeKey } from '../../lib/rateLimit';
import { wardAdminDb } from '../../lib/firebaseAdmin';

// 메시지 길이 상한 (네이버 웍스 자체 한도와 무관, 봇 채널 가독성·과도 발송 방지)
const MAX_MESSAGE_LENGTH = 2000;
// rate limit: (uid 또는 IP) 1분 10회 — 정상 사용(치료계획 입력 알림 등)은 시간당 수 회 수준
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ── JWT 생성 (Node.js 내장 crypto 사용) ───────────────────────────────────────
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createJWT(clientId, serviceAccount, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientId,
    sub: serviceAccount,
    iat: now,
    exp: now + 3600,
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];
  const signingInput = segments.join('.');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${signingInput}.${signature}`;
}

// ── 네이버 웍스 Access Token 발급 ─────────────────────────────────────────────
async function getAccessToken() {
  const clientId     = process.env.NAVER_WORKS_CLIENT_ID;
  const clientSecret = process.env.NAVER_WORKS_CLIENT_SECRET;
  const serviceAccount = process.env.NAVER_WORKS_SERVICE_ACCOUNT;
  const privateKey   = process.env.NAVER_WORKS_PRIVATE_KEY?.replace(/\\n/g, '\n');

  const missing = [
    !clientId && 'CLIENT_ID',
    !clientSecret && 'CLIENT_SECRET',
    !serviceAccount && 'SERVICE_ACCOUNT',
    !privateKey && 'PRIVATE_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`네이버 웍스 환경변수 미설정: NAVER_WORKS_${missing.join(', NAVER_WORKS_')}`);
  }

  const jwt = createJWT(clientId, serviceAccount, privateKey);

  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      assertion: jwt,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'bot',
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`토큰 발급 실패: ${data.error} - ${data.error_description || ''}`);
  return data.access_token;
}

// ── 봇 메시지 전송 ────────────────────────────────────────────────────────────
async function sendBotMessage(accessToken, channelId, botId, message) {
  const res = await fetch(
    `https://www.worksapis.com/v1.0/bots/${botId}/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: { type: 'text', text: message },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`메시지 전송 실패 (${res.status}): ${JSON.stringify(err)}`);
  }
  return await res.json().catch(() => ({ success: true }));
}

// ── API 핸들러 ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const a = await requireAuth(req, res);
  if (!a.ok && !a.audited) return; // enforce 모드: 401 이미 응답됨

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: '메시지가 없습니다' });

  // 메시지 길이 상한 — 직원 실수·자동화 폭주·봇 채널 가독성 보호
  if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) {
    return res.status(413).json({ error: `메시지가 너무 깁니다 (최대 ${MAX_MESSAGE_LENGTH}자)` });
  }

  // Rate limit: uid 우선(인증 통과 시), 없으면 IP. audit 모드 폴백 시에도 IP 기반 보호.
  const rlKey = `naver-works-send/${a.user?.uid ? `uid_${sanitizeKey(a.user.uid)}` : `ip_${getClientIp(req)}`}`;
  const rl = await checkRateLimit({ key: rlKey, max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS, db: wardAdminDb });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: '봇 발송이 너무 잦습니다. 잠시 후 다시 시도해주세요.', retryAfter: rl.retryAfter });
  }

  const channelId = process.env.NAVER_WORKS_CHANNEL_ID;
  const botId     = process.env.NAVER_WORKS_BOT_ID;
  if (!channelId || !botId) {
    return res.status(500).json({ error: 'NAVER_WORKS_CHANNEL_ID 또는 BOT_ID 미설정' });
  }

  try {
    const token = await getAccessToken();
    const result = await sendBotMessage(token, channelId, botId, message);
    return res.status(200).json({ status: 'sent', result });
  } catch (err) {
    console.error('[naver-works-send]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
