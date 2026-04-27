package com.ewoo.calldetector

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        // 권한 체크 — 없으면 fail (사용자가 settings 화면에서 부여 후 재시도)
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.WRITE_CONTACTS)
            != PackageManager.PERMISSION_GRANTED) return@withContext Result.failure()

        val patients = Api.fetchPatients(applicationContext) ?: return@withContext Result.retry()
        ContactsSync.syncAll(applicationContext, patients)
        Prefs.setLastSync(applicationContext, System.currentTimeMillis())
        Result.success()
    }
}

object SyncScheduler {
    private const val WORK_NAME = "ewoo_patient_sync"
    private const val WORK_NAME_ONCE = "ewoo_patient_sync_once"

    fun schedulePeriodic(ctx: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        // WorkManager 최소 주기 = 15분 (Android 시스템 한도)
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(ctx)
            .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** 사용자가 설정 화면에서 "지금 동기화" 누를 때 */
    fun runOnce(ctx: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val req = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints)
            .build()
        // KEEP — 이미 enqueue/실행 중이면 새 요청 무시.
        // 버튼 연타로 worker 가 병렬 누적되어 ContactsContract DELETE/INSERT 가
        // 서로 경합, 환자수 배수로 RawContact 중복 쌓이는 사고 방지 (2026-04-27 핫픽스).
        WorkManager.getInstance(ctx).enqueueUniqueWork(
            WORK_NAME_ONCE,
            ExistingWorkPolicy.KEEP,
            req,
        )
    }
}
