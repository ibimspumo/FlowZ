# FlowZ Design System

## Direction

Eine konzentrierte Werkbank bei gedämpftem Abendlicht: Der Canvas tritt zurück, Inhalte und typisierte Verbindungen leuchten. Restrained color strategy, Dark Mode only.

## Color

Alle Farben werden als OKLCH-Tokens geführt. Nahezu neutrale Flächen, Rose nur für primäre Aktionen; Socket-Farben sind semantisch: Text blau, Bild magenta, Liste gelb. Zustände tragen zusätzlich Icon und Text.

## Typography

Inter bzw. die System-Sans als einzige UI-Familie. Kompakte feste Größen von 11–18 px, tabellarische Ziffern für Kosten und Zoomwerte.

## Shape & Depth

Node-Radius 12 px, Controls 8 px, Pills vollständig rund. Tiefe entsteht durch klare Flächenstufen und einen knappen Schatten, nicht durch dekoratives Glas.

## Motion

150–220 ms für Fokus, Auswahl und Statuswechsel. Keine dekorativen Eingangsanimationen. `prefers-reduced-motion` schaltet Übergänge aus.

## Components

Nodes folgen Kopf, Inhalt, Fuß. Primäraktionen sind rosefarben; sekundäre Aktionen neutral. Sockets zeigen Typfarbe, Form und Beschriftung. Formfelder haben konsistente Fokus-Ringe und mindestens 36 px Interaktionshöhe.

Canvasnahe Werkzeuge wie die Asset-Bibliothek erscheinen als nicht-modale, verschiebbare Paletten. Sie dürfen den Graph weder abdunkeln noch sperren. Inhalte werden per Drag-and-Drop direkt auf den Canvas oder auf kompatible Eingabe-Nodes gebracht; Tastaturaktionen bieten denselben Weg ohne Ziehen.

Audio und Video erscheinen in kompakten, nativen Media-Previews ohne Autoplay. Offscreen-Previews werden pausiert und laden höchstens Metadaten. FlowZ liefert große Medien über das private, Range-fähige `flowz-media`-Protokoll aus: Die WebView erhält ausschließlich eine SHA-256-ID, niemals lokale Pfade oder Base64-/Data-URLs. Ein localhost-Server wurde bewusst vermieden, weil er einen Netzwerk-Listener, Portverwaltung und zusätzliche Angriffsfläche erzeugen würde; Tauri-Custom-Protocol-Responses bleiben prozesslokal und erlauben trotzdem Browser-seitiges Seeking.

Lokale Spracherkennung ist eine bewusst optionale Erweiterung und keine vorgetäuschte Laufzeitfähigkeit. Sie darf erst als auswählbarer Provider erscheinen, wenn ein lokaler Adapter samt Modellverwaltung, Downloadstatus, Speicherbedarf, Abbruchsemantik und reproduzierbaren Qualitätstests installiert ist. Bis dahin zeigt die Transkriptions-Node ausschließlich verifizierte OpenRouter-STT-Modelle und kennzeichnet lokale STT transparent als nicht installiert.

Wort- und Abschnittszeitmarken werden nur für eine explizite, getestete OpenRouter-Modell-Allowlist aktiviert; ein gemeinsames Namenspräfix reicht nicht als Capability-Nachweis. Bezahlte Transkriptionen werden atomar mit Kosten und Provenienz in SQLite gespeichert. Scheitert diese gesamte Transaktion nach erfolgreicher Providerantwort, schreibt FlowZ Text, Kosten, Modell, Quell-Provenienz und typisierte Zeitmarken zusätzlich atomar und `fsync`-durable in eine auf 256 Einträge beziehungsweise 64 MiB begrenzte 30-Tage-Notfallablage. Diese Ergebnisse erscheinen unter „Nicht zugeordnet“ und lassen sich nach Wiederherstellung der Datenbank als Text-Node übernehmen.

Mikrofonzugriff beginnt ausschließlich nach einem expliziten Klick in einer Audio-Import-Node. Während der Aufnahme zeigt die Node Dauer, Stoppen/Übernehmen und Verwerfen an; Dateiimport bleibt die gleichwertige Alternative. MediaRecorder-Chunks werden sequenziell als rohe IPC-Bytes in eine begrenzte Rust-Session geschrieben, bei Rückstau pausiert und nach Abbruch, Fehler oder Neustart vollständig aus dem temporären Bereich entfernt. Erst eine erfolgreich geprüfte Aufnahme wird als unveränderliches Audioergebnis übernommen.

Das Tauri-Protokoll beantwortet kleine Anfragen ohne `Range` standardskonform als vollständige `200`-Antwort; eine unaufgeforderte `206`-Teilstrecke wäre semantisch falsch. Tauri-v2-Custom-Protocol-Bodies sind derzeit `Cow<[u8]>` statt Streams. Deshalb werden GETs ohne `Range` oberhalb von 8 MiB kontrolliert mit `413 Payload Too Large`, `Accept-Ranges: bytes` und `X-FlowZ-Required-Range: bytes` abgelehnt, statt bis zu 4 GiB in den Prozessspeicher zu laden. Die nativen WebKit-/Chromium-Mediaelemente fordern seekbare Audio- und Videodaten beim Abspielen in Byte-Bereichen an. Jede explizit angeforderte Strecke wird auf 8 MiB begrenzt und erhält einen exakten `Content-Range`. Sobald Tauri einen Streaming-Body für Custom Protocols anbietet, kann der große No-Range-Pfad ohne Speicher-Risiko auf eine vollständige gestreamte `200`-Antwort umgestellt werden.

Ältere Projektdateien aus Schema v2 und Datenbank-v6-Ergebnisse können Medienmetadaten ohne das später ergänzte Feld `playable` enthalten. FlowZ normalisiert diesen abgeleiteten Vorschauwert deterministisch aus Container und Codecs in TypeScript und Rust. Projekt-Schema und Media-Modul bleiben bewusst auf Version 2 beziehungsweise Modulversion 1: Der Wert ändert weder Ports noch Ausführungssemantik oder gespeicherte Originalbytes. Unbekannte Codecs werden konservativ als nicht direkt abspielbar markiert; das CAS-Original bleibt für nachfolgende Nodes erhalten.

## Custom Controls

Interaktive Auswahlfelder werden als gemeinsame FlowZ-Komponenten gestaltet, wenn dadurch die Aufgabe klarer oder schneller wird. Modelllisten verwenden ein durchsuchbares Combobox-/Listbox-Muster; kompakte Parameter wie Format und Auflösung verwenden dieselbe visuelle Sprache ohne unnötige Suche. Native Controls bleiben nur dort bestehen, wo sie funktional oder barriereärmer überlegen sind. Alle Custom Controls benötigen Tastatursteuerung, sichtbaren Fokus und semantische ARIA-Zustände.
