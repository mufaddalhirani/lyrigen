"""A demo library for screenshots: made-up artists and songs, generated music,
original lyrics, and covers from public-domain works in The Met's Open Access
collection (CC0). Nothing copyrighted, nothing from anyone's own library.

    python scripts/make-demo-library.py "C:/Users/Public/Music/Lyrigen Demo"
    node scripts/readme-shots.mjs "C:/Users/Public/Music/Lyrigen Demo"

Needs ffmpeg on PATH (or set FFMPEG) and Pillow.
"""
import io
import json
import os
import subprocess
import sys
import urllib.request

from PIL import Image

FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
HEADERS = {'User-Agent': 'Mozilla/5.0 (Lyrigen demo library)'}

# artist, album, genre, Met object id for the cover, [(title, bpm)]
ALBUMS = [
    ('Marlowe Hart', 'Afterglow', 'Synthpop', 436528, [('Glass Horizon', 118), ('Paper Planets', 118), ('Signal Bloom', 122)]),  # van Gogh, Irises
    ('The Low Tides', 'Salt & Signal', 'Indie', 45434, [('Low Tide Radio', 104), ('Satellite Heart', 124)]),  # Hokusai, The Great Wave
    ('Parade', 'Night Shift', 'Electronic', 437654, [('Midnight Arcade', 128), ('Soft Machinery', 96)]),  # Seurat, Circus Sideshow
    ('Field Notes', 'Sunroom', 'Lo-fi', 436535, [('Golden Hour Loop', 84), ('Cloud Cartography', 90)]),  # van Gogh, Wheat Field with Cypresses
]

LYRICS = {
    'Glass Horizon': [
        'we were drawing lines across the glass horizon', 'counting every light the city left on',
        'hold the frame a little longer', 'let the colours run',
        'every signal fading into morning', 'every echo finds its way back home',
        'we were drawing lines across the glass horizon', 'and the night was ours alone',
    ],
    'Low Tide Radio': [
        'static on the low tide radio', 'someone singing where the ferries go',
        'salt in the speakers and a slow hello', 'turn it up and let the harbour know',
    ],
    'Midnight Arcade': [
        'insert a coin and the lights come alive', 'high score glowing on a screen at five',
        'we never lose when we play it slow', 'midnight arcade is the only place we go',
    ],
}


def cover(path, object_id):
    """A public-domain artwork from The Met, cropped square."""
    request = urllib.request.Request(f'https://collectionapi.metmuseum.org/public/collection/v1/objects/{object_id}', headers=HEADERS)
    meta = json.load(urllib.request.urlopen(request))
    if not meta.get('isPublicDomain'):
        raise SystemExit(f'Met object {object_id} is not public domain')
    image = Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(meta['primaryImageSmall'], headers=HEADERS)).read())).convert('RGB')
    side = min(image.size)
    left, top = (image.width - side) // 2, (image.height - side) // 2
    image.crop((left, top, left + side, top + side)).resize((900, 900), Image.LANCZOS).save(path, quality=90)


def ttml(lines, bpm):
    """Word-timed TTML: a line every two bars, with an instrumental break after line four."""
    beat = 60 / bpm
    body, t = [], beat * 8
    for number, line in enumerate(lines, 1):
        words = line.split()
        span = beat * 7
        step = span / len(words)
        spans = ' '.join(f'<span begin="{t + i * step:.3f}" end="{t + (i + 1) * step - 0.05:.3f}">{word}</span>' for i, word in enumerate(words))
        body.append(f'<p begin="{t:.3f}" end="{t + span:.3f}" itunes:key="L{number}">{spans}</p>')
        t += beat * 8 * (2 if number == 4 else 1)
    return ('<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word">'
            '<body><div>' + ''.join(body) + '</div></body></tt>')


def song(path, bpm, key, seed, tags, seconds=96):
    """A kick on every beat, off-beat hats, a pad that moves every bar, and a bass pulse."""
    beat = 60 / bpm
    shift = f'(1+0.125*floor(mod(t/{beat * 4},4)))'
    expr = (f'0.55*sin(2*PI*52*t)*exp(-14*mod(t,{beat}))'
            f'+0.06*(random({seed})*2-1)*exp(-45*mod(t+{beat / 2},{beat}))'
            f'+0.07*(sin(2*PI*{key}*{shift}*t)+sin(2*PI*{key * 1.26}*{shift}*t)+sin(2*PI*{key * 1.5}*{shift}*t))'
            f'+0.18*sin(2*PI*{key / 4}*{shift}*t)*(0.6+0.4*exp(-6*mod(t,{beat})))')
    metadata = [arg for key_, value in tags.items() for arg in ('-metadata', f'{key_}={value}')]
    subprocess.run([FFMPEG, '-y', '-v', 'error', '-f', 'lavfi', '-i', f"aevalsrc='{expr}':s=48000:d={seconds}", '-ac', '2',
                    '-af', f'afade=t=in:d=2,afade=t=out:st={seconds - 4}:d=4,alimiter=limit=0.9',
                    *metadata, '-c:a', 'libopus', '-b:a', '160k', path], check=True)


def main(root):
    for index, (artist, album, genre, cover_id, tracks) in enumerate(ALBUMS):
        folder = os.path.join(root, artist, album)
        os.makedirs(folder, exist_ok=True)
        cover(os.path.join(folder, 'cover.jpg'), cover_id)
        for number, (title, bpm) in enumerate(tracks, 1):
            target = os.path.join(folder, f'{artist} - {title}.opus')
            song(target, bpm, [196, 220, 247, 262, 294][(index + number) % 5], index * 10 + number,
                 {'title': title, 'artist': artist, 'album': album, 'genre': genre, 'track': number, 'date': 2026})
            if title in LYRICS:
                with open(os.path.splitext(target)[0] + '.ttml', 'w', encoding='utf-8') as handle:
                    handle.write(ttml(LYRICS[title], bpm))
            print('made', target)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
