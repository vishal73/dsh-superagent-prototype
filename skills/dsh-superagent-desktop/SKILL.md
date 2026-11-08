---
name: dsh-superagent-desktop
description: See and operate desktop apps on this machine through the agent-desktop CLI's accessibility tree, when a request asks for something only a desktop app can do.
---

`agent-desktop` (https://github.com/vercel-labs/agent-desktop) reads a desktop app's accessibility tree and returns JSON with a ref for every element you may act on. There is no model in it: you drive the loop. Use it only when the request needs a desktop app — an installed macOS, Windows or Linux program, a window, a menu, the clipboard — and not when the work belongs in the repository.

## Before the first use

1. `agent-desktop status` reports the platform, accessibility permission and supported surfaces. If the command is missing, say so instead of guessing; the operator installs it with `npm install -g agent-desktop`.
2. If the platform is macOS and the permission is not granted, ask the operator to run `agent-desktop permissions --guide`; a worker cannot grant it.
3. Run `agent-desktop skills get desktop` and `agent-desktop skills get platform` once, and follow them. They match the installed version; this skill only adds the rules below.

## The loop

1. `agent-desktop snapshot --app "<name>" -i` to see interactive elements with refs; add `--compact`, `--skeleton`, or `--root <ref>` to stay within a dense app.
2. Read the tree, pick a ref, act: `click`, `type --stdin`, `set-value`, `select`, `toggle`, `scroll-to`, `press`.
3. Snapshot again and check the result before claiming success. A click that returns `ok: true` is not proof the app did what the person asked.

A ref belongs to its snapshot. `@e8` alone is rejected; use the full `@<snapshot>:<ref>`. When an action answers `STALE_REF` or `AMBIGUOUS_TARGET`, take a new snapshot and use its refs. Several windows of one app answer `AMBIGUOUS_TARGET` with candidate window ids: snapshot again with `--window-id`.

## Safety and privacy

- Act only within the request. Do not quit, uninstall, send messages, make purchases, change account settings or accept permissions unless the person asked for exactly that; ask first when unsure.
- Input is headless by default. `--headed` moves the pointer and takes focus, so use it only when the person is not using the machine or asked for it.
- Pass text through `--stdin` when it may be private, and keep secrets out of process arguments and out of later snapshots.
- Snapshots, clipboard reads, screenshots and traces can contain private content. Never paste them into GitHub, a public issue, a commit or a chat reply, and do not leave them in logs.
- Retry a failed command only when `error.disposition.retry` is `safe`. A refused permission is for the operator, not a reason to try another surface.

## Reporting

Keep the reply short, and shorter still for a Telegram request: what you did, what the app now shows, and anything the person must do (such as a permission grant). Offer a screenshot instead of pasting one, and then only when the surface is not private.
