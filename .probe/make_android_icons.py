"""
生成 Android 启动图标（mipmap 各密度 + 自适应图标前景）。

源图：public/icons/icon-512.png（深色圆角底 + 青色取景框火柴人，与网页 favicon 同款）

产出：
  android/app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png
  android/app/src/main/res/mipmap-{...}/ic_launcher_round.png        （圆形裁切，API 25 及以下用）
  android/app/src/main/res/mipmap-{...}/ic_launcher_foreground.png   （自适应图标前景，108dp 基准）
  android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
  android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml

为什么前景要缩到 62%：自适应图标有 66/108 的安全区，超出部分会被各家启动器
按自己的形状裁掉。把内容压进安全区里，圆/方/水滴三种形状都不会切到火柴人。

用法：
  python .probe/make_android_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "icons" / "icon-512.png"
RES = ROOT / "android" / "app" / "src" / "main" / "res"

# 传统图标边长（dp）→ 目录名
LEGACY = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

# 自适应图标前景画布边长（dp）= 108
FOREGROUND = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}

# 前景内容占画布的比例（安全区 66/108 ≈ 0.61，取 0.60 留一点余量）
CONTENT_RATIO = 0.60

ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/appBackground" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""


def circular(img: Image.Image) -> Image.Image:
    """把方形图标裁成圆形，边缘做抗锯齿。"""
    size = img.size[0]
    # 4 倍超采样再缩回去，圆边才不会毛刺
    scale = 4
    mask = Image.new("L", (size * scale, size * scale), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size * scale - 1, size * scale - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"源图不存在：{SRC}")

    src = Image.open(SRC).convert("RGBA")

    for density, size in LEGACY.items():
        out_dir = RES / f"mipmap-{density}"
        out_dir.mkdir(parents=True, exist_ok=True)

        square = src.resize((size, size), Image.LANCZOS)
        square.save(out_dir / "ic_launcher.png")
        circular(square).save(out_dir / "ic_launcher_round.png")

    for density, canvas in FOREGROUND.items():
        out_dir = RES / f"mipmap-{density}"
        out_dir.mkdir(parents=True, exist_ok=True)

        inner = max(1, round(canvas * CONTENT_RATIO))
        scaled = src.resize((inner, inner), Image.LANCZOS)

        foreground = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        offset = (canvas - inner) // 2
        foreground.paste(scaled, (offset, offset), scaled)
        foreground.save(out_dir / "ic_launcher_foreground.png")

    anydpi = RES / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    (anydpi / "ic_launcher.xml").write_text(ADAPTIVE_XML, encoding="utf-8")
    (anydpi / "ic_launcher_round.xml").write_text(ADAPTIVE_XML, encoding="utf-8")

    print("已生成：")
    for path in sorted(RES.glob("mipmap-*/ic_launcher*.png")):
        print(f"  {path.relative_to(ROOT)}  {path.stat().st_size} B")
    for path in sorted(anydpi.glob("*.xml")):
        print(f"  {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
