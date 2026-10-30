"""Render the project's original geometric meter mark (requires Pillow).

Run from a checkout: python scripts/render_brand_icon.py
Only brand PNG files are written; this script is not integration runtime code.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BRAND = Path(__file__).resolve().parents[1] / "custom_components/appliance_meter/brand"


def render(size):
    """Use vector-style primitives and supersampling; no fonts or external art."""
    scale = size * 4 / 256
    image = Image.new("RGBA", (size * 4, size * 4))
    drawing = ImageDraw.Draw(image)

    def box(bounds):
        return tuple(round(value * scale) for value in bounds)

    # Meter enclosure fills the square; only the outer rounded corners are clear.
    drawing.rounded_rectangle(box((0, 0, 256, 256)), radius=round(40 * scale),
                              fill="#126878")
    drawing.rounded_rectangle(box((40, 36, 216, 142)), radius=round(14 * scale),
                              fill="#FFFFFF")
    # Consumption chart inside the display.
    for bounds in ((62, 99, 84, 120), (101, 77, 123, 120), (140, 55, 162, 120)):
        drawing.rounded_rectangle(box(bounds), radius=round(3 * scale),
                                  fill="#126878")
    # Electrical energy symbol, drawn specifically for this project.
    drawing.polygon(
        [(round(x * scale), round(y * scale)) for x, y in
         ((135, 155), (100, 199), (124, 199), (115, 236),
          (163, 182), (137, 182), (149, 155))],
        fill="#FFD35A",
    )
    return image.resize((size, size), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    BRAND.mkdir(parents=True, exist_ok=True)
    for size, filename in ((256, "icon.png"), (512, "icon@2x.png")):
        render(size).save(BRAND / filename, optimize=True)
        print(BRAND / filename)
