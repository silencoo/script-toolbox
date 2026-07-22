# Sanitized API examples

These files are reference requests captured while developing the Autobrr and
JPopSuki integrations. Account-bound RSS values have been replaced with:

- `YOUR_USER_ID`
- `YOUR_FEED_TOKEN`
- `YOUR_AUTH`
- `YOUR_AUTHKEY`
- `YOUR_PASSKEY`

The examples intentionally contain no Cookie or Authorization header. Supply
Autobrr authentication at runtime through `AUTO_BRR_COOKIE`; do not paste a
real session into these files.

Endpoint ids, payload fields, and browser headers may vary between software
versions. Prefer the Python tools for normal operation and use these requests
only when diagnosing an API change.
