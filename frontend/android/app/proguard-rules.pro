# ── Capacitor core ──────────────────────────────────────────────────────────
-keep class com.getcapacitor.** { *; }
-keepclassmembers class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep @com.getcapacitor.annotation.Permission class * { *; }

# ── Capacitor plugins used by MicoPay ────────────────────────────────────────
# Secure Storage (@aparajita/capacitor-secure-storage)
-keep class com.aparajita.capacitor.securestorage.** { *; }

# Barcode Scanning (@capacitor-mlkit/barcode-scanning)
-keep class io.capawesome.capacitorjs.plugins.mlkit.barcodescanning.** { *; }
# MLKit barcode — keep model classes
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_barcode.** { *; }

# Geolocation (@capacitor/geolocation)
-keep class com.getcapacitor.plugin.geolocation.** { *; }

# Status Bar (@capacitor/status-bar)
-keep class com.getcapacitor.plugin.statusbar.** { *; }

# App plugin (@capacitor/app)
-keep class com.getcapacitor.plugin.app.** { *; }

# ── WebView / JS bridge ───────────────────────────────────────────────────────
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── AndroidX / support ───────────────────────────────────────────────────────
-keep class androidx.core.app.CoreComponentFactory { *; }

# ── Reflection & serialization safety ────────────────────────────────────────
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes Exceptions
-keepattributes EnclosingMethod
-keepattributes InnerClasses

# ── Stack traces (keep for crash reporting) ───────────────────────────────────
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ── Gson / JSON (if used anywhere) ───────────────────────────────────────────
-keepclassmembers,allowobfuscation class * {
    @com.google.gson.annotations.SerializedName <fields>;
}