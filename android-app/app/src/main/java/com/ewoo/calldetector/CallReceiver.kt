package com.ewoo.calldetector

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.telephony.TelephonyManager
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch

/**
 * 전화 RINGING 감지 → 잠시 후(500ms) CallLog 에서 가장 최근 INCOMING 항목 조회 → 백엔드 POST.
 *
 * Android 10+ 에서는 EXTRA_INCOMING_NUMBER 가 사라져 CallLog 우회가 표준.
 * READ_CALL_LOG 권한 필요. RINGING 후 매우 짧은 시간 (~수백 ms) 내에 CallLog 에 기록됨.
 */
class CallReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "EwooCallReceiver"
        private var lastReportedNumber: String? = null
        private var lastReportedAt: Long = 0
    }

    override fun onReceive(context: Context, intent: Intent) {
        // [DEBUG 2026-04-27] receiver 발화 자체 확인용 Toast — 폰 화면에 즉시 노출
        Toast.makeText(context, "📞 receiver: ${intent.action} state=${intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: "(null)"}", Toast.LENGTH_LONG).show()

        if (intent.action != "android.intent.action.PHONE_STATE") return
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE)
        if (state != TelephonyManager.EXTRA_STATE_RINGING) return

        // 권한 체크 — 거부 시 조용히 스킵 (UI 측 안내가 별도)
        if (!hasPerm(context, Manifest.permission.READ_CALL_LOG)) {
            Toast.makeText(context, "❌ READ_CALL_LOG 권한 없음", Toast.LENGTH_LONG).show()
            Log.w(TAG, "READ_CALL_LOG 권한 없음 — 스킵")
            return
        }

        // 약간 지연 후 CallLog 조회 (기록 완료 보장)
        Handler(Looper.getMainLooper()).postDelayed({
            val phone = readLatestIncomingNumber(context)
            if (phone.isNullOrBlank()) {
                Toast.makeText(context, "❌ CallLog 에서 number 못 찾음", Toast.LENGTH_LONG).show()
                Log.w(TAG, "incoming number 못 찾음")
                return@postDelayed
            }
            val digits = phone.replace(Regex("\\D"), "")
            if (digits.isBlank()) return@postDelayed

            val now = System.currentTimeMillis()
            if (lastReportedNumber == digits && now - lastReportedAt < 5_000) {
                Toast.makeText(context, "⏭️ dedup skip ($digits)", Toast.LENGTH_SHORT).show()
                return@postDelayed
            }
            lastReportedNumber = digits
            lastReportedAt = now

            Toast.makeText(context, "📤 POST $digits", Toast.LENGTH_LONG).show()
            GlobalScope.launch(Dispatchers.IO) {
                val ok = Api.postIncomingCall(context, digits)
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(context, if (ok) "✅ POST 성공" else "❌ POST 실패", Toast.LENGTH_LONG).show()
                }
            }
        }, 600)
    }

    private fun hasPerm(ctx: Context, perm: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    private fun readLatestIncomingNumber(ctx: Context): String? {
        val cur = ctx.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE),
            "${CallLog.Calls.TYPE}=?",
            arrayOf(CallLog.Calls.INCOMING_TYPE.toString()),
            "${CallLog.Calls.DATE} DESC LIMIT 1"
        ) ?: return null
        cur.use {
            if (it.moveToFirst()) {
                val numIdx = it.getColumnIndex(CallLog.Calls.NUMBER)
                if (numIdx >= 0) return it.getString(numIdx)
            }
        }
        return null
    }
}
