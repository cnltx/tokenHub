# tokenHub development

- tokenHub is independent: native Node.js HTTP and vanilla HTML/CSS/JS, no runtime packages. Read docs/architecture.md when changing module boundaries.
- Read .agents/skills/tokenhub/SKILL.md for routing, forwarding, credentials, accounting, Docker, or desktop startup work.
- The client always receives its requested model's response. Optional background forwarding copies full context to the selected target, never changes the primary result, never recurses, and never offers candidate acceptance.
- Authorize source and target with the same client identity. Keep background concurrency and health state separate from primary capacity/health. Client cancellation and shutdown abort active requests.
- data/, .tmp/, credentials, environment files, exports, and screenshots are private generated state. Verify Git and Docker exclusions before packaging.
- Run node scripts/check.js and node test/run.js. Tests use local mock providers, never real model API keys.
- Windows shortcuts invoke wscript/Node with hidden console; Docker uses Compose and persistent data. Keep the two modes from writing the same data concurrently.
- Management is login-free: no accounts, passwords, cookies, or admin secret. Keep automatic CSRF and Host/Origin checks; inference still requires its client token.
