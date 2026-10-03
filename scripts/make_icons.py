#!/usr/bin/env python3
"""Generate extension icons (pure stdlib — no Pillow needed).

Draws a 3D diagonal capsule: dark-blue half + white half, cylindrical shading,
specular highlight and a soft navy rim, on a transparent background.
"""
import math, struct, zlib, os

def clamp(x, a, b):
    return max(a, min(b, x))

def render(size):
    s = size
    cx = cy = s / 2.0
    ang = math.radians(-40)          # diagonal, bottom-left -> top-right
    dx, dy = math.cos(ang), math.sin(ang)
    px, py = -dy, dx                 # perpendicular (positive = lower-right side)
    L = 0.24 * s                     # half length of the axis segment
    R = 0.165 * s                    # capsule radius

    rows = []
    for y in range(s):
        row = bytearray(b'\x00')
        for x in range(s):
            vx, vy = x + 0.5 - cx, y + 0.5 - cy
            u = vx * dx + vy * dy
            w = vx * px + vy * py
            du = clamp(u, -L, L)
            dist = math.hypot(u - du, w)
            aa = clamp((R + 0.75 - dist) / 1.5, 0.0, 1.0)
            if aa <= 0.01:
                row += bytes((0, 0, 0, 0))
                continue

            t = clamp(w / R, -1.0, 1.0)          # -1 top .. 1 bottom
            f = 1.16 - 0.52 * (t + 1.0) / 2.0    # light from above
            spec = math.exp(-((t + 0.55) / 0.22) ** 2) * 0.55
            tip = (u + L) / (2.0 * L) if u < 0 else 1.0  # blue gradient toward tail

            if u < 0:  # dark-blue half
                base = [47 + (10 - 47) * (1 - tip) * 0.8,
                        107 + (42 - 107) * (1 - tip) * 0.8,
                        255 + (120 - 255) * (1 - tip) * 0.8]
                white = 0.25
            else:      # white half
                base = [235, 243, 255]
                white = 0.9

            r, g, b = [c * f for c in base]
            r += spec * 255 * (1.0 if u >= 0 else white)
            g += spec * 255 * (1.0 if u >= 0 else white)
            b += spec * 255 * (1.0 if u >= 0 else white)

            # soft navy rim on the bottom edge
            if t > 0.78:
                k = (t - 0.78) / 0.22
                r = r * (1 - k) + 10 * k
                g = g * (1 - k) + 42 * k
                b = b * (1 - k) + 107 * k

            row += bytes((clamp(round(r), 0, 255), clamp(round(g), 0, 255),
                          clamp(round(b), 0, 255), round(aa * 255)))
        rows.append(bytes(row))
    return b''.join(rows)

def png(path, size):
    raw = render(size)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    print(f'wrote {path} ({size}x{size})')

for s in (16, 48, 128):
    png(f'public/icons/icon{s}.png', s)
