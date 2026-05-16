import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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
    ?: "https://agenticwalletadapter.com/#app"
val launchUri = uri(launchUrl)
val launchScheme = launchUri.scheme ?: "https"
val launchHost = propertyOrEnv("AGENTIC_ANDROID_HOST")
    ?: propertyOrEnv("agenticHost")
    ?: launchUri.host
    ?: "agenticwalletadapter.com"
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
    false,
)
val deviceAgentWalletAllowlist = propertyOrEnv("AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST")
    ?: "4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w"
val cloudApiBaseUrl = propertyOrEnv("AGENTIC_ANDROID_CLOUD_API_BASE_URL")
    ?: propertyOrEnv("AGENTIC_CLOUD_API_BASE_URL")
    ?: "https://agentic-signer.com"
val cloudApiUri = uri(cloudApiBaseUrl)
val localLaunchHosts = setOf("localhost", "127.0.0.1", "0.0.0.0", "::1")

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
        minSdk = 24
        targetSdk = 35
        versionCode = parsedVersionCode
        versionName = appVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        manifestPlaceholders["agenticScheme"] = launchScheme
        manifestPlaceholders["agenticHost"] = launchHost
        manifestPlaceholders["agenticWebFallbackEnabled"] = enableWebFallback.toString()
        manifestPlaceholders["usesCleartextTraffic"] = (usesCleartext || allowLanBridge).toString()
        manifestPlaceholders["agenticDeviceAgentEnabled"] = deviceAgentEnabled.toString()

        buildConfigField("String", "AGENTIC_LAUNCH_URL", "\"${launchUrl.replace("\"", "\\\"")}\"")
        buildConfigField("String", "AGENTIC_LAUNCH_SCHEME", "\"${launchScheme.replace("\"", "\\\"")}\"")
        buildConfigField("String", "AGENTIC_LAUNCH_HOST", "\"${launchHost.replace("\"", "\\\"")}\"")
        buildConfigField("int", "AGENTIC_LAUNCH_PORT", launchPort.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_SHOW_EXAMPLE_TAB", showExampleTab.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_ENABLE_WEB_FALLBACK", enableWebFallback.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_ALLOW_LAN_BRIDGE", allowLanBridge.toString())
        buildConfigField("boolean", "AGENTIC_ANDROID_DEVICE_AGENT", deviceAgentEnabled.toString())
        buildConfigField("String", "AGENTIC_ANDROID_CLOUD_API_BASE_URL", "\"${cloudApiBaseUrl.replace("\"", "\\\"")}\"")
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
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(rootProject.layout.projectDirectory.dir("../browser-demo/dist"))
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
    environment("VITE_AGENTIC_DEVICE_AGENT", deviceAgentEnabled.toString())
    environment("VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST", deviceAgentWalletAllowlist)
    environment("VITE_AGENTIC_CLOUD_API_BASE_URL", cloudApiBaseUrl)
    environment("VITE_CAPACITOR_IOS_APP", "false")
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
    environment("VITE_AGENTIC_DEVICE_AGENT", deviceAgentEnabled.toString())
    environment("VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST", deviceAgentWalletAllowlist)
    environment("VITE_AGENTIC_CLOUD_API_BASE_URL", cloudApiBaseUrl)
    environment("VITE_CAPACITOR_IOS_APP", "false")
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

buildBundledWebAssets.configure {
    dependsOn(typecheckBundledWebAssets)
}

typecheckBundledWebAssets.configure {
    dependsOn(buildBundledWebAssetDependencies)
}

tasks.matching { task ->
    task.name.startsWith("merge") && task.name.endsWith("Assets")
}.configureEach {
    dependsOn(verifyBundledWebAssets)
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.0")
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.8")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
