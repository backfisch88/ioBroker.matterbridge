# Older Changelog

This file contains changelog entries older than what is currently kept in [README.md](README.md).

Covers releases up to and including 0.6.x:

- Added automatic installation and registration of the bundled `matterbridge-iobroker-bridge` plugin
- Added the `dataDir` configuration option
- Added `-nosudo` flag to prevent Matterbridge's internal plugin installer from losing the isolated npm prefix via `sudo`'s environment reset
- Added adapter icon and configurable Matter port
- Added isolated Node.js runtime download and management
- Added `control.installPlugin`/`control.removePlugin` states for managing Matterbridge plugins independently of Matterbridge's own (unreliable) install mechanism

### 0.1.0
- Initial release: install, start, stop, and embed Matterbridge as an ioBroker adapter with an admin tab
