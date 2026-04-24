import java.util.Properties

pluginManagement {
    val flutterSdkPath =
        run {
            val properties = Properties()
            val localPropertiesFile = file("local.properties")

            require(localPropertiesFile.exists()) {
                "local.properties is missing. Add flutter.sdk and sdk.dir before building."
            }

            localPropertiesFile.inputStream().use { properties.load(it) }
            val sdkPath = properties.getProperty("flutter.sdk")

            require(!sdkPath.isNullOrBlank()) {
                "flutter.sdk is not set in local.properties."
            }

            sdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.1.4" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}

include(":app")
