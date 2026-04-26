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
        if (intent.action != "android.intent.action.PHONE_STATE") return
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE)
        if (state != TelephonyManager.EXTRA_STATE_RINGING) return

        // 권한 체크 — 거부 시 조용히 스킵 (UI 측 안내가 별도)
        if (!hasPerm(context, Manifest.permission.READ_CALL_LOG)) {
            Log.w(TAG, "READ_CALL_LOG 권한 없음 — 스킵")
            return
        }

        // 약간 지연 후 CallLog 조회 (기록 완료 보장)
        Handler(Looper.getMainLooper()).postDelayed({
            val phone = readLatestIncomingNumber(context)
            if (phone.isNullOrBlank()) {
                Log.w(TAG, "incoming number 못 찾음")
                return@postDelayed
            }
            val digits = phone.replace(Regex("\\D"), "")
            if (digits.isBlank()) return@postDelayed

            // 같은 번호 5초 내 중복 호출 방지 (PHONE_STATE 가 여러 번 발화됨)
            val now = System.currentTimeMillis()
            if (lastReportedNumber == digits && now - lastReportedAt < 5_000) {
                return@postDelayed
            }
            lastReportedNumber = digits
            lastReportedAt = now

            GlobalScope.launch(Dispatchers.IO) {
                Api.postIncomingCall(context, digits)
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
