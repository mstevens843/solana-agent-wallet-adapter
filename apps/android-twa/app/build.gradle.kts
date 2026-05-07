plugins {
    id("com.android.application")
}

fun propertyOrEnv(name: String): String? =
    providers.gradleProperty(name).orNull ?: System.getenv(name)

fun escapedResValue(value: String): String =
    value.replace("\\", "\\\\").replace("\"", "\\\"")

val launchUrl = propertyOrEnv("AGENTIC_ANDROID_LAUNCH_URL")
    ?: propertyOrEnv("agenticLaunchUrl")
    ?: "https://agentic.onrender.com/app"
val launchUri = uri(launchUrl)
val launchScheme = launchUri.scheme ?: "https"
val launchHost = propertyOrEnv("AGENTIC_ANDROID_HOST")
    ?: propertyOrEnv("agenticHost")
    ?: launchUri.host
    ?: "agentic.onrender.com"
val launchPort = launchUri.port
val launchOrigin = "$launchScheme://$launchHost${if (launchPort > 0) ":$launchPort" else ""}"
val usesCleartext = launchScheme == "http"
val assetStatements =
    """[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"web","site":"$launchOrigin"}}]"""
val requestedTasks = gradle.startParameter.taskNames.map { it.lowercase() }
val isReleaseBuild = requestedTasks.any { it.contains("release") }
val localLaunchHosts = setOf("localhost", "127.0.0.1", "0.0.0.0", "::1")

if (isReleaseBuild && (launchScheme != "https" || launchHost.lowercase() in localLaunchHosts)) {
    throw GradleException(
        "Release Android builds must use a non-local HTTPS AGENTIC_ANDROID_LAUNCH_URL. Current value: $launchUrl",
    )
}

val appVersionCode = propertyOrEnv("AGENTIC_ANDROID_VERSION_CODE")
    ?: propertyOrEnv("agenticVersionCode")
    ?: "1"
val appVersionName = propertyOrEnv("AGENTIC_ANDROID_VERSION_NAME")
    ?: propertyOrEnv("agenticVersionName")
    ?: "0.1.0"
val parsedVersionCode = appVersionCode.toIntOrNull()
if (parsedVersionCode == null || parsedVersionCode <= 0) {
    throw GradleException("AGENTIC_ANDROID_VERSION_CODE must be a positive integer. Current value: $appVersionCode")
}

val releaseKeystore = propertyOrEnv("AGENTIC_ANDROID_KEYSTORE")
val releaseKeyAlias = propertyOrEnv("AGENTIC_ANDROID_KEY_ALIAS")
val releaseStorePassword = propertyOrEnv("AGENTIC_ANDROID_STORE_PASSWORD")
val releaseKeyPassword = propertyOrEnv("AGENTIC_ANDROID_KEY_PASSWORD")
val requireReleaseSigning =
    propertyOrEnv("AGENTIC_ANDROID_REQUIRE_SIGNING")
        ?.let { it == "1" || it.equals("true", ignoreCase = true) || it.equals("yes", ignoreCase = true) }
        ?: false
val releaseSigningValues = mapOf(
    "AGENTIC_ANDROID_KEYSTORE" to releaseKeystore,
    "AGENTIC_ANDROID_KEY_ALIAS" to releaseKeyAlias,
    "AGENTIC_ANDROID_STORE_PASSWORD" to releaseStorePassword,
    "AGENTIC_ANDROID_KEY_PASSWORD" to releaseKeyPassword,
)
val missingReleaseSigning = releaseSigningValues.filter { it.value.isNullOrBlank() }.keys
val hasReleaseSigning = missingReleaseSigning.isEmpty()

if (isReleaseBuild && requireReleaseSigning && !hasReleaseSigning) {
    throw GradleException(
        "AGENTIC_ANDROID_REQUIRE_SIGNING=1 requires complete release signing env. Missing: ${missingReleaseSigning.joinToString(", ")}",
    )
}

android {
    namespace = "com.agentic.wallet"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.agentic.wallet"
        minSdk = 23
        targetSdk = 35
        versionCode = parsedVersionCode
        versionName = appVersionName

        manifestPlaceholders["agenticScheme"] = launchScheme
        manifestPlaceholders["agenticHost"] = launchHost
        manifestPlaceholders["usesCleartextTraffic"] = usesCleartext.toString()

        buildConfigField("String", "AGENTIC_LAUNCH_URL", "\"${launchUrl.replace("\"", "\\\"")}\"")
        buildConfigField("String", "AGENTIC_LAUNCH_SCHEME", "\"${launchScheme.replace("\"", "\\\"")}\"")
        buildConfigField("String", "AGENTIC_LAUNCH_HOST", "\"${launchHost.replace("\"", "\\\"")}\"")
        buildConfigField("int", "AGENTIC_LAUNCH_PORT", launchPort.toString())
        resValue("string", "launch_url", launchUrl)
        resValue("string", "asset_statements", escapedResValue(assetStatements))
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseKeystore!!)
                keyAlias = releaseKeyAlias
                storePassword = releaseStorePassword
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
        }
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.0")
}
