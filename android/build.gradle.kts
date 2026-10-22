// 顶层构建脚本：只声明插件版本，不 apply。
// 版本矩阵固定，改之前先确认 CI（.github/workflows/android.yml）里的 JDK / Gradle 版本能对上。
plugins {
    id("com.android.application") version "8.5.2" apply false
}
