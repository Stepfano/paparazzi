package com.traveloka.paparazzi

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/**
 * One screen: where the hub is, which folder to file into, and a start/stop switch.
 * Built in code rather than XML to keep the app free of AndroidX and resource plumbing.
 */
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var hubField: EditText
    private lateinit var collectionField: EditText
    private lateinit var tagsField: EditText
    private lateinit var statusView: TextView
    private lateinit var toggle: Button
    private val io = Executors.newSingleThreadExecutor()

    private val needPerms: Array<String>
        get() = buildList {
            if (Build.VERSION.SDK_INT >= 33) {
                add(Manifest.permission.READ_MEDIA_IMAGES)
                add(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }.toTypedArray()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad + pad, pad, pad)
        }

        root.addView(TextView(this).apply {
            text = "Paparazzi"
            textSize = 24f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "Screenshots you take go straight to your Figma library."
            textSize = 13f
            alpha = 0.7f
            setPadding(0, pad / 3, 0, pad)
        })

        hubField = field("Hub URL, e.g. http://10.15.39.66:8899", prefs.hubUrl, InputType.TYPE_TEXT_VARIATION_URI)
        root.addView(label("Hub")); root.addView(hubField)

        collectionField = field("competitors/Agoda", prefs.collection, InputType.TYPE_CLASS_TEXT)
        root.addView(label("Folder")); root.addView(collectionField)

        tagsField = field("funnel, pricing", prefs.tags, InputType.TYPE_CLASS_TEXT)
        root.addView(label("Tags (optional)")); root.addView(tagsField)

        toggle = Button(this).apply {
            setPadding(pad, pad / 2, pad, pad / 2)
            setOnClickListener { onToggle() }
        }
        root.addView(toggle, lp().apply { topMargin = pad })

        root.addView(Button(this).apply {
            text = "Test connection"
            setOnClickListener { testConnection() }
        }, lp())

        statusView = TextView(this).apply {
            textSize = 13f
            setPadding(0, pad, 0, 0)
        }
        root.addView(statusView)

        root.addView(TextView(this).apply {
            text = "On Xiaomi/HyperOS, also allow Autostart and set battery saver to " +
                "\"No restrictions\" for Paparazzi, or Android will stop it in the background."
            textSize = 11f
            alpha = 0.6f
            setPadding(0, pad, 0, 0)
        })
        root.addView(Button(this).apply {
            text = "Open app settings"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:$packageName")))
            }
        }, lp())

        setContentView(android.widget.ScrollView(this).apply { addView(root) })
        render()
    }

    override fun onPause() {
        super.onPause()
        save()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun save() {
        prefs.hubUrl = hubField.text.toString()
        prefs.collection = collectionField.text.toString().ifBlank { "inbox" }
        prefs.tags = tagsField.text.toString()
    }

    private fun onToggle() {
        save()
        if (prefs.running) {
            stopService(Intent(this, CaptureService::class.java))
            prefs.running = false
            render()
            return
        }
        if (prefs.hubUrl.isBlank()) {
            toast("Set the hub URL first")
            return
        }
        val missing = needPerms.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), 42)
            return
        }
        startService(Intent(this, CaptureService::class.java))
        prefs.running = true
        render()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        // Reading images is essential; the notification permission only affects visibility.
        val essential = perms.indices.filter {
            perms[it] != Manifest.permission.POST_NOTIFICATIONS
        }
        if (essential.all { results.getOrNull(it) == PackageManager.PERMISSION_GRANTED }) {
            startService(Intent(this, CaptureService::class.java))
            prefs.running = true
        } else {
            toast("Paparazzi needs access to your images to see screenshots")
        }
        render()
    }

    private fun testConnection() {
        save()
        statusView.text = "Checking…"
        val url = prefs.hubUrl
        io.execute {
            val res = Uploader.ping(url)
            runOnUiThread {
                statusView.text = if (res != null) "Hub reachable — $res"
                                  else "Cannot reach $url\nIs the hub running, and are you on the same Wi-Fi?"
                statusView.setTextColor(if (res != null) Color.parseColor("#0f9960")
                                        else Color.parseColor("#c23030"))
            }
        }
    }

    private fun render() {
        toggle.text = if (prefs.running) "Stop watching" else "Start watching"
        val last = prefs.lastStatus
        if (last.isNotBlank()) {
            statusView.setTextColor(Color.GRAY)
            statusView.text = last
        }
    }

    private fun label(t: String) = TextView(this).apply {
        text = t; textSize = 12f; alpha = 0.7f
        setPadding(0, (8 * resources.displayMetrics.density).toInt(), 0, 0)
    }

    private fun field(hint: String, value: String, type: Int) = EditText(this).apply {
        this.hint = hint
        setText(value)
        inputType = type
        setSingleLine()
        gravity = Gravity.START
    }

    private fun lp() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    )

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_SHORT).show()
}
