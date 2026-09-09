### The review loop

`Ctrl+Alt+U` — next unread hunk
`Ctrl+Alt+Shift+U` — previous one

(`Cmd` instead of `Ctrl` on macOS.)

Hunks come **worst first**: risk is read from the path (`auth/`, `billing/`,
`migrations/`) and from the content (`eval(`, `process.env`, string-built SQL),
so three unread lines in a session handler outrank forty in a README.

The gutter marks unread lines while you work, and the sidebar under Source
Control lists them file by file. Right-click a file you reviewed elsewhere —
in the GitHub UI, in a pair session — and mark it read.
