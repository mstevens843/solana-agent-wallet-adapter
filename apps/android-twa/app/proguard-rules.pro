-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,*Annotation*

# WebView JavaScript bridge methods are looked up by name at runtime.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Kotlin metadata available for libraries that inspect Kotlin declarations.
-keep class kotlin.Metadata { *; }
