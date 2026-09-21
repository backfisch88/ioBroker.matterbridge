'use strict';

/**
 * ioBroker.matterbridge
 * -----------------------
 * Installs, starts, monitors, and stops a native Matterbridge instance
 * as a child process. Does NOT implement any Matter logic itself - all
 * cluster/plugin management is handled by Matterbridge itself. Matterbridge
 * configuration (plugins, devices, bridges) is done via the embedded admin
 * tab (tab.html), not through this adapter.
 */

const utils = require('@iobroker/adapter-core');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');

class MatterbridgeAdapter extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'matterbridge' });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.child = null;
    this.restartTimer = null;
    this.stoppedByUser = false;
    this.backoffMs = 5000;

    // IMPORTANT: do NOT place this below __dirname (i.e. inside
    // /opt/iobroker/node_modules/...)! A manual or automatic "update
    // adapter" for ANY other adapter triggers an internal npm
    // install/prune at the root of /opt/iobroker - and npm's
    // deduplication/cleanup mechanism scans the ENTIRE node_modules tree,
    // incorrectly treats our seemingly isolated matterbridgeInstall folder
    // as "unreferenced", and deletes parts of it (this was the cause of
    // recurring, mysterious crashes/reversions we hit in production).
    // Store it under iobroker-data instead - ioBroker's own data/config
    // directory, completely outside the npm package tree and therefore
    // immune to this.
    const dataDir = this.config.dataDir || path.join(__dirname, '..', '..', 'iobroker-data');
    const mbDataDir = path.join(dataDir, 'matterbridge');
    this.mbInstallDir = path.join(mbDataDir, 'matterbridgeInstall');
    this.mbStorageDir = path.join(mbDataDir, 'matterbridgeStorage');
    this.nodeRuntimeDir = path.join(mbDataDir, 'nodeRuntime');
    this._migrateOldLocationIfNeeded(mbDataDir);

    this.mbBin = path.join(this.mbInstallDir, 'bin', 'matterbridge');

    // Own, isolated Node.js runtime ONLY for the Matterbridge child
    // process. Matterbridge (and its @matterbridge/* / @matter/*
    // dependencies) may require a newer Node.js version than the system
    // Node.js that runs ioBroker itself. To avoid touching the system
    // Node.js for ioBroker and other adapters, we download a self-
    // contained Node.js version on demand and use it exclusively for
    // Matterbridge (both for the npm installation and for running the
    // process).
    this.nodeMajor = this.config.nodeMajor || 24;
    this.nodeBin = path.join(this.nodeRuntimeDir, 'bin', 'node');
    this.nodeRuntimeBinDir = path.join(this.nodeRuntimeDir, 'bin');

    // Safety net: if the adapter's own Node.js process is terminated
    // hard (e.g. because js-controller does not wait for onUnload),
    // still try to take the Matterbridge child process down with it
    // synchronously - otherwise it would remain as an orphan process
    // holding the port.
    const killChildSync = () => {
      if (this.child) {
        try { this.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      }
    };
    process.on('exit', killChildSync);
    process.on('SIGINT', killChildSync);
    process.on('SIGTERM', killChildSync);
  }

  /**
   * Migrates an existing installation from the old location (below the
   * adapter directory in /opt/iobroker/node_modules/... - vulnerable to
   * npm install/prune on EVERY adapter update) to the new, safe location
   * under iobroker-data. Runs synchronously in the constructor, BEFORE
   * the new paths are used for the first time. Any existing installation
   * (pairing, plugins, Node runtime) is fully preserved - no manual
   * action required.
   */
  _migrateOldLocationIfNeeded(mbDataDir) {
    const oldInstall = path.join(__dirname, 'matterbridgeInstall');
    const oldStorage = path.join(__dirname, 'matterbridgeStorage');
    const oldNodeRuntime = path.join(__dirname, 'nodeRuntime');
    const newInstall = path.join(mbDataDir, 'matterbridgeInstall');

    if (fs.existsSync(newInstall)) return; // already migrated, or fresh install

    const anyOldExists = fs.existsSync(oldInstall) || fs.existsSync(oldStorage) || fs.existsSync(oldNodeRuntime);
    if (!anyOldExists) return; // nothing to migrate (fresh install)

    try {
      fs.mkdirSync(mbDataDir, { recursive: true });
      for (const [src, name] of [
        [oldInstall, 'matterbridgeInstall'],
        [oldStorage, 'matterbridgeStorage'],
        [oldNodeRuntime, 'nodeRuntime'],
      ]) {
        if (fs.existsSync(src)) {
          fs.renameSync(src, path.join(mbDataDir, name));
        }
      }
      this.log.info(`Migrated existing Matterbridge installation from ${__dirname} to ${mbDataDir} (protects against npm install/prune during other adapters' updates).`);
    } catch (err) {
      // this.log may not be ready yet at this point (still inside the
      // constructor, before super() has finished initializing logging) -
      // fall back to console.error in that case.
      const logFn = this.log?.error ? (msg) => this.log.error(msg) : (msg) => console.error(msg);
      logFn(`Failed to migrate the Matterbridge installation: ${err.message}. Please move it manually from ${__dirname} to ${mbDataDir}.`);
    }
  }

  async onReady() {
    this.subscribeStates('control.*');

    // IMPORTANT: in addition to the environment variables we set
    // ourselves when spawning Matterbridge, we also persist the npm
    // prefix in the current user's own ~/.npmrc. Reason: Matterbridge's
    // OWN internal "install a plugin" mechanism (the button in its
    // frontend) has proven unreliable at inheriting environment
    // variables - it kept landing at the system default location despite
    // NPM_CONFIG_PREFIX being set correctly when Matterbridge itself was
    // spawned. npm, on the other hand, ALWAYS reads ~/.npmrc regardless
    // of how/by which code it is invoked - more robust than relying on
    // env inheritance through third-party code.
    await this.ensureNpmrcPrefix();

    const nodeRuntimeInstalled = await this.checkNodeRuntimeInstalled();
    await this.setStateAsync('info.nodeRuntimeReady', nodeRuntimeInstalled, true);

    if (!nodeRuntimeInstalled) {
      this.log.info(`Isolated Node.js ${this.nodeMajor} runtime for Matterbridge not found - downloading it now (only used for Matterbridge, the system Node.js is left untouched)`);
      try {
        await this.installNodeRuntime();
        await this.setStateAsync('info.nodeRuntimeReady', true, true);
        this.log.info('Node.js runtime for Matterbridge installed successfully');
      } catch (err) {
        this.log.error(`Failed to download/install the isolated Node.js runtime: ${err.message}. Matterbridge cannot run reliably without a compatible Node.js version.`);
        return;
      }
    }

    const installed = await this.checkInstalled();
    await this.setStateAsync('info.installed', installed, true);

    if (!installed) {
      this.log.info('Matterbridge is not installed yet - installing it now locally via npm');
      try {
        await this.installMatterbridge();
        await this.setStateAsync('info.installed', true, true);
      } catch (err) {
        this.log.error(`Installation failed: ${err.message}. Please check manually (e.g. permissions for a global npm installation).`);
        return;
      }
    }

    try {
      await this.ensureBridgePlugin();
    } catch (err) {
      this.log.error(`Could not install the bundled ioBroker bridge plugin: ${err.message}`);
    }

    if (this.config.autostart !== false) {
      this.startMatterbridge();
    }
  }

  /**
   * Automatically installs and registers the bundled generic
   * "matterbridge-iobroker-bridge" plugin if it is not present yet, so
   * that no manual extra step is required out of the box to expose
   * ioBroker devices (switches, blinds, Roborock vacuums, ...) through
   * Matterbridge. The plugin itself starts with zero active devices by
   * default (pure opt-in via "whiteList"/"idPrefixes" in the plugin
   * configuration).
   */
  async ensureBridgePlugin() {
    const pluginName = 'matterbridge-iobroker-bridge';
    const pluginDir = path.join(this.mbInstallDir, 'lib', 'node_modules', pluginName);
    const pkgPath = path.join(pluginDir, 'package.json');

    if (fs.existsSync(pkgPath)) {
      this.log.debug(`Bundled plugin "${pluginName}" is already present.`);
      return;
    }

    this.log.info(`Installing bundled plugin "${pluginName}" (generic ioBroker device bridge)...`);
    const bundledDir = path.join(__dirname, 'bundledPlugins', pluginName);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.cpSync(bundledDir, pluginDir, { recursive: true });

    await new Promise((resolve, reject) => {
      exec('npm install --omit=dev', {
        cwd: pluginDir,
        maxBuffer: 1024 * 1024 * 10,
        env: {
          ...process.env,
          NPM_CONFIG_PREFIX: this.mbInstallDir,
          PATH: `${this.nodeRuntimeBinDir}:${process.env.PATH}`,
        },
      }, (err, stdout, stderr) => {
        if (err) {
          this.log.error(stderr);
          return reject(err);
        }
        resolve();
      });
    });

    await this.runMatterbridgeCli(['-add', pkgPath]);
    this.log.info(`Plugin "${pluginName}" installed and registered (0 devices active for now - selection happens via "whiteList"/"idPrefixes" in the plugin configuration in the Matterbridge frontend).`);
  }

  /**
   * Ensures that the personal ~/.npmrc of the user running the adapter
   * process contains a "prefix=" line pointing to our isolated
   * mbInstallDir. Idempotent: an existing, already-correct line is left
   * untouched; a deviating line is replaced (with a log message so
   * nothing is silently overwritten); other lines in the file are left
   * as-is.
   */
  async ensureNpmrcPrefix() {
    const npmrcPath = path.join(os.homedir(), '.npmrc');
    const desiredLine = `prefix=${this.mbInstallDir}`;

    let lines = [];
    try {
      const content = fs.readFileSync(npmrcPath, 'utf8');
      lines = content.split('\n');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn(`Could not read ${npmrcPath} (${err.message}) - trying to write it anyway.`);
      }
      lines = [];
    }

    const prefixLineIndex = lines.findIndex((l) => /^\s*prefix\s*=/.test(l));

    if (prefixLineIndex === -1) {
      lines.push(desiredLine);
      fs.writeFileSync(npmrcPath, lines.join('\n').replace(/\n+$/, '\n') || `${desiredLine}\n`);
      this.log.info(`~/.npmrc: added "prefix=${this.mbInstallDir}" (file: ${npmrcPath}). This ensures plugin installations via Matterbridge's own install button also land in the correct location.`);
      return;
    }

    if (lines[prefixLineIndex].trim() === desiredLine) {
      // already correct - nothing to do
      return;
    }

    this.log.warn(`~/.npmrc contained a deviating "prefix=" entry ("${lines[prefixLineIndex].trim()}") - setting it to "${desiredLine}" so Matterbridge plugin installations reliably land in the isolated directory.`);
    lines[prefixLineIndex] = desiredLine;
    fs.writeFileSync(npmrcPath, lines.join('\n'));
  }

  checkNodeRuntimeInstalled() {
    return new Promise((resolve) => {
      fs.access(this.nodeBin, fs.constants.X_OK, (err) => resolve(!err));
    });
  }

  /**
   * Determines the exact current filename for the requested Node.js
   * major version and platform/architecture from SHASUMS256.txt, downloads
   * the tarball, and extracts it in isolation into nodeRuntimeDir. Uses
   * only built-in Node.js facilities (https) plus the system "tar"
   * command, so no additional npm dependencies are required.
   */
  async installNodeRuntime() {
    const platform = os.platform(); // 'linux', 'darwin', ...
    const archRaw = os.arch(); // 'x64', 'arm64', ...

    if (platform !== 'linux' && platform !== 'darwin') {
      throw new Error(`Automatic Node.js runtime download is not supported on platform "${platform}". Please extract Node.js ${this.nodeMajor}.x into ${this.nodeRuntimeDir} manually.`);
    }
    if (archRaw !== 'x64' && archRaw !== 'arm64') {
      throw new Error(`Automatic Node.js runtime download is not supported on architecture "${archRaw}". Please extract Node.js ${this.nodeMajor}.x into ${this.nodeRuntimeDir} manually.`);
    }

    const tag = `${platform}-${archRaw}`; // e.g. "linux-x64"
    const indexBase = `https://nodejs.org/dist/latest-v${this.nodeMajor}.x`;

    this.log.info(`Looking up the current Node.js ${this.nodeMajor}.x version for ${tag}...`);
    const shasums = await this._httpGetText(`${indexBase}/SHASUMS256.txt`);

    const suffix = `-${tag}.tar.gz`;
    const line = shasums.split('\n').find((l) => l.trim().endsWith(suffix) && l.includes(`v${this.nodeMajor}.`));
    if (!line) {
      throw new Error(`Could not find a matching Node.js ${this.nodeMajor}.x file for ${tag} in SHASUMS256.txt.`);
    }
    const filename = line.trim().split(/\s+/)[1];
    const downloadUrl = `${indexBase}/${filename}`;
    this.log.info(`Downloading ${downloadUrl}...`);

    fs.rmSync(this.nodeRuntimeDir, { recursive: true, force: true });
    fs.mkdirSync(this.nodeRuntimeDir, { recursive: true });

    const tmpTarball = path.join(os.tmpdir(), filename);
    await this._httpDownloadFile(downloadUrl, tmpTarball);

    this.log.info('Extracting the Node.js runtime...');
    await new Promise((resolve, reject) => {
      exec(`tar -xzf "${tmpTarball}" -C "${this.nodeRuntimeDir}" --strip-components=1`, (err, stdout, stderr) => {
        fs.rm(tmpTarball, { force: true }, () => {});
        if (err) {
          this.log.error(stderr);
          return reject(err);
        }
        resolve();
      });
    });

    const ok = await this.checkNodeRuntimeInstalled();
    if (!ok) {
      throw new Error('Node.js binary not found/executable after extraction - the download may be incomplete.');
    }
  }

  _httpGetText(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          return resolve(this._httpGetText(res.headers.location, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} while fetching ${url}`));
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  _httpDownloadFile(url, destPath, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          return resolve(this._httpDownloadFile(res.headers.location, destPath, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} while downloading ${url}`));
        }
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve()));
        fileStream.on('error', reject);
      }).on('error', reject);
    });
  }

  checkInstalled() {
    return new Promise((resolve) => {
      fs.access(this.mbBin, fs.constants.X_OK, (err) => resolve(!err));
    });
  }

  installMatterbridge() {
    return new Promise((resolve, reject) => {
      // Clean start: remove leftovers from a previous failed attempt.
      fs.rmSync(this.mbInstallDir, { recursive: true, force: true });
      fs.mkdirSync(this.mbInstallDir, { recursive: true });

      const registryArg = this.config.npmMirror ? ` --registry=${this.config.npmMirror}` : '';
      // "-g" plus our own NPM_CONFIG_PREFIX instead of "--prefix": npm
      // treats this like a normal global installation (correct
      // resolution of optional dependencies such as @matterbridge/thread),
      // but it ends up entirely inside a folder owned by the iobroker
      // user - no EACCES needed. IMPORTANT: PATH is set so that npm/node
      // are resolved from the isolated Node.js runtime - not the system
      // Node.js - so that everything compiled/checked during installation
      // matches the version Matterbridge will actually run with later.
      const cmd = `npm install -g matterbridge --omit=dev${registryArg}`;
      exec(cmd, {
        maxBuffer: 1024 * 1024 * 10,
        env: {
          ...process.env,
          NPM_CONFIG_PREFIX: this.mbInstallDir,
          PATH: `${this.nodeRuntimeBinDir}:${process.env.PATH}`,
        },
      }, (err, stdout, stderr) => {
        if (err) {
          this.log.error(stderr);
          return reject(err);
        }
        this.log.info('Matterbridge installed successfully (user-local global prefix, isolated Node.js runtime)');
        resolve();
      });
    });
  }

  startMatterbridge() {
    if (this.child) {
      this.log.warn('Matterbridge is already running');
      return;
    }

    // Safety net: if a previous hard crash left a Matterbridge process
    // with this exact binary path running (one this adapter process no
    // longer knows about), clean it up first.
    exec(`pkill -9 -f "${this.mbBin}"`, () => {
      this._doStartMatterbridge();
    });
  }

  /**
   * Deletes all "matter.lock" files below mbStorageDir BEFORE a new
   * Matterbridge process is started. This adapter is the only legitimate
   * owner of that process - if we are starting fresh, any existing lock
   * file can no longer be held "for real" (e.g. after a hard host reboot
   * where the old process could not clean up its own lock file).
   * Recursive, since every plugin/Matter node has its own lock file in
   * its own subdirectory.
   */
  cleanupStaleLocks() {
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name === 'matter.lock') {
          try {
            fs.unlinkSync(full);
            this.log.info(`Removed stale lock file: ${full}`);
          } catch (err) {
            this.log.warn(`Could not remove lock file (${full}): ${err.message}`);
          }
        }
      }
    };
    walk(this.mbStorageDir);
  }

  _doStartMatterbridge() {
    const args = [
      this.mbBin,
      '--service',
      '-frontend', String(this.config.frontendPort || 8283),
      '-port', String(this.config.matterPort || 5540),
      '-homedir', this.mbStorageDir,
      // CRITICAL: without this flag, Matterbridge automatically prepends
      // "sudo" to its own internal "npm install" calls (e.g. via the
      // install button in the frontend) whenever PATH does not contain a
      // "/.nvm/versions/node/" segment (see spawnCommand.js in
      // @matterbridge/thread). Since we use our own isolated Node.js
      // runtime instead of nvm, this condition would always be true - and
      // "sudo" resets the environment by default (its own PATH from
      // /etc/sudoers), which would wipe our NPM_CONFIG_PREFIX and PATH
      // override on every internal install call. "-nosudo" is an
      // officially supported Matterbridge CLI flag that disables this
      // behavior cleanly, without patching Matterbridge files - so it
      // also survives Matterbridge updates.
      '-nosudo',
    ];

    // Only set when explicitly configured - otherwise Matterbridge
    // automatically picks the first suitable external interface.
    if (this.config.mdnsInterface) {
      args.push('-mdnsinterface', this.config.mdnsInterface);
    }

    // Important: we do NOT start "this.mbBin" directly (that would use
    // the system Node.js via the "#!/usr/bin/env node" shebang), but
    // explicitly run our isolated Node.js runtime as the interpreter.
    // This guarantees Matterbridge always runs with a compatible Node.js
    // version, regardless of which Node.js binary is otherwise on the
    // system PATH.
    this.cleanupStaleLocks();

    this.log.info(`Starting Matterbridge: ${this.nodeBin} ${args.join(' ')}`);
    this.child = spawn(this.nodeBin, args, {
      env: {
        ...process.env,
        NPM_CONFIG_PREFIX: this.mbInstallDir,
        PATH: `${this.nodeRuntimeBinDir}:${process.env.PATH}`,
      },
    });

    this.child.stdout.on('data', (data) => this.log.debug(`[matterbridge] ${data.toString().trim()}`));
    this.child.stderr.on('data', (data) => this.log.warn(`[matterbridge] ${data.toString().trim()}`));

    this.child.on('spawn', () => {
      this.backoffMs = 5000; // reset backoff after a successful start
      this.setStateAsync('info.running', true, true);
    });

    this.child.on('exit', (code, signal) => {
      this.setStateAsync('info.running', false, true);
      this.child = null;

      if (this.stoppedByUser) {
        this.stoppedByUser = false;
        return;
      }

      if (this.config.autoRestart !== false) {
        this.log.warn(`Matterbridge exited (code=${code}, signal=${signal}) - restarting in ${this.backoffMs / 1000}s`);
        this.restartTimer = setTimeout(() => {
          this.startMatterbridge();
          this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60 * 1000); // exponential backoff, max 5 min
        }, this.backoffMs);
      } else {
        this.log.info(`Matterbridge exited (code=${code}, signal=${signal})`);
      }
    });
  }

  stopMatterbridge() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.stoppedByUser = true;
      try {
        this.child.kill('SIGKILL');
      } catch (e) {
        // process may already be gone - ignore
      }
    }
  }

  onStateChange(id, state) {
    if (!state || state.ack) return;

    if (id.endsWith('control.restart') && state.val) {
      this.log.info('Manual restart requested');
      this.stopMatterbridge();
      setTimeout(() => this.startMatterbridge(), 2000);
      this.setStateAsync(id, false, true);
    }

    if (id.endsWith('control.stop') && state.val) {
      this.log.info('Manual stop requested');
      this.stopMatterbridge();
      this.setStateAsync(id, false, true);
    }

    if (id.endsWith('control.installPlugin') && state.val) {
      const pluginName = String(state.val).trim();
      this.setStateAsync(id, '', true);
      if (pluginName) {
        this.installAndAddPlugin(pluginName).catch((err) => {
          this.log.error(`Failed to install plugin "${pluginName}": ${err.message}`);
        });
      }
    }

    if (id.endsWith('control.removePlugin') && state.val) {
      const pluginName = String(state.val).trim();
      this.setStateAsync(id, '', true);
      if (pluginName) {
        this.removePlugin(pluginName).catch((err) => {
          this.log.error(`Could not remove plugin "${pluginName}": ${err.message}`);
        });
      }
    }
  }

  /**
   * Runs a Matterbridge CLI call (e.g. "-add"/"-remove") explicitly with
   * the isolated Node.js runtime and the correct storage directory,
   * without requiring anyone to manually set $MB/-homedir in a shell.
   */
  runMatterbridgeCli(args) {
    return new Promise((resolve, reject) => {
      const fullArgs = [this.mbBin, '-homedir', this.mbStorageDir, ...args];
      this.log.info(`Running: ${this.nodeBin} ${fullArgs.join(' ')}`);
      exec(`"${this.nodeBin}" ${fullArgs.map((a) => `"${a}"`).join(' ')}`, {
        maxBuffer: 1024 * 1024 * 10,
        env: {
          ...process.env,
          NPM_CONFIG_PREFIX: this.mbInstallDir,
          PATH: `${this.nodeRuntimeBinDir}:${process.env.PATH}`,
        },
      }, (err, stdout, stderr) => {
        if (err) {
          this.log.error(stderr || err.message);
          return reject(err);
        }
        this.log.debug(stdout);
        resolve(stdout);
      });
    });
  }

  /**
   * Runs "npm install -g <plugin>" explicitly with the isolated Node.js
   * runtime and our own prefix (independent of Matterbridge's own,
   * unreliable internal install mechanism in the frontend), then
   * registers it with Matterbridge directly.
   */
  installAndAddPlugin(pluginName) {
    return new Promise((resolve, reject) => {
      const registryArg = this.config.npmMirror ? ` --registry=${this.config.npmMirror}` : '';
      const cmd = `npm install -g ${pluginName}@latest --omit=dev${registryArg}`;
      this.log.info(`Installing plugin "${pluginName}" (isolated Node.js/npm version, correct prefix)...`);
      exec(cmd, {
        maxBuffer: 1024 * 1024 * 10,
        env: {
          ...process.env,
          NPM_CONFIG_PREFIX: this.mbInstallDir,
          PATH: `${this.nodeRuntimeBinDir}:${process.env.PATH}`,
        },
      }, async (err, stdout, stderr) => {
        if (err) {
          this.log.error(stderr);
          return reject(err);
        }
        this.log.info(`Plugin "${pluginName}" installed, registering it with Matterbridge...`);
        try {
          const pkgPath = path.join(this.mbInstallDir, 'lib', 'node_modules', pluginName, 'package.json');
          await this.runMatterbridgeCli(['-add', pkgPath]);
          this.log.info(`Plugin "${pluginName}" added successfully. Matterbridge needs to be restarted for it to load.`);
          resolve();
        } catch (addErr) {
          reject(addErr);
        }
      });
    });
  }

  async removePlugin(pluginName) {
    const pkgPath = path.join(this.mbInstallDir, 'lib', 'node_modules', pluginName, 'package.json');
    await this.runMatterbridgeCli(['-remove', pkgPath]);
    this.log.info(`Plugin "${pluginName}" removed from Matterbridge (files on disk are kept - delete them manually if needed).`);
  }

  onUnload(callback) {
    try {
      this.stopMatterbridge();
      callback();
    } catch (e) {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new MatterbridgeAdapter(options);
} else {
  new MatterbridgeAdapter();
}
