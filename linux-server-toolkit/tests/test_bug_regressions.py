#!/usr/bin/env python3
"""Regression tests using temporary files and mocked system mutations."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'
SSHD = shutil.which('sshd') or ('/usr/sbin/sshd' if Path('/usr/sbin/sshd').is_file() else None)


class RegressionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolkit-regression-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def shell(self, code, *, input='', env=None, status=0):
        prefix = '''source "$1"
TEST_TMP="$2"
LOG_FILE="$TEST_TMP/toolkit.log"
BACKUP_DIR="$TEST_TMP/backups"
DIR_TRANSACTION_DIR="$TEST_TMP/transactions"
LOG_READY=false
initialize_terminal
'''
        child = subprocess.run(['bash', '-c', prefix + code, 'regression',
                                str(TOOLKIT), str(self.root)], input=input,
                               text=True, capture_output=True, timeout=15,
                               env=dict(os.environ, NON_INTERACTIVE='0', DRY_RUN='0',
                                        PLAN_ONLY='0', TOOLKIT_LANG='en', **(env or {})))
        self.assertEqual(child.returncode, status, child.stdout + child.stderr)
        return child.stdout + child.stderr

    def test_noninteractive_profile_runs_modules_in_order(self):
        output = self.shell('''NON_INTERACTIVE=1
run_profile_module() { printf 'EXECUTED:%s\n' "$1"; }
apply_profile_modules minimal 'essentials ssh firewall fail2ban auto_updates'
''')
        self.assertEqual([line for line in output.splitlines() if line.startswith('EXECUTED:')],
                         ['EXECUTED:' + name for name in
                          ('essentials', 'ssh', 'firewall', 'fail2ban', 'auto_updates')])

    def test_profile_retains_interactive_cancel_and_stops_on_failure(self):
        code = '''run_profile_module() { printf 'EXECUTED:%s\n' "$1"; return 7; }
apply_profile_modules minimal 'essentials ssh'
'''
        self.assertNotIn('EXECUTED:', self.shell(code, input='n\n', status=1))
        output = self.shell('NON_INTERACTIVE=1\n' + code, status=7)
        self.assertIn('EXECUTED:essentials', output)
        self.assertNotIn('EXECUTED:ssh', output)

    def test_noninteractive_profile_reports_deferred_menus(self):
        output = self.shell('''NON_INTERACTIVE=1
run_profile_module() { printf 'EXECUTED:%s\n' "$1"; }
apply_profile_modules custom 'essentials runtime reverse_proxy compose_backup monitoring backup_restore security_audit script_quality restic_drill report'
''')
        self.assertIn('EXECUTED:essentials', output)
        self.assertIn('EXECUTED:report', output)
        for module in ('runtime', 'reverse_proxy', 'compose_backup', 'monitoring',
                       'backup_restore', 'security_audit', 'script_quality', 'restic_drill'):
            self.assertNotIn('EXECUTED:' + module, output)
            self.assertIn('Skipped ' + module, output)
        self.assertIn('finished with interactive modules skipped:', output)

    def test_firewall_noninteractive_never_reads_stdin(self):
        output = self.shell('''NON_INTERACTIVE=1
ufw() { printf 'UFW:%s\n' "$*"; }
sshd() { printf 'port 2222\n'; }
ui_read() { echo UNEXPECTED_READ; return 9; }
invoke_action action_configure_firewall
''', input='y\n')
        self.assertNotIn('UNEXPECTED_READ', output)
        self.assertIn('UFW:allow 2222/tcp', output)
        self.assertIn('UFW:--force enable', output)
        self.assertNotIn('UFW:allow 80/', output)

    def test_debian_and_ubuntu_update_origins(self):
        for distro in ('debian', 'ubuntu'):
            self.shell(f'''OS_ID={distro}
unattended-upgrades() {{ :; }}
write_file_atomic() {{ cat > "$TEST_TMP/$(basename "$1")"; }}
action_configure_auto_updates
''')
            config = (self.root / '50unattended-upgrades').read_text()
            if distro == 'debian':
                self.assertIn('Origins-Pattern', config)
                self.assertNotIn('Allowed-Origins', config)
                self.assertIn('codename=${distro_codename},label=Debian-Security', config)
                self.assertIn('codename=${distro_codename}-security,label=Debian-Security', config)
                self.assertNotIn('archive=', config)
            else:
                self.assertIn('Allowed-Origins', config)
                self.assertIn('${distro_id}:${distro_codename}-security', config)
                self.assertIn('${distro_id}ESMApps:', config)
            if shutil.which('apt-config'):
                subprocess.run(['apt-config', '-c', str(self.root / '50unattended-upgrades'),
                                'dump'], check=True, capture_output=True)

    @unittest.skipUnless(SSHD and shutil.which('ssh-keygen'), 'requires OpenSSH server and ssh-keygen')
    def test_ssh_include_precedence_and_effective_verification(self):
        key = self.root / 'hostkey'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True)
        included = self.root / 'cloud-init.conf'
        included.write_text('PasswordAuthentication yes\nPermitRootLogin yes\n')
        config = self.root / 'sshd_config'
        config.write_text(f'HostKey {key}\nInclude {included}\n'
                          '#Match User commented-example\nPasswordAuthentication yes\n'
                          'Match User restricted\n    PasswordAuthentication yes\n')
        self.shell('''sshd() { "$TEST_SSHD" "$@"; }
set_sshd_directive_in_file "$TEST_TMP/sshd_config" PasswordAuthentication no
set_sshd_directive_in_file "$TEST_TMP/sshd_config" PermitRootLogin no
set_sshd_directive_in_file "$TEST_TMP/sshd_config" PasswordAuthentication no
verify_sshd_settings "$TEST_TMP/sshd_config" '' passwordauthentication=no permitrootlogin=no
if verify_sshd_login_settings "$TEST_TMP/sshd_config" restricted passwordauthentication=no; then
    echo 'FAILED TO DETECT MATCH OVERRIDE'; exit 1
fi
''', env={'TEST_SSHD': SSHD})
        rewritten = config.read_text()
        self.assertLess(rewritten.index('PasswordAuthentication no'), rewritten.index('Include '))
        self.assertEqual(rewritten.count('PasswordAuthentication no'), 1)
        self.assertIn('Match User restricted\n    PasswordAuthentication yes', rewritten)
        self.assertEqual(included.read_text(), 'PasswordAuthentication yes\nPermitRootLogin yes\n')

    @unittest.skipUnless(SSHD and shutil.which('ssh-keygen'), 'requires OpenSSH server and ssh-keygen')
    def test_ssh_action_verifies_values_and_rolls_back_after_reload_mismatch(self):
        key = self.root / 'hostkey'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True)
        included = self.root / 'cloud-init.conf'
        included.write_text('PasswordAuthentication yes\nPermitRootLogin yes\n')
        original = f'HostKey {key}\nPort 2222\nInclude {included}\n'
        config = self.root / 'sshd_config'
        (self.root / 'original').write_text(original)
        code = r'''# Redirect the action's hardcoded system configuration to the fixture.
action_source="$(declare -f action_configure_ssh_transactional)"
action_source="${action_source//\/etc\/ssh\/sshd_config/$TEST_TMP/sshd_config}"
eval "$action_source"
sshd() { "$TEST_SSHD" "$@"; }
NON_INTERACTIVE=1
SSH_PUBLIC_KEY=''
select_ssh_key_target() { SSH_SELECTED_USER=root; SSH_SELECTED_HOME="$TEST_TMP"; }
authorized_keys_is_usable_for_user() { :; }
confirm_action() { return 0; }
atomic_install_file() { cp "$2" "$1"; echo INSTALLED; }
reload_ssh_service() {
    if [ "$BREAK_RELOAD" = 1 ]; then
        sed -i 's/^PasswordAuthentication no$/PasswordAuthentication yes/' "$TEST_TMP/sshd_config"
    fi
}
rollback_last_operation() { cp "$TEST_TMP/original" "$TEST_TMP/sshd_config"; echo ROLLED_BACK; }
invoke_action action_configure_ssh_transactional
'''
        for break_reload, expected_status in (('0', 0), ('1', 1)):
            config.write_text(original)
            output = self.shell(code, status=expected_status,
                                env={'TEST_SSHD': SSHD, 'BREAK_RELOAD': break_reload})
            self.assertIn('INSTALLED', output)
            if break_reload == '1':
                self.assertIn('ROLLED_BACK', output)
                self.assertEqual(config.read_text(), original)
                self.assertNotIn('SSH configuration applied safely', output)
            else:
                self.assertIn('SSH configuration applied safely', output)
                self.assertIn('PasswordAuthentication no', config.read_text())
        config.write_text(original)
        included.write_text('Match User root\n PasswordAuthentication yes\n')
        output = self.shell(code, status=1, env={'TEST_SSHD': SSHD, 'BREAK_RELOAD': '0'})
        self.assertNotIn('INSTALLED', output)
        self.assertEqual(config.read_text(), original)

    def test_user_manager_keeps_root_without_key_or_sudo(self):
        for usable_key, sudo_access in (('false', 'false'), ('true', 'false'), ('false', 'true')):
            output = self.shell(f'''id() {{ return 1; }}
adduser() {{ :; }}
get_user_home() {{ echo "$TEST_TMP/custom-home"; }}
validate_ssh_key_target_user() {{ :; }}
authorized_keys_is_usable_for_user() {{ {usable_key}; }}
user_has_sudo_access() {{ {sudo_access}; }}
reload_ssh_service() {{ echo UNEXPECTED_RELOAD; return 99; }}
atomic_install_file() {{ echo UNEXPECTED_WRITE; return 99; }}
invoke_action action_user_manager
''', input='reviewuser\nn\nn\ny\n')
            self.assertIn('Root SSH login was kept', output)
            self.assertNotIn('UNEXPECTED_', output)

    def test_sudo_group_membership_cannot_bypass_policy_check(self):
        self.shell('''id() { echo 'reviewuser sudo'; }
sudo() { return 1; }
user_has_sudo_access reviewuser
''', status=1)
        self.shell('''sudo() { printf '%s\n' "$*" > "$TEST_TMP/sudo.args"; }
user_has_sudo_access reviewuser
''')
        self.assertEqual((self.root / 'sudo.args').read_text().strip(),
                         '-n -l -U reviewuser -u root -- /bin/sh')

    def test_user_manager_uses_account_home_and_requires_confirmation(self):
        output = self.shell('''id() { return 1; }
adduser() { :; }
get_user_home() { echo "$TEST_TMP/custom-home"; }
install_authorized_key() { printf 'KEY_HOME:%s\n' "$2"; }
validate_ssh_key_target_user() { :; }
authorized_keys_is_usable_for_user() { :; }
user_has_sudo_access() { :; }
reload_ssh_service() { echo UNEXPECTED_RELOAD; return 99; }
atomic_install_file() { echo UNEXPECTED_WRITE; return 99; }
invoke_action action_user_manager
''', input='reviewuser\ny\nFAKE-KEY\nn\nn\n')
        self.assertIn('KEY_HOME:' + str(self.root / 'custom-home'), output)
        self.assertIn('Have you tested SSH login and sudo', output)
        self.assertNotIn('UNEXPECTED_', output)

    def test_user_manager_disables_root_after_prerequisites_and_confirmation(self):
        ssh_dir = self.root / 'ssh'
        ssh_dir.mkdir()
        config = ssh_dir / 'sshd_config'
        config.write_text('PermitRootLogin yes\n')
        output = self.shell(r'''manager="$(declare -f action_user_manager)"
manager="${manager//\/etc\/ssh/$TEST_TMP/ssh}"
eval "$manager"
id() { return 1; }
adduser() { :; }
get_user_home() { echo "$TEST_TMP/custom-home"; }
validate_ssh_key_target_user() { :; }
authorized_keys_is_usable_for_user() { :; }
user_has_sudo_access() { :; }
sshd() { printf 'permitrootlogin no\npubkeyauthentication yes\n'; }
atomic_install_file() { cp "$2" "$1"; }
reload_ssh_service() { echo RELOADED; }
invoke_action action_user_manager
''', input='reviewuser\nn\nn\ny\n')
        self.assertIn('Root SSH login disabled', output)
        self.assertIn('RELOADED', output)
        self.assertTrue(config.read_text().startswith('PermitRootLogin no\n'))

    def docker_fixture(self):
        project = self.root / 'project'
        project.mkdir()
        (project / 'compose.yaml').write_text('services: {}\n')
        (self.root / 'model.json').write_text(json.dumps({'volumes': {
            'db': {'name': 'reviewapp_db'},
            'custom': {'name': 'custom-db'},
            'external': {'name': 'existing-external'},
        }}))
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        docker = bin_dir / 'docker'
        docker.write_text('''#!/bin/bash
printf '%s\n' "$*" >> "$FIXTURE_DIR/docker.calls"
case "$*" in
    'compose version') exit 0 ;;
    'compose config --format json') cat "$FIXTURE_DIR/model.json"; exit 0 ;;
    'compose config') echo 'services: {}'; exit 0 ;;
    'volume inspect '*) [ "${MISSING_VOLUME:-0}" = 0 ]; exit ;;
    'run '*) exit "${BACKUP_EXIT:-0}" ;;
esac
exit 99
''')
        docker.chmod(0o755)
        return {'PATH': str(bin_dir) + ':' + os.environ['PATH'], 'FIXTURE_DIR': str(self.root)}

    @unittest.skipUnless(shutil.which('jq'), 'requires jq')
    def test_compose_backup_resolves_names_and_propagates_failure(self):
        env = self.docker_fixture()
        code = '''NON_INTERACTIVE=1
invoke_action run_docker_compose_backup_once
'''
        inputs = f'{self.root}/project\n{self.root}/backups\n'
        self.shell(code, input=inputs, env=env)
        calls = (self.root / 'docker.calls').read_text()
        for name in ('reviewapp_db', 'custom-db', 'existing-external'):
            self.assertIn('volume inspect ' + name, calls)
            self.assertIn('-v ' + name + ':/volume:ro', calls)
        self.assertNotIn('-v db:', calls)
        (self.root / 'docker.calls').write_text('')
        output = self.shell(code, input=inputs, env=dict(env, MISSING_VOLUME='1'), status=1)
        self.assertNotIn('run --rm', (self.root / 'docker.calls').read_text())
        self.assertNotIn('project backup completed', output)
        output = self.shell(code, input=inputs, env=dict(env, BACKUP_EXIT='17'), status=1)
        self.assertNotIn('project backup completed', output)

    @unittest.skipUnless(shutil.which('jq'), 'requires jq')
    def test_compose_timer_embeds_working_backup_and_fails_job_on_error(self):
        env = self.docker_fixture()
        self.shell('''NON_INTERACTIVE=1
validate_systemd_calendar_value() { :; }
write_file_atomic() { cat > "$TEST_TMP/$(basename "$1")"; }
systemd_daemon_reload() { :; }
systemctl() { :; }
invoke_action install_docker_compose_backup_timer
''', input=f'{self.root}/project\n{self.root}/backups\n\n', env=env)
        script = self.root / 'init-compose-backup-project'
        script.write_text(script.read_text().replace('/var/log/init-compose-backup-project.log',
                                                    str(self.root / 'timer.log')))
        subprocess.run(['bash', '-n', str(script)], check=True)
        for rc in (0, 17):
            (self.root / 'timer.log').write_text('')
            child = subprocess.run(['bash', str(script)], capture_output=True, text=True,
                                   env=dict(os.environ, **env, BACKUP_EXIT=str(rc)), timeout=15)
            self.assertEqual(child.returncode, 0 if rc == 0 else 1, child.stderr)
            log = (self.root / 'timer.log').read_text()
            self.assertEqual('compose backup done' in log, rc == 0)
        self.assertIn('-v reviewapp_db:/volume:ro', (self.root / 'docker.calls').read_text())

    @unittest.skipUnless(shutil.which('jq'), 'requires jq')
    def test_compose_empty_and_invalid_volume_models(self):
        self.docker_fixture()
        code = '''backup_compose_project "$TEST_TMP/project" "$TEST_TMP/backups" 'docker compose' compose.yaml 1'''
        env = {'PATH': str(self.root / 'bin') + ':' + os.environ['PATH'], 'FIXTURE_DIR': str(self.root)}
        for model, expected_status in (({'volumes': {}}, 0),
                                       ({'volumes': {'db': {}}}, 1),
                                       ({'volumes': False}, 1), (None, 1)):
            (self.root / 'model.json').write_text(json.dumps(model))
            (self.root / 'docker.calls').write_text('')
            self.shell(code, env=env, status=expected_status)
            self.assertNotIn('run --rm', (self.root / 'docker.calls').read_text())
        (self.root / 'model.json').write_text('')
        self.shell(code, env=env, status=1)

    @unittest.skipUnless(shutil.which('jq') and shutil.which('docker'), 'requires jq and Compose CLI')
    def test_volume_resolver_with_real_compose_configuration(self):
        version = subprocess.run(['docker', 'compose', 'version'], capture_output=True)
        if version.returncode:
            self.skipTest('Compose CLI unavailable')
        config = self.root / 'compose.yaml'
        config.write_text('''name: reviewapp
services:
  db:
    image: busybox
    volumes: [db:/db, custom:/custom, external:/external]
volumes:
  db: {}
  custom:
    name: custom-db
  external:
    external: true
    name: existing-external
''')
        # config is local-only: no Engine access, image pulls, or containers.
        model = subprocess.run(['docker', 'compose', '-f', str(config), 'config', '--format', 'json'],
                               capture_output=True, text=True, check=True)
        (self.root / 'model.json').write_text(model.stdout)
        output = self.shell('docker_compose_volume_names "$TEST_TMP/model.json"')
        self.assertEqual(output.splitlines(), ['custom-db', 'existing-external', 'reviewapp_db'])


if __name__ == '__main__':
    unittest.main()
