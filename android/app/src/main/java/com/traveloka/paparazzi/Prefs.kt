package com.traveloka.paparazzi

import android.content.Context

/** Settings plus the high-water mark of what has already been uploaded. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("paparazzi", Context.MODE_PRIVATE)

    var hubUrl: String
        get() = sp.getString("hubUrl", "") ?: ""
        set(v) = sp.edit().putString("hubUrl", v.trim().trimEnd('/')).apply()

    var collection: String
        get() = sp.getString("collection", "inbox") ?: "inbox"
        set(v) = sp.edit().putString("collection", v.trim()).apply()

    var tags: String
        get() = sp.getString("tags", "") ?: ""
        set(v) = sp.edit().putString("tags", v.trim()).apply()

    /** MediaStore ids only ever increase, so one number is enough to avoid re-uploading. */
    var lastMediaId: Long
        get() = sp.getLong("lastMediaId", 0L)
        set(v) = sp.edit().putLong("lastMediaId", v).apply()

    var running: Boolean
        get() = sp.getBoolean("running", false)
        set(v) = sp.edit().putBoolean("running", v).apply()

    var lastStatus: String
        get() = sp.getString("lastStatus", "") ?: ""
        set(v) = sp.edit().putString("lastStatus", v).apply()

    var sentCount: Int
        get() = sp.getInt("sentCount", 0)
        set(v) = sp.edit().putInt("sentCount", v).apply()
}
