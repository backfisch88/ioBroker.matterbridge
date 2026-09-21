/**
 * matterbridge-iobroker-bridge
 * -----------------------------
 * Verbindet sich DIREKT mit der ioBroker States-/Objects-Datenbank
 * (Redis-Protokoll, Port aus iobroker.json ermittelt - funktioniert sowohl
 * mit echtem Redis als auch mit dem eingebauten Datei-Modus-Simulator von
 * js-controller). Kein zusaetzlicher ioBroker-Adapter (socketio/ws/rest-api)
 * noetig.
 *
 * Unterstuetzte Geraete-"Kinds":
 *   - "switch"  <- Rolle "switch"/"switch.*"        -> Matter OnOff-Geraet
 *   - "cover"   <- Rolle "level.blind"/"level.shutter" -> Matter WindowCovering
 *   - "vacuum"  <- erkannt an "<adapter>.<instance>.Devices.<id>.deviceStatus.state"
 *                  (Roborock-Adapter-Struktur)        -> Matter RoboticVacuumCleaner
 *
 * Konfiguration (Matterbridge-Plugin-Config, siehe auch das mitgelieferte
 * *.schema.json fuer die Checkbox-Auswahl im Frontend):
 *   {
 *     "whiteList": [...],           // einzelne IDs, per Checkbox im Frontend waehlbar
 *     "blackList": [...],
 *     "rolePrefixes": ["switch", "level.blind", "level.shutter"],
 *     "excludeIdSubstrings": ["wled.", "udpn.", ".seg."],  // grobe Rauschunterdrueckung
 *     "iobrokerDataDir": "/opt/iobroker/iobroker-data",
 *     "invertBlindPosition": false
 *   }
 *
 * Schreibrichtung (Matter-Kommando -> ioBroker):
 *   Wir schreiben SET + PUBLISH auf "io.<id>" mit {val, ack:false, ...} -
 *   exakt das Muster, das auch die ioBroker Admin-Oberflaeche selbst nutzt.
 *   Der eigentliche, besitzende Adapter uebernimmt den Befehl ueber seine
 *   eigene interne States-Subscription, fuehrt die physische Aktion aus und
 *   bestaetigt danach mit ack:true - dieses Muster haben wir empirisch am
 *   echten System verifiziert.
 *
 * Leserichtung (ioBroker -> Matter-Attribut):
 *   Wir abonnieren "io.<id>" per Redis SUBSCRIBE und uebernehmen nur
 *   Nachrichten mit ack:true (bestaetigte, echte Geraetezustaende - nicht
 *   die durchlaufenden ack:false-Befehle).
 */

import path from 'node:path';
import fs from 'node:fs';
import Redis from 'ioredis';
import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, onOffSwitch, coverDevice, dimmableLight, contactSensor, occupancySensor, temperatureSensor, humiditySensor } from 'matterbridge';
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { OnOff, WindowCovering, LevelControl, BooleanState, TemperatureMeasurement, RelativeHumidityMeasurement, OccupancySensing } from 'matterbridge/matter/clusters';

const DEFAULT_IOBROKER_DATA_DIR = '/opt/iobroker/iobroker-data';
const DEFAULT_ROLE_PREFIXES = ['switch', 'level.blind', 'level.shutter'];
const DEFAULT_EXCLUDE_ID_SUBSTRINGS = ['0_userdata.', 'javascript.', 'script.js.', 'wled.', 'udpn.', '.seg.'];

// Roborock deviceStatus.state Codes -> Matter RvcOperationalState
// (bekannte Werte aus der Roborock/Xiaomi-miio-Protokolldokumentation,
// 1:1 uebernommen aus unserem frueheren dedizierten Roborock-Plugin)
function mapRoborockOperationalState(state) {
  switch (state) {
    case 5:
    case 7:
    case 11:
    case 17:
    case 18:
      return 0x01; // Running
    case 6:
    case 16:
      return 0x40; // SeekingCharger
    case 8:
    case 100:
      return 0x41; // Charging
    case 10:
      return 0x02; // Paused
    case 9:
    case 12:
      return 0x03; // Error
    case 3:
    default:
      return 0x42; // Docked
  }
}

/** Ordnet eine ioBroker-Rolle einem von uns unterstuetzten Geraete-"Kind" zu. */
function roleToKind(role) {
  if (!role) return null;
  if (role === 'switch' || role.startsWith('switch.')) return 'switch';
  if (role === 'level.blind' || role === 'level.shutter') return 'cover';
  return null;
}

class IobrokerBridgePlatform extends MatterbridgeDynamicPlatform {
  constructor(matterbridge, log, config) {
    super(matterbridge, log, config);

    /** @type {Map<string, MatterbridgeEndpoint>} Geraete-Key -> Matter-Endpoint (fuer switch/cover: die ioBroker-State-ID; fuer vacuum: die Roborock-Device-ID) */
    this.endpoints = new Map();
    /** @type {Map<string, string>} Geraete-Key -> Kind ("switch"/"cover"/"vacuum") */
    this.kinds = new Map();
    /** @type {Map<string, (state: any) => void>} ioBroker-State-ID -> Handler, der die Aenderung auf den richtigen Endpoint/Attribut anwendet */
    this.stateWatchers = new Map();

    this.redisCmd = null;
    this.redisSub = null;
  }

  async onStart(reason) {
    this.log.info(`ioBroker-Bridge startet: ${reason ?? ''}`);
    await this.ready;

    const dbConfig = this.readIobrokerDbConfig();
    this.log.info(`Verbinde mit ioBroker-Datenbank auf ${dbConfig.host}:${dbConfig.port} (Typ: ${dbConfig.type})`);

    this.redisCmd = new Redis({ host: dbConfig.host, port: dbConfig.port, lazyConnect: false });
    this.redisSub = new Redis({ host: dbConfig.host, port: dbConfig.port, lazyConnect: false });

    this.redisCmd.on('error', (err) => this.log.error(`Redis (Befehle) Fehler: ${err.message}`));
    this.redisSub.on('error', (err) => this.log.error(`Redis (Subscribe) Fehler: ${err.message}`));

    this.bindRedisMessageHandler();

    // 1. Alle unterstuetzten Geraete durchsuchen (einzelne States UND
    //    zusammengesetzte Geraete wie Roborock-Sauger) und beim Frontend
    //    als auswaehlbare Geraete melden (Checkbox-Liste via setSelectDevice).
    const discoveredStates = await this.discoverStateDevices();
    const discoveredVacuums = await this.discoverVacuums();
    const discovered = [...discoveredStates, ...discoveredVacuums];
    this.log.info(`${discovered.length} unterstuetzte(s) Geraet(e) gefunden (${discoveredStates.length} States, ${discoveredVacuums.length} Sauger).`);

    // Aufraeumen: Geraete, die frueher einmal per setSelectDevice() gemeldet
    // wurden (z.B. aus alten Plugin-Versionen mit weniger strikten Filtern
    // oder inzwischen entfernte States), aber in diesem Lauf nicht mehr
    // gefunden werden, aus der Checkbox-Liste entfernen. Sonst waechst die
    // Liste ueber Plugin-Neustarts/-Versionen hinweg immer weiter an.
    const currentIds = new Set(discovered.map((d) => d.id));
    for (const existing of this.getSelectDevices()) {
      if (!currentIds.has(existing.serial)) {
        await this.clearDeviceSelect(existing.serial);
      }
    }

    // 2. Standardmaessig werden KEINE Geraete angelegt (bewusst opt-in,
    //    damit man bei grossen Installationen (600+ States) nicht von einer
    //    Checkbox-Flut erschlagen wird). Ein Geraet wird nur angelegt, wenn:
    //    - seine ID explizit in "whiteList" steht (einzeln per Checkbox gewaehlt), ODER
    //    - seine ID mit einem der "idPrefixes" beginnt (z.B. "shelly.0." fuer
    //      "alle Shelly-Geraete auf einen Schlag", ohne 700 Checkboxen anzuklicken)
    //    "blackList" schliesst in beiden Faellen explizit aus (Vorrang).
    const whiteList = Array.isArray(this.config.whiteList) ? this.config.whiteList : [];
    const blackList = Array.isArray(this.config.blackList) ? this.config.blackList : [];
    const idPrefixes = Array.isArray(this.config.idPrefixes) ? this.config.idPrefixes : [];

    const toExpose = discovered.filter((d) => {
      if (blackList.includes(d.id)) return false;
      if (whiteList.includes(d.id)) return true;
      if (idPrefixes.some((p) => p && d.id.startsWith(p))) return true;
      return false;
    });

    // Checkbox-Liste im Frontend (setSelectDevice) bewusst NICHT fuer JEDES
    // gefundene Geraet befuellen - bei 600+ States waere die Liste sonst
    // unbenutzbar. Stattdessen nur die Geraete melden, die weder schon per
    // "idPrefixes" pauschal aktiv sind noch per "blackList" explizit
    // ausgeschlossen wurden - also genau die, bei denen eine einzelne
    // Entscheidung tatsaechlich noch sinnvoll ist.
    const needsIndividualReview = discovered.filter((d) => {
      if (blackList.includes(d.id)) return false;
      if (idPrefixes.some((p) => p && d.id.startsWith(p))) return false;
      return true;
    });
    for (const d of needsIndividualReview) {
      this.setSelectDevice(d.id, d.name, undefined, d.kind === 'switch' ? 'hub' : d.kind === 'cover' ? 'wall_shade' : 'robot_vacuum');
    }
    this.log.info(`${needsIndividualReview.length} Geraet(e) stehen zur einzelnen Auswahl (whiteList) bereit, ${discovered.length - needsIndividualReview.length} bereits durch idPrefixes/blackList entschieden.`);

    this.log.info(`${toExpose.length} Geraet(e) werden angelegt (Whitelist: ${whiteList.length}, Praefix-Filter: ${idPrefixes.length}, Blacklist: ${blackList.length}).`);
    if (toExpose.length === 0) {
      this.log.info('Keine Geraete ausgewaehlt - trage IDs in "whiteList" ein (per Checkbox im Frontend) oder setze "idPrefixes" (z.B. ["shelly.0."] fuer eine ganze Adapter-Instanz auf einmal).');
    }

    for (const device of toExpose) {
      try {
        if (device.kind === 'vacuum') {
          await this.addVacuumDevice(device);
        } else {
          await this.addSimpleDevice(device);
        }
      } catch (err) {
        this.log.error(`Konnte Geraet fuer "${device.id}" nicht anlegen: ${err.message}`);
      }
    }

    // "Baukasten": Geraetetyp im Dropdown waehlen, passende State-IDs
    // eintragen, speichern - unabhaengig von Adapter/Namenskonvention und
    // unabhaengig von Whitelist/Praefix-Filter (wird immer angelegt).
    const customDevices = Array.isArray(this.config.customDevices) ? this.config.customDevices : [];
    for (const custom of customDevices) {
      try {
        if (custom.type === 'switch') {
          if (!custom.stateId) {
            this.log.warn(`Baukasten-Eintrag "${custom.name}" (switch) hat keine "stateId" - wird uebersprungen.`);
            continue;
          }
          await this.addSimpleDevice({ id: custom.stateId, name: custom.name || custom.stateId, kind: 'switch' });
        } else if (custom.type === 'cover' || custom.type === 'coverWithTarget') {
          if (!custom.positionId) {
            this.log.warn(`Baukasten-Eintrag "${custom.name}" (${custom.type}) hat keine "positionId" - wird uebersprungen.`);
            continue;
          }
          await this.addSimpleDevice({
            id: custom.positionId,
            name: custom.name || custom.positionId,
            kind: 'cover',
            targetId: custom.type === 'coverWithTarget' ? custom.targetPositionId || null : null,
          });
        } else if (custom.type === 'vacuumSimple') {
          if (!custom.isCleaningId) {
            this.log.warn(`Baukasten-Eintrag "${custom.name}" (vacuumSimple) hat keine "isCleaningId" - wird uebersprungen.`);
            continue;
          }
          await this.addGenericVacuumDevice(custom);
        } else if (custom.type === 'temperatureSensor') {
          if (!custom.stateId) {
            this.log.warn(`Baukasten-Eintrag "${custom.name}" (temperatureSensor) hat keine "stateId" - wird uebersprungen.`);
            continue;
          }
          await this.addSensorDevice({ ...custom, sensorKind: 'temperature' });
        } else if (custom.type === 'humiditySensor') {
          if (!custom.stateId) {
            this.log.warn(`Baukasten-Eintrag "${custom.name}" (humiditySensor) hat keine "stateId" - wird uebersprungen.`);
            continue;
          }
          await this.addSensorDevice({ ...custom, sensorKind: 'humidity' });
        } else if (custom.type === 'contactSensor') {
          if (!custom.stateId) {
            this.log.warn(`Baukasten-Eintrag "${custom.name}" (contactSensor) hat keine "stateId" - wird uebersprungen.`);
            continue;
          }
          await this.addSensorDevice({ ...custom, sensorKind: 'contact' });
        } else if (custom.type === 'occupancySensor') {
          if (!custom.stateId) {
            this.log.warn(`Baukasten-Eintrag "${custom.name}" (occupancySensor) hat keine "stateId" - wird uebersprungen.`);
            continue;
          }
          await this.addSensorDevice({ ...custom, sensorKind: 'occupancy' });
        } else if (custom.type === 'dimmer') {
          if (!custom.stateId) {
            this.log.warn(`Baukasten-Eintrag "${custom.name}" (dimmer) hat keine "stateId" - wird uebersprungen.`);
            continue;
          }
          await this.addDimmerDevice(custom);
        } else {
          this.log.warn(`Baukasten-Eintrag "${custom.name}" hat unbekannten Typ "${custom.type}" - wird uebersprungen.`);
        }
      } catch (err) {
        this.log.error(`Konnte Baukasten-Geraet "${custom.name}" nicht anlegen: ${err.message}`);
      }
    }
  }

  /**
   * Durchsucht die Objects-DB (Redis SCAN, nicht KEYS - damit auch bei
   * grossen Installationen Redis nicht blockiert) nach allen einzelnen
   * States mit einer unterstuetzten Rolle und meldet jeden Treffer per
   * setSelectDevice() beim Frontend an.
   */
  async discoverStateDevices() {
    const rolePrefixes = Array.isArray(this.config.rolePrefixes) && this.config.rolePrefixes.length > 0 ? this.config.rolePrefixes : DEFAULT_ROLE_PREFIXES;
    const excludeSubstrings = Array.isArray(this.config.excludeIdSubstrings) && this.config.excludeIdSubstrings.length > 0 ? this.config.excludeIdSubstrings : DEFAULT_EXCLUDE_ID_SUBSTRINGS;
    const requireDeviceName = this.config.requireDeviceName === true;
    const found = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redisCmd.scan(cursor, 'MATCH', 'cfg.o.*', 'COUNT', 500);
      cursor = nextCursor;
      if (keys.length === 0) continue;
      const values = await this.redisCmd.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        const raw = values[i];
        if (!raw) continue;
        let obj;
        try {
          obj = JSON.parse(raw);
        } catch {
          continue;
        }
        if (obj.type !== 'state' || !obj.common) continue;
        const role = obj.common.role || '';
        const matchesConfiguredRole = rolePrefixes.some((p) => role === p || role.startsWith(`${p}.`));
        const kind = roleToKind(role);
        if (!matchesConfiguredRole || !kind) continue;
        const id = keys[i].slice('cfg.o.'.length);
        if (excludeSubstrings.some((s) => id.includes(s))) continue;
        const leafSegment = id.split('.').pop();
        // "TargetPosition" wird nie als eigenstaendiges Geraet gefuehrt,
        // sondern (falls vorhanden) als Sollwert-Begleiter von "Position"
        // mit demselben Rollo zusammengefasst (siehe targetId unten).
        if (kind === 'cover' && leafSegment === 'TargetPosition') continue;
        const leafName = (obj.common.name && (obj.common.name.de || obj.common.name.en)) || '';
        const name = await this.resolveFriendlyName(id, leafName);
        // Ohne einen "echten" uebergeordneten Geraete-/Kanalnamen ist ein
        // Treffer meistens kein physisches Geraet, sondern z.B. eine von
        // einem Skript angelegte lose Variable mit zufaellig passender
        // Rolle. Per Default ausblenden, per "requireDeviceName": false
        // in der Config abschaltbar, falls doch gewuenscht.
        if (requireDeviceName && name === null) continue;
        const finalName = name ?? this.prettifyRawId(id);

        // Rollo mit separatem Soll-Positions-State (z.B. Shelly
        // "Cover0.Position" + "Cover0.TargetPosition")? Dann als Paar
        // fuehren, damit wir spaeter Ist/Soll/Bewegungsstatus korrekt
        // gemeinsam setzen koennen (Matter WindowCovering unterstuetzt das
        // nativ ueber currentPosition/targetPosition/operationalStatus).
        let targetId = null;
        if (kind === 'cover') {
          const parentPath = id.slice(0, id.length - leafSegment.length - 1);
          const candidateTargetId = `${parentPath}.TargetPosition`;
          const targetRaw = await this.redisCmd.get(`cfg.o.${candidateTargetId}`);
          if (targetRaw) targetId = candidateTargetId;
        }

        found.push({ id, name: finalName, role, kind, targetId });
        this.setSelectDevice(id, finalName, undefined, kind === 'switch' ? 'hub' : 'wall_shade');
      }
    } while (cursor !== '0');
    return found;
  }

  /**
   * Universeller Namens-Ansatz (funktioniert adapterunabhaengig, nicht nur
   * fuer Shelly): Der einzelne State selbst heisst bei praktisch jedem
   * ioBroker-Adapter nur generisch "Switch"/"Schalter"/"Position" - das
   * eigentliche, unterscheidbare Geraet steckt eine oder mehrere Ebenen
   * hoeher als "channel"/"device"-Objekt mit eigenem common.name (z.B. der
   * vom Nutzer vergebene Geraetename). Wir laufen die ID-Hierarchie von der
   * vollen State-ID aus nach oben (jeweils das letzte ".segment" entfernen)
   * und nehmen den ersten gefundenen Eltern-Namen. Ist der Blattname selbst
   * schon spezifisch (z.B. bei manchen Adaptern), wird er angehaengt, sonst
   * ersetzt der Elternname ihn komplett.
   */
  async resolveFriendlyName(id, leafName) {
    const genericLeafNames = ['switch', 'schalter', 'state', 'on', 'off', 'position', 'level', 'value', 'relay'];
    const parts = id.split('.');
    // parts[0] = Adaptername, parts[1] = Instanznummer - mindestens diese
    // zwei behalten, alles darunter (channel/device-Ebenen) durchprobieren.
    for (let i = parts.length - 1; i > 1; i--) {
      const candidateId = parts.slice(0, i).join('.');
      try {
        const raw = await this.redisCmd.get(`cfg.o.${candidateId}`);
        if (!raw) continue;
        const obj = JSON.parse(raw);
        if (obj.type === 'channel' || obj.type === 'device') {
          let parentName = obj.common?.name ? obj.common.name.de || obj.common.name.en : null;
          // Viele Adapter (u.a. Shelly) spiegeln den vom Geraet selbst
          // konfigurierten Namen zusaetzlich als eigenen ".name"-STATE
          // (nicht als common.name-Metadatum) - das ist oft die einzige
          // Quelle fuer einen echten, vom Nutzer/Geraet vergebenen Namen.
          if (!parentName) {
            try {
              const nameStateRaw = await this.redisCmd.get(`io.${candidateId}.name`);
              if (nameStateRaw) {
                const nameState = JSON.parse(nameStateRaw);
                if (nameState.val && typeof nameState.val === 'string') parentName = nameState.val;
              }
            } catch {
              // ignorieren
            }
          }
          if (!parentName) continue;
          if (!leafName || genericLeafNames.includes(leafName.toLowerCase())) return parentName;
          return `${parentName} ${leafName}`;
        }
      } catch {
        // Ignorieren und naechst-hoehere Ebene probieren
      }
    }
    // Kein "echter" Kanal-/Geraete-Name gefunden.
    return null;
  }

  /**
   * Letzter Ausweg, wenn ioBroker selbst gar keinen Namen fuer das Geraet
   * kennt (z.B. Shelly-Geraet nie manuell umbenannt): Statt der vollen,
   * technischen ID mit MAC-Adresse zumindest eine halbwegs lesbare
   * Kurzform bauen (Adaptername + Instanznummer weglassen, alles nach "#"
   * in jedem Pfadsegment abschneiden). Kein Ersatz fuer einen echten Namen,
   * aber besser lesbar als "shellyplus1#e465b8f2a3d8#1.Relay0.Switch".
   */
  prettifyRawId(id) {
    const parts = id.split('.').slice(2); // Adaptername + Instanznummer weg
    const cleaned = parts.map((seg) => seg.split('#')[0]).filter(Boolean);
    return cleaned.length > 0 ? cleaned.join(' ') : id;
  }

  /**
   * Erkennt Roborock-Sauger an ihrer charakteristischen Objekt-Struktur
   * "<adapter>.<instance>.Devices.<deviceId>.deviceStatus.state" - das ist
   * exakt der State, den unser frueheres dediziertes Roborock-Plugin schon
   * genutzt hat.
   */
  async discoverVacuums() {
    const found = [];
    let cursor = '0';
    const pattern = 'cfg.o.*.Devices.*.deviceStatus.state';
    do {
      const [nextCursor, keys] = await this.redisCmd.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = nextCursor;
      for (const key of keys) {
        const idPart = key.slice('cfg.o.'.length, -'.deviceStatus.state'.length); // z.B. "roborock.0.Devices.7bp2..."
        const m = idPart.match(/^(.+)\.Devices\.([^.]+)$/);
        if (!m) continue;
        const [, instance, deviceId] = m;
        const base = `${instance}.Devices.${deviceId}`;
        let name = `Staubsauger ${deviceId.slice(0, 6)}`;
        try {
          const deviceObjRaw = await this.redisCmd.get(`cfg.o.${instance}.Devices.${deviceId}`);
          if (deviceObjRaw) {
            const deviceObj = JSON.parse(deviceObjRaw);
            if (deviceObj.common?.name) {
              name = deviceObj.common.name.de || deviceObj.common.name.en || name;
            }
          }
        } catch {
          // Fallback-Name bleibt bestehen
        }
        found.push({ id: base, serial: deviceId, name, kind: 'vacuum', base });
        this.setSelectDevice(base, name, undefined, 'robot_vacuum');
      }
    } while (cursor !== '0');
    return found;
  }

  /**
   * Liest Host/Port/Typ der ioBroker-Datenbank direkt aus iobroker.json -
   * damit funktioniert die Verbindung automatisch sowohl im Datei-Modus
   * (eingebauter Simulator, Standardport 9000 fuer States) als auch mit
   * echtem Redis (z.B. Port 6379), ohne dass wir das selbst konfigurieren
   * muessten.
   */
  readIobrokerDbConfig() {
    const dataDir = this.config.iobrokerDataDir || DEFAULT_IOBROKER_DATA_DIR;
    const cfgPath = path.join(dataDir, 'iobroker.json');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      throw new Error(`Konnte ${cfgPath} nicht lesen (${err.message}). "iobrokerDataDir" in der Plugin-Config korrekt gesetzt?`);
    }
    const statesCfg = parsed.states || {};
    return {
      host: statesCfg.host || '127.0.0.1',
      port: statesCfg.port || 9000,
      type: statesCfg.type || 'file',
    };
  }

  async addSimpleDevice({ id, name, kind, targetId }) {
    const safeId = id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);

    let endpoint;

    if (kind === 'switch') {
      endpoint = new MatterbridgeEndpoint([onOffSwitch], { id: safeId });
      endpoint
        .createDefaultIdentifyClusterServer()
        .createDefaultBasicInformationClusterServer(name, id, 0xfff1, 'ioBroker', 0x8000, 'ioBroker Bridge Device')
        .createDefaultOnOffClusterServer();

      endpoint.addCommandHandler('on', async () => this.writeIobrokerState(id, true));
      endpoint.addCommandHandler('off', async () => this.writeIobrokerState(id, false));
      endpoint.addCommandHandler('toggle', async () => {
        const current = endpoint.getAttribute(OnOff.id, 'onOff', this.log);
        await this.writeIobrokerState(id, !current);
      });

      this.stateWatchers.set(id, (state) => endpoint.setAttribute(OnOff.id, 'onOff', !!state.val, this.log));
    } else if (kind === 'cover') {
      endpoint = new MatterbridgeEndpoint([coverDevice], { id: safeId });
      endpoint
        .createDefaultIdentifyClusterServer()
        .createDefaultBasicInformationClusterServer(name, id, 0xfff1, 'ioBroker', 0x8000, 'ioBroker Bridge Device')
        .createDefaultWindowCoveringClusterServer();

      if (targetId) {
        // Rollo mit getrenntem Ist-/Soll-Position-State (z.B. Shelly
        // "Position" + "TargetPosition"): Matter WindowCovering bildet das
        // nativ ab (current/target/operationalStatus). Befehle schreiben
        // auf den Soll-State - das physische Geraet faehrt selbststaendig
        // dorthin und meldet den Ist-Wert laufend zurueck.
        let lastCurrent = null;
        let lastTarget = null;

        const applyCombined = () => {
          if (lastCurrent === null) return;
          const target = lastTarget ?? lastCurrent;
          let status = WindowCovering.MovementStatus.Stopped;
          if (target < lastCurrent) status = WindowCovering.MovementStatus.Opening;
          else if (target > lastCurrent) status = WindowCovering.MovementStatus.Closing;
          endpoint.setWindowCoveringCurrentTargetStatus(lastCurrent, target, status);
        };

        endpoint.addCommandHandler('upOrOpen', async () => this.writeIobrokerState(targetId, this.toIobrokerBlindValue(0)));
        endpoint.addCommandHandler('downOrClose', async () => this.writeIobrokerState(targetId, this.toIobrokerBlindValue(100)));
        endpoint.addCommandHandler('stopMotion', async () => {
          // "Stop" heisst hier: Soll-Position auf die aktuelle Ist-Position
          // setzen, damit das Geraet an Ort und Stelle stehen bleibt.
          if (lastCurrent !== null) await this.writeIobrokerState(targetId, this.toIobrokerBlindValue(Math.round(lastCurrent / 100)));
        });
        endpoint.addCommandHandler('goToLiftPercentage', async ({ request }) => {
          const percent = Math.round(request.liftPercent100thsValue / 100);
          await this.writeIobrokerState(targetId, this.toIobrokerBlindValue(percent));
        });

        this.stateWatchers.set(id, (state) => {
          const percent = this.fromIobrokerBlindValue(Number(state.val) || 0);
          lastCurrent = Math.max(0, Math.min(10000, Math.round(percent * 100)));
          applyCombined();
        });
        this.stateWatchers.set(targetId, (state) => {
          const percent = this.fromIobrokerBlindValue(Number(state.val) || 0);
          lastTarget = Math.max(0, Math.min(10000, Math.round(percent * 100)));
          applyCombined();
        });
      } else {
        // Einfacher Fall: nur ein einzelner Positions-State, kein
        // getrennter Sollwert - Ist und Soll sind dann immer identisch,
        // Bewegungsstatus bleibt "Stopped" (wir haben keine Information
        // ueber eine laufende Fahrt).
        endpoint.addCommandHandler('upOrOpen', async ({ attributes }) => {
          attributes.currentPositionLiftPercent100ths = 0;
          await this.writeIobrokerState(id, this.toIobrokerBlindValue(0));
        });
        endpoint.addCommandHandler('downOrClose', async ({ attributes }) => {
          attributes.currentPositionLiftPercent100ths = 10000;
          await this.writeIobrokerState(id, this.toIobrokerBlindValue(100));
        });
        endpoint.addCommandHandler('stopMotion', async () => {
          this.log.info(`Stop-Kommando fuer ${id} empfangen (kein getrennter Soll-State bekannt, nichts zu tun)`);
        });
        endpoint.addCommandHandler('goToLiftPercentage', async ({ request, attributes }) => {
          attributes.currentPositionLiftPercent100ths = request.liftPercent100thsValue;
          const percent = Math.round(request.liftPercent100thsValue / 100);
          await this.writeIobrokerState(id, this.toIobrokerBlindValue(percent));
        });

        this.stateWatchers.set(id, (state) => {
          const percent = this.fromIobrokerBlindValue(Number(state.val) || 0);
          const percent100ths = Math.max(0, Math.min(10000, Math.round(percent * 100)));
          endpoint.setAttribute(WindowCovering.id, 'currentPositionLiftPercent100ths', percent100ths, this.log);
        });
      }
    } else {
      this.log.warn(`Geraete-Kind "${kind}" fuer "${id}" wird nicht unterstuetzt. Wird uebersprungen.`);
      return;
    }

    await this.registerDevice(endpoint);
    this.endpoints.set(id, endpoint);
    this.kinds.set(id, kind);
    this.log.info(`Geraet "${name}" fuer "${id}" (${kind}) registriert.`);

    const stateRaw = await this.redisCmd.get(`io.${id}`);
    if (stateRaw) this.stateWatchers.get(id)?.(JSON.parse(stateRaw));
    await this.redisSub.subscribe(`io.${id}`);

    if (targetId) {
      const targetRaw = await this.redisCmd.get(`io.${targetId}`);
      if (targetRaw) this.stateWatchers.get(targetId)?.(JSON.parse(targetRaw));
      await this.redisSub.subscribe(`io.${targetId}`);
    }
  }

  /**
   * Legt einen Roborock-Sauger als Matter RoboticVacuumCleaner an. Nutzt
   * dieselbe Zustands-Zuordnung (mapRoborockOperationalState) und dieselben
   * Command-/State-Pfade wie unser frueheres dediziertes Plugin, nur jetzt
   * per direkter Redis-Verbindung statt Socket.IO.
   */
  async addVacuumDevice({ serial, name, base }) {
    const stateIdOperational = `${base}.deviceStatus.state`;
    const stateIdBattery = `${base}.deviceStatus.battery`;
    const cmdStart = `${base}.commands.app_start`;
    const cmdPause = `${base}.commands.app_pause`;
    const cmdCharge = `${base}.commands.app_charge`;

    const vacuum = new RoboticVacuumCleaner(name, serial, 'server');

    vacuum.addCommandHandler('changeRunMode', async (mode) => {
      if (mode === 1) await this.writeIobrokerState(cmdStart, true);
      else if (mode === 0) await this.writeIobrokerState(cmdCharge, true);
    });
    vacuum.addCommandHandler('pause', async () => this.writeIobrokerState(cmdPause, true));
    vacuum.addCommandHandler('resume', async () => this.writeIobrokerState(cmdStart, true));
    vacuum.addCommandHandler('goHome', async () => this.writeIobrokerState(cmdCharge, true));

    await this.registerDevice(vacuum);
    this.endpoints.set(base, vacuum);
    this.kinds.set(base, 'vacuum');
    this.log.info(`Sauger "${name}" (${serial}) registriert.`);

    this.stateWatchers.set(stateIdOperational, (state) => {
      const opState = mapRoborockOperationalState(Number(state.val));
      vacuum.setOperationalState(opState);
      this.log.debug(`Roborock state=${state.val} -> RvcOperationalState=${opState}`);
    });
    this.stateWatchers.set(stateIdBattery, (state) => {
      this.log.debug(`${name}: Batteriestand ${state.val}%`);
      // PowerSource-Cluster-Update kann bei Bedarf hier ergaenzt werden,
      // sobald der genaue Attributname/Skalierung final verifiziert ist.
    });

    for (const stateId of [stateIdOperational, stateIdBattery]) {
      const raw = await this.redisCmd.get(`io.${stateId}`);
      if (raw) this.stateWatchers.get(stateId)?.(JSON.parse(raw));
      await this.redisSub.subscribe(`io.${stateId}`);
    }
  }

  /**
   * Generischer Sauger fuer den Baukasten (customDevices, type
   * "vacuumSimple") - im Gegensatz zur automatischen Roborock-Erkennung
   * (die Roborocks spezifische Zahlencodes fuer den Betriebsstatus kennt)
   * hier bewusst vereinfacht: nur "laeuft gerade" (ja/nein) statt
   * feingranularer Zustaende (Fehler/Laden/etc.), da sich Statuscodes
   * zwischen Saugroboter-Adaptern nicht verallgemeinern lassen.
   */
  async addGenericVacuumDevice({ name, isCleaningId, startId, pauseId, dockId }) {
    const safeId = isCleaningId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
    const vacuum = new RoboticVacuumCleaner(name, safeId, 'server');

    vacuum.addCommandHandler('changeRunMode', async (mode) => {
      if (mode === 1 && startId) await this.writeIobrokerState(startId, true);
      else if (mode === 0 && dockId) await this.writeIobrokerState(dockId, true);
    });
    if (pauseId) vacuum.addCommandHandler('pause', async () => this.writeIobrokerState(pauseId, true));
    if (startId) vacuum.addCommandHandler('resume', async () => this.writeIobrokerState(startId, true));
    if (dockId) vacuum.addCommandHandler('goHome', async () => this.writeIobrokerState(dockId, true));

    await this.registerDevice(vacuum);
    this.endpoints.set(isCleaningId, vacuum);
    this.kinds.set(isCleaningId, 'vacuum');
    this.log.info(`Generischer Sauger "${name}" registriert (vereinfachtes Status-Modell: laeuft/laeuft nicht).`);

    this.stateWatchers.set(isCleaningId, (state) => {
      const opState = state.val ? 0x01 /* Running */ : 0x42 /* Docked */;
      vacuum.setOperationalState(opState);
    });

    const raw = await this.redisCmd.get(`io.${isCleaningId}`);
    if (raw) this.stateWatchers.get(isCleaningId)?.(JSON.parse(raw));
    await this.redisSub.subscribe(`io.${isCleaningId}`);
  }

  /**
   * Generischer, reiner Lese-Sensor fuer den Baukasten (Temperatur,
   * Feuchte, Kontakt, Bewegung) - alle vier folgen demselben simplen
   * Ein-State-Muster, daher eine gemeinsame Methode statt vier fast
   * identischer.
   */
  async addSensorDevice({ name, stateId, sensorKind, invert }) {
    const safeId = stateId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
    let endpoint;

    if (sensorKind === 'temperature') {
      endpoint = new MatterbridgeEndpoint([temperatureSensor], { id: safeId });
      endpoint
        .createDefaultIdentifyClusterServer()
        .createDefaultBasicInformationClusterServer(name, stateId, 0xfff1, 'ioBroker', 0x8000, 'ioBroker Bridge Device')
        .createDefaultTemperatureMeasurementClusterServer();
      this.stateWatchers.set(stateId, (state) => {
        const centidegrees = Math.round((Number(state.val) || 0) * 100);
        endpoint.setAttribute(TemperatureMeasurement.id, 'measuredValue', centidegrees, this.log);
      });
    } else if (sensorKind === 'humidity') {
      endpoint = new MatterbridgeEndpoint([humiditySensor], { id: safeId });
      endpoint
        .createDefaultIdentifyClusterServer()
        .createDefaultBasicInformationClusterServer(name, stateId, 0xfff1, 'ioBroker', 0x8000, 'ioBroker Bridge Device')
        .createDefaultRelativeHumidityMeasurementClusterServer();
      this.stateWatchers.set(stateId, (state) => {
        const centipercent = Math.round((Number(state.val) || 0) * 100);
        endpoint.setAttribute(RelativeHumidityMeasurement.id, 'measuredValue', centipercent, this.log);
      });
    } else if (sensorKind === 'contact') {
      endpoint = new MatterbridgeEndpoint([contactSensor], { id: safeId });
      endpoint
        .createDefaultIdentifyClusterServer()
        .createDefaultBasicInformationClusterServer(name, stateId, 0xfff1, 'ioBroker', 0x8000, 'ioBroker Bridge Device')
        .createDefaultBooleanStateClusterServer(true);
      this.stateWatchers.set(stateId, (state) => {
        let closed = !!state.val;
        if (invert) closed = !closed;
        // Matter BooleanState fuer ContactSensor: true = Kontakt/geschlossen.
        endpoint.setAttribute(BooleanState.id, 'stateValue', closed, this.log);
      });
    } else if (sensorKind === 'occupancy') {
      endpoint = new MatterbridgeEndpoint([occupancySensor], { id: safeId });
      endpoint
        .createDefaultIdentifyClusterServer()
        .createDefaultBasicInformationClusterServer(name, stateId, 0xfff1, 'ioBroker', 0x8000, 'ioBroker Bridge Device')
        .createDefaultOccupancySensingClusterServer(false);
      this.stateWatchers.set(stateId, (state) => {
        let occupied = !!state.val;
        if (invert) occupied = !occupied;
        endpoint.setAttribute(OccupancySensing.id, 'occupancy', { occupied }, this.log);
      });
    } else {
      this.log.warn(`Unbekannte Sensor-Art "${sensorKind}" fuer "${name}".`);
      return;
    }

    await this.registerDevice(endpoint);
    this.endpoints.set(stateId, endpoint);
    this.kinds.set(stateId, `sensor:${sensorKind}`);
    this.log.info(`Sensor "${name}" (${sensorKind}) registriert.`);

    const raw = await this.redisCmd.get(`io.${stateId}`);
    if (raw) this.stateWatchers.get(stateId)?.(JSON.parse(raw));
    await this.redisSub.subscribe(`io.${stateId}`);
  }

  /**
   * Dimmbares Licht fuer den Baukasten. ioBroker-Rolle "level.dimmer" ist
   * ueblicherweise 0-100 (Prozent), Matter LevelControl nutzt 1-254 - wird
   * hier umgerechnet.
   */
  async addDimmerDevice({ name, stateId }) {
    const safeId = stateId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
    const endpoint = new MatterbridgeEndpoint([dimmableLight], { id: safeId });
    endpoint
      .createDefaultIdentifyClusterServer()
      .createDefaultBasicInformationClusterServer(name, stateId, 0xfff1, 'ioBroker', 0x8000, 'ioBroker Bridge Device')
      .createDefaultOnOffClusterServer()
      .createDefaultLevelControlClusterServer();

    const percentToMatter = (percent) => Math.max(1, Math.min(254, Math.round((percent / 100) * 254)));
    const matterToPercent = (level) => Math.max(0, Math.min(100, Math.round((level / 254) * 100)));

    endpoint.addCommandHandler('on', async () => this.writeIobrokerState(stateId, 100));
    endpoint.addCommandHandler('off', async () => this.writeIobrokerState(stateId, 0));
    endpoint.addCommandHandler('toggle', async () => {
      const current = endpoint.getAttribute(OnOff.id, 'onOff', this.log);
      await this.writeIobrokerState(stateId, current ? 0 : 100);
    });
    endpoint.addCommandHandler('moveToLevel', async ({ request }) => {
      await this.writeIobrokerState(stateId, matterToPercent(request.level));
    });
    endpoint.addCommandHandler('moveToLevelWithOnOff', async ({ request }) => {
      await this.writeIobrokerState(stateId, matterToPercent(request.level));
    });

    this.stateWatchers.set(stateId, (state) => {
      const percent = Number(state.val) || 0;
      endpoint.setAttribute(OnOff.id, 'onOff', percent > 0, this.log);
      endpoint.setAttribute(LevelControl.id, 'currentLevel', percentToMatter(percent), this.log);
    });

    await this.registerDevice(endpoint);
    this.endpoints.set(stateId, endpoint);
    this.kinds.set(stateId, 'dimmer');
    this.log.info(`Dimmer "${name}" registriert.`);

    const raw = await this.redisCmd.get(`io.${stateId}`);
    if (raw) this.stateWatchers.get(stateId)?.(JSON.parse(raw));
    await this.redisSub.subscribe(`io.${stateId}`);
  }

  bindRedisMessageHandler() {
    this.redisSub.on('message', (channel, message) => {
      const id = channel.startsWith('io.') ? channel.slice(3) : channel;
      const watcher = this.stateWatchers.get(id);
      if (!watcher) return;
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      // Nur bestaetigte Werte (ack:true) uebernehmen - ack:false sind nur
      // durchlaufende Befehle, kein tatsaechlicher Geraetezustand.
      if (!parsed.ack) return;
      watcher(parsed);
    });
  }

  /**
   * ioBroker-Konvention fuer "level.blind" ist je nach Adapter nicht ganz
   * einheitlich (manche 0=zu/100=offen, manche umgekehrt). Standardmaessig
   * gehen wir von 0=offen/100=zu aus (passend zu Matter WindowCovering:
   * 0=offen, 10000=zu). Falls es bei einem Geraet verkehrt herum faehrt,
   * "invertBlindPosition": true in der Plugin-Config setzen.
   */
  toIobrokerBlindValue(matterPercentOpen0Closed100) {
    return this.config.invertBlindPosition ? 100 - matterPercentOpen0Closed100 : matterPercentOpen0Closed100;
  }

  fromIobrokerBlindValue(iobrokerVal) {
    return this.config.invertBlindPosition ? 100 - iobrokerVal : iobrokerVal;
  }

  async writeIobrokerState(id, val) {
    const now = Date.now();
    const payload = JSON.stringify({
      val,
      ack: false,
      ts: now,
      lc: now,
      from: 'system.adapter.matterbridge-iobroker-bridge.0',
      user: 'system.user.admin',
    });
    await this.redisCmd.set(`io.${id}`, payload);
    await this.redisCmd.publish(`io.${id}`, payload);
    this.log.info(`Befehl an ioBroker gesendet: ${id} = ${JSON.stringify(val)}`);
  }

  async onShutdown(reason) {
    this.log.info(`ioBroker-Bridge wird beendet: ${reason ?? ''}`);
    try {
      if (this.redisSub) await this.redisSub.quit();
      if (this.redisCmd) await this.redisCmd.quit();
    } catch (err) {
      this.log.debug(`Fehler beim Schliessen der Redis-Verbindungen: ${err.message}`);
    }
    await super.onShutdown(reason);
  }
}

export default function initializePlugin(matterbridge, log, config) {
  return new IobrokerBridgePlatform(matterbridge, log, config);
}

