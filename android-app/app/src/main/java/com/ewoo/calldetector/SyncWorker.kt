package com.ewoo.calldetector

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
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
    companion object {
        private const val TAG = "EwooSyncWorker"
        // 직전 sync 후 이 간격 안에 다시 trigger 되면 즉시 success 로 종료 — 실제 wipe+insert
        // 는 1회만 일어나서 visible oscillation 차단. periodic+manual+retry 가 동시에 떠도 안전.
        private const val DEBOUNCE_MS = 60_000L
        // fetchPatients 가 null 반환 시 무한 retry 방지. 3회까지만 retry, 이후 success 로 종료
        // 해서 다음 periodic 주기를 기다림.
        private const val MAX_RETRY = 3
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        // 권한 체크 — 없으면 success 로 조용히 종료 (failure 면 retry 안 하지만 향후 schedule 도
        // 안 한다는 보장이 없어 일관성 위해 success).
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.WRITE_CONTACTS)
            != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "WRITE_CONTACTS 미부여 — sync 스킵")
            return@withContext Result.success()
        }

        // Debounce — 직전 성공 sync 후 60초 이내면 no-op.
        val sinceLast = System.currentTimeMillis() - Prefs.lastSync(applicationContext)
        if (sinceLast in 0..DEBOUNCE_MS) {
            Log.i(TAG, "직전 sync 후 ${sinceLast / 1000}s 경과 — debounce 스킵")
            return@withContext Result.success()
        }

        val patients = Api.fetchPatients(applicationContext)
        if (patients == null) {
            return@withContext if (runAttemptCount < MAX_RETRY) {
                Log.w(TAG, "fetch 실패 — retry (attempt ${runAttemptCount + 1}/$MAX_RETRY)")
                Result.retry()
            } else {
                Log.w(TAG, "fetch 실패 ${MAX_RETRY}회 — 다음 periodic 까지 대기")
                Result.success()
            }
        }

        ContactsSync.syncAll(applicationContext, patients)
        Prefs.setLastSync(applicationContext, System.currentTimeMillis())
        Log.i(TAG, "sync 완료: ${patients.size}건")
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
