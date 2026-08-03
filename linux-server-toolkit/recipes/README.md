# Operations recipes

These files are deployment or debugging references rather than automatic
steps in `server-toolkit.sh`:

- `clouddrive-mitm-proxy.yaml` routes selected CloudDrive traffic through a
  local capture proxy for controlled debugging.
- `nginx-pwa-reverse-proxy.conf` is an example reverse proxy that rewrites an
  upstream site and injects PWA metadata. It requires review and accompanying
  manifest, service worker, and icons before use. It also removes the upstream
  Content Security Policy, which weakens browser protections and must be an
  explicit trust decision.
- `qnap-moriy-agent-qpkg-deployment.md` documents QNAP QPKG registration and
  `daemon_mgr` supervision for a Moriy Agent build.

Every value is an example. Review paths, hostnames, process names, certificate
handling, and trust boundaries before adapting a recipe to a real host.
