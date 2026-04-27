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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    companion object {
        private const val TAG = "EwooSyncWorker"
        private const val DEBOUNCE_MS = 60_000L
        private const val MAX_RETRY = 3
        // 같은 프로세스 내 모든 SyncWorker 인스턴스를 순차 실행. periodic/once/retry 가 동시에
        // 떠도 wipe+insert 는 한 번에 하나만 — 병렬 worker 가 같은 lastSync 를 읽고 모두
        // debounce 를 통과해 동시에 ContactsSync 를 돌리는 race 차단.
        private val syncMutex = Mutex()
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.WRITE_CONTACTS)
            != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "WRITE_CONTACTS 미부여 — sync 스킵")
            return@withContext Result.success()
        }

        syncMutex.withLock {
            // Debounce 는 lock 안에서 — 직전 worker 가 방금 끝났으면 lastSync 가 recent 라서 skip
            val sinceLast = System.currentTimeMillis() - Prefs.lastSync(applicationContext)
            if (sinceLast in 0..DEBOUNCE_MS) {
                Log.i(TAG, "직전 sync 후 ${sinceLast / 1000}s 경과 — debounce 스킵")
                return@withLock Result.success()
            }

            val patients = Api.fetchPatients(applicationContext)
            if (patients == null) {
                return@withLock if (runAttemptCount < MAX_RETRY) {
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
