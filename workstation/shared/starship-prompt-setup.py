#!/usr/bin/env python3
"""Merge prompt-owned keys without rewriting unrelated TOML text (Python 3.11+)."""
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
import tomllib


def merge(source, template):
    original = tomllib.loads(source)
    desired = tomllib.loads(template)
    # Parse whole statements, including multiline strings/arrays. Fail closed on
    # exotic key/table spelling rather than risk damaging someone's dotfiles.
    def statements(text):
        pending = ''
        for line in text.splitlines(keepends=True):
            pending += line
            try:
                tomllib.loads(pending)
            except tomllib.TOMLDecodeError:
                continue
            yield pending
            pending = ''
        if pending:
            raise ValueError('Incomplete TOML statement')

    replacements = {}
    section = ''
    for statement in statements(template):
        header = re.match(r'^\[([\w-]+)\]', statement)
        if header:
            section = header[1]
        elif '=' in statement and not statement.lstrip().startswith('#'):
            replacements[section, statement.split('=', 1)[0].strip()] = statement
    remaining = dict(replacements)
    output = []
    section = ''

    def flush():
        for pair in list(remaining):
            if pair[0] == section:
                output.append(remaining.pop(pair))

    seen = {''}
    for statement in statements(source):
        stripped = statement.lstrip()
        if stripped.startswith('['):
            flush()
            header = re.fullmatch(r'\[([\w-]+)\]\s*(?:#[^\n]*)?\n?', stripped)
            # Other tables remain untouched; semantic validation below ensures
            # alternate spelling of a managed table cannot silently bypass it.
            section = header[1] if header else stripped.strip()
            seen.add(section)
        key = re.match(r'^([\w-]+)\s*=', statement)
        pair = (section, key[1]) if key else None
        if pair in remaining:
            output.append(remaining.pop(pair))
        else:
            output.append(statement)
    if output and not output[-1].endswith('\n'):
        output[-1] += '\n'
    flush()
    for section in dict.fromkeys(pair[0] for pair in remaining):
        if section in seen:
            raise ValueError('Unsupported duplicate table layout')
        output.append(f'\n[{section}]\n')
        flush()
    result = ''.join(output)
    expected = dict(original)
    for key, value in desired.items():
        expected[key] = {**original.get(key, {}), **value} if isinstance(value, dict) else value
    if tomllib.loads(result) != expected:
        raise ValueError('Unsupported TOML layout; no files changed')
    return result


def write_backed_up(path, content):
    path = path.expanduser().resolve()  # Preserve symlinks used by dotfile managers.
    if path.exists() and path.read_text() == content:
        print(f'Already current: {path}')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_name(f'{path.name}.bak.{time.time_ns()}')
        shutil.copy2(path, backup)
        print(f'Backup: {backup}')
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(content)
        if path.exists():
            shutil.copymode(path, temporary)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f'Updated: {path}')


def main():
    home = Path.home()
    config = Path(os.environ.get('STARSHIP_CONFIG') or
                  str(Path(os.environ.get('XDG_CONFIG_HOME') or home / '.config') / 'starship.toml'))
    rc = Path(os.environ.get('ZDOTDIR') or home) / '.zshrc'
    source = config.read_text() if config.exists() else ''
    template = Path(__file__).with_name('starship-prompt.toml').read_text()
    candidate = merge(source, template)
    shell = rc.read_text() if rc.exists() else ''
    # Leave existing initialization/plugins alone; init must run only once.
    initialized = re.search(r'^[^#\n]*\bstarship\s+init\s+zsh\b', shell, re.M)
    write_backed_up(config, candidate)
    if not initialized:
        write_backed_up(rc, shell.rstrip() + '''

# >>> script-toolbox Starship prompt >>>
if command -v starship >/dev/null 2>&1; then
  eval "$(starship init zsh)"
fi
# <<< script-toolbox Starship prompt <<<
''')
    print('Reload with: exec zsh (or open a new Ghostty window).')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(f'ERROR: {error}')
