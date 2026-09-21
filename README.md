![Logo](admin/matterbridge.png)

# ioBroker.matterbridge

[![NPM version](https://img.shields.io/npm/v/iobroker.matterbridge.svg)](https://www.npmjs.com/package/iobroker.matterbridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Runs and supervises a native [Matterbridge](https://github.com/Luligu/matterbridge) instance as a child process and embeds its web UI as an ioBroker admin tab. Matterbridge exposes devices to Matter controllers such as Apple Home, Google Home, Amazon Alexa, and Home Assistant.

This adapter does not implement any Matter logic itself - all cluster and plugin management is handled by Matterbridge. It also automatically installs and registers the bundled `matterbridge-iobroker-bridge` plugin, which exposes ioBroker states (switches, blinds, vacuum robots, sensors, dimmers, and more via a configurable device builder) as Matter devices.

## Features

- Installs and manages Matterbridge as a supervised child process (install, start, stop, restart, auto-restart with exponential backoff)
- Downloads and uses an isolated Node.js runtime just for Matterbridge, independent of the system Node.js used by ioBroker
- Stores Matterbridge's installation, storage, and Node.js runtime under `iobroker-data/matterbridge/`, outside the npm package tree, so that updating other adapters cannot accidentally remove them
- Automatic migration of an existing installation from the previous (unsafe) location
- Automatic cleanup of stale Matterbridge lock files on start, so it comes back up cleanly after a hard host reboot
- Embeds the Matterbridge frontend as an ioBroker admin tab
- Ships and auto-installs the `matterbridge-iobroker-bridge` plugin: exposes ioBroker devices as Matter devices via a whitelist, ID-prefix filter (enable a whole adapter instance at once), or a device builder for switches, blinds (with current/target position), vacuum robots, temperature/humidity/contact/occupancy sensors, and dimmers
- `control.installPlugin` / `control.removePlugin` states to manage additional Matterbridge plugins independently of Matterbridge's own (unreliable) internal installer

## Installation

Install via the ioBroker Admin UI, or from a local checkout:

```bash
npm install /path/to/ioBroker.matterbridge --production
iobroker upload matterbridge
iobroker add matterbridge
```

## Configuration

| Setting | Description |
|---------|-------------|
| Frontend port | Matterbridge web frontend port (default: 8283) |
| Matter port | Matter network port (default: 5540) |
| mDNS interface | Optionally restrict mDNS advertisement to a specific network interface |
| Autostart | Start Matterbridge automatically when the adapter starts (default: on) |
| npm mirror | Alternative npm registry for installation, if needed |
| Node.js major version | Node.js major version to download for the isolated runtime (default: 24) |
| iobroker-data directory | Override the default `iobroker-data` location if your installation uses a non-standard path |

The actual Matterbridge configuration (plugins, devices, bridges, pairing) is done through the embedded admin tab, which shows the Matterbridge web frontend.

## Datapoints

```
matterbridge.0.info.running            → Matterbridge process is running (read-only)
matterbridge.0.info.installed          → Matterbridge has been installed (read-only)
matterbridge.0.info.nodeRuntimeReady   → Isolated Node.js runtime is ready (read-only)
matterbridge.0.control.restart         → Restart Matterbridge (button)
matterbridge.0.control.stop            → Stop Matterbridge (button)
matterbridge.0.control.installPlugin   → Install & register a Matterbridge plugin by npm package name (writable)
matterbridge.0.control.removePlugin    → Remove a Matterbridge plugin by npm package name (writable)
```

### The bundled bridge plugin

`matterbridge-iobroker-bridge` connects directly to the ioBroker states/objects database (Redis protocol) and exposes selected ioBroker devices as Matter devices. It starts with zero active devices by default; devices are enabled via:

- a **whitelist** of individual state IDs,
- **ID prefixes**, to enable a whole adapter instance at once (e.g. `shelly.0.`),
- a **device builder**, to compose custom devices (switch, blind with position/target, vacuum, temperature/humidity/contact/occupancy sensor, dimmer) from arbitrary ioBroker states, independent of adapter/naming convention.

Its own configuration is done through the Matterbridge frontend (embedded admin tab), on the plugin's settings page.

## Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->

### 0.7.1 (2026-09-21)
- Translated all backend/log text, README, and admin UI to English (with German translation retained via i18n)
- Fixed `package.json`/`io-package.json` metadata for ioBroker repository review (author, license, repository, keywords, engines, dependency versions, adapter category, tier, news, licenseInformation)
- Added `xs/sm/md/lg/xl` size attributes to all `admin/jsonConfig.json` items
- Enabled i18n for the admin configuration UI (English and German translations)
- Added automatic cleanup of stale Matterbridge `matter.lock` files on start, so the process comes back up cleanly after a hard host reboot

### 0.7.0 (2026-09-15)
- Moved Matterbridge installation/storage/Node.js runtime from the adapter directory to `iobroker-data/matterbridge/`, with automatic migration of existing installations. Protects against npm install/prune operations triggered by updates of other adapters.

### 0.6.x
- Added automatic installation and registration of the bundled `matterbridge-iobroker-bridge` plugin
- Added the `dataDir` configuration option

### 0.5.x
- Added `-nosudo` flag to prevent Matterbridge's internal plugin installer from losing the isolated npm prefix via `sudo`'s environment reset
- Added adapter icon and configurable Matter port

### 0.2.x - 0.4.x
- Added isolated Node.js runtime download and management
- Added `control.installPlugin`/`control.removePlugin` states for managing Matterbridge plugins independently of Matterbridge's own (unreliable) install mechanism

### 0.1.0
- Initial release: install, start, stop, and embed Matterbridge as an ioBroker adapter with an admin tab

## License

MIT License

Copyright (c) 2026 Henrik Schönhofen (backfisch88) <henrik.schoenhofen@icloud.com>

See [LICENSE](LICENSE) for the full license text.
