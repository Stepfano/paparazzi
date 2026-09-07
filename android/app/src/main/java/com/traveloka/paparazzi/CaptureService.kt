package com.traveloka.paparazzi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.provider.MediaStore
import java.util.concurrent.Executors

/**
 * Foreground service that notices new screenshots and pushes them to the hub.
 *
 * A ContentObserver on MediaStore fires for ANY new image, so each candidate is checked against
 * the screenshot folders before uploading — otherwise every camera photo and downloaded image
 * would end up in the library.
 *
 * Android requires the persistent notification; it is not optional for a service that runs
 * while the app is in the background.
 */
class CaptureService : Service() {

    companion object {
        const val CHANNEL_ID = "paparazzi.capture"
        const val NOTIF_ID = 1001
        const val ACTION_STOP = "com.traveloka.paparazzi.STOP"

        /** MediaStore reports every image; only these paths are screenshots. */
        private val SCREENSHOT_HINTS = listOf("screenshot", "screenshots")
    }

    private lateinit var prefs: Prefs
    private var observer: ContentObserver? = null
    private var thread: HandlerThread? = null
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIF_ID, buildNotification("Watching for screenshots"))
        prefs.running = true
        registerObserver()
        // START_STICKY so Android brings the service back if it is killed for memory.
        return START_STICKY
    }

    private fun registerObserver() {
        if (observer != null) return
        val t = HandlerThread("paparazzi-observer").apply { start() }
        thread = t
        val obs = object : ContentObserver(Handler(t.looper)) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                // The observer can fire several times for one insert, and the row may not be
                // complete yet, so the scan is idempotent and driven by the id high-water mark.
                io.execute { scanForNew() }
            }
        }
        contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, obs
        )
        observer = obs
        io.execute { scanForNew() }
    }

    /** Finds images newer than the last uploaded id and pushes the ones that are screenshots. */
    private fun scanForNew() {
        val hub = prefs.hubUrl
        if (hub.isBlank()) {
            notify("Hub URL not set — open Paparazzi")
            return
        }

        val cols = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.DATA,
        )
        val since = prefs.lastMediaId

        contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            cols,
            "${MediaStore.Images.Media._ID} > ?",
            arrayOf(since.toString()),
            "${MediaStore.Images.Media._ID} ASC"
        )?.use { c ->
            val idIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val mimeIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val dateIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val dataIdx = c.getColumnIndex(MediaStore.Images.Media.DATA)

            while (c.moveToNext()) {
                val id = c.getLong(idIdx)
                val name = c.getString(nameIdx) ?: "screenshot.png"
                val mime = c.getString(mimeIdx) ?: "image/png"
                val addedSec = c.getLong(dateIdx)
                val path = if (dataIdx >= 0) c.getString(dataIdx) ?: "" else ""

                // Advance the marker even for skipped rows, so non-screenshots are not rescanned.
                prefs.lastMediaId = id

                if (!looksLikeScreenshot(name, path)) continue

                val uri = Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toString())
                val bytes = runCatching {
                    contentResolver.openInputStream(uri)?.use { it.readBytes() }
                }.getOrNull()

                if (bytes == null || bytes.isEmpty()) {
                    notify("Could not read $name")
                    continue
                }

                when (val r = Uploader.upload(
                    hubUrl = hub,
                    bytes = bytes,
                    name = name,
                    mime = mime,
                    collection = prefs.collection,
                    tags = prefs.tags,
                    capturedAtMs = if (addedSec > 0) addedSec * 1000 else System.currentTimeMillis(),
                )) {
                    is UploadResult.Stored -> {
                        prefs.sentCount = prefs.sentCount + 1
                        notify("Sent $name  (${prefs.sentCount} total)")
                    }
                    is UploadResult.Duplicate -> notify("Already had $name")
                    is UploadResult.Failed -> {
                        // Roll the marker back so this screenshot is retried on the next event
                        // rather than silently lost.
                        prefs.lastMediaId = id - 1
                        notify("Failed: ${r.reason}")
                        return
                    }
                }
            }
        }
    }

    private fun looksLikeScreenshot(name: String, path: String): Boolean {
        val hay = (path.ifBlank { name }).lowercase()
        if (SCREENSHOT_HINTS.any { hay.contains(it) }) return true
        // Some OEMs drop the folder hint but keep it in the filename.
        return name.lowercase().startsWith("screenshot")
    }

    private fun notify(text: String) {
        prefs.lastStatus = text
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, CaptureService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val b = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Paparazzi")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
        return b.build()
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Screenshot capture", NotificationManager.IMPORTANCE_LOW)
                    .apply { description = "Shows that Paparazzi is watching for screenshots" }
            )
        }
    }

    override fun onDestroy() {
        observer?.let { contentResolver.unregisterContentObserver(it) }
        observer = null
        thread?.quitSafely()
        io.shutdown()
        prefs.running = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
