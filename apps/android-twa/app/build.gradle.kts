import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

fun propertyOrEnv(name: String): String? =
    providers.gradleProperty(name).orNull ?: System.getenv(name)

fun escapedResValue(value: String): String =
    value.replace("\\", "\\\\").replace("\"", "\\\"")

fun booleanFlag(value: String?, name: String, defaultValue: Boolean): Boolean {
    val normalized = value?.trim()?.lowercase()
    return when (normalized) {
        null, "" -> defaultValue
        "1", "true", "yes", "on" -> true
        "0", "false", "no", "off" -> false
        else -> throw GradleException(
            "$name must be a boolean value: true/false, 1/0, yes/no, or on/off. Current value: $value",
        )
    }
}

fun resolvedPnpmCommand(): String {
    val configured = propertyOrEnv("PNPM_BIN")
        ?: propertyOrEnv("agenticPnpmBin")
    if (!configured.isNullOrBlank()) return configured

    return listOf("/usr/local/bin/pnpm", "/opt/homebrew/bin/pnpm")
        .firstOrNull { file(it).isFile }
        ?: "pnpm"
}

fun resolvedNodeCommand(): String {
    val configured = propertyOrEnv("NODE_BIN")
        ?: propertyOrEnv("agenticNodeBin")
    if (!configured.isNullOrBlank()) return configured

    return listOf("/usr/local/bin/node", "/opt/homebrew/bin/node")
        .firstOrNull { file(it).isFile }
        ?: "node"
}

val launchUrl = propertyOrEnv("AGENTIC_ANDROID_LAUNCH_URL")
    ?: propertyOrEnv("agenticLaunchUrl")
    ?: "https://agentic-signer.com/app"
val launchUri = uri(launchUrl)
val launchScheme = launchUri.scheme ?: "https"
val launchHost = propertyOrEnv("AGENTIC_ANDROID_HOST")
    ?: propertyOrEnv("agenticHost")
    ?: launchUri.host
    ?: "agentic-signer.com"
val launchPort = launchUri.port
val launchOrigin = "$launchScheme://$launchHost${if (launchPort > 0) ":$launchPort" else ""}"
val usesCleartext = launchScheme == "http"
val assetStatements =
    """[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"web","site":"$launchOrigin"}}]"""
val requestedTasks = gradle.startParameter.taskNames.map { it.lowercase() }
val isReleaseBuild = requestedTasks.any { it.contains("release") }
val showExampleTabInput = providers.gradleProperty("agenticShowExampleTab").orNull
    ?: providers.gradleProperty("AGENTIC_ANDROID_SHOW_EXAMPLE_TAB").orNull
    ?: System.getenv("AGENTIC_ANDROID_SHOW_EXAMPLE_TAB")
    ?: System.getenv("agenticShowExampleTab")
val showExampleTab = booleanFlag(
    showExampleTabInput,
    "AGENTIC_ANDROID_SHOW_EXAMPLE_TAB",
    !isReleaseBuild,
)
val enableWebFallbackInput = providers.gradleProperty("agenticEnableWebFallback").orNull
    ?: providers.gradleProperty("AGENTIC_ANDROID_ENABLE_WEB_FALLBACK").orNull
    ?: System.getenv("AGENTIC_ANDROID_ENABLE_WEB_FALLBACK")
    ?: System.getenv("agenticEnableWebFallback")
val enableWebFallback = booleanFlag(
    enableWebFallbackInput,
    "AGENTIC_ANDROID_ENABLE_WEB_FALLBACK",
    false,
)
val allowLanBridgeInput = providers.gradleProperty("agenticAllowLanBridge").orNull
    ?: providers.gradleProperty("AGENTIC_ANDROID_ALLOW_LAN_BRIDGE").orNull
    ?: System.getenv("AGENTIC_ANDROID_ALLOW_LAN_BRIDGE")
    ?: System.getenv("agenticAllowLanBridge")
val allowLanBridge = booleanFlag(
    allowLanBridgeInput,
    "AGENTIC_ANDROID_ALLOW_LAN_BRIDGE",
    !isReleaseBuild,
)
val deviceAgentInput = providers.gradleProperty("agenticDeviceAgent").orNull
    ?: providers.gradleProperty("AGENTIC_ANDROID_DEVICE_AGENT").orNull
    ?: System.getenv("AGENTIC_ANDROID_DEVICE_AGENT")
    ?: System.getenv("agenticDeviceAgent")
val deviceAgentEnabled = booleanFlag(
    deviceAgentInput,
    "AGENTIC_ANDROID_DEVICE_AGENT",
    !isReleaseBuild,
)
val streamingSignerInput = providers.gradleProperty("agenticStreamingSigner").orNull
    ?: providers.gradleProperty("AGENTIC_ANDROID_STREAMING_SIGNER").orNull
    ?: System.getenv("AGENTIC_ANDROID_STREAMING_SIGNER")
    ?: System.getenv("agenticStreamingSigner")
val streamingSignerEnabled = booleanFlag(
    streamingSignerInput,
    "AGENTIC_ANDROID_STREAMING_SIGNER",
    !isReleaseBuild,
)
val deviceAgentWalletAllowlist = propertyOrEnv("AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST")
    ?: if (isReleaseBuild) "" else "4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w"
val androidReleaseProfileInput = propertyOrEnv("AGENTIC_ANDROID_RELEASE_PROFILE")
    ?: propertyOrEnv("agenticReleaseProfile")
val androidReleaseProfile = androidReleaseProfileInput?.trim()?.lowercase() ?: if (isReleaseBuild) "" else "debug"
val allowedAndroidReleaseProfiles = setOf("public-safe", "device-agent", "streaming-signer", "full")
if (isReleaseBuild) {
    if (androidReleaseProfile.isBlank()) {
        throw GradleException(
            "Release Android builds require AGENTIC_ANDROID_RELEASE_PROFILE. " +
                "Use one of: ${allowedAndroidReleaseProfiles.joinToString(", ")}.",
        )
    }
    if (androidReleaseProfile !in allowedAndroidReleaseProfiles) {
        throw GradleException(
            "AGENTIC_ANDROID_RELEASE_PROFILE must be one of: ${allowedAndroidReleaseProfiles.joinToString(", ")}. " +
                "Current value: $androidReleaseProfile",
        )
    }
    when (androidReleaseProfile) {
        "public-safe" -> {
            if (deviceAgentEnabled || streamingSignerEnabled) {
                throw GradleException(
                    "AGENTIC_ANDROID_RELEASE_PROFILE=public-safe requires AGENTIC_ANDROID_DEVICE_AGENT=false " +
                        "and AGENTIC_ANDROID_STREAMING_SIGNER=false.",
                )
            }
        }
        "device-agent" -> {
            if (!deviceAgentEnabled || streamingSignerEnabled) {
                throw GradleException(
                    "AGENTIC_ANDROID_RELEASE_PROFILE=device-agent requires AGENTIC_ANDROID_DEVICE_AGENT=true " +
                        "and AGENTIC_ANDROID_STREAMING_SIGNER=false.",
                )
            }
        }
        "streaming-signer" -> {
            if (deviceAgentEnabled || !streamingSignerEnabled) {
                throw GradleException(
                    "AGENTIC_ANDROID_RELEASE_PROFILE=streaming-signer requires AGENTIC_ANDROID_DEVICE_AGENT=false " +
                        "and AGENTIC_ANDROID_STREAMING_SIGNER=true.",
                )
            }
        }
        "full" -> {
            if (!deviceAgentEnabled || !streamingSignerEnabled) {
                throw GradleException(
                    "AGENTIC_ANDROID_RELEASE_PROFILE=full requires AGENTIC_ANDROID_DEVICE_AGENT=true " +
                        "and AGENTIC_ANDROID_STREAMING_SIGNER=true.",
                )
            }
        }
    }
}
val cloudApiBaseUrl = propertyOrEnv("AGENTIC_ANDROID_CLOUD_API_BASE_URL")
    ?: propertyOrEnv("AGENTIC_CLOUD_API_BASE_URL")
    ?: "https://agentic-signer.com"
val cloudApiUri = uri(cloudApiBaseUrl)
// GA4 measurement id baked into the bundled (offline-fallback) browser-demo build. The live
// WebView path loads from Render, which already injects this via render.yaml; this keeps
// analytics working when the bundled assets are served. Mirrors render.yaml's value.
val gaMeasurementId = propertyOrEnv("VITE_AGENTIC_GA_MEASUREMENT_ID")
    ?: propertyOrEnv("AGENTIC_GA_MEASUREMENT_ID")
    ?: "G-MJ3VZ7VEX7"
val localLaunchHosts = setOf("localhost", "127.0.0.1", "0.0.0.0", "::1")

// Live-update URL: when non-empty, the WebView loads this remote origin at launch instead of
// the bundled browser-demo assets. Lets us ship UI changes via Render with no APK re-upload.
// Release builds default to the canonical Render origin; debug builds default to empty so
// local dev keeps loading the bundled `agentic.local` assets unchanged.
val remoteWebUrlInput = propertyOrEnv("AGENTIC_ANDROID_REMOTE_WEB_URL")
    ?: propertyOrEnv("agenticRemoteWebUrl")
// Land the Android TWA on the interactive guided walkthrough so Solana dApp Store reviewers
// see a Solana approval flow on first paint instead of the marketing root (which previously
// triggered a "Limited In-App Functionality" rejection). Web visitors to agentic-signer.com
// are unaffected — they still hit the marketing root.
val remoteWebUrl = (remoteWebUrlInput ?: if (isReleaseBuild) "https://agentic-signer.com/demo" else "").trim()
if (remoteWebUrl.isNotEmpty()) {
    val parsed = runCatching { uri(remoteWebUrl) }.getOrNull()
    val scheme = parsed?.scheme?.lowercase()
    val host = parsed?.host?.lowercase()
    if (parsed == null || host.isNullOrBlank()) {
        throw GradleException(
            "AGENTIC_ANDROID_REMOTE_WEB_URL must be a valid absolute URL. Current value: $remoteWebUrl",
        )
    }
    if (isReleaseBuild && (scheme != "https" || host in localLaunchHosts)) {
        throw GradleException(
            "Release Android builds must use a non-local HTTPS AGENTIC_ANDROID_REMOTE_WEB_URL. Current value: $remoteWebUrl",
        )
    }
}

if (isReleaseBuild && (launchScheme != "https" || launchHost.lowercase() in localLaunchHosts)) {
    throw GradleException(
        "Release Android builds must use a non-local HTTPS AGENTIC_ANDROID_LAUNCH_URL. Current value: $launchUrl",
    )
}

if (isReleaseBuild && cloudApiUri.scheme != "https") {
    throw GradleException(
        "Release Android builds must use an HTTPS AGENTIC_ANDROID_CLOUD_API_BASE_URL. Current value: $cloudApiBaseUrl",
    )
}

val appVersionCode = propertyOrEnv("AGENTIC_ANDROID_VERSION_CODE")
    ?: propertyOrEnv("agenticVersionCode")
    ?: "9"
val appVersionName = propertyOrEnv("AGENTIC_ANDROID_VERSION_NAME")
    ?: propertyOrEnv("agenticVersionName")
    ?: "1.0.9"
val parsedVersionCode = appVersionCode.toIntOrNull()
if (parsedVersionCode == null || parsedVersionCode <= 0) {
    throw GradleException("AGENTIC_ANDROID_VERSION_CODE must be a positive integer. Current value: $appVersionCode")
}

val releaseKeystore = propertyOrEnv("AGENTIC_ANDROID_KEYSTORE")
    ?: providers.gradleProperty("android.injected.signing.store.file").orNull
val releaseKeyAlias = propertyOrEnv("AGENTIC_ANDROID_KEY_ALIAS")
    ?: providers.gradleProperty("android.injected.signing.key.alias").orNull
val releaseStorePassword = propertyOrEnv("AGENTIC_ANDROID_STORE_PASSWORD")
    ?: providers.gradleProperty("android.injected.signing.store.password").orNull
val releaseKeyPassword = propertyOrEnv("AGENTIC_ANDROID_KEY_PASSWORD")
    ?: providers.gradleProperty("android.injected.signing.key.password").orNull
val requireReleaseSigning =
    propertyOrEnv("AGENTIC_ANDROID_REQUIRE_SIGNING")
        ?.let { it == "1" || it.equals("true", ignoreCase = true) || it.equals("yes", ignoreCase = true) }
        ?: isReleaseBuild
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
        "Release Android builds require complete signing config from AGENTIC_ANDROID_* env vars or Android Studio's signing wizard. Missing: ${missingReleaseSigning.joinToString(", ")}",
    )
}

val bundledWebDistDir = rootProject.layout.projectDirectory.dir("../browser-demo/dist")
val filteredBundledWebAssetsDir = layout.buildDirectory.dir("generated/filteredBundledWebAssets")

android {
    namespace = "com.agentic.wallet"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.agentic.wallet"
        minSdk = 24
        targetSdk = 35
        versionCode = parsedVersionCode
        versionName = appVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        manifestPlaceholders["agenticScheme"] = launchScheme
        manifestPlaceholders["agenticHost"] = launchHost
        manifestPlaceholders["agenticWebFallbackEnabled"] = enableWebFallback.toString()
        manifestPlaceholders["usesCleartextTraffic"] = (usesCleartext || allowLanBridge).toString()
        manifestPlaceholders["agenticDeviceAgentEnabled"] = (deviceAgentEnabled || streamingSignerEnabled).toString()

        buildConfigField("String", "AGENTIC_LAUNCH_URL", "\"${launchUrl.replace("\"", "\\\"")}\"")
        buildConfigField("String", "AGENTIC_LAUNCH_SCHEME", "\"${launchScheme.replace("\"", "\\\"")}\"")
        buildConfigField("String", "AGENTIC_LAUNCH_HOST", "\"${launchHost.replace("\"", "\\\"")}\"")
        buildConfigField("int", "AGENTIC_LAUNCH_PORT", launchPort.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_SHOW_EXAMPLE_TAB", showExampleTab.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_ENABLE_WEB_FALLBACK", enableWebFallback.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_ALLOW_LAN_BRIDGE", allowLanBridge.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_DEVICE_AGENT", deviceAgentEnabled.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_STREAMING_SIGNER", streamingSignerEnabled.toString())
        buildConfigField("String", "AGENTIC_ANDROID_RELEASE_PROFILE", "\"${androidReleaseProfile.replace("\"", "\\\"")}\"")
        buildConfigField("String", "AGENTIC_ANDROID_CLOUD_API_BASE_URL", "\"${cloudApiBaseUrl.replace("\"", "\\\"")}\"")
        buildConfigField("String", "AGENTIC_ANDROID_REMOTE_WEB_URL", "\"${remoteWebUrl.replace("\"", "\\\"")}\"")
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

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        }
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
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(filteredBundledWebAssetsDir)
        }
    }

    testOptions {
        unitTests {
            // Let JVM unit tests exercise code paths that touch android.util.Log (e.g. AgentMwaLog
            // diagnostics in BridgeAiClient) — unmocked android.jar methods return defaults instead
            // of throwing "not mocked". Logging is verified for real on-device, not in unit tests.
            isReturnDefaultValues = true
        }
    }
}

val buildBundledWebAssetDependencies = tasks.register<Exec>("buildBundledWebAssetDependencies") {
    workingDir = rootProject.layout.projectDirectory.dir("../..").asFile
    commandLine(resolvedPnpmCommand(), "--filter", "@solana-agent-wallet-adapter/browser-demo^...", "build")
    environment(
        "PATH",
        listOf("/usr/local/bin", "/opt/homebrew/bin", System.getenv("PATH") ?: "")
            .filter { it.isNotBlank() }
            .joinToString(File.pathSeparator),
    )
}

val buildBundledWebAssets = tasks.register<Exec>("buildBundledWebAssets") {
    workingDir = rootProject.layout.projectDirectory.dir("../..").asFile
    commandLine(resolvedPnpmCommand(), "-F", "@solana-agent-wallet-adapter/browser-demo", "build")
    environment(
        "PATH",
        listOf("/usr/local/bin", "/opt/homebrew/bin", System.getenv("PATH") ?: "")
            .filter { it.isNotBlank() }
            .joinToString(File.pathSeparator),
    )
    environment("VITE_AGENTIC_ANDROID_APP", "true")
    environment("VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB", showExampleTab.toString())
    environment("VITE_AGENTIC_ANDROID_ALLOW_LAN_BRIDGE", allowLanBridge.toString())
    environment("VITE_AGENTIC_ANDROID_DEVICE_AGENT", deviceAgentEnabled.toString())
    environment("VITE_AGENTIC_ANDROID_STREAMING_SIGNER", streamingSignerEnabled.toString())
    environment("VITE_AGENTIC_DEVICE_AGENT", deviceAgentEnabled.toString())
    environment("VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST", deviceAgentWalletAllowlist)
    environment("VITE_AGENTIC_CLOUD_API_BASE_URL", cloudApiBaseUrl)
    environment("VITE_CAPACITOR_IOS_APP", "false")
    environment("VITE_AGENTIC_GA_MEASUREMENT_ID", gaMeasurementId)
}

val typecheckBundledWebAssets = tasks.register<Exec>("typecheckBundledWebAssets") {
    workingDir = rootProject.layout.projectDirectory.dir("../..").asFile
    commandLine(resolvedPnpmCommand(), "-F", "@solana-agent-wallet-adapter/browser-demo", "typecheck")
    environment(
        "PATH",
        listOf("/usr/local/bin", "/opt/homebrew/bin", System.getenv("PATH") ?: "")
            .filter { it.isNotBlank() }
            .joinToString(File.pathSeparator),
    )
    environment("VITE_AGENTIC_ANDROID_APP", "true")
    environment("VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB", showExampleTab.toString())
    environment("VITE_AGENTIC_ANDROID_ALLOW_LAN_BRIDGE", allowLanBridge.toString())
    environment("VITE_AGENTIC_ANDROID_DEVICE_AGENT", deviceAgentEnabled.toString())
    environment("VITE_AGENTIC_ANDROID_STREAMING_SIGNER", streamingSignerEnabled.toString())
    environment("VITE_AGENTIC_DEVICE_AGENT", deviceAgentEnabled.toString())
    environment("VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST", deviceAgentWalletAllowlist)
    environment("VITE_AGENTIC_CLOUD_API_BASE_URL", cloudApiBaseUrl)
    environment("VITE_CAPACITOR_IOS_APP", "false")
    environment("VITE_AGENTIC_GA_MEASUREMENT_ID", gaMeasurementId)
}

val verifyBundledWebAssets = tasks.register<Exec>("verifyBundledWebAssets") {
    workingDir = rootProject.layout.projectDirectory.dir("../..").asFile
    commandLine(resolvedNodeCommand(), "scripts/verify-browser-dist.mjs")
    environment(
        "PATH",
        listOf("/usr/local/bin", "/opt/homebrew/bin", System.getenv("PATH") ?: "")
            .filter { it.isNotBlank() }
            .joinToString(File.pathSeparator),
    )
    dependsOn(buildBundledWebAssets)
}

val syncFilteredBundledWebAssets = tasks.register<Sync>("syncFilteredBundledWebAssets") {
    dependsOn(verifyBundledWebAssets)
    from(bundledWebDistDir)
    into(filteredBundledWebAssetsDir)
    exclude(
        "og/**",
        "**/*.bak",
    )
}

buildBundledWebAssets.configure {
    dependsOn(typecheckBundledWebAssets)
}

typecheckBundledWebAssets.configure {
    dependsOn(buildBundledWebAssetDependencies)
}

tasks.matching { task ->
    task.name.startsWith("merge") && task.name.endsWith("Assets")
}.configureEach {
    dependsOn(syncFilteredBundledWebAssets)
}

tasks.matching { task ->
    task.name.contains("LintVital", ignoreCase = true)
}.configureEach {
    dependsOn(syncFilteredBundledWebAssets)
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.0")
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.8")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // Firebase Analytics (Google Analytics for Firebase) — baseline native app analytics
    // (installs, app-opens, sessions, crashes). Advertising-ID collection is disabled via
    // AndroidManifest meta-data; the ad-id module is excluded so it is never pulled in
    // transitively, keeping the Play Data Safety disclosure minimal for a wallet app.
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-analytics") {
        exclude(group = "com.google.android.gms", module = "play-services-ads-identifier")
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
