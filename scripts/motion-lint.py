"""Keep the stylesheets to the motion rules.

Every CSS transition may animate only transform and opacity, must finish
within 240 ms, and uses the shared easing (--ease). Colour, background, size
and spacing changes happen instantly instead: they cost a repaint or a
relayout on every frame, and on hover an instant change reads as crisper
anyway.

    python scripts/motion-lint.py          report what breaks the rules
    python scripts/motion-lint.py --fix    rewrite the stylesheets in place
"""
import glob
import re
import sys

FILES = ['src/App.css'] + sorted(glob.glob('src/styles/*.css'))
ALLOWED = ('transform', 'opacity')
MAX_SECONDS = 0.24


def split_top_level(value):
    parts, depth, current = [], 0, ''
    for char in value:
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
        if char == ',' and depth == 0:
            parts.append(current)
            current = ''
        else:
            current += char
    parts.append(current)
    return [part.strip() for part in parts if part.strip()]


def seconds(token):
    return float(token[:-2]) / 1000 if token.endswith('ms') else float(token[:-1])


def rewrite(value):
    important = '!important' in value
    value = value.replace('!important', '').strip()
    result = _rewrite(value)
    return f'{result} !important' if important else result


def _rewrite(value):
    kept = []
    for part in split_top_level(value):
        tokens = re.findall(r'cubic-bezier\([^)]*\)|var\([^)]*\)|\S+', part)
        prop = tokens[0]
        if prop == 'none':
            return 'none'
        props = list(ALLOWED) if prop == 'all' else [prop] if prop in ALLOWED else []
        times = [t for t in tokens[1:] if re.fullmatch(r'[\d.]+m?s', t)]
        duration = min(seconds(times[0]), MAX_SECONDS) if times else 0.18
        delay = f' {times[1]}' if len(times) > 1 else ''
        for name in props:
            kept.append(f'{name} {round(duration * 1000)}ms var(--ease){delay}')
    return ', '.join(kept) if kept else 'none'


def main(fix):
    broken = 0
    for path in FILES:
        text = open(path, encoding='utf-8', newline='').read()

        def replace(match):
            nonlocal broken
            new = rewrite(match.group(2))
            if new.replace(' ', '') != match.group(2).replace(' ', ''):
                broken += 1
                if not fix:
                    print(f'{path}: transition: {match.group(2).strip()}  ->  {new}')
            return match.group(1) + new

        updated = re.sub(r'(transition\s*:\s*)([^;}]+)', replace, text)
        if fix and updated != text:
            open(path, 'w', encoding='utf-8', newline='').write(updated)
    print(f'{broken} transition(s) {"rewritten" if fix else "break the rules"}')
    return broken


if __name__ == '__main__':
    count = main('--fix' in sys.argv)
    sys.exit(1 if count and '--fix' not in sys.argv else 0)
