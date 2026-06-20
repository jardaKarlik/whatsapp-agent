from PIL import Image, ImageDraw, ImageFilter, ImageEnhance
import random, math, os

# SoundCloud recommended: at least 800x800, we use 2000x2000 for crispness
SIZE = 2000
img = Image.new("RGB", (SIZE, SIZE), "#0a0a0a")
draw = ImageDraw.Draw(img)

random.seed(42)

def noise_layer(width, height, alpha=30):
    """Generate a subtle noise overlay."""
    noise = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    nd = ImageDraw.Draw(noise)
    for _ in range(50000):
        x = random.randint(0, width - 1)
        y = random.randint(0, height - 1)
        gray = random.randint(0, 80)
        nd.point((x, y), fill=(gray, gray, gray, alpha))
    return noise

def radial_gradient(size, colors):
    """Draw a radial gradient from center."""
    im = Image.new("RGB", size)
    d = ImageDraw.Draw(im)
    cx, cy = size[0] // 2, size[1] // 2
    max_r = int(math.hypot(cx, cy))
    for r in range(max_r, 0, -5):
        ratio = r / max_r
        col = tuple(int(c1 * ratio + c2 * (1 - ratio)) for c1, c2 in zip(colors[0], colors[1]))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    return im

def draw_speaker(draw, x, y, w, h, color):
    """Draw a boxy speaker cabinet."""
    # Cabinet
    draw.rectangle([x, y, x + w, y + h], fill=color, outline=(20, 20, 20), width=4)
    # Woofer circles
    woofers = 2
    margin = w // 8
    woofer_w = (w - margin * 2) // woofers
    for i in range(woofers):
        cx = x + margin + woofer_w // 2 + i * (woofer_w + margin // 2)
        cy = y + h // 2
        r = min(woofer_w, h // 2) // 2 - 8
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(10, 10, 10), outline=(40, 40, 40), width=3)
        # Cone
        draw.ellipse([cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2], fill=(5, 5, 5))

def draw_stack(draw, x, y, width, height, base_color):
    """Draw a stack of speakers."""
    # Base / scaffold
    draw.rectangle([x - 10, y + height - 20, x + width + 10, y + height], fill="#1a1a1a")
    # 3 tiers
    tiers = 3
    tier_h = height // tiers
    for i in range(tiers):
        ty = y + i * tier_h
        # Slight darkening for lower tiers
        darken = int(40 * (tiers - 1 - i) / tiers)
        c = tuple(max(0, v - darken) for v in base_color)
        draw_speaker(draw, x, ty, width, tier_h - 4, c)

def draw_dancer(draw, cx, cy, scale, color):
    """Draw a rough silhouette of a dancing person using simple shapes."""
    # Head
    r = int(12 * scale)
    draw.ellipse([cx - r, cy - int(40 * scale) - r, cx + r, cy - int(40 * scale) + r], fill=color)
    # Body line
    draw.line([cx, cy - int(28 * scale), cx, cy + int(10 * scale)], fill=color, width=int(6 * scale))
    # Arms (raised)
    arm_len = int(25 * scale)
    draw.line([cx, cy - int(20 * scale), cx - arm_len, cy - int(45 * scale)], fill=color, width=int(4 * scale))
    draw.line([cx, cy - int(20 * scale), cx + arm_len, cy - int(10 * scale)], fill=color, width=int(4 * scale))
    # Legs
    leg_len = int(30 * scale)
    draw.line([cx, cy + int(10 * scale), cx - int(10 * scale), cy + int(10 * scale) + leg_len], fill=color, width=int(5 * scale))
    draw.line([cx, cy + int(10 * scale), cx + int(10 * scale), cy + int(10 * scale) + leg_len], fill=color, width=int(5 * scale))

# Background radial gradient: dark teal/green to near-black
bg = radial_gradient((SIZE, SIZE), ((10, 40, 30), (5, 5, 5)))
img = Image.blend(img, bg, 0.6)

# Ground / floor glow
draw = ImageDraw.Draw(img)
draw.ellipse([SIZE * 0.2, SIZE * 0.75, SIZE * 0.8, SIZE * 1.0], fill=(20, 80, 60))

# Soundsystem stack in center
stack_w = int(SIZE * 0.35)
stack_h = int(SIZE * 0.45)
stack_x = (SIZE - stack_w) // 2
stack_y = int(SIZE * 0.45)
base_color = (50, 60, 55)
draw_stack(draw, stack_x, stack_y, stack_w, stack_h, base_color)

# Additional smaller stacks on sides
side_stack_w = int(stack_w * 0.6)
side_stack_h = int(stack_h * 0.7)
draw_stack(draw, int(SIZE * 0.12), int(SIZE * 0.55), side_stack_w, side_stack_h, (45, 55, 50))
draw_stack(draw, int(SIZE * 0.78), int(SIZE * 0.55), side_stack_w, side_stack_h, (45, 55, 50))

# Light beams from top (yellow-green neon)
beam_color = (180, 255, 80)
for angle in range(-40, 41, 20):
    rad = math.radians(angle - 90)
    x1 = SIZE // 2
    y1 = int(SIZE * 0.05)
    length = int(SIZE * 0.6)
    x2 = int(x1 + length * math.cos(rad))
    y2 = int(y1 + length * math.sin(rad))
    draw.line([x1, y1, x2, y2], fill=beam_color, width=8)

# Draw crowd silhouettes in front
num_dancers = 18
dancer_color = (5, 5, 5)
for i in range(num_dancers):
    # Spread across bottom
    cx = int(SIZE * 0.08 + (SIZE * 0.84) * (i / max(1, num_dancers - 1)))
    # Add jitter
    cx += random.randint(-30, 30)
    cy = int(SIZE * 0.82 + random.randint(-20, 40))
    scale = random.uniform(0.8, 1.4)
    # Vary color slightly for depth
    dc = tuple(min(255, max(0, c + random.randint(-10, 10))) for c in dancer_color)
    draw_dancer(draw, cx, cy, scale, dc)

# Add subtle noise overlay
noise = noise_layer(SIZE, SIZE, alpha=25)
img = Image.alpha_composite(img.convert("RGBA"), noise).convert("RGB")

# Slight contrast boost
enhancer = ImageEnhance.Contrast(img)
img = enhancer.enhance(1.15)

# Optional slight vignette
vignette = Image.new("L", (SIZE, SIZE), 0)
vd = ImageDraw.Draw(vignette)
vd.ellipse([SIZE * 0.05, SIZE * 0.05, SIZE * 0.95, SIZE * 0.95], fill=180)
vignette = vignette.filter(ImageFilter.GaussianBlur(radius=200))
img = Image.composite(img, Image.new("RGB", (SIZE, SIZE), (0, 0, 0)), vignette)

# Save final
out_path = "c:\\_dev\\whatsapp-agent\\hardtek_thumbnail.jpg"
img.save(out_path, "JPEG", quality=95)
print(f"Saved thumbnail to: {out_path} ({SIZE}x{SIZE}px)")
