# Firebase / Firestore (usa reflection para (de)serializar mapas dinamicos)
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**

# MLKit barcode scanning (mobile_scanner)
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# Play Core (deferred components de Flutter, evita warning de R8 aunque no se use Play Store split install)
-dontwarn com.google.android.play.core.**

# sqflite / bluetooth: JNI, no ofuscar nombres de metodos nativos
-keepclasseswithmembernames class * {
    native <methods>;
}

# Nuestros modelos hacen (de)serializacion JSON manual, no con reflection --
# no se necesitan reglas -keep adicionales para lib/.
