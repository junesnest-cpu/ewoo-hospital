/**
 * 병원장 전용 경영현황 API — Firebase에서 읽기 전용
 * (EMR 데이터는 로컬 스크립트 syncDirectorStats.js로 동기화)
 */
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

if (!getApps().length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { action, year, month } = req.body;
  const targetYear = year || new Date().getFullYear();

  const db = getDatabase();

  try {
    if (action === 'revenue') {
      const snap = await db.ref(`directorStats/${targetYear}/revenue`).once('value');
      const data = snap.val();
      if (!data) return res.json({ year: targetYear, inpatient: {}, outpatient: {}, bedDays: {}, treatmentItems: {}, lastSync: null });

      const lastSyncSnap = await db.ref(`directorStats/${targetYear}/lastSync`).once('value');
      const tiSnap = await db.ref(`directorStats/${targetYear}/treatmentItems`).once('value');
      return res.json({
        year: targetYear,
        inpatient: data.inpatient || {},
        outpatient: data.outpatient || {},
        bedDays: data.bedDays || {},
        treatmentItems: tiSnap.val() || {},
        lastSync: lastSyncSnap.val(),
      });
    } else if (action === 'occupancy') {
      const m = month || (new Date().getMonth() + 1);
      const ym = `${targetYear}${String(m).padStart(2, '0')}`;
      const [occSnap, revSnap, lastSyncSnap] = await Promise.all([
        db.ref(`directorStats/${targetYear}/occupancy/${ym}`).once('value'),
        db.ref(`directorStats/${targetYear}/dailyRevenue/${ym}`).once('value'),
        db.ref(`directorStats/${targetYear}/lastSync`).once('value'),
      ]);
      const occData = occSnap.val() || {};
      const revData = revSnap.val() || {};

      const daily = Object.entries(occData)
        .map(([dt, v]) => ({ date: dt, ...v, inTotal: revData[dt]?.inTotal || 0, outTotal: revData[dt]?.outTotal || 0, gongdan: revData[dt]?.gongdan || 0 }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return res.json({
        year: targetYear, month: m, totalBeds: 78,
        daily,
        lastSync: lastSyncSnap.val(),
      });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('director-stats error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
