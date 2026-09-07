plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.traveloka.paparazzi"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.traveloka.paparazzi"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// Deliberately no dependencies: HttpURLConnection and the platform UI classes are enough,
// so the build needs nothing beyond the Android plugin itself.
dependencies { }
