-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,*Annotation*

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
