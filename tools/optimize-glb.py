#!/usr/bin/env python3
"""Shrinks the textures inside .glb models (e.g. from Modly: 4096 x 4096 PNG) to a size that
suits a stream overlay, re-encoded as JPEG. Geometry, skeleton and materials stay as they are.

    python3 tools/optimize-glb.py games/chess/models/*.glb            # 1024 px, in place
    python3 tools/optimize-glb.py --size 2048 --out dist/ model.glb

Needs Pillow (pip install pillow). A 4096 texture costs 64 MB of graphics memory once loaded;
1024 costs 4 MB and looks the same at board size.
"""
import argparse, io, json, os, struct, sys
from PIL import Image

def align4(n): return (n + 3) & ~3

def optimize(path, out, size, quality):
    data = open(path, 'rb').read()
    magic, version, _ = struct.unpack('<4sII', data[:12])
    if magic != b'glTF' or version != 2: raise SystemExit(f'{path}: not a glTF 2 binary')
    jlen, jtype = struct.unpack('<I4s', data[12:20])
    gltf = json.loads(data[20:20 + jlen])
    off = 20 + jlen
    blen, btype = struct.unpack('<I4s', data[off:off + 8])
    binary = data[off + 8:off + 8 + blen]

    views = gltf.get('bufferViews', [])
    chunks = [binary[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']] for v in views]
    changed = 0
    for img in gltf.get('images', []):
        if 'bufferView' not in img: continue
        i = img['bufferView']
        pic = Image.open(io.BytesIO(chunks[i]))
        if max(pic.size) <= size and img.get('mimeType') == 'image/jpeg': continue
        pic = pic.convert('RGB')
        if max(pic.size) > size: pic = pic.resize((size, size * pic.size[1] // pic.size[0]), Image.LANCZOS)
        buf = io.BytesIO()
        pic.save(buf, 'JPEG', quality=quality, optimize=True)
        chunks[i] = buf.getvalue()
        img['mimeType'] = 'image/jpeg'
        changed += 1

    # Rebuild the binary chunk: every buffer view 4-byte aligned, in the original order.
    out_bin = bytearray()
    for v, c in zip(views, chunks):
        out_bin += b'\0' * (align4(len(out_bin)) - len(out_bin))
        v['byteOffset'] = len(out_bin)
        v['byteLength'] = len(c)
        out_bin += c
    out_bin += b'\0' * (align4(len(out_bin)) - len(out_bin))
    gltf['buffers'][0]['byteLength'] = len(out_bin)
    gltf.setdefault('asset', {})['generator'] = (gltf['asset'].get('generator', '') + ' + optimize-glb').strip()

    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (align4(len(js)) - len(js))
    total = 12 + 8 + len(js) + 8 + len(out_bin)
    blob = struct.pack('<4sII', b'glTF', 2, total) + struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(out_bin), b'BIN\0') + bytes(out_bin)
    open(out, 'wb').write(blob)
    return changed, len(data), len(blob)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--quality', type=int, default=88)
    ap.add_argument('--out', default=None, help='folder for the results (default: replace the files)')
    a = ap.parse_args()
    for f in a.files:
        out = os.path.join(a.out, os.path.basename(f)) if a.out else f
        if a.out: os.makedirs(a.out, exist_ok=True)
        n, before, after = optimize(f, out, a.size, a.quality)
        print(f'{f}: {n} texture(s) shrunk, {before // 1024} KB -> {after // 1024} KB')

if __name__ == '__main__':
    sys.exit(main())
