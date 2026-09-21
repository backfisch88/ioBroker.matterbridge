'use strict';

/**
 * ioBroker.matterbridge
 * -----------------------
 * Installiert, startet, überwacht und stoppt eine native Matterbridge-
 * Instanz als Kindprozess. Bindet KEINE eigene Matter-Logik ein - die
 * komplette Cluster-/Plugin-Verwaltung übernimmt Matterbridge selbst.
 * Die Konfiguration von Matterbridge (Plugins, Geräte, Bridges) läuft
 * über den eingebetteten Admin-Tab (tab.html), nicht über diesen Adapter.
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

    // WICHTIG: NICHT mehr unterhalb von __dirname (also innerhalb von
    // /opt/iobroker/node_modules/...) ablegen! Ein manuelles oder
    // automatisches "Adapter aktualisieren" fuer IRGENDEINEN anderen
    // Adapter loest bei ioBroker intern ein npm install/prune auf Root-
    // Ebene von /opt/iobroker aus - und npm's Deduplizierungs-/Aufraeum-
    // Mechanismus durchsucht dabei den GESAMTEN node_modules-Baum, findet
    // unseren isoliert wirkenden matterbridgeInstall-Ordner faelschlich als
    // "nicht referenziert" und loescht Teile davon (das war die Ursache
    // fuer die immer wiederkehrenden mysterioesen Abstuerze/Rueckspruenge
    // im Laufe des heutigen Tages). Stattdessen unter iobroker-data
    // ablegen - das ist ioBrokers eigener Daten-/Konfigurationsordner,
    // vollkommen ausserhalb des npm-Paketbaums, also immun dagegen.
    const dataDir = this.config.dataDir || path.join(__dirname, '..', '..', 'iobroker-data');
    const mbDataDir = path.join(dataDir, 'matterbridge');
    this.mbInstallDir = path.join(mbDataDir, 'matterbridgeInstall');
    this.mbStorageDir = path.join(mbDataDir, 'matterbridgeStorage');
    this.nodeRuntimeDir = path.join(mbDataDir, 'nodeRuntime');
    this._migrateOldLocationIfNeeded(mbDataDir);

    this.mbBin = path.join(this.mbInstallDir, 'bin', 'matterbridge');

    // Isolierte, eigene Node.js-Laufzeit NUR fuer den Matterbridge-Kindprozess.
    // Matterbridge (bzw. dessen @matterbridge/* / @matter/* Abhaengigkeiten)
    // kann eine neuere Node-Version voraussetzen als das System-Node, mit dem
    // ioBroker selbst laeuft. Um das System-Node fuer ioBroker und andere
    // Adapter NICHT anzufassen, laden wir bei Bedarf eine eigene, in sich
    // abgeschlossene Node-Version herunter und benutzen sie ausschliesslich
    // fuer Matterbridge (Installation per npm UND Start des Prozesses).
    this.nodeMajor = this.config.nodeMajor || 24;
    this.nodeBin = path.join(this.nodeRuntimeDir, 'bin', 'node');
    this.nodeRuntimeBinDir = path.join(this.nodeRuntimeDir, 'bin');

    // Sicherheitsnetz: falls der Adapter-Node-Prozess selbst hart beendet
    // wird (z.B. weil js-controller nicht auf onUnload wartet), trotzdem
    // versuchen, den Matterbridge-Kindprozess synchron mitzunehmen -
    // sonst bleibt er als Orphan-Prozess auf dem Port hängen.
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
   * Migriert eine bestehende Installation vom alten Ort (unterhalb des
   * Adapter-Ordners in /opt/iobroker/node_modules/... - anfaellig fuer
   * npm install/prune bei JEDEM Adapter-Update) zum neuen, sicheren Ort
   * unter iobroker-data. Laeuft synchron im Constructor, VOR dem ersten
   * Zugriff auf die neuen Pfade. Bereits existierende Installationen
   * (Pairing, Plugins, Node-Runtime) bleiben dabei vollstaendig erhalten -
   * kein manueller Eingriff noetig.
   */
  _migrateOldLocationIfNeeded(mbDataDir) {
    const oldInstall = path.join(__dirname, 'matterbridgeInstall');
    const oldStorage = path.join(__dirname, 'matterbridgeStorage');
    const oldNodeRuntime = path.join(__dirname, 'nodeRuntime');
    const newInstall = path.join(mbDataDir, 'matterbridgeInstall');

    if (fs.existsSync(newInstall)) return; // Migration schon erledigt oder Frischinstallation

    const anyOldExists = fs.existsSync(oldInstall) || fs.existsSync(oldStorage) || fs.existsSync(oldNodeRuntime);
    if (!anyOldExists) return; // Nichts zu migrieren (Frischinstallation)

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
      this.log.info(`Bestehende Matterbridge-Installation von ${__dirname} nach ${mbDataDir} migriert (Schutz vor npm install/prune bei anderen Adapter-Updates).`);
    } catch (err) {
      // Log erst nach super() verfuegbar - hier ggf. noch nicht, daher
      // Fallback auf console.error falls this.log noch nicht bereitsteht.
      const logFn = this.log?.error ? (msg) => this.log.error(msg) : (msg) => console.error(msg);
      logFn(`Migration der Matterbridge-Installation fehlgeschlagen: ${err.message}. Bitte manuell von ${__dirname} nach ${mbDataDir} verschieben.`);
    }
  }

  async onReady() {
    this.subscribeStates('control.*');

    // WICHTIG: Zusaetzlich zu den Umgebungsvariablen, die wir selbst beim
    // Spawnen von Matterbridge setzen, tragen wir den Prefix auch dauerhaft
    // in die persoenliche ~/.npmrc des aktuellen Users (des Users, unter dem
    // dieser Adapter-Prozess laeuft) ein. Grund: Matterbridges EIGENER
    // interner "Install a plugin"-Mechanismus (Button im Frontend) hat sich
    // als nicht zuverlaessig env-vererbend erwiesen - er landete trotz
    // korrekt gesetztem NPM_CONFIG_PREFIX beim Spawnen von Matterbridge immer
    // wieder am System-Standard-Ort. ~/.npmrc wird von npm dagegen IMMER
    // gelesen, unabhaengig davon, wie/von welchem Code npm aufgerufen wird -
    // das ist robuster als sich auf Env-Vererbung durch fremden Code zu
    // verlassen.
    await this.ensureNpmrcPrefix();

    const nodeRuntimeInstalled = await this.checkNodeRuntimeInstalled();
    await this.setStateAsync('info.nodeRuntimeReady', nodeRuntimeInstalled, true);

    if (!nodeRuntimeInstalled) {
      this.log.info(`Isolierte Node.js-${this.nodeMajor}-Laufzeit fuer Matterbridge nicht gefunden - lade sie jetzt herunter (nur fuer Matterbridge, System-Node bleibt unberuehrt)`);
      try {
        await this.installNodeRuntime();
        await this.setStateAsync('info.nodeRuntimeReady', true, true);
        this.log.info('Node.js-Laufzeit fuer Matterbridge erfolgreich installiert');
      } catch (err) {
        this.log.error(`Download/Installation der isolierten Node.js-Laufzeit fehlgeschlagen: ${err.message}. Matterbridge kann ohne kompatible Node-Version nicht zuverlaessig laufen.`);
        return;
      }
    }

    const installed = await this.checkInstalled();
    await this.setStateAsync('info.installed', installed, true);

    if (!installed) {
      this.log.info('Matterbridge ist noch nicht installiert - installiere jetzt lokal per npm');
      try {
        await this.installMatterbridge();
        await this.setStateAsync('info.installed', true, true);
      } catch (err) {
        this.log.error(`Installation fehlgeschlagen: ${err.message}. Bitte manuell prüfen (z.B. Rechte für globale npm-Installation).`);
        return;
      }
    }

    try {
      await this.ensureBridgePlugin();
    } catch (err) {
      this.log.error(`Mitgeliefertes ioBroker-Bridge-Plugin konnte nicht installiert werden: ${err.message}`);
    }

    if (this.config.autostart !== false) {
      this.startMatterbridge();
    }
  }

  /**
   * Installiert und registriert das mitgelieferte generische
   * "matterbridge-iobroker-bridge"-Plugin automatisch, falls es noch nicht
   * vorhanden ist - damit ist ab Werk kein manueller Zusatzschritt mehr
   * noetig, um ioBroker-Geraete (Schalter, Rollos, Roborock-Sauger, ...)
   * ueber Matterbridge bereitzustellen. Das Plugin selbst startet
   * standardmaessig mit null aktiven Geraeten (reines Opt-in ueber
   * "whiteList"/"idPrefixes" in der Plugin-Config).
   */
  async ensureBridgePlugin() {
    const pluginName = 'matterbridge-iobroker-bridge';
    const pluginDir = path.join(this.mbInstallDir, 'lib', 'node_modules', pluginName);
    const pkgPath = path.join(pluginDir, 'package.json');

    if (fs.existsSync(pkgPath)) {
      this.log.debug(`Mitgeliefertes Plugin "${pluginName}" bereits vorhanden.`);
      return;
    }

    this.log.info(`Installiere mitgeliefertes Plugin "${pluginName}" (generische ioBroker-Geraete-Bridge)...`);
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
    this.log.info(`Plugin "${pluginName}" installiert und registriert (aktuell 0 Geraete aktiv - Auswahl erfolgt ueber "whiteList"/"idPrefixes" in der Plugin-Config im Matterbridge-Frontend).`);
  }

  /**
   * Sorgt dafuer, dass die persoenliche ~/.npmrc des Users, unter dem der
   * Adapter-Prozess laeuft, eine "prefix="-Zeile enthaelt, die auf unseren
   * isolierten mbInstallDir zeigt. Idempotent: bestehende, bereits korrekte
   * Zeile wird nicht angefasst; eine abweichende Zeile wird ersetzt (mit
   * Logausgabe, damit nichts still ueberschrieben wird); andere Zeilen in
   * der Datei bleiben unangetastet.
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
        this.log.warn(`Konnte ${npmrcPath} nicht lesen (${err.message}) - versuche trotzdem, sie neu zu schreiben.`);
      }
      lines = [];
    }

    const prefixLineIndex = lines.findIndex((l) => /^\s*prefix\s*=/.test(l));

    if (prefixLineIndex === -1) {
      lines.push(desiredLine);
      fs.writeFileSync(npmrcPath, lines.join('\n').replace(/\n+$/, '\n') || `${desiredLine}\n`);
      this.log.info(`~/.npmrc: "prefix=${this.mbInstallDir}" ergaenzt (Datei: ${npmrcPath}). Dadurch landen auch Plugin-Installationen ueber Matterbridges eigenen Install-Button garantiert am richtigen Ort.`);
      return;
    }

    if (lines[prefixLineIndex].trim() === desiredLine) {
      // Bereits korrekt - nichts zu tun.
      return;
    }

    this.log.warn(`~/.npmrc enthielt einen abweichenden "prefix="-Eintrag ("${lines[prefixLineIndex].trim()}") - wird auf "${desiredLine}" gesetzt, damit Matterbridge-Plugin-Installationen zuverlaessig im isolierten Verzeichnis landen.`);
    lines[prefixLineIndex] = desiredLine;
    fs.writeFileSync(npmrcPath, lines.join('\n'));
  }

  checkNodeRuntimeInstalled() {
    return new Promise((resolve) => {
      fs.access(this.nodeBin, fs.constants.X_OK, (err) => resolve(!err));
    });
  }

  /**
   * Ermittelt aus SHASUMS256.txt der gewuenschten Node-Major-Version den
   * exakten aktuellen Dateinamen fuer die passende Plattform/Architektur,
   * laedt das Tarball herunter und entpackt es isoliert nach nodeRuntimeDir.
   * Rein mit Node-Bordmitteln (https) + dem System-"tar"-Kommando, damit
   * keine zusaetzlichen npm-Abhaengigkeiten noetig sind.
   */
  async installNodeRuntime() {
    const platform = os.platform(); // 'linux', 'darwin', ...
    const archRaw = os.arch(); // 'x64', 'arm64', ...

    if (platform !== 'linux' && platform !== 'darwin') {
      throw new Error(`Automatischer Node-Runtime-Download wird fuer Plattform "${platform}" nicht unterstuetzt. Bitte manuell Node ${this.nodeMajor}.x nach ${this.nodeRuntimeDir} entpacken.`);
    }
    if (archRaw !== 'x64' && archRaw !== 'arm64') {
      throw new Error(`Automatischer Node-Runtime-Download wird fuer Architektur "${archRaw}" nicht unterstuetzt. Bitte manuell Node ${this.nodeMajor}.x nach ${this.nodeRuntimeDir} entpacken.`);
    }

    const tag = `${platform}-${archRaw}`; // z.B. "linux-x64"
    const indexBase = `https://nodejs.org/dist/latest-v${this.nodeMajor}.x`;

    this.log.info(`Suche aktuelle Node.js ${this.nodeMajor}.x Version fuer ${tag}...`);
    const shasums = await this._httpGetText(`${indexBase}/SHASUMS256.txt`);

    const suffix = `-${tag}.tar.gz`;
    const line = shasums.split('\n').find((l) => l.trim().endsWith(suffix) && l.includes(`v${this.nodeMajor}.`));
    if (!line) {
      throw new Error(`Konnte keine passende Node ${this.nodeMajor}.x Datei fuer ${tag} in SHASUMS256.txt finden.`);
    }
    const filename = line.trim().split(/\s+/)[1];
    const downloadUrl = `${indexBase}/${filename}`;
    this.log.info(`Lade ${downloadUrl} herunter...`);

    fs.rmSync(this.nodeRuntimeDir, { recursive: true, force: true });
    fs.mkdirSync(this.nodeRuntimeDir, { recursive: true });

    const tmpTarball = path.join(os.tmpdir(), filename);
    await this._httpDownloadFile(downloadUrl, tmpTarball);

    this.log.info('Entpacke Node.js-Laufzeit...');
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
      throw new Error('Node-Binary nach dem Entpacken nicht gefunden/ausfuehrbar - Download evtl. unvollstaendig.');
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
          return reject(new Error(`HTTP ${res.statusCode} beim Abruf von ${url}`));
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
          return reject(new Error(`HTTP ${res.statusCode} beim Download von ${url}`));
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
      // Sauberer Neustart: Reste eines vorherigen fehlgeschlagenen Versuchs entfernen.
      fs.rmSync(this.mbInstallDir, { recursive: true, force: true });
      fs.mkdirSync(this.mbInstallDir, { recursive: true });

      const registryArg = this.config.npmMirror ? ` --registry=${this.config.npmMirror}` : '';
      // "-g" + eigener NPM_CONFIG_PREFIX statt "--prefix": npm behandelt das
      // wie eine normale globale Installation (korrekte Auflösung optionaler
      // Abhängigkeiten wie bei @matterbridge/thread), landet aber komplett
      // in einem Ordner, der dem iobroker-User gehört - kein EACCES nötig.
      // WICHTIG: PATH wird so gesetzt, dass npm/node aus der isolierten
      // Node-Runtime verwendet werden - nicht das System-Node -, damit alle
      // waehrend der Installation kompilierten/geprueften Teile zur Version
      // passen, mit der Matterbridge spaeter auch tatsaechlich laeuft.
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
        this.log.info('Matterbridge erfolgreich installiert (user-lokaler globaler Prefix, isolierte Node-Runtime)');
        resolve();
      });
    });
  }

  startMatterbridge() {
    if (this.child) {
      this.log.warn('Matterbridge läuft bereits');
      return;
    }

    // Absicherung: falls durch einen vorherigen harten Absturz noch ein
    // Matterbridge-Prozess mit genau diesem Binary-Pfad übrig ist (den
    // dieser Adapter-Prozess selbst nicht mehr kennt), erst aufräumen.
    exec(`pkill -9 -f "${this.mbBin}"`, () => {
      this._doStartMatterbridge();
    });
  }

  /**
   * Loescht alle "matter.lock"-Dateien unterhalb von mbStorageDir, BEVOR
   * ein neuer Matterbridge-Prozess gestartet wird. Unser Adapter ist der
   * einzige legitime Besitzer dieses Prozesses - wenn wir gerade neu
   * starten, kann keine bestehende Lock-Datei noch "echt" gehalten werden
   * (z.B. nach einem harten Host-Reboot, bei dem der alte Prozess seine
   * eigene Sperrdatei nicht mehr aufraeumen konnte). Rekursiv, da jedes
   * Plugin/jeder Matter-Knoten seine eigene Lock-Datei in einem eigenen
   * Unterordner hat.
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
            this.log.info(`Verwaiste Sperrdatei entfernt: ${full}`);
          } catch (err) {
            this.log.warn(`Konnte Sperrdatei nicht entfernen (${full}): ${err.message}`);
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
      // KRITISCH: Ohne dieses Flag stellt Matterbridge seinen eigenen
      // internen "npm install"-Aufrufen (z.B. ueber den Install-Button im
      // Frontend) automatisch ein "sudo" voran, sobald der PATH keinen
      // "/.nvm/versions/node/"-Anteil enthaelt (siehe spawnCommand.js in
      // @matterbridge/thread). Da wir eine eigene, isolierte Node-Runtime
      // statt nvm verwenden, wuerde genau das immer zutreffen - und "sudo"
      // setzt standardmaessig die Umgebung zurueck (eigener PATH aus
      // /etc/sudoers), wodurch unser NPM_CONFIG_PREFIX und PATH-Override
      // bei jedem internen Install-Aufruf verloren gingen. "-nosudo" ist
      // ein offiziell unterstuetztes Matterbridge-CLI-Flag und deaktiviert
      // dieses Verhalten sauber, ohne Matterbridge-Dateien zu patchen -
      // uebersteht also auch Matterbridge-Updates.
      '-nosudo',
    ];

    // Nur setzen, wenn explizit konfiguriert - sonst wählt Matterbridge
    // automatisch das erste passende externe Interface.
    if (this.config.mdnsInterface) {
      args.push('-mdnsinterface', this.config.mdnsInterface);
    }

    // Wichtig: Wir starten NICHT "this.mbBin" direkt (das wuerde ueber den
    // Shebang "#!/usr/bin/env node" das System-Node verwenden), sondern
    // explizit unsere isolierte Node-Runtime als Interpreter. So laeuft
    // Matterbridge garantiert mit einer kompatiblen Node-Version, egal
    // welches Node-Binary sonst im System-PATH steht.
    this.cleanupStaleLocks();

    this.log.info(`Starte Matterbridge: ${this.nodeBin} ${args.join(' ')}`);
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
      this.backoffMs = 5000; // Backoff zurücksetzen bei erfolgreichem Start
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
        this.log.warn(`Matterbridge beendet (code=${code}, signal=${signal}) - Neustart in ${this.backoffMs / 1000}s`);
        this.restartTimer = setTimeout(() => {
          this.startMatterbridge();
          this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60 * 1000); // Exponential Backoff, max 5min
        }, this.backoffMs);
      } else {
        this.log.info(`Matterbridge beendet (code=${code}, signal=${signal})`);
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
        // Prozess evtl. schon weg - ignorieren
      }
    }
  }

  onStateChange(id, state) {
    if (!state || state.ack) return;

    if (id.endsWith('control.restart') && state.val) {
      this.log.info('Manueller Neustart angefordert');
      this.stopMatterbridge();
      setTimeout(() => this.startMatterbridge(), 2000);
      this.setStateAsync(id, false, true);
    }

    if (id.endsWith('control.stop') && state.val) {
      this.log.info('Manuelles Stoppen angefordert');
      this.stopMatterbridge();
      this.setStateAsync(id, false, true);
    }

    if (id.endsWith('control.installPlugin') && state.val) {
      const pluginName = String(state.val).trim();
      this.setStateAsync(id, '', true);
      if (pluginName) {
        this.installAndAddPlugin(pluginName).catch((err) => {
          this.log.error(`Plugin-Installation von "${pluginName}" fehlgeschlagen: ${err.message}`);
        });
      }
    }

    if (id.endsWith('control.removePlugin') && state.val) {
      const pluginName = String(state.val).trim();
      this.setStateAsync(id, '', true);
      if (pluginName) {
        this.removePlugin(pluginName).catch((err) => {
          this.log.error(`Plugin "${pluginName}" konnte nicht entfernt werden: ${err.message}`);
        });
      }
    }
  }

  /**
   * Fuehrt einen Matterbridge-CLI-Aufruf (z.B. "-add"/"-remove") explizit mit
   * der isolierten Node-Runtime und korrektem Storage-Verzeichnis aus - ohne
   * dass irgendjemand manuell $MB/-homedir in einer Shell setzen muss. Das
   * ist genau der Teil, der heute beim manuellen Vorgehen immer wieder an
   * vergessenen "export"-Befehlen in neuen SSH-Sessions gescheitert ist.
   */
  runMatterbridgeCli(args) {
    return new Promise((resolve, reject) => {
      const fullArgs = [this.mbBin, '-homedir', this.mbStorageDir, ...args];
      this.log.info(`Fuehre aus: ${this.nodeBin} ${fullArgs.join(' ')}`);
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
   * npm install -g <plugin> explizit mit der isolierten Node-Runtime und
   * unserem eigenen Prefix (unabhaengig von Matterbridges eigenem, nicht
   * zuverlaessigem internen Install-Mechanismus im Frontend), danach direkt
   * bei Matterbridge registrieren.
   */
  installAndAddPlugin(pluginName) {
    return new Promise((resolve, reject) => {
      const registryArg = this.config.npmMirror ? ` --registry=${this.config.npmMirror}` : '';
      const cmd = `npm install -g ${pluginName}@latest --omit=dev${registryArg}`;
      this.log.info(`Installiere Plugin "${pluginName}" (isolierte Node/npm-Version, korrekter Prefix)...`);
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
        this.log.info(`Plugin "${pluginName}" installiert, registriere bei Matterbridge...`);
        try {
          const pkgPath = path.join(this.mbInstallDir, 'lib', 'node_modules', pluginName, 'package.json');
          await this.runMatterbridgeCli(['-add', pkgPath]);
          this.log.info(`Plugin "${pluginName}" erfolgreich hinzugefuegt. Matterbridge-Neustart erforderlich, damit es geladen wird.`);
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
    this.log.info(`Plugin "${pluginName}" aus Matterbridge entfernt (Dateien auf der Platte bleiben - bei Bedarf manuell loeschen).`);
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
