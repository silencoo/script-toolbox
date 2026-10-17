#!/usr/bin/env python3
"""Shared local/CI validation entrypoint. Discovers tests within each component."""
import argparse
import os
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = ('server-toolkit', 'agent', 'docker-sandboxes', 'workstation',
              'extensions', 'userscripts', 'proxy-rules', 'sub-store',
              'mihomo-console', 'sing-box', 'cloudflare-vless', 'toolbox-store',
              'sunshine-vdd', 'linux-do', 'misc')
EXCLUDED = {'node_modules', 'dist', '.git', '.venv', '__pycache__', '.browser'}


def run(*args, cwd=ROOT):
    print('+ ' + shlex.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)


def files(directory, patterns):
    base = ROOT / directory
    if not base.is_dir():
        raise FileNotFoundError(f"Validation directory does not exist: {base}")
    return sorted({p for pattern in patterns for p in base.rglob(pattern)
                   if not EXCLUDED.intersection(p.relative_to(base).parts)})


def node_tests(directory):
    tests = files(directory, ('*.test.mjs', '*.test.cjs', '*.test.js', 'test.mjs'))
    if tests:
        run('node', '--test', *tests)


def shell_tests(directory):
    for path in files(directory, ('*-test.sh', 'test_*.sh')):
        run('bash', path)


def unittest(directory, pattern='test*.py'):
    run(sys.executable, '-B', '-m', 'unittest', 'discover', '-s', directory, '-p', pattern, '-v')


def powershell_tests(directory):
    tests = files(directory, ('*-test.ps1', '*.Tests.ps1'))
    for shell in ('powershell', 'pwsh'):
        for path in tests:
            run(shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path)


def npm(directory, script, install):
    cwd = ROOT / directory
    if install:
        run('npm.cmd' if os.name == 'nt' else 'npm', 'ci', cwd=cwd)
    run('npm.cmd' if os.name == 'nt' else 'npm', 'run', script, cwd=cwd)


def syntax(directories):
    for directory in directories:
        for path in files(directory, ('*.sh', '*.js', '*.mjs', '*.cjs')):
            if 'userscripts/sht-helper/src/modules' in path.as_posix():
                continue  # Concatenated source fragments are not standalone JS.
            run(*(('bash', '-n') if path.suffix == '.sh' else ('node', '--check')), path)


def validate(component, install=False, containers=False):
    windows = sys.platform == 'win32'
    if component == 'server-toolkit':
        if install:
            run(sys.executable, '-m', 'pip', 'install', 'Flask>=3,<4')
        run('bash', '-c', '(( BASH_VERSINFO[0] >= 4 )) || { echo "Bash 4+ required" >&2; exit 1; }')
        syntax([component])
        unittest('server-toolkit/tests')
        shell_tests('server-toolkit/tests')
    elif component == 'agent':
        if install:
            run(sys.executable, '-m', 'pip', 'install', 'pytest')
        npm('agent/tui', 'test' if windows else 'validate', install)
        if not windows:
            run('git', 'diff', '--exit-code', '--', 'agent/tui/dist')
            run('bash', 'agent/test.sh')
        else:
            node_tests('agent')
            run('bash', 'agent/tests/windows-git-bash-smoke.sh')
            run('powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'agent/tests/install-commands-powershell-test.ps1')
        run('node', 'agent/tui/dist/toolbox-tui.mjs', '--help')
        for directory in sorted((ROOT / 'agent/promptctl').rglob('tests')):
            if (windows and 'claude' in directory.parts) or EXCLUDED.intersection(directory.parts):
                continue
            run(sys.executable, '-m', 'pytest', '-p', 'no:cacheprovider', '-q', directory)
    elif component == 'docker-sandboxes':
        if windows:
            powershell_tests(component)
        else:
            syntax([component])
            shell_tests(component)
            for path in ['kits/zsh-shell/files/home/.zshrc', 'kits/zsh-shell/files/home/.config/sbx-manager/completions/_claude']:
                run('zsh', '-n', str(ROOT / component / path))
    elif component == 'workstation':
        if windows:
            powershell_tests(component)
        else:
            syntax([component])
            shell_tests(component)
            unittest('workstation/tests')
            run('zsh', '-n', 'workstation/macos/zshrc.zsh')
    elif component == 'extensions':
        syntax([component])
        for package in sorted((ROOT / component).glob('*/package.json')):
            directory = package.parent.relative_to(ROOT)
            npm(directory, 'test:unit' if package.parent.name == 'singlefile-mv3' else 'validate', install)
    elif component == 'userscripts':
        for directory in ['userscripts', 'jpopsuki-rss-autobrr', 'turnstile-autoclick']:
            syntax([directory])
            if directory == 'userscripts':
                for child in sorted((ROOT / directory).iterdir()):
                    if child.is_dir() and child.name not in ('sht-helper', 'linux-do'):
                        node_tests(str(child.relative_to(ROOT)))
            else:
                node_tests(directory)
        npm('userscripts/sht-helper', 'check', install)
    elif component == 'linux-do':
        syntax(['userscripts/linux-do'])
        directory = ROOT / 'userscripts/linux-do'
        if install:
            run('npm', 'ci', cwd=directory)
            command = ['npx', '--no-install', 'playwright', 'install']
            if sys.platform == 'linux':
                command.append('--with-deps')
            run(*command, 'chromium', cwd=directory)
        node_tests('userscripts/linux-do')
    elif component == 'proxy-rules':
        syntax(['quantumult-x', 'proxy-rules'])
        node_tests('quantumult-x')
        npm('proxy-rules', 'check', install)
    elif component == 'sub-store':
        syntax([component])
        node_tests(component)
    elif component == 'mihomo-console':
        if install:
            run(sys.executable, '-m', 'pip', 'install', '-r', 'mihomo-console/requirements.txt')
        syntax([component])
        unittest(component)
        if containers:
            os.environ.setdefault('NAS_IP', '192.0.2.10')
            for compose in ['compose.yaml', 'deploy/qnap.compose.yaml', 'deploy/truenas.compose.yaml']:
                run('docker', 'compose', '-f', f'mihomo-console/{compose}', 'config', '--quiet')
    elif component == 'sing-box':
        syntax([component])
        unittest('sing-box/tests')
    elif component in ('cloudflare-vless', 'toolbox-store'):
        if component == 'cloudflare-vless':
            node_tests('workers/cloudflare-vless')
        npm(f'workers/{component}', 'validate', install)
    elif component == 'sunshine-vdd':
        powershell_tests(component)
    elif component == 'misc':
        syntax(['debian-ai-workstation', 'dujiaoka-epusdt'])
        unittest('scripts/tests')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('component', choices=COMPONENTS)
    parser.add_argument('--install', action='store_true', help='install npm/Python test dependencies in the active environment')
    parser.add_argument('--containers', action='store_true', help='also validate Docker Compose configurations')
    args = parser.parse_args()
    os.chdir(ROOT)
    validate(args.component, args.install, args.containers)


if __name__ == '__main__':
    main()
