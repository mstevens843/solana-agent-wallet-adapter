-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,*Annotation*

# Compact optimized release DEX output. AGP 9.1 enables this by default for apps;
# keep it explicit here while the project stays on the lower-risk AGP 8.x line.
-repackageclasses

# WebView JavaScript bridge methods are looked up by name at runtime.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Kotlin metadata available for libraries that inspect Kotlin declarations.
-keep class kotlin.Metadata { *; }

# Firebase Analytics keeps optional Advertising ID lookups, but this wallet app
# intentionally excludes the ads identifier module from release artifacts.
-dontwarn com.google.android.gms.ads.identifier.AdvertisingIdClient$Info
-dontwarn com.google.android.gms.ads.identifier.AdvertisingIdClient
