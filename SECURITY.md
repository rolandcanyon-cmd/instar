# Security Policy

## Instar's Security Model

Instar runs Claude Code with `--dangerously-skip-permissions`. Security is enforced through behavioral hooks, LLM-supervised safety gates, and network hardening rather than permission dialogs.

This is power-user infrastructure for developers who want genuine AI autonomy. If you need a sandboxed environment, Instar is not the right tool.

**Security layers:**
- Command guards block destructive operations (rm -rf, force push, database drops)
- Safety gates provide LLM-supervised review of external actions
- Network hardening: localhost-only API, CORS, rate limiting
- Audit trails via decision journaling
- Adaptive trust per service

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

Please use [GitHub's private vulnerability reporting](https://github.com/JKHeadley/instar/security/advisories/new) to submit security issues.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a timeline for resolution.

**Do not** open a public GitHub issue for security vulnerabilities.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| < Latest | Best effort |
