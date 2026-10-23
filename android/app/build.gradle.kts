plugins {
    id("com.android.application")
}

android {
    namespace = "cn.photocoach.app"
    compileSdk = 34

    defaultConfig {
        // 实验分支专用：改成独立包名，让验证版能和正式版**共存**。
        //
        // 原因：CI 每次构建用的 ~/.android/debug.keystore 是 runner 上临时生成的，
        // 每次的签名指纹都不一样（实测 51d48957… 和 78e40185…），
        // 所以同一个包名的两个 APK 无法覆盖安装，只能卸载重装。
        // 改包名后两个 App 互不干扰，测完直接卸载验证版即可，正式版一直保留。
        //
        // ⚠️ 合并回 main 前必须改回 "cn.photocoach.app"。
        applicationId = "cn.photocoach.app.probe"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "1.2.0"

        // 线上地址写死在这里。改地址时两处要同步：
        //   1. 本文件 APP_URL
        //   2. MainActivity.java 的 APP_HOST（只填 host，不含协议和路径）
        //
        // 2026-10-23 起改为自有域名（华为云 ECS + Let's Encrypt），地址**固定不变**。
        // 之前用的托管平台每次部署都换域名，导致改一次网页就得重出一次 APK；
        // 现在网页更新只需在服务器上跑 deploy/update.sh，APK 不用动。
        // 详见 AGENTS.md §14.8 与 deploy/README.md。
        buildConfigField(
            "String",
            "APP_URL",
            "\"https://photo.galois1130.site/\""
        )
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            // CI 用 Android SDK 自带的 debug.keystore 签名，跨机器一致，
            // 因此后续新版本可以直接覆盖安装，不需要先卸载。
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // 目前只产出可侧载的包，没有上架计划，release 也用 debug 签名，
            // 避免在仓库/Secrets 里维护正式密钥。真要上架时再换成正式 keystore。
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // 壳工程只有一个 Activity，lint 不阻断 CI。
        abortOnError = false
    }
}

// 刻意没有任何依赖：不用 androidx / appcompat / kotlin-stdlib。
// 好处是 CI 只需要 AGP 一个插件，构建失败面最小；代价是不能用 ViewBinding 之类，
// 但本工程总共一个 Activity + 一个 WebView，手写足够。
dependencies {}
