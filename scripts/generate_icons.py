#!/usr/bin/env python3
"""从主 PNG 生成 Windows、macOS 与 Linux 图标资源。"""

from pathlib import Path
from shutil import copyfile

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
SOURCE_ICON = BUILD / "icon-source.png"
SOURCE_MAC_ICON = BUILD / "icon-source.icns"


def main() -> None:
    if not SOURCE_ICON.is_file() or not SOURCE_MAC_ICON.is_file():
        raise FileNotFoundError(f"缺少主图标源文件：{SOURCE_ICON} / {SOURCE_MAC_ICON}")

    # 只维护一个高分辨率源文件，其他格式全部机械生成，避免不同平台再次出现图案不一致。
    with Image.open(SOURCE_ICON) as source:
        icon = source.convert("RGBA")

    resampling = getattr(Image, "Resampling", Image)
    icon_512 = icon.resize((512, 512), resampling.LANCZOS)
    icon_512.save(BUILD / "icon.png", optimize=True)
    icon_512.save(
        BUILD / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    # Linux 上的 Pillow 不一定带 ICNS 写入器，因此保留同源的正式 ICNS，生成时直接复制。
    copyfile(SOURCE_MAC_ICON, BUILD / "icon.icns")


if __name__ == "__main__":
    main()
