# ioBroker.matterbridge

[![NPM version](https://img.shields.io/npm/v/iobroker.matterbridge.svg)](https://www.npmjs.com/package/iobroker.matterbridge)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Runs and supervises a native [Matterbridge](https://github.com/Luligu/matterbridge) instance as a child process and embeds its web UI as an ioBroker admin tab. Matterbridge exposes devices to Matter controllers such as Apple Home, Google Home, Amazon Alexa, and Home Assistant.

This adapter does not implement any Matter logic itself - all cluster and plugin management is handled by Matterbridge. The adapter's job is to:

- install and keep an isolated Node.js runtime for Matterbridge (independent of the system Node.js used by ioBroker),
- install and start/stop/restart the Matterbridge process,
- automatically install and register the bundled [matterbridge-iobroker-bridge](https://github.com/backfisch88/ioBroker.matterbridge) plugin, which exposes ioBroker states (switches, blinds, vacuum robots, sensors, and more via a configurable device builder) as Matter devices,
- embed the Matterbridge frontend as an admin tab for configuration.

## Why a separate Node.js runtime?

Matterbridge and its `@matterbridge/*`/`@matter/*` dependencies may require a newer Node.js version than the one ioBroker itself runs on. To avoid touching the system Node.js (which could affect other adapters), this adapter downloads a self-contained Node.js version on demand and uses it exclusively for the Matterbridge process and its plugin installations.

## Data location

Matterbridge's installation, storage, and Node.js runtime are stored under `iobroker-data/matterbridge/` - intentionally **not** inside the adapter's own directory under `node_modules`. This is because any `npm install`/`npm prune` operation triggered by updating **any other** ioBroker adapter scans the entire `node_modules` tree and could otherwise remove parts of an installation living there. Storing it under `iobroker-data` keeps it outside that tree and therefore safe.

Existing installations from the old location are migrated automatically and transparently on first start after updating.

## Configuration

- **Frontend port / Matter port**: network ports used by Matterbridge.
- **mDNS interface**: optionally restrict mDNS advertisement to a specific network interface.
- **Autostart**: start Matterbridge automatically when the adapter starts.
- **npm mirror**: use an alternative npm registry for installation, if needed.
- **Node.js major version**: which Node.js major version to download for the isolated runtime (default: 24).
- **iobroker-data directory**: override the default `iobroker-data` location if your installation uses a non-standard path.

The actual Matterbridge configuration (plugins, devices, bridges, pairing) is done through the embedded admin tab, which shows the Matterbridge web frontend.

### States

- `info.running` - whether the Matterbridge process is currently running
- `info.installed` - whether Matterbridge has been installed
- `info.nodeRuntimeReady` - whether the isolated Node.js runtime is ready
- `control.restart` - button to restart Matterbridge
- `control.stop` - button to stop Matterbridge
- `control.installPlugin` - write an npm package name to install and register a Matterbridge plugin
- `control.removePlugin` - write an npm package name to remove a Matterbridge plugin

## The bundled bridge plugin

`matterbridge-iobroker-bridge` connects directly to the ioBroker states/objects database (Redis protocol) and exposes selected ioBroker devices as Matter devices. It starts with zero active devices by default; devices are enabled via a whitelist, ID prefixes (to enable a whole adapter instance at once, e.g. `shelly.0.`), or a device builder for composing custom devices (switches, blinds with position/target, vacuum robots, temperature/humidity/contact/occupancy sensors, dimmers) from arbitrary ioBroker states.

## License

MIT License

Copyright (c) 2026 Henrik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Changelog

### 0.7.1 (2026-09-21)

- Translated all backend/log text, README, and admin UI to English (with German translation retained via i18n).
- Fixed `package.json`/`io-package.json` metadata for ioBroker repository review (author, license, repository, keywords, engines, dependency versions, adapter category, tier, news, licenseInformation).
- Added `xs/sm/md/lg/xl` size attributes to all `admin/jsonConfig.json` items.
- Enabled i18n for the admin configuration UI (English and German translations).
- Added automatic cleanup of stale Matterbridge `matter.lock` files on start, so the process comes back up cleanly after a hard host reboot.

### 0.7.0 (2026-09-15)

- Moved Matterbridge installation/storage/Node.js runtime from the adapter directory to `iobroker-data/matterbridge/`, with automatic migration of existing installations. Protects against npm install/prune operations triggered by updates of other adapters.

### 0.6.x

- Added automatic installation and registration of the bundled `matterbridge-iobroker-bridge` plugin.
- Added the `dataDir` configuration option.

### 0.5.x

- Added `-nosudo` flag to prevent Matterbridge's internal plugin installer from losing the isolated npm prefix via `sudo`'s environment reset.
- Added adapter icon and configurable Matter port.

### 0.2.x - 0.4.x

- Added isolated Node.js runtime download and management.
- Added `control.installPlugin`/`control.removePlugin` states for managing Matterbridge plugins independently of Matterbridge's own (unreliable) install mechanism.

### 0.1.0

- Initial release: install, start, stop, and embed Matterbridge as an ioBroker adapter with an admin tab.
