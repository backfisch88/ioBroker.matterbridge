/**
 * matterbridge-iobroker-bridge
 * -----------------------------
 * Connects DIRECTLY to the ioBroker states/objects database (Redis
 * protocol, port determined from iobroker.json - works both with real
 * Redis and with js-controller's built-in file-mode simulator). No
 * additional ioBroker adapter (socketio/ws/rest-api) required.
 *
 * Supported device "kinds":
 *   - "switch"  <- role "switch"/"switch.*"              -> Matter OnOff device
 *   - "cover"   <- role "level.blind"/"level.shutter"    -> Matter WindowCovering
 *   - "vacuum"  <- detected via "<adapter>.<instance>.Devices.<id>.deviceStatus.state"
 *                  (Roborock adapter structure)           -> Matter RoboticVacuumCleaner
 *
 * Configuration (Matterbridge plugin config, see also the bundled
 * *.schema.json for the checkbox selection in the frontend):
 *   {
 *     "whiteList": [...],           // individual IDs, selectable via checkbox in the frontend
 *     "blackList": [...],
 *     "rolePrefixes": ["switch", "level.blind", "level.shutter"],
 *     "excludeIdSubstrings": ["wled.", "udpn.", ".seg."],  // rough noise reduction
 *     "iobrokerDataDir": "/opt/iobroker/iobroker-data",
 *     "invertBlindPosition": false
 *   }
 *
 * Write direction (Matter command -> ioBroker):
 *   We write SET + PUBLISH on "io.<id>" with {val, ack:false, ...} -
 *   exactly the pattern the ioBroker admin UI itself uses. The actual
 *   owning adapter picks up the command via its own internal state
 *   subscription, performs the physical action, and then confirms with
 *   ack:true - this pattern has been verified empirically on a real
 *   system.
 *
 * Read direction (ioBroker -> Matter attribute):
 *   We subscribe to "io.<id>" via Redis SUBSCRIBE and only accept
 *   messages with ack:true (confirmed, real device states - not the
 *   pass-through ack:false commands).
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

// Roborock deviceStatus.state codes -> Matter RvcOperationalState
// (known values from the Roborock/Xiaomi-miio protocol documentation,
// taken 1:1 from our earlier dedicated Roborock plugin)
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

/** Maps an ioBroker role to one of our supported device "kinds". */
function roleToKind(role) {
  if (!role) return null;
  if (role === 'switch' || role.startsWith('switch.')) return 'switch';
  if (role === 'level.blind' || role === 'level.shutter') return 'cover';
  return null;
}

class IobrokerBridgePlatform extends MatterbridgeDynamicPlatform {
  constructor(matterbridge, log, config) {
    super(matterbridge, log, config);

    /** @type {Map<string, MatterbridgeEndpoint>} device key -> Matter endpoint (for switch/cover: the ioBroker state ID; for vacuum: the Roborock device ID) */
    this.endpoints = new Map();
    /** @type {Map<string, string>} device key -> kind ("switch"/"cover"/"vacuum") */
    this.kinds = new Map();
    /** @type {Map<string, (state: any) => void>} ioBroker state ID -> handler that applies the change to the correct endpoint/attribute */
    this.stateWatchers = new Map();

    this.redisCmd = null;
    this.redisSub = null;
  }

  async onStart(reason) {
    this.log.info(`ioBroker bridge starting: ${reason ?? ''}`);
    await this.ready;

    const dbConfig = this.readIobrokerDbConfig();
    this.log.info(`Connecting to the ioBroker database at ${dbConfig.host}:${dbConfig.port} (type: ${dbConfig.type})`);

    this.redisCmd = new Redis({ host: dbConfig.host, port: dbConfig.port, lazyConnect: false });
    this.redisSub = new Redis({ host: dbConfig.host, port: dbConfig.port, lazyConnect: false });

    this.redisCmd.on('error', (err) => this.log.error(`Redis (commands) error: ${err.message}`));
    this.redisSub.on('error', (err) => this.log.error(`Redis (subscribe) error: ${err.message}`));

    this.bindRedisMessageHandler();

    // 1. Scan for all supported devices (individual states AND composite
    //    devices such as Roborock vacuums) and report them to the
    //    frontend as selectable devices (checkbox list via setSelectDevice).
    const discoveredStates = await this.discoverStateDevices();
    const discoveredVacuums = await this.discoverVacuums();
    const discovered = [...discoveredStates, ...discoveredVacuums];
    this.log.info(`${discovered.length} supported device(s) found (${discoveredStates.length} states, ${discoveredVacuums.length} vacuum(s)).`);

    // Clean up: remove devices that were previously reported via
    // setSelectDevice() (e.g. from older plugin versions with less
    // strict filters, or states that no longer exist) but are not found
    // in this run, from the checkbox list. Otherwise the list would just
    // keep growing across plugin restarts/versions.
    const currentIds = new Set(discovered.map((d) => d.id));
    for (const existing of this.getSelectDevices()) {
      if (!currentIds.has(existing.serial)) {
        await this.clearDeviceSelect(existing.serial);
      }
    }

    // 2. By default NO devices are created (deliberately opt-in, so that
    //    large installations (600+ states) are not overwhelmed by a
    //    flood of checkboxes). A device is only created if:
    //    - its ID is explicitly listed in "whiteList" (selected
    //      individually via checkbox), OR
    //    - its ID starts with one of the "idPrefixes" (e.g. "shelly.0."
    //      to enable "all Shelly devices at once" without clicking 700
    //      checkboxes)
    //    "blackList" explicitly excludes a device in both cases (takes
    //    precedence).
    const whiteList = Array.isArray(this.config.whiteList) ? this.config.whiteList : [];
    const blackList = Array.isArray(this.config.blackList) ? this.config.blackList : [];
    const idPrefixes = Array.isArray(this.config.idPrefixes) ? this.config.idPrefixes : [];

    const toExpose = discovered.filter((d) => {
      if (blackList.includes(d.id)) return false;
      if (whiteList.includes(d.id)) return true;
      if (idPrefixes.some((p) => p && d.id.startsWith(p))) return true;
      return false;
    });

    // Deliberately do NOT populate the frontend checkbox list
    // (setSelectDevice) for EVERY discovered device - with 600+ states
    // the list would otherwise be unusable. Instead, only report devices
    // that are neither already active via "idPrefixes" nor explicitly
    // excluded via "blackList" - i.e. exactly the ones where an
    // individual decision is actually still meaningful.
    const needsIndividualReview = discovered.filter((d) => {
      if (blackList.includes(d.id)) return false;
      if (idPrefixes.some((p) => p && d.id.startsWith(p))) return false;
      return true;
    });
    for (const d of needsIndividualReview) {
      this.setSelectDevice(d.id, d.name, undefined, d.kind === 'switch' ? 'hub' : d.kind === 'cover' ? 'wall_shade' : 'robot_vacuum');
    }
    this.log.info(`${needsIndividualReview.length} device(s) are available for individual selection (whiteList), ${discovered.length - needsIndividualReview.length} already decided via idPrefixes/blackList.`);

    this.log.info(`${toExpose.length} device(s) will be created (whitelist: ${whiteList.length}, prefix filter: ${idPrefixes.length}, blacklist: ${blackList.length}).`);
    if (toExpose.length === 0) {
      this.log.info('No devices selected - add IDs to "whiteList" (via checkbox in the frontend) or set "idPrefixes" (e.g. ["shelly.0."] to enable a whole adapter instance at once).');
    }

    for (const device of toExpose) {
      try {
        if (device.kind === 'vacuum') {
          await this.addVacuumDevice(device);
        } else {
          await this.addSimpleDevice(device);
        }
      } catch (err) {
        this.log.error(`Could not create device for "${device.id}": ${err.message}`);
      }
    }

    // "Device builder": pick a device type in the dropdown, enter the
    // matching state IDs, save - independent of adapter/naming
    // convention and independent of the whitelist/prefix filter (always
    // created).
    const customDevices = Array.isArray(this.config.customDevices) ? this.config.customDevices : [];
    for (const custom of customDevices) {
      try {
        if (custom.type === 'switch') {
          if (!custom.stateId) {
            this.log.warn(`Device builder entry "${custom.name}" (switch) has no "stateId" - skipping.`);
            continue;
          }
          await this.addSimpleDevice({ id: custom.stateId, name: custom.name || custom.stateId, kind: 'switch' });
        } else if (custom.type === 'cover' || custom.type === 'coverWithTarget') {
          if (!custom.positionId) {
            this.log.warn(`Device builder entry "${custom.name}" (${custom.type}) has no "positionId" - skipping.`);
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
            this.log.warn(`Device builder entry "${custom.name}" (vacuumSimple) has no "isCleaningId" - skipping.`);
            continue;
          }
          await this.addGenericVacuumDevice(custom);
        } else if (custom.type === 'temperatureSensor') {
          if (!custom.stateId) {
            this.log.warn(`Device builder entry "${custom.name}" (temperatureSensor) has no "stateId" - skipping.`);
            continue;
          }
          await this.addSensorDevice({ ...custom, sensorKind: 'temperature' });
        } else if (custom.type === 'humiditySensor') {
          if (!custom.stateId) {
            this.log.warn(`Device builder entry "${custom.name}" (humiditySensor) has no "stateId" - skipping.`);
            continue;
          }
          await this.addSensorDevice({ ...custom, sensorKind: 'humidity' });
        } else if (custom.type === 'contactSensor') {
          if (!custom.stateId) {
            this.log.warn(`Device builder entry "${custom.name}" (contactSensor) has no "stateId" - skipping.`);
            continue;
          }
          await this.addSensorDevice({ ...custom, sensorKind: 'contact' });
        } else if (custom.type === 'occupancySensor') {
          if (!custom.stateId) {
            this.log.warn(`Device builder entry "${custom.name}" (occupancySensor) has no "stateId" - skipping.`);
            continue;
          }
          await this.addSensorDevice({ ...custom, sensorKind: 'occupancy' });
        } else if (custom.type === 'dimmer') {
          if (!custom.stateId) {
            this.log.warn(`Device builder entry "${custom.name}" (dimmer) has no "stateId" - skipping.`);
            continue;
          }
          await this.addDimmerDevice(custom);
        } else {
          this.log.warn(`Device builder entry "${custom.name}" has unknown type "${custom.type}" - skipping.`);
        }
      } catch (err) {
        this.log.error(`Could not create device builder device "${custom.name}": ${err.message}`);
      }
    }
  }

  /**
   * Scans the objects DB (Redis SCAN, not KEYS - so Redis is not blocked
   * even on large installations) for all individual states with a
   * supported role and reports each match to the frontend via
   * setSelectDevice().
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
        // "TargetPosition" is never treated as a standalone device, but
        // (if present) combined with "Position" as its target-value
        // companion for the same blind (see targetId below).
        if (kind === 'cover' && leafSegment === 'TargetPosition') continue;
        const leafName = (obj.common.name && (obj.common.name.de || obj.common.name.en)) || '';
        const name = await this.resolveFriendlyName(id, leafName);
        // Without a "real" parent channel/device name, a match is
        // usually not a physical device but e.g. a loose variable
        // created by a script that happens to have a matching role.
        // Hidden by default; can be disabled via "requireDeviceName":
        // false in the config if desired anyway.
        if (requireDeviceName && name === null) continue;
        const finalName = name ?? this.prettifyRawId(id);

        // Blind with a separate target-position state (e.g. Shelly
        // "Cover0.Position" + "Cover0.TargetPosition")? Then treat them
        // as a pair so we can later set current/target/movement status
        // correctly together (Matter WindowCovering supports this
        // natively via currentPosition/targetPosition/operationalStatus).
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
   * Universal naming approach (adapter-independent, not just for
   * Shelly): the individual state itself is named only generically
   * ("Switch"/"Position"/etc.) by practically every ioBroker adapter -
   * the actual, distinguishable device sits one or more levels higher,
   * as a "channel"/"device" object with its own common.name (e.g. the
   * device name the user assigned). We walk the ID hierarchy upward from
   * the full state ID (removing the last ".segment" each time) and use
   * the first parent name found. If the leaf name itself is already
   * specific (as with some adapters), it is appended; otherwise the
   * parent name replaces it entirely.
   */
  async resolveFriendlyName(id, leafName) {
    const genericLeafNames = ['switch', 'schalter', 'state', 'on', 'off', 'position', 'level', 'value', 'relay'];
    const parts = id.split('.');
    // parts[0] = adapter name, parts[1] = instance number - keep at
    // least these two, try every level below (channel/device levels).
    for (let i = parts.length - 1; i > 1; i--) {
      const candidateId = parts.slice(0, i).join('.');
      try {
        const raw = await this.redisCmd.get(`cfg.o.${candidateId}`);
        if (!raw) continue;
        const obj = JSON.parse(raw);
        if (obj.type === 'channel' || obj.type === 'device') {
          let parentName = obj.common?.name ? obj.common.name.de || obj.common.name.en : null;
          // Many adapters (Shelly among others) additionally mirror the
          // name configured on the device itself as its own ".name"
          // STATE (not as a common.name metadata field) - this is often
          // the only source for a real, user/device-assigned name.
          if (!parentName) {
            try {
              const nameStateRaw = await this.redisCmd.get(`io.${candidateId}.name`);
              if (nameStateRaw) {
                const nameState = JSON.parse(nameStateRaw);
                if (nameState.val && typeof nameState.val === 'string') parentName = nameState.val;
              }
            } catch {
              // ignore
            }
          }
          if (!parentName) continue;
          if (!leafName || genericLeafNames.includes(leafName.toLowerCase())) return parentName;
          return `${parentName} ${leafName}`;
        }
      } catch {
        // ignore and try the next level up
      }
    }
    // No "real" channel/device name found.
    return null;
  }

  /**
   * Last resort when ioBroker itself has no name for the device at all
   * (e.g. a Shelly device that was never renamed manually): instead of
   * the full, technical ID with a MAC address, build at least a
   * somewhat readable short form (drop adapter name + instance number,
   * cut off everything after "#" in each path segment). Not a
   * replacement for a real name, but more readable than
   * "shellyplus1#e465b8f2a3d8#1.Relay0.Switch".
   */
  prettifyRawId(id) {
    const parts = id.split('.').slice(2); // drop adapter name + instance number
    const cleaned = parts.map((seg) => seg.split('#')[0]).filter(Boolean);
    return cleaned.length > 0 ? cleaned.join(' ') : id;
  }

  /**
   * Detects Roborock vacuums by their characteristic object structure
   * "<adapter>.<instance>.Devices.<deviceId>.deviceStatus.state" - this
   * is exactly the state our earlier dedicated Roborock plugin already
   * used.
   */
  async discoverVacuums() {
    const found = [];
    let cursor = '0';
    const pattern = 'cfg.o.*.Devices.*.deviceStatus.state';
    do {
      const [nextCursor, keys] = await this.redisCmd.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = nextCursor;
      for (const key of keys) {
        const idPart = key.slice('cfg.o.'.length, -'.deviceStatus.state'.length); // e.g. "roborock.0.Devices.7bp2..."
        const m = idPart.match(/^(.+)\.Devices\.([^.]+)$/);
        if (!m) continue;
        const [, instance, deviceId] = m;
        const base = `${instance}.Devices.${deviceId}`;
        let name = `Vacuum ${deviceId.slice(0, 6)}`;
        try {
          const deviceObjRaw = await this.redisCmd.get(`cfg.o.${instance}.Devices.${deviceId}`);
          if (deviceObjRaw) {
            const deviceObj = JSON.parse(deviceObjRaw);
            if (deviceObj.common?.name) {
              name = deviceObj.common.name.de || deviceObj.common.name.en || name;
            }
          }
        } catch {
          // keep the fallback name
        }
        found.push({ id: base, serial: deviceId, name, kind: 'vacuum', base });
        this.setSelectDevice(base, name, undefined, 'robot_vacuum');
      }
    } while (cursor !== '0');
    return found;
  }

  /**
   * Reads host/port/type of the ioBroker database directly from
   * iobroker.json - this way the connection works automatically both in
   * file mode (built-in simulator, default port 9000 for states) and
   * with real Redis (e.g. port 6379), without us having to configure it
   * ourselves.
   */
  readIobrokerDbConfig() {
    const dataDir = this.config.iobrokerDataDir || DEFAULT_IOBROKER_DATA_DIR;
    const cfgPath = path.join(dataDir, 'iobroker.json');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      throw new Error(`Could not read ${cfgPath} (${err.message}). Is "iobrokerDataDir" set correctly in the plugin config?`);
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
        // Blind with separate current/target position states (e.g.
        // Shelly "Position" + "TargetPosition"): Matter WindowCovering
        // models this natively (current/target/operationalStatus).
        // Commands write to the target state - the physical device
        // moves there on its own and continuously reports the current
        // value back.
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
          // "Stop" here means: set the target position to the current
          // position, so the device stays where it is.
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
        // Simple case: only a single position state, no separate target
        // value - current and target are then always identical,
        // movement status stays "Stopped" (we have no information about
        // an ongoing movement).
        endpoint.addCommandHandler('upOrOpen', async ({ attributes }) => {
          attributes.currentPositionLiftPercent100ths = 0;
          await this.writeIobrokerState(id, this.toIobrokerBlindValue(0));
        });
        endpoint.addCommandHandler('downOrClose', async ({ attributes }) => {
          attributes.currentPositionLiftPercent100ths = 10000;
          await this.writeIobrokerState(id, this.toIobrokerBlindValue(100));
        });
        endpoint.addCommandHandler('stopMotion', async () => {
          this.log.info(`Stop command received for ${id} (no separate target state known, nothing to do)`);
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
      this.log.warn(`Device kind "${kind}" for "${id}" is not supported. Skipping.`);
      return;
    }

    await this.registerDevice(endpoint);
    this.endpoints.set(id, endpoint);
    this.kinds.set(id, kind);
    this.log.info(`Device "${name}" for "${id}" (${kind}) registered.`);

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
   * Creates a Roborock vacuum as a Matter RoboticVacuumCleaner. Uses the
   * same state mapping (mapRoborockOperationalState) and the same
   * command/state paths as our earlier dedicated plugin, just now via a
   * direct Redis connection instead of Socket.IO.
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
    this.log.info(`Vacuum "${name}" (${serial}) registered.`);

    this.stateWatchers.set(stateIdOperational, (state) => {
      const opState = mapRoborockOperationalState(Number(state.val));
      vacuum.setOperationalState(opState);
      this.log.debug(`Roborock state=${state.val} -> RvcOperationalState=${opState}`);
    });
    this.stateWatchers.set(stateIdBattery, (state) => {
      this.log.debug(`${name}: battery level ${state.val}%`);
      // A PowerSource cluster update can be added here later, once the
      // exact attribute name/scaling has been finally verified.
    });

    for (const stateId of [stateIdOperational, stateIdBattery]) {
      const raw = await this.redisCmd.get(`io.${stateId}`);
      if (raw) this.stateWatchers.get(stateId)?.(JSON.parse(raw));
      await this.redisSub.subscribe(`io.${stateId}`);
    }
  }

  /**
   * Generic vacuum for the device builder (customDevices, type
   * "vacuumSimple") - unlike the automatic Roborock detection (which
   * knows Roborock's specific numeric operational-state codes), this is
   * deliberately simplified: only "currently running" (yes/no) instead
   * of fine-grained states (error/charging/etc.), since status codes
   * cannot be generalized across different vacuum-robot adapters.
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
    this.log.info(`Generic vacuum "${name}" registered (simplified status model: running/not running).`);

    this.stateWatchers.set(isCleaningId, (state) => {
      const opState = state.val ? 0x01 /* Running */ : 0x42 /* Docked */;
      vacuum.setOperationalState(opState);
    });

    const raw = await this.redisCmd.get(`io.${isCleaningId}`);
    if (raw) this.stateWatchers.get(isCleaningId)?.(JSON.parse(raw));
    await this.redisSub.subscribe(`io.${isCleaningId}`);
  }

  /**
   * Generic, read-only sensor for the device builder (temperature,
   * humidity, contact, occupancy) - all four follow the same simple
   * single-state pattern, hence one shared method instead of four nearly
   * identical ones.
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
        // Matter BooleanState for ContactSensor: true = contact/closed.
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
      this.log.warn(`Unknown sensor kind "${sensorKind}" for "${name}".`);
      return;
    }

    await this.registerDevice(endpoint);
    this.endpoints.set(stateId, endpoint);
    this.kinds.set(stateId, `sensor:${sensorKind}`);
    this.log.info(`Sensor "${name}" (${sensorKind}) registered.`);

    const raw = await this.redisCmd.get(`io.${stateId}`);
    if (raw) this.stateWatchers.get(stateId)?.(JSON.parse(raw));
    await this.redisSub.subscribe(`io.${stateId}`);
  }

  /**
   * Dimmable light for the device builder. The ioBroker role
   * "level.dimmer" is usually 0-100 (percent), while Matter LevelControl
   * uses 1-254 - converted here.
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
    this.log.info(`Dimmer "${name}" registered.`);

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
      // Only accept confirmed values (ack:true) - ack:false are just
      // pass-through commands, not an actual device state.
      if (!parsed.ack) return;
      watcher(parsed);
    });
  }

  /**
   * The ioBroker convention for "level.blind" is not entirely uniform
   * across adapters (some use 0=closed/100=open, others the reverse). By
   * default we assume 0=open/100=closed (matching Matter WindowCovering:
   * 0=open, 10000=closed). If a device moves the wrong way, set
   * "invertBlindPosition": true in the plugin config.
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
    this.log.info(`Command sent to ioBroker: ${id} = ${JSON.stringify(val)}`);
  }

  async onShutdown(reason) {
    this.log.info(`ioBroker bridge shutting down: ${reason ?? ''}`);
    try {
      if (this.redisSub) await this.redisSub.quit();
      if (this.redisCmd) await this.redisCmd.quit();
    } catch (err) {
      this.log.debug(`Error closing the Redis connections: ${err.message}`);
    }
    await super.onShutdown(reason);
  }
}

export default function initializePlugin(matterbridge, log, config) {
  return new IobrokerBridgePlatform(matterbridge, log, config);
}
