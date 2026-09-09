### At commit time

```
$ git commit -m "fix: session expiry"

BLINDSPOT  Review coverage 55%  ·  45% unread
⚠ CRITICAL  src/auth/session.ts lines 9-34 unread
```

The hook **warns and exits 0** by default. Enforcement is opt-in:

```bash
blindspot check --min-coverage 70   # exit 1 below 70%
blindspot check --max-critical 0    # exit 1 on any unread high-risk line
```

The same CLI works in CI, and `blindspot install-hook --trailer` adds an
opt-in commit trailer recording the number with the commit.
