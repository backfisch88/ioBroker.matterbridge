# iobroker.matterbridge

Installiert und überwacht eine native Matterbridge-Instanz aus ioBroker heraus
und bettet deren Oberfläche als Admin-Tab ein. Die eigentliche Matter-Logik
(Plugins, Bridges, Geräte) verwaltest du komplett in Matterbridge selbst -
dieser Adapter ist "nur" der Prozess-Supervisor + die Einbettung.

## Voraussetzungen

- Laufende ioBroker-Installation (js-controller >= 5.0.0)
- Node.js >= 18, npm, `jq` (wird von `install.sh` bei Bedarf nachinstalliert)

## Isolierte Node.js-Laufzeit für Matterbridge

Matterbridge (bzw. dessen `@matterbridge/*`/`@matter/*`-Abhängigkeiten) kann eine
neuere Node.js-Version voraussetzen als das System-Node, mit dem ioBroker selbst
läuft. Damit das System-Node für ioBroker und andere Adapter **nicht** angefasst
werden muss, lädt dieser Adapter beim ersten Start automatisch eine eigene,
isolierte Node.js-Version (Standard: 24.x) herunter und legt sie unter
`<Adapterordner>/nodeRuntime` ab. Diese Laufzeit wird ausschließlich für die
npm-Installation von Matterbridge und den Start des Matterbridge-Kindprozesses
verwendet – nirgendwo sonst im System.

Falls eine künftige Matterbridge-Version eine höhere Node-Hauptversion braucht,
kann das in den Adapter-Einstellungen unter "Node.js-Hauptversion für
Matterbridge" angepasst werden; der Adapter lädt die passende Version dann
beim nächsten Start automatisch nach.

Unterstützt werden aktuell Linux und macOS auf x64/arm64 (automatischer
Download von nodejs.org). Für andere Plattformen muss die Node-Version manuell
nach `<Adapterordner>/nodeRuntime` entpackt werden.

## Zuverlässiger globaler npm-Prefix (auch für Matterbridges eigenen "Install"-Button)

Matterbridge installiert Plugins nicht nur über die Kommandozeile, sondern
bietet im Web-Frontend auch einen eigenen "Install"-Button, der intern selbst
`npm install -g ...` aufruft. Dieser interne Mechanismus hat sich als nicht
zuverlässig darin erwiesen, die `NPM_CONFIG_PREFIX`-Umgebungsvariable zu
übernehmen, die der Adapter beim Start von Matterbridge setzt - Plugins
landeten dadurch teils trotzdem im System-Standard-Verzeichnis
(`npm root -g`) statt im isolierten Installationsordner dieses Adapters.

Um das zuverlässig zu vermeiden, schreibt der Adapter beim Start zusätzlich
eine `prefix=`-Zeile in die persönliche `~/.npmrc` des Users, unter dem der
Adapter-Prozess läuft. Diese Datei liest npm *immer*, unabhängig davon, wie
oder von welchem Code aus `npm` aufgerufen wird - das ist deutlich robuster
als sich auf Umgebungsvariablen-Vererbung durch fremden Code zu verlassen.
Bestehende andere Einträge in `~/.npmrc` bleiben dabei unangetastet; nur eine
eventuell abweichende `prefix=`-Zeile wird (mit Log-Hinweis) korrigiert.

## Mitgeliefertes Plugin: matterbridge-iobroker-bridge

Der Adapter installiert und registriert das mitgelieferte generische
Plugin `matterbridge-iobroker-bridge` automatisch, falls es noch nicht
vorhanden ist - kein manueller Zusatzschritt noetig, um ioBroker-Geraete
(Schalter, Rollos, Roborock-Sauger, ...) ueber Matterbridge bereitzustellen.

**Wichtig:** Das Plugin startet standardmaessig mit **null aktiven Geraeten**
(reines Opt-in). Um Geraete zu aktivieren, im Matterbridge-Frontend bei
diesem Plugin die Config oeffnen und entweder:
- einzelne Geraete unter `whiteList` anhaken (Checkbox-Liste), oder
- unter `idPrefixes` einen Praefix eintragen, z.B. `["shelly.0."]`, um
  **alle** gefundenen Geraete einer ganzen Adapter-Instanz auf einmal zu
  aktivieren, ohne jedes einzeln anzuhaken.

`blackList` schliesst States in beiden Faellen explizit aus.

## Plugins zuverlässig installieren: `control.installPlugin` statt Frontend-Button

Matterbridges eigener "Install"-Button im Web-Frontend spawnt seinen
`npm install`-Kindprozess nachweislich mit dem **System-Node/npm**, nicht mit
der isolierten Runtime dieses Adapters - selbst wenn Matterbridge selbst
korrekt mit der isolierten Node-Version läuft. Das lässt sich von diesem
Adapter aus nicht beheben, da es sich um fest verdrahtetes Verhalten in
Matterbridges eigenem Code handelt.

Stattdessen gibt es zwei neue States, über die Plugin-Installation/-Entfernung
zuverlässig **innerhalb dieses Adapters** läuft (garantiert korrekte
Node/npm-Version, korrekter `-homedir`, kein manuelles `export`/`$MB` in
irgendeiner Shell nötig):

- **`control.installPlugin`**: npm-Paketnamen reinschreiben (z.B.
  `matterbridge-roborock-vacuum-plugin`) → wird installiert und bei
  Matterbridge registriert. Matterbridge danach einmal neu starten, damit das
  Plugin geladen wird.
- **`control.removePlugin`**: npm-Paketnamen reinschreiben → wird bei
  Matterbridge deregistriert (Dateien bleiben auf der Platte, bei Bedarf
  manuell löschen).

### Eigentliche Ursache gefunden (seit Version 0.5.0 behoben): `-nosudo`

Matterbridge stellt seinen eigenen internen `npm install`-Aufrufen (u.a. den
Install-Button im Frontend) automatisch ein `sudo` voran, sobald der `PATH`
keinen `/.nvm/versions/node/`-Anteil enthält (siehe `spawnCommand.js` im
`@matterbridge/thread`-Paket) - das trifft auf unsere eigene, isolierte
Node-Runtime (statt `nvm`) immer zu. `sudo` setzt aber standardmäßig die
Umgebung zurück (eigener `PATH` aus `/etc/sudoers`), wodurch das sorgfältig
gesetzte `NPM_CONFIG_PREFIX` bei jedem internen Install-Aufruf verloren ging -
das war die eigentliche Ursache dafür, dass Plugins über den Frontend-Button
immer wieder im System-Standardverzeichnis statt im isolierten
Installationsordner landeten.

Der Adapter startet Matterbridge seit Version 0.5.0 mit dem offiziell
unterstützten CLI-Flag `-nosudo`, das dieses Verhalten sauber deaktiviert -
kein Patchen von Matterbridge-Dateien nötig, übersteht also auch
Matterbridge-Updates. Der Frontend-Install-Button sollte damit ebenfalls
zuverlässig funktionieren; `control.installPlugin`/`control.removePlugin`
bleiben als zusätzlicher, garantiert funktionierender Weg bestehen.
- Zugriff auf den ioBroker-Host per SSH/Terminal

## Installation

1. Diesen Ordner komplett auf den ioBroker-Host kopieren, z.B.:
   ```bash
   scp -r iobroker.matterbridge/ pi@iobroker-host:/home/pi/
   ```

2. Auf dem Host, als der User, unter dem ioBroker läuft:
   ```bash
   cd /home/pi/iobroker.matterbridge
   chmod +x install.sh uninstall.sh
   ./install.sh /opt/iobroker
   ```
   (Pfad `/opt/iobroker` ggf. an deine Installation anpassen.)

3. Das Skript fragt interaktiv nach Frontend-Port, Matter-Port und
   mDNS-Interface, installiert Matterbridge global via npm falls nötig,
   legt die Adapterinstanz an, konfiguriert sie und startet sie.

4. Nach dem Start:
   - Log prüfen: `iobroker logs matterbridge.0`
   - Admin-Tab "Matterbridge" in der ioBroker-Oberfläche öffnen
   - Dort Community-Plugins (Roborock, Dreame, Dyson, ...) wie gewohnt
     über die Matterbridge-Oberfläche installieren und konfigurieren

## Deinstallation

```bash
./uninstall.sh /opt/iobroker        # Instanz + Adapter entfernen
./uninstall.sh /opt/iobroker -f     # zusätzlich Matterbridge-Storage löschen
```

## Bekannte Stolpersteine

- **Rechte für globale npm-Installation:** Falls `npm install -g matterbridge`
  im Adapter-Log fehlschlägt, dem ioBroker-User Schreibrechte auf den
  globalen npm-Pfad geben oder auf lokale Installation umstellen
  (`installPath` in der Adapter-Config).
- **Portkonflikte:** Läuft bereits eine zweite Matter-Instanz
  (z.B. `ioBroker.matter`) auf demselben Host, Frontend- und Matter-Port
  unterschiedlich wählen.
- **iFrame/Login:** Falls Matterbridge mit Passwortschutz läuft, wirst
  du im Admin-Tab zum Matterbridge-Login weitergeleitet - das ist normal.
