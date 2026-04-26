package com.ewoo.calldetector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 부팅 후 자동으로 sync worker 재예약. (WorkManager 는 일반적으로 부팅 후 복원되지만 명시 보장)
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        SyncScheduler.schedulePeriodic(context)
    }
}
