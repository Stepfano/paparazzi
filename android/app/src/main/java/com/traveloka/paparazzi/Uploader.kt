package com.traveloka.paparazzi

import android.os.Build
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Result of one push: the hub either stored it, recognised it as a duplicate, or failed. */
sealed class UploadResult {
    data class Stored(val id: String) : UploadResult()
    data class Duplicate(val ofId: String, val similarity: Double) : UploadResult()
    data class Failed(val reason: String) : UploadResult()
}

object Uploader {

    /**
     * POSTs raw image bytes to the hub. Metadata rides on the query string, which keeps the
     * body a plain image and avoids needing a multipart encoder.
     */
    fun upload(
        hubUrl: String,
        bytes: ByteArray,
        name: String,
        mime: String,
        collection: String,
        tags: String,
        capturedAtMs: Long,
        appPackage: String? = null,
    ): UploadResult {
        if (hubUrl.isBlank()) return UploadResult.Failed("hub URL not set")

        val q = StringBuilder("?name=").append(enc(name))
            .append("&platform=android")
            .append("&collection=").append(enc(collection.ifBlank { "inbox" }))
            .append("&captured=").append(capturedAtMs)
            .append("&device=").append(enc(Build.MODEL ?: ""))
            .append("&os=").append(enc(Build.VERSION.RELEASE ?: ""))
        if (tags.isNotBlank()) q.append("&tags=").append(enc(tags))
        if (!appPackage.isNullOrBlank()) q.append("&package=").append(enc(appPackage))

        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$hubUrl/v1/upload$q").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", mime)
                setFixedLengthStreamingMode(bytes.size)
                connectTimeout = 8000
                readTimeout = 30000
            }
            BufferedOutputStream(conn.outputStream).use { it.write(bytes) }

            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.let { readAll(it) } ?: ""

            if (code !in 200..299) {
                val msg = runCatching { JSONObject(body).optString("error") }.getOrNull()
                return UploadResult.Failed(msg?.ifBlank { "HTTP $code" } ?: "HTTP $code")
            }
            val json = JSONObject(body)
            when {
                json.optBoolean("duplicate") ->
                    UploadResult.Duplicate(json.optString("duplicateOf"), json.optDouble("similarity", 0.0))
                else -> UploadResult.Stored(json.optString("id"))
            }
        } catch (e: Exception) {
            UploadResult.Failed(e.message ?: e.javaClass.simpleName)
        } finally {
            conn?.disconnect()
        }
    }

    /** Cheap reachability probe so the UI can say whether the hub is up before starting. */
    fun ping(hubUrl: String): String? {
        if (hubUrl.isBlank()) return null
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$hubUrl/v1/health").openConnection() as HttpURLConnection).apply {
                connectTimeout = 4000; readTimeout = 4000
            }
            if (conn.responseCode !in 200..299) return null
            val j = JSONObject(readAll(conn.inputStream))
            "${j.optInt("screenshots")} in library"
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun readAll(s: InputStream): String = s.bufferedReader().use { it.readText() }
    private fun enc(v: String): String = URLEncoder.encode(v, "UTF-8")
}
