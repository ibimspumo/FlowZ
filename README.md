# FlowZ

Eine lokale, nodebasierte Werkbank für Text-, Bild-, Video- und Marken-Workflows. OpenRouter übernimmt Text und Transkription; visuelle Cloud-Generierung und Bildwerkzeuge laufen über fal.ai. Projekte, Medien, Verläufe und Kosten bleiben nachvollziehbar in der lokalen Bibliothek.

## Starten

Voraussetzungen: Node.js 20+, Rust und die Tauri-2-Systemvoraussetzungen für macOS.

```bash
corepack prepare pnpm@11.10.0 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

Dann oben rechts **Einstellungen** öffnen und die benötigten OpenRouter-, fal.ai- und optionalen Brave-Search-Schlüssel eintragen. Die Keys werden über Rust im macOS-Schlüsselbund unter `dev.flowz.app` gespeichert und weder in Graphen noch in localStorage geschrieben.

Kostenpflichtige KI-Nodes werden bewusst und einzeln oder über die explizite Workflow-Ausführung gestartet. Deterministische Eingabe- und Transformations-Nodes aktualisieren abhängige Nodes lokal. Erzeugte Ergebnisse, Varianten, Graphen und Positionen werden projektbezogen gespeichert; Medien und Ergebnisverläufe liegen in der lokalen FlowZ-Bibliothek.

## Browser-Modus

`corepack pnpm dev` zeigt die Oberfläche im Browser, deaktiviert dort aber API- und Schlüsselbund-Aufrufe. Für echte Provider-Tests immer `corepack pnpm tauri dev` verwenden.

## Datenschutz und Kosten

Cloud-Ausführungen werden direkt an den jeweils gewählten Provider übertragen und können Kosten verursachen. FlowZ startet keine kostenpflichtige KI-Ausführung automatisch. Schätzungen und tatsächliche Providerkosten werden getrennt ausgewiesen.

## App-Icon aktualisieren

Das einzige manuell gepflegte Master-Asset liegt als `assets/icon/flowz-icon-master-1024.png` in exakt 1024 × 1024 Pixeln vor. Nach einem Austausch erzeugt

```bash
corepack pnpm icons
corepack pnpm run verify:icons
```

alle Tauri-/macOS-Formate und das Web-Favicon neu. Generierte Icon-Dateien werden mit eingecheckt, damit CI nur verifiziert und während eines Releases keine Assets stillschweigend verändert.

## Unsigned macOS-Releases

GitHub Releases werden derzeit ausschließlich für Apple-Silicon-Macs (`aarch64`) gebaut. Die App und ihre eingebetteten FFmpeg-Sidecars erhalten eine ad-hoc Signatur, aber keine Apple Developer-ID-Signatur und keine Notarisierung. macOS kann den ersten Start deshalb blockieren; ohne Apple-Notarisierung gibt es keine Garantie, dass jede macOS-Version oder Sicherheitsrichtlinie die App akzeptiert.

Installation:

1. DMG und `SHA256SUMS.txt` aus dem offiziellen [FlowZ-Releasebereich](https://github.com/ibimspumo/FlowZ/releases) in dasselbe Verzeichnis laden und vor der Installation prüfen:

   ```bash
   cd ~/Downloads
   grep 'FlowZ_.*_aarch64\.dmg$' SHA256SUMS.txt | shasum -a 256 -c -
   ```

   Nur bei der Ausgabe `OK` fortfahren und FlowZ aus dem DMG nach `/Applications` ziehen.
2. Zuerst per Rechtsklick auf FlowZ → **Öffnen** versuchen. Alternativ in **Systemeinstellungen → Datenschutz & Sicherheit** bei FlowZ **Dennoch öffnen** wählen.
3. Wenn Gatekeeper die ad-hoc signierte App weiterhin wegen des Download-Quarantäneattributs blockiert, bewusst im Terminal ausführen:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/FlowZ.app"
   ```

   Dieser Befehl entfernt Quarantäneattribute rekursiv. Ihn nur für eine direkt aus dem offiziellen Repository geladene FlowZ-App verwenden. Vorher kann die Datei anhand von `SHA256SUMS.txt` im Release geprüft werden.

## Updates und Releases

In **Einstellungen → FlowZ Updates** wird ausschließlich manuell nach Updates gesucht. FlowZ zeigt installierte und verfügbare Version sowie Release-Hinweise an. Der kombinierte Download-und-Installationsschritt erfordert eine ausdrückliche Aktion; der anschließende Neustart bleibt eine zweite, separate Entscheidung. Updater-Pakete werden mit einem separaten Tauri-Schlüssel signiert und vor der Installation geprüft.

Ein Release entsteht durch einen Tag, der exakt zur Version in `package.json`, `src-tauri/tauri.conf.json` und `src-tauri/Cargo.toml` passt:

```bash
corepack pnpm run verify:release -- v0.1.0
git tag v0.1.0
git push origin v0.1.0
```

Die GitHub Action veröffentlicht DMG, Tauri-Updater-Archiv, Signatur, `latest.json` und `SHA256SUMS.txt`. Der private Updater-Schlüssel gehört niemals ins Repository; die Pipeline liest ihn aus `TAURI_SIGNING_PRIVATE_KEY` und `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in GitHub Actions Secrets.

Vor dem ersten Release muss in GitHub ein geschütztes Environment `release-signing` eingerichtet und die beiden Signing-Secrets dort hinterlegt werden. Der Release-Workflow akzeptiert ausschließlich stabile Tags auf einem Commit von `main`, für den der normale CI-Workflow bereits erfolgreich war. Passend zu den gebündelten LGPL-Sidecars veröffentlicht jedes Release außerdem den exakt geprüften FFmpeg-Quell-Tarball samt Buildkonfiguration.

Der separate Updater-Schlüssel ist eine kostenlose, von Tauri vorgeschriebene Minisign-Signatur und benötigt weder einen Apple Developer Account noch ein kostenpflichtiges Zertifikat. Eine vollständige lokale Probe mit dem Schlüssel unter `~/.tauri/flowz-updater.key` und dem Passwort im macOS-Schlüsselbund führt denselben Artefaktprüfer wie GitHub Actions aus, ohne Tag, Upload oder Release:

```bash
bash scripts/rehearse-macos-release.sh
```

Die vollständigen Release-Sicherheitsgrenzen und der vor dem ersten Push noch ausstehende Clean-Checkout-Gate stehen in [`docs/release-security.md`](docs/release-security.md).
