plugins {
    id("com.android.application")
}

android {
    namespace = "cn.photocoach.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.photocoach.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // 线上地址写死在这里（含 sharecode）。改地址时三处要同步：
        //   1. 本文件 APP_URL
        //   2. public/manifest.webmanifest 的 start_url
        //   3. AGENTS.md §9.3
        buildConfigField(
            "String",
            "APP_URL",
            "\"https://photo-coach-01631.app.workbuddy.host/?sharecode=KW332RH4SO\""
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
