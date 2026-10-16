#!/usr/bin/env python3
"""Fail2Ban regression tests; no host configuration or services are changed."""
import configparser
import subprocess
import unittest
import test_bug_regressions as regression

TOOLKIT = regression.TOOLKIT


class Fail2banTest(unittest.TestCase):
    shell = regression.RegressionTest.shell
    def setUp(self):
        regression.RegressionTest.setUp(self)
        self.config = self.root / 'fail2ban'
        (self.config / 'jail.d').mkdir(parents=True)

    def render(self, existing='', backend='systemd', logpath='', ports='49999'):
        (self.config / 'jail.d/sshd.local').write_text(existing)
        output = self.shell(f'render_fail2ban_jail "$TEST_TMP/fail2ban" {backend} "{logpath}" "{ports}"')
        config = configparser.ConfigParser(interpolation=None)
        config.read_string(output)
        return config

    def test_journal_only_config(self):
        jail = self.render()['sshd']
        self.assertEqual(jail['backend'], 'systemd')
        self.assertEqual(jail['logpath'], '')
        self.assertEqual(jail['port'], '49999')
        self.assertNotIn('bantime', jail)

    def test_preserves_policy_port_actions_and_other_jails(self):
        config = self.render('''[sshd]
port = 49999
maxretry = 7
bantime = 7200
findtime = 900
action = %(action_mw)s
backend = auto
logpath = /var/log/auth.log
[other]
enabled = false
''', ports='22')
        for key, value in dict(port='49999', maxretry='7', bantime='7200',
                               findtime='900', action='%(action_mw)s').items():
            self.assertEqual(config['sshd'][key], value)
        self.assertEqual(config['other']['enabled'], 'false')

    def test_inherited_custom_port_and_policy_not_overwritten(self):
        (self.config / 'jail.local').write_text('[sshd]\nport = 49999\nbantime = 86400\n')
        jail = self.render(ports='22')['sshd']
        self.assertNotIn('port', jail)
        self.assertNotIn('bantime', jail)

    def test_file_backend_and_multiple_ports(self):
        jail = self.render(backend='polling', logpath='/var/log/auth.log', ports='22,49999')['sshd']
        self.assertEqual(jail['logpath'], '/var/log/auth.log')
        self.assertEqual(jail['backend'], 'polling')
        self.assertEqual(jail['port'], '22,49999')

    def test_journald_selected_without_auth_log(self):
        self.assertIn('systemd', self.shell('''journalctl() { :; }
systemctl() { [ "$*" = 'is-active --quiet systemd-journald' ]; }
fail2ban_log_source
'''))

    def action(self, overrides='', status=0):
        return self.shell('''# Rewrite only the function's fixed config path into our fixture.
definition="$(declare -f action_configure_fail2ban)"
definition="${definition//\/etc\/fail2ban/$TEST_TMP/fail2ban}"
eval "$definition"
ui_log_success() { printf '%s\\n' "$1"; }
fail2ban_log_source() { echo 'polling /var/log/auth.log'; }
install_packages_batch() { :; }
sshd() { printf 'port 49999\\n'; }
fail2ban-client() { echo "CLIENT:$*"; }
systemctl() { echo "SYSTEMCTL:$*"; }
enable_and_restart_service() { echo "RESTART:$*"; }
write_file_atomic() { echo WRITE; cat > "$1"; }
rollback_operations_from() { echo ROLLBACK; }
fail2ban_diagnostics() { echo DIAGNOSTICS; }
sleep() { :; }
''' + overrides + '\naction_configure_fail2ban\n', status=status)

    def test_validation_before_write_and_restart(self):
        out = self.action()
        self.assertLess(out.index(' -t'), out.index('WRITE'))
        self.assertLess(out.index('WRITE'), out.index('RESTART:fail2ban'))
        self.assertIn('CLIENT:status sshd', out)
        self.assertNotIn('RESTART:ssh', out)

    def test_validation_failure_never_writes_or_restarts(self):
        target = self.config / 'jail.d/sshd.local'
        target.write_text('[sshd]\nbantime = 7200\n')
        out = self.action('fail2ban-client() { return 1; }', status=1)
        self.assertNotIn('WRITE', out)
        self.assertNotIn('RESTART:', out)
        self.assertEqual(target.read_text(), '[sshd]\nbantime = 7200\n')

    def test_failed_port_detection_never_writes(self):
        out = self.action('sshd() { return 1; }', status=1)
        self.assertNotIn('WRITE', out)
        self.assertNotIn('RESTART:', out)

    def test_failed_jail_rolls_back_and_reports_failure(self):
        out = self.action('fail2ban_ssh_ready() { return 1; }', status=1)
        self.assertIn('ROLLBACK', out)
        self.assertIn('DIAGNOSTICS', out)
        self.assertIn('SYSTEMCTL:restart fail2ban', out)
        self.assertNotIn('SSH jail is running', out)

    def test_dry_run_does_not_install_write_or_restart(self):
        out = self.action('DRY_RUN=1\ninstall_packages_batch() { echo INSTALL; return 1; }')
        for marker in ('WRITE', 'RESTART:', 'INSTALL'):
            self.assertNotIn(marker, out)

    def test_install_failure_never_writes_or_restarts(self):
        out = self.action('install_packages_batch() { return 1; }', status=1)
        self.assertNotIn('WRITE', out)
        self.assertNotIn('RESTART:', out)

    def test_restart_failure_rolls_back(self):
        out = self.action('enable_and_restart_service() { return 1; }', status=1)
        self.assertIn('ROLLBACK', out)
        self.assertNotIn('SSH jail is running', out)

    def test_validation_does_not_write_through_config_symlink(self):
        original = self.root / 'original.local'
        original.write_text('[sshd]\nbantime = 7200\n')
        (self.config / 'jail.d/sshd.local').symlink_to(original)
        self.action('fail2ban-client() { return 1; }', status=1)
        self.assertEqual(original.read_text(), '[sshd]\nbantime = 7200\n')

    def test_shell_syntax(self):
        subprocess.run(['bash', '-n', str(TOOLKIT)], check=True)
