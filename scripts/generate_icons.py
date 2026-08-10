#!/usr/bin/env python3
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"


def create_icon(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    scale = size / 512

    # 使用简单的深绿底和四根流量柱，保证缩小到任务栏尺寸后仍然容易识别。
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(112 * scale), fill="#173528")
    bars = [(112, 236, 172, 346), (198, 122, 258, 346), (284, 164, 344, 346), (370, 228, 430, 346)]
    for left, top, right, bottom in bars:
        draw.rounded_rectangle(
            tuple(int(value * scale) for value in (left, top, right, bottom)),
            radius=max(2, int(10 * scale)),
            fill="#D7EF74",
        )
    draw.line(
        tuple(int(value * scale) for value in (104, 374, 408, 374)),
        fill="#FFFFFF",
        width=max(2, int(20 * scale)),
    )
    return image


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    icon = create_icon(512)
    icon.save(BUILD / "icon.png", optimize=True)
    icon.save(BUILD / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # macOS 的 ICNS 应包含高分辨率源图，避免在 Retina 屏幕和 Dock 中显示模糊。
    mac_icon = create_icon(1024)
    mac_icon.save(BUILD / "icon.icns", format="ICNS")


if __name__ == "__main__":
    main()
