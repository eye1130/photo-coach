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
        versionCode = 2
        versionName = "1.1.0"

        // 线上地址写死在这里。改地址时三处要同步：
        //   1. 本文件 APP_URL
        //   2. public/manifest.webmanifest 的 start_url
        //   3. MainActivity.java 的 APP_HOST（只填 host，不含协议和路径）
        //
        // ⚠️ 2026-10-23 实测：发布平台**每次部署都会换一个新域名**，旧域名立刻 400。
        // 所以这个字段的有效期只到下一次部署为止 —— 重新发布后必须同步改这里、
        // 重新出包、用户重装。长期方案是把网页打进 APK 的 assets（见 AGENTS.md §14.8），
        // 彻底摆脱域名依赖。
        buildConfigField(
            "String",
            "APP_URL",
            "\"https://2e6d73676aed42759e5e88229b9d0269.sg.agentos-app.run\""
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
