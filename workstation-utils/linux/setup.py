#!/usr/bin/env python3
"""Plan or install application profiles on Debian 13; never deploy preferences."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys

CATALOG = Path(__file__).with_name('packages.json')
OS_RELEASE = Path('/etc/os-release')
FLATHUB = 'https://dl.flathub.org/repo/flathub.flatpakrepo'


def load_catalog():
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
    if catalog.get('schema_version') != 1:
        raise ValueError('Unsupported package catalog schema.')
    identities = set()
    for key, package in catalog['packages'].items():
        manager, name = package['manager'], package['id']
        pattern = r'[a-z0-9][a-z0-9+.-]*' if manager == 'apt' else r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_-]+){2,}'
        if manager not in ('apt', 'flatpak') or not re.fullmatch(pattern, name):
            raise ValueError(f'Invalid package identifier for {key}.')
        if not package['name'] or (manager, name) in identities:
            raise ValueError(f'Empty label or duplicate package: {key}.')
        identities.add((manager, name))
    for key, profile in catalog['profiles'].items():
        if not profile['description'] or not profile['packages']:
            raise ValueError(f'Empty profile: {key}.')
        if any(name not in catalog['packages'] for name in profile['packages']):
            raise ValueError(f'Unknown package in profile: {key}.')
    return catalog


def select_packages(catalog, profiles, manager):
    selected = {}
    for profile in profiles:
        if profile not in catalog['profiles']:
            raise ValueError(f'Unknown profile {profile!r}; use the list command.')
        for key in catalog['profiles'][profile]['packages']:
            package = catalog['packages'][key]
            if manager == 'all' or package['manager'] == manager:
                selected[key] = package
    if not selected:
        raise ValueError('No applications match the selected profiles and manager.')
    return list(selected.values())


def package_ids(packages, manager):
    return [package['id'] for package in packages if package['manager'] == manager]


def apt_prefix():
    return [] if hasattr(os, 'geteuid') and os.geteuid() == 0 else ['sudo']


def install_commands(apt, flatpak):
    commands = []
    if apt:
        commands.extend([apt_prefix() + ['apt-get', 'update'],
                         apt_prefix() + ['apt-get', 'install', '--no-upgrade', *apt]])
    if flatpak:
        commands.extend([
            ['flatpak', 'remote-add', '--user', '--if-not-exists', 'flathub', FLATHUB],
            ['flatpak', 'install', '--user', 'flathub', *flatpak],
        ])
    return commands


def show_plan(packages, profiles):
    print('Plan: ' + ', '.join(profiles) + ' profile(s)')
    for package in packages:
        print(f"  {package['manager']:7} {package['id']:38} {package['name']}")
    apt = package_ids(packages, 'apt')
    flatpak = package_ids(packages, 'flatpak')
    if flatpak:
        apt.append('flatpak')
    print('\nCandidate commands; install checks what is missing first:')
    for command in install_commands(apt, flatpak):
        print('  $ ' + shlex.join(command))


def require_debian():
    if platform.system() != 'Linux':
        raise RuntimeError('Installation requires Debian 13; plan works on any Python host.')
    release = {}
    for line in OS_RELEASE.read_text(encoding='utf-8').splitlines():
        key, separator, value = line.partition('=')
        if separator and key in ('ID', 'VERSION_ID'):
            release[key] = value.strip('"\'')
    if release.get('ID') != 'debian' or release.get('VERSION_ID') != '13':
        raise RuntimeError('This application catalog currently supports Debian 13 only.')


def installed_apt(packages):
    if not packages:
        return set()
    result = subprocess.run(
        ['dpkg-query', '-W', '-f=${binary:Package} ${db:Status-Abbrev}\n', *packages],
        text=True, capture_output=True)
    if result.returncode not in (0, 1):
        raise RuntimeError('Could not read installed APT packages.')
    return {fields[0].split(':')[0] for line in result.stdout.splitlines()
            if len(fields := line.split()) == 2 and fields[1] == 'ii'}


def installed_flatpak():
    # Without a scope flag, list includes user and system installations.
    result = subprocess.run(['flatpak', 'list', '--app', '--columns=application'],
                            text=True, capture_output=True, check=True)
    return set(result.stdout.splitlines())


def execute(command):
    print('$ ' + shlex.join(command), flush=True)
    subprocess.run(command, check=True)


def install(packages, assume_yes):
    require_debian()
    flatpak = package_ids(packages, 'flatpak')
    if flatpak and os.geteuid() == 0:
        raise RuntimeError('Run as the desktop user; APT uses sudo, Flatpak installs for that user.')
    apt = package_ids(packages, 'apt')
    has_flatpak = bool(shutil.which('flatpak')) if flatpak else False
    if flatpak and not has_flatpak:
        apt.append('flatpak')
    installed = installed_apt(apt)
    missing_apt = [name for name in apt if name not in installed]
    if flatpak and not has_flatpak and 'flatpak' not in missing_apt:
        raise RuntimeError('The flatpak package is installed but its command is missing; check PATH.')
    installed_apps = installed_flatpak() if has_flatpak else set()
    missing_flatpak = [name for name in flatpak if name not in installed_apps]
    if not missing_apt and not missing_flatpak:
        print('OK   All requested applications are already installed.')
        return
    print('\nMissing: ' + ', '.join(missing_apt + missing_flatpak))
    if not assume_yes:
        try:
            confirmed = input('Install these missing packages? [y/N] ').strip().lower() in ('y', 'yes')
        except EOFError:
            confirmed = False
        if not confirmed:
            print('Cancelled; no changes were made.')
            return
    for command in install_commands(missing_apt, []):
        execute(command)
    if flatpak and not has_flatpak:
        if not shutil.which('flatpak'):
            raise RuntimeError('Flatpak is unavailable after APT installation.')
        # A previous Flatpak removal may have retained installed user apps.
        installed_apps = installed_flatpak()
        missing_flatpak = [name for name in flatpak if name not in installed_apps]
    for command in install_commands([], missing_flatpak):
        execute(command)
    print('OK   Requested applications are installed.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', nargs='?', choices=('plan', 'install', 'list'), default='plan')
    parser.add_argument('profiles', nargs='*', help='core, desktop, admin, apps; default: core')
    parser.add_argument('--manager', choices=('all', 'apt', 'flatpak'), default='all')
    parser.add_argument('--dry-run', action='store_true', help='preview without querying or changing this machine')
    parser.add_argument('--yes', action='store_true', help='skip this script\'s confirmation; keep package-manager prompts')
    args = parser.parse_args(argv)
    try:
        catalog = load_catalog()
        if args.command == 'list':
            for name, profile in catalog['profiles'].items():
                print(f"{name:10} {profile['description']}")
            return 0
        profiles = list(dict.fromkeys(name.strip().lower() for value in args.profiles
                                     for name in value.split(',') if name.strip())) or ['core']
        packages = select_packages(catalog, profiles, args.manager)
        show_plan(packages, profiles)
        if args.command == 'plan' or args.dry_run:
            print('Preview only; no package queries, network requests, or changes were made.')
            return 0
        install(packages, args.yes)
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
