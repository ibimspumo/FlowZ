# FlowZ End-to-End Audit & Findings

Stand: 2026-07-13, Release-Kandidat `0.1.3`  
Audit-Ziel: Installierte FlowZ-App vollständig prüfen, reproduzierbare Fehler und Produktlogik-Lücken beheben und die korrigierte Version erneut verifizieren.  
Testobjekte: Ausgangsversion `/Applications/FlowZ.app` `0.1.1`; mehrfach korrigiertes lokales Bundle `0.1.2`; Release-Kandidat `0.1.3`; Branch `codex/e2e-hardening-0.1.2`.

## Status

- Phase: abgeschlossen; Veröffentlichung von `0.1.3`
- Technischer Gate: **bestanden** (Frontend, Rust, Clippy, Build, Ressourcen- und Release-Version)
- Produkt-/Node-Gate: **bestanden**; nativer Text→Bild→Video-Flow, Previews, History, Expand, Playback, Delete und MP4-Import ausgeführt
- Release-Gate: **0.1.3 versioniert**; signierte DMG-/Updater-Artefakte werden ausschließlich durch den geschützten GitHub-Release-Workflow erzeugt
- Offene bestätigte P0/P1/P2/P3 im Code: **0 / 0 / 3 / 0**. Die drei P2 sind nicht release-blockierende Performance-/Target-/Chunk-Optimierungen.

## Methodik

Jeder Befund erhält Schweregrad, reproduzierbare Schritte, erwartetes und tatsächliches Verhalten, technische Ursache, Fix und Retest-Evidenz. P0/P1 werden vor einem Release zwingend geschlossen. P2 werden geschlossen, sofern sie den vereinbarten Produktumfang betreffen; P3 wird nur aufgenommen, wenn der Befund objektiv und überprüfbar ist.

## Testumgebung

| Eigenschaft | Wert |
|---|---|
| Datum / Zeitzone | 2026-07-13 / Europe/Berlin |
| Plattform | macOS (lokal installierte Tauri-App) |
| Installierte App | `/Applications/FlowZ.app` |
| Ausgangs-/Zielversion | `0.1.1` → `0.1.3` |
| Native Persistenz | bestehende SQLite-/CAS-Daten bewusst übernommen |
| Provider | OpenRouter, fal.ai und Brave Search verbunden; Schlüsselbundfreigabe erteilt; kostenbegrenzte Live-Aufrufe erfolgreich |
| Zielstandard | PRODUCT.md, DESIGN.md, WCAG 2.2 AA |

## Audit Health Score

| # | Dimension | Score | Kernbefund |
|---|---|---:|---|
| 1 | Accessibility | 3/4 | Fokusfallen/-rückgabe, Home-Roving-Tabindex, Artboard-Tastatur und Kontrast korrigiert; kleine Bestands-Targets bleiben P2. |
| 2 | Performance | 2/4 | Vollständige Store-Abos und Artboard-Pointer-Rerender skalieren schlecht. |
| 3 | Responsive | 3/4 | Artboard-Panels und Topbar besitzen nun kompakte Breakpoints; Extrembreiten bleiben bewusst begrenzt. |
| 4 | Theming | 3/4 | Fehlende semantische Tokens und `--dim` korrigiert; einzelne harte Bestandsfarben bleiben wartbarkeitsrelevant. |
| 5 | Anti-Patterns | 4/4 | Eigenständige Werkbank; Preview-/History-Vertrag ist nun konsistent im Produktmuster verankert. |
| **Gesamt** |  | **15/20 · Good** | Release-Blocker geschlossen; verbleibende P2-Optimierungen getrennt ausgewiesen. |

Anti-Pattern-Verdikt: FlowZ wirkt grundsätzlich wie ein eigenständiges Produktionswerkzeug und nicht wie ein generisches AI-SaaS. Die schweren Probleme sind funktional, resilient, zugänglich und responsiv, nicht primär ästhetisch.

## Befunde

### FZ-E2E-001 · P0 · Node löschen kann die gesamte App schwarz machen

- **Status:** **behoben**; DOM-Regression, Root-/Workspace-/Node-Recovery und benignes Removal automatisiert verifiziert. Header-Delete und Tastatur-Delete wurden nativ ausgeführt; kein Black Screen und kein App-Absturz.
- **Ort:** `src/components/ModuleNodeComponent.tsx:13-21`, `src/components/AppNodeHost.tsx:20`, `src/store.ts:705-714`, `src/main.tsx:8`.
- **Ursache:** ReactFlow kann während seiner prop→interner-Store-Synchronisierung noch einen alten Node-Renderer halten, nachdem der kanonische Graph den Node bereits entfernt hat. `AppNodeHost` wirft in diesem legitimen Zwischenzustand. Ohne Root-/Workspace-Error-Boundary wird der gesamte React-Root entfernt; sichtbar bleibt nur die schwarze WebView.
- **Auswirkung:** Kerninteraktion führt zum vollständigen Oberflächenverlust. Nicht gespeicherter Kontext und Cancel-Oberflächen laufender Jobs werden unzugänglich.
- **Fix:** `AppNodeHost` und `ModuleNodeComponent` behandeln den legitimen Removal-Zwischenzustand als leere Darstellung. `RecoveryBoundary` schützt Root, Workspace und einzelne Nodes; die UI bietet einen kontrollierten Wiederanlauf statt einer schwarzen WebView.
- **Evidenz:** `src/components/ui-resilience.test.tsx`, `src/components/RecoveryBoundary.tsx`; gesamter Frontend-Gate 552/552 grün.

### FZ-E2E-002 · P0 · Erfolgreiche fal.ai-Bild-/Videoläufe werden als veraltet verworfen

- **Status:** **behoben**; gemeinsamer Snapshot-Vertrag und Rust-Targetprüfungen für Bild, Video und Brand grün. FLUX.1 Schnell und Seedance 2.0 Fast wurden nativ erfolgreich ausgeführt und aktiviert.
- **Ort:** `src/nodes/fal-transport.ts:17-19,41,100`, `src-tauri/src/fal_image.rs:1622-1659`, `src-tauri/src/fal_provider.rs:1180-1187`, `src/nodes/fal-view.tsx:403-404`.
- **Reale Evidenz:** Zwei heutige `google/nano-banana-2-lite`-Läufe sind in SQLite `success`, Providerphasen `complete`, CAS enthält gültige 1376×768-PNGs. Gleichzeitig existiert kein aktives Ergebnis. Die gespeicherten Input-Fingerprints enthalten ausschließlich `{execution: …}`.
- **Ursache:** TypeScript sendet nur einen vereinfachten Fingerprint, während Rust für die Current-Target-Prüfung Modul-, Konfigurations-, Request- und Verbindungsdaten erwartet. `targetCurrent` wird dadurch false, obwohl sich das Projekt nicht geändert hat.
- **Auswirkung:** Kostenpflichtige Arbeit gelingt beim Provider, erscheint aber nicht aktiv am Node. Das verletzt zusätzlich das Preview-/Öffnen-Kriterium.
- **Fix:** Kanonisches `ExecutionSnapshot`-Schema auf TypeScript- und Rust-Seite, inklusive Modulversion, Projekt-/Node-Revision, normalisierter Konfiguration, Request und Verbindungszustand. Unveränderte Targets werden aktiviert; abweichende Snapshots bleiben als bezahlte, wieder zuweisbare Orphans erhalten.
- **Evidenz:** `src/nodes/execution-snapshot.test.ts`, `src-tauri/src/execution_snapshot.rs`, Rust-Tests `logo_target_accepts_exact_contract_and_rejects_module_change` und `video_target_accepts_exact_snapshot_and_rejects_request_or_revision_change`.

### FZ-E2E-003 · P1 · Persistierte Ergebnisse werden nie aktiv gesetzt

- **Status:** **behoben**; atomare Persistenz, explizite Aktivierung und Restart-Hydration automatisiert verifiziert.
- **Ort:** `src-tauri/src/lib.rs:2491-2555`, `src-tauri/src/persistence/database.rs:848-896`, `src/nodes/extracted-provider-views.tsx:215-280`, `src/nodes/extracted-node-views.tsx:415-439`, `src/store.ts:307-311`.
- **Evidenz:** Lokale Datenbank enthält derzeit acht Resultate und null Zeilen in `active_results`.
- **Ursache:** `library_store_result` hängt Results bewusst nur an; produktive Caller markieren sie ausschließlich flüchtig als aktiv und rufen keine persistente Aktivierung auf. Hydration lädt nur aktive Werte.
- **Auswirkung:** Text-, Webseiten-, lokale Bild- und Providerergebnisse verschwinden nach Neustart als aktive Node-Ausgabe. Preview und Downstream-Wiring brechen.
- **Fix:** Provider- und lokale Ergebnisse werden mit targetgebundener Aktivierung atomar gespeichert. Die Hydration rekonstruiert aktive Werte nach Neustart, ohne Preview-Daten zu verkabeln.
- **Evidenz:** `src/nodes/provider-persistence.test.ts`, `src-tauri/src/persistence/database.rs` einschließlich Atomizitäts-, Restart- und Rollbacktests.

### FZ-E2E-004 · P1 · Bildausgänge werden nach Hydration zu Data-URLs statt CAS-Referenzen

- **Status:** **behoben**; CAS-only-Hydration und Negativtests für Data-/Provider-URLs grün.
- **Ort:** `src/store.ts:323-331,380-420`, `src/components/result-curation.ts:93-115`, `src/nodes/fal-view.tsx:241-257`, `src/nodes/fal-runtime.ts:22-35`.
- **Ursache:** Persistierte Bildvarianten, Collections und Asset-Referenzen materialisieren Preview-Data-URLs als verkabelbare Werte. Downstream wird daraus ungültig `flowz-cas:data:image…` gebaut.
- **Auswirkung:** Bild→Bildanalyse/-generierung/-video und kuratierte Listen können nach Reload technisch nicht funktionieren.
- **Fix:** Verkabelbare Medienwerte bleiben ausschließlich `flowz-cas:<64-hex>`; Data-URLs werden nur für sichtbare Previews materialisiert. Vergleiche beim Hydrieren sind target-/revisionsgebunden.
- **Evidenz:** `src/store.hydration-cas.test.ts`, `src/components/result-curation.test.ts`.

### FZ-E2E-005 · P1 · Sichtbare Domain- und Logo-Direktfelder sind nicht editierbar

- **Status:** **behoben**; Adapter-Whitelist, kontrollierte Direktfeldtests und native Eingabe-/Persistenzprüfung grün.
- **Ort:** `src/app/adapters.ts:314-352`, `src/nodes/extracted-provider-views.tsx:463-479`, `src/nodes/image/views.tsx:58-98`.
- **Reproduktion Domain:** Template „Marke von Grund auf“ einsetzen → in „04 · Domains“ `flowz-e2e-test` in „Domainname“ schreiben → Wert verschwindet sofort; Projektdatei behält `domainName: ""`.
- **Reproduktion Logo:** In „08 · Transparentes Logo“ ein lokales Briefing eingeben → Feld bleibt leer und der Override bleibt deaktiviert.
- **Ursache:** `configPatchFor` whitelistet die sichtbaren Felder `domainName`, `inlineBrief` und `briefOverride` nicht.
- **Auswirkung:** Der im Produktvertrag geforderte Direktmodus ist für Domains und Logo faktisch kaputt.
- **Fix/Evidenz:** `domainName`, `inlineBrief` und `briefOverride` werden exakt persistiert; `src/app/adapters.test.ts` deckt die Direktmodi ab.

### FZ-E2E-006 · P1 · Brand-Artefakte sind nicht fachlich typisiert

- **Status:** **behoben**; nominale Artefaktidentitäten sind an sämtlichen Verbindungswegen zentral erzwungen.
- **Ort:** `src/domain/values.ts:3-7`, `src/nodes/module-specifications.ts:414-623`, `src/nodes/brand/execute.ts:129-163,358-361`.
- **Ursache:** Briefing, Zielgruppe, Namen, Palette, Fonts und Artboard teilen den generischen Typ `json`. Die UI erlaubt dadurch fachlich unsinnige Kabel, die erst im Executor am Envelope scheitern.
- **Auswirkung:** Typen verhindern Fehler nicht vor der Ausführung, obwohl dies ein zentraler Produktwert ist.
- **Fix:** Acht nominale Identitäten (`brand-brief`, `audience-analysis`, `name-candidate-list`, `domain-availability`, `handle-plan`, `font-pairing`, `color-palette`, `artboard-reference`) erweitern JSON-Porttypen. Generisches und nominales JSON sind absichtlich inkompatibel.
- **Evidenz:** 58 fokussierte Kompatibilitäts-/Template-Tests; explizite Negativfälle Brief→Domain, Audience→Domain und Palette→Artboard-Fonts.

### FZ-E2E-007 · P1 · Text-/Bildanalyse-Varianten und Video-Listen sind nur scheinbar umgesetzt

- **Status:** **behoben**; Runtime-Werte bleiben typisierte Listen, jede Textvariante wird als eigenes Resultat derselben Run-Familie persistiert und ist kuratierbar.
- **Ort:** `src/nodes/extracted-provider-views.tsx:31-73,193-255`, `src/nodes/ai/modules.ts:64-105`, `src/nodes/video/modules.ts:41,112-152`.
- **Ursache:** Runtime-Listen werden als ein JSON-String serialisiert, nur der erste Skalar persistiert, `listProcessingMode` nicht ausgewertet, Bildlisten teils als Text aufgebaut. Video gibt künstlich eine Singleton-Liste aus.
- **Auswirkung:** Fan-out, Geschwistervarianten, aktive Auswahl und Downstream-Wiederverwendung entsprechen nicht dem Produktvertrag.
- **Fix/Evidenz:** `src/nodes/runtime-display-values.ts`, `src/nodes/runtime-display-values.test.ts`, `src/nodes/provider-persistence.test.ts`; Provider-Metadaten führen Kosten je Variante.

### FZ-E2E-008 · P1 · Generationsfehler zeigt nur eine generische Meldung

- **Status:** **behoben**; Brand-Resultpräfix, vollständiger Snapshot und sichere strukturierte Fehlerdetails korrigiert. Nativer Zielgruppenlauf erfolgreich; genau ein Loading-State und sichtbares Ergebnis/History bestätigt.
- **Reproduktion:** Vollständiges Markenbriefing an „02 · Zielgruppe“ anschließen → „Zielgruppe analysieren“ → Node wechselt von „Läuft“ zu „Fehler“ und zeigt ausschließlich „Der Vorgang konnte nicht abgeschlossen werden.“; kein `runs`-Eintrag wird erzeugt.
- **Auswirkung:** Nutzer kann weder Ursache noch Handlung ableiten; Debugging und Selbsthilfe sind unmöglich.
- **Technische Ursache:** Der Providerlauf selbst antwortet erfolgreich. Der Frontend-Caller persistiert jedoch `module-audienceAnalysis`, während Rust ausschließlich `brand-audienceAnalysis` akzeptiert. Der Reject geschieht nach dem möglicherweise kostenpflichtigen Providerlauf, aber vor dem `runs`-Insert. Selbst nach einer reinen Prefix-Korrektur fehlt noch der vollständige Snapshot, sodass Rust das Resultat als nicht aktuell einstufen würde, während die UI es fälschlich als aktiv markiert.
- **Fixziel:** Gemeinsamer Brand-Resultvertrag inklusive vollständigem Execution-Snapshot und Run-Journal vor dem Provideraufruf; strukturierter Fehlercode, sichere technische Details/Retry-Hinweis, kopierbare Diagnose-ID; Providerfehler weiterhin ohne Secret-Leak.
- **Evidenz:** TypeScript-/Rust-Snapshot-Contracttests, Secret-Scanner und vollständiger Rust-Gate.

### FZ-E2E-009 · P1 · Preview-, Öffnen- und History-Vertrag ist nicht durchgängig gesichert

- **Status:** **behoben und nativ verifiziert**; Text, Bild und Video waren inline sichtbar, groß zu öffnen und jeweils in der History vorhanden. Text/Bild überstanden einen nativen Neustart. Der beim abschließenden Video-Neustart entdeckte URL-Hydrierungsfehler ist durch einen vollständigen Store-Reload-Regressionstest geschlossen; auf ausdrücklichen Nutzerwunsch erfolgte danach kein weiterer Eingriff in die installierte App.
- **Anforderung:** Jeder generierte Text, jedes Bild und jedes Video muss inline sichtbar, als aktive Version erkennbar, in größerer Ansicht zu öffnen, in History/Varianten auswählbar und nach Neustart weiterhin verfügbar sein.
- **Bekannte Blocker:** E2E-002 bis E2E-004 verhindern aktive beziehungsweise restart-feste Previews. Die Result-History/Lightbox wird innerhalb des transformierten ReactFlow-Canvas statt in einem Portal gerendert (`NodeHistoryLauncher.tsx:12-16`, `NodeResultHistory.css:1`) und kann dadurch gezoomt, verschoben oder geclippt sein.
- **Interaktive Evidenz:** Die History von „01 · Markenbriefing“ wurde bei Fit-View geöffnet. Statt eines viewportfüllenden Overlays erschien sie als wenige Pixel breite, mitskalierte Spalte innerhalb der Node; Textinhalt und Aktionen waren praktisch unlesbar. Damit ist Öffnen/Vergrößern am realen Canvas eindeutig nicht nutzbar.
- **Fix:** `InlineOutputPreview` zeigt Text, Bilder, Bildlisten und Videos direkt am Node. Anklicken/Expandieren öffnet ein portaliertes, viewportgebundenes Overlay. History und Lightbox liegen außerhalb der Canvas-Transformation, besitzen Fokusfalle, Escape-Schließen und Fokusrückgabe; lange Texte sind groß lesbar, alle Varianten bleiben einzeln auswählbar.
- **Evidenz:** `src/components/inline-output-preview.test.tsx`, `src/components/ui-resilience.test.tsx`, `src/components/NodeResultHistory.tsx`.

### FZ-E2E-010 · P0 · Gebündeltes FFmpeg verhindert jeden Videoimport

- **Status:** **behoben**; Rust-Integrationstest mit dem tatsächlich aufgelösten Sidecar und nativer Import einer kontrollierten H.264/AAC-MP4 grün. Inline-Player und 2 s / 640×360 / 24 fps wurden angezeigt.
- **Reproduktion:** In einer `Video-Import`-Node eine gültige 640×360-H.264/AAC-MP4 wählen → Node zeigt nur „Der Vorgang konnte nicht abgeschlossen werden.“. Dieselbe Datei wird von gebündeltem `ffprobe` vollständig gelesen; Audioimport einer kontrollierten WAV funktioniert inklusive Inline-Player.
- **Technische Ursache:** Das gebündelte FFmpeg 8.1.2 wurde mit `--disable-zlib` gebaut und besitzt keinen PNG-Encoder. `extract_video_frame()` verlangt für Start-/Endbild zwingend PNG. Ein direkter Sidecar-Aufruf endet mit `Automatic encoder selection failed ... codec png is probably disabled`. JPEG/MJPEG-Ausgabe funktioniert und wird bereits für Poster verwendet.
- **Ort:** `src-tauri/src/persistence/media.rs:382-409`, Sidecar-Buildkonfiguration in `src-tauri/third-party/ffmpeg/README.md`.
- **Auswirkung:** Lokaler Videoimport und downstream Frame-/Sequenzfunktionen sind in der ausgelieferten App vollständig blockiert; generierte Videos würden beim gleichen Frame-Extraktionsschritt ebenfalls scheitern.
- **Fix:** Start-/Endframes werden mit dem im Bundle garantierten MJPEG/JPEG-Encoder erzeugt; Mime-/CAS-Metadaten entsprechen dem realen Format.
- **Evidenz:** `real_video_import_creates_decodable_derivatives_with_the_bundled_sidecar` und vollständiger Rust-Gate.

### FZ-E2E-011 · P1 · Provider-Nodes zeigen denselben Loading State doppelt

- **Status:** **behoben**, durch Nutzer-Screenshot an „Zielgruppe analysieren“ bestätigt und anschließend zentral über alle Node-Familien geprüft.
- **Reproduktion:** Providerlauf starten → im Node-Inhalt erscheint ein alleinstehender Spinner, gleichzeitig rendert der gemeinsame Node-Footer Spinner plus „Läuft“.
- **Ursache:** `ProviderBody` fügte zusätzlich zum statusführenden `ModuleNodeFrame` einen zweiten `LoaderCircle` ein. Mehrere lokale/Context-Runbuttons verwendeten ebenfalls Spinner, obwohl der Footer bereits den laufenden Zustand erklärt.
- **Fix:** Genau ein Live-Status bleibt im Footer (`role=status`). Die primäre Aktion wird während des Laufs zur eindeutigen Abbrechen-Aktion mit Stop-Symbol; der redundante Provider-Spinner wurde entfernt.
- **Evidenz:** `src/components/ui-resilience.test.tsx` erzwingt den zentralen Ein-Status-Vertrag; Nutzerscreenshots vom 13.07.2026 dokumentieren den Ausgangsfehler.

### FZ-E2E-012 · P1 · Unabhängige Änderungen werden fälschlich als Projektwechsel behandelt

- **Status:** **behoben**; exakte port-/resultgebundene Snapshots tolerieren Canvas- und unabhängige Projektänderungen, ohne Zieländerungen durchzulassen.
- **Reproduktion:** Bezahlten Brand-/Medienlauf starten; währenddessen Canvas verschieben, zoomen oder eine unabhängige Node ändern → Backend speichert das Ergebnis, verweigert aber die Aktivierung mit „Das Projekt wurde während des Vorgangs gewechselt“.
- **Ursache:** Der Execution Snapshot verlangte die exakte globale Projekt-Revision und verwendete zugleich nicht portgenaue aktive Quellresultate. Visuelle Canvas-Metadaten und unabhängige Graphänderungen wurden dadurch wie eine Änderung des eigentlichen Targets behandelt.
- **Fix:** Target-Konfiguration, konkrete eingehende Kanten und port-/resultgenaue Upstream-Identitäten werden streng geprüft; Canvas-/unabhängige Änderungen werden toleriert. Stale bezahlte Resultate erscheinen trotzdem sofort in der History, ohne die alte aktive Ausgabe zu ersetzen.

### FZ-E2E-013 · P0 · App-Start scheitert mit Apple-Crashreport und `FOREIGN KEY constraint failed`

- **Status:** **behoben**; Start gegen eine unveränderte Kopie der realen Nutzerdaten und regulärer nativer Neustart erfolgreich.
- **Ursache:** Der generische Orphan-Sweep berücksichtigte `font_provenance` nicht. Vier gültige Font-/Lizenz-Blobs wurden als verwaist behandelt; `ON DELETE RESTRICT` brach den Tauri-Setup-Hook ab.
- **Fix:** Alle sechs Blob-Bereinigungswege schützen Font-Provenienz und Dokument-Cover. Physisch unvollständige Provenienzpaare werden atomar repariert, ohne den Start zu blockieren.
- **Evidenz:** Restart-, Missing-Pair-, Preservation- und Cover-Regressionstests in Rust; Datenbankintegrität und Foreign Keys der realen Daten waren anschließend sauber.

### FZ-E2E-014 · P1 · Wechsel des Bildmodells lässt versteckte, ungültige Altparameter aktiv

- **Status:** **behoben**; Nano Banana → FLUX.1 Schnell nativ gewechselt und Bild erfolgreich generiert.
- **Ursache:** Modellfremde Konfiguration blieb global erhalten, wurde unsichtbar validiert und teilweise an den Provider gesendet.
- **Fix:** Modellgebundene Endpoint-Konfigurationen, Capability-Normalisierung und sichtbare FLUX-Controls für Größe, Schritte, Guidance, Beschleunigung und Safety. Versteckte Altwerte werden weder validiert noch gesendet.
- **Evidenz:** Capability-/View-/Requesttests und nativer FLUX-Lauf mit 1 Variante, 4 Schritten, Guidance 3.5, ohne Seed.

### FZ-E2E-015 · P1 · Image-to-Video wird durch widersprüchlichen Kostenkontext blockiert

- **Status:** **behoben**; der ursprünglich blockierte 4-s-Lauf wurde anschließend ohne Neusubmission abgeschlossen.
- **Ursache:** TypeScript sendete korrekt `image-to-video`; Rust erwartete intern die nicht kanonische Kurzform `image`.
- **Fix:** Kanonische Modalitäten `text-to-video`, `image-to-video` und `reference-to-video` auf beiden Seiten. Exakter Regressionstest für 4 s, 480p, 16:9, Standard-Bitrate und Audio aus.

### FZ-E2E-016 · P1 · fal.ai-Queue-Status verwendet bei verschachtelten Modellen den falschen Pfad

- **Status:** **behoben**; vorhandene Request-ID wurde sicher fortgesetzt, nicht erneut abgerechnet.
- **Ursache:** Submit benötigt den vollständigen Modellpfad, Status/Result/Cancel dagegen die Basis-App `bytedance/seedance-2.0`. Der vollständige Pfad lieferte HTTP 405.
- **Fix:** Expliziter, auditierter `queue_app`-Vertrag; UUID-validierte, fail-closed Control-URLs. Resume rekonstruiert zusätzlich den vollständigen unveränderlichen Request-Vertrag einschließlich Start-/Endframe und Referenzen vor dem ersten Netzwerkzugriff.
- **Evidenz:** Providerstatus `COMPLETED`; MP4 mit 235.886 Bytes; Inline-Wiedergabe erreichte 4/4 Sekunden; großes Video-Overlay und History sichtbar.

### FZ-E2E-017 · P1 · Persistiertes Video wird nach Neustart als ungültige `tauri://`-URL geladen

- **Status:** **behoben**; vollständiger Store-Initialize/Reload-Test grün. Kein weiterer Eingriff in die installierte App nach der ausdrücklichen Nutzeranweisung, direkt zu veröffentlichen.
- **Ursache:** `persistedMedia()` setzte den nackten Blob-Hash als Preview-Wert; WebKit löste ihn relativ zu `tauri://localhost/` auf.
- **Fix:** Preview-Werte verwenden hashvalidiert `flowz-media://localhost/<sha256>`; Downstream-Ausgänge bleiben strikt `flowz-cas:<sha256>`.
- **Evidenz:** `src/store.hydration-cas.test.ts` prüft aktives MP4, `playable: true`, Media-Preview-URL, CAS-Kabelwert und den expliziten Ausschluss von `tauri://`.

### Weitere bestätigte P1/P2-Befunde

- **Behoben:** Keyboard-Portwahl filtert Zyklen, hält einen abgewiesenen Dialog mit sichtbarer Ursache offen und ersetzt belegte Single-Inputs konsistent zum Pointer-Pfad.
- **Behoben:** Textgenerierung besitzt nur ehrliche Textports; multimodale Auswertung liegt ausschließlich bei der Bildanalyse.
- **Behoben:** Direct-Media berücksichtigt belegte, noch leere Kabel als `cable-empty` und fällt nicht still auf lokale Daten zurück.
- **Behoben:** Paid Image Tools binden Quelle und vollständige Konfiguration an den Aktivierungs-Snapshot; geänderte Targets können nicht aktiviert werden.
- **Behoben:** Asset-Drop erzeugt exakt das validierte Asset-Node-Schema und keine zusätzlichen Provenienzfelder.
- **Behoben:** Home-Roving-Tabindex, Artboard-Tastaturwege, Fokusführung und Dialogsemantik.
- **Behoben:** `--dim`, fehlende semantische Tokenaliases, mobile Artboard-Panels und unsichtbare Lazy-Fallbacks.
- **Verbleibend P2:** Vollständige Store-Abos und pointermove-basierte Artboard-Komplettrenders sollten bei sehr großen Dokumenten profiliert und selektiv geschnitten werden.
- **Verbleibend P2:** Ein Teil älterer Icon-Targets unterschreitet 36 px, obwohl die klickbare Fläche in den primären Pfaden größer ist.
- **Verbleibend P2:** Das Font-Metadatenchunk ist mit rund 2,07 MB groß; es wird lazy geladen und hält das verifizierte Initial-Budget ein, sollte langfristig jedoch indexiert/nachgeladen werden.

## Node- und Verbindungslogik

Alle 25 öffentlich registrierten Node-Arten wurden einmal auf einem Stress-Flow angelegt. Ergänzend wurden Registry, Spezifikationen, Adapter, Templates und Runtime-Verträge vollständig automatisiert geprüft.

| Bereich | Ergebnis |
|---|---|
| Text | Textgenerierung ist text-only; Einzel-/Listenwerte bleiben typisiert; Varianten sind getrennte, sichtbare Resultate. |
| Bildanalyse | Akzeptiert einzelne Bilder und Bildlisten; dies ist der einzige multimodale Analysepfad. |
| Bildgenerierung | Prompt, optionale CAS-Referenzen, Varianten und Kostenmetadaten stimmen mit der Capability-Matrix überein. |
| Video | Bild-/Frame-Eingänge sind CAS-gebunden; lokaler Import erzeugt Video, Poster, Start- und Endframe. |
| Audio/Transkription | WAV-Import, Inline-Player, MIME-/Hashbindung und Transkriptionskonfiguration sind streng typisiert. |
| Brand | Acht nominale Artefakttypen verhindern semantisch falsche Kabel bereits im Editor. |
| Artboard | `artboard-reference` und `color-palette` bleiben getrennt; Bildlisten sind als echter Eingang verfügbar. |
| Kabel | Pointer, Reconnect, Node-Menü und Tastatur nutzen dieselbe zentrale Kompatibilitätsprüfung. |
| Single-Inputs | Bestehende Kante wird nur nach gültiger neuer Verbindung ersetzt; Rejects bleiben sichtbar. |
| Direktmodus | Ein belegtes Kabel hat Vorrang; ein leeres Kabel ist ein sichtbarer Fehler und kein Anlass für stillen lokalen Fallback. |
| Medien | Nur `flowz-cas:<sha256>` ist downstream verkabelbar; Preview-URLs bleiben reine Darstellung. |
| Templates | Alle kuratierten Brand-/Social-/Artboard-Templates bestehen die nominale Validierung. |

## Button- und Interaktionsmatrix

| Oberfläche | Betätigte Controls / Pfade | Ergebnis 0.1.1 / Korrektur |
|---|---|---|
| Home/Katalog | Einstellungen, Neuer Flow, Neues Artboard, Suche, Alle/Flows/Artboards, alle drei Sortierungen, Karten-Kontextmenü Open/Rename/Duplicate | Keine Abstürze; Home-Tastaturfokus korrigiert. Delete wartet regelkonform auf unmittelbare Bestätigung. |
| Tabs | Home, drei Flow-Tabs, Artboard-Tab, Tab schließen/wieder öffnen | Persistierter Zustand bleibt erhalten; Recovery-Hinweis für absichtlich beschädigten Testflow sichtbar. |
| Flow-Canvas | Node-Katalog, alle 25 Node-Arten, Fit, Zoom +/−, Orphan-Palette, Kabel-/Portpfade | Keine Insert-/Zoom-Abstürze; Kompatibilität und Fehlerpfade korrigiert. |
| Node-Menü | History, direkte Felder, Datei-/Medienauswahl, Varianten/Kuration | Domain/Logo-Direktfelder, History-Portal und Inline-Previews korrigiert. |
| Assets | Bild/Audio/Video-Import, Tabs, Filter, Suche, Collapse | Bild, Audio und kontrollierte H.264/AAC-MP4 funktionierten nativ; Video erzeugte Player, Poster, Start- und Endframe. |
| Projekt/Storage | Assets, Results, Runs, Costs, History, Filter und leere Tabs | Leere Costs-/History-Tabs besitzen jetzt verständliche Empty States. |
| Einstellungen | Provider-Status, Sprache, Updateprüfung | Provider verbunden; macOS-Schlüsselbundfreigabe erfolgreich; Version 0.1.2 im installierten Testbuild angezeigt. |
| Artboard Navigation | Zoom, Layers/Assets/Inputs, Flow-Link, Panels ein-/ausklappen | Keine Abstürze; responsives Verhalten und Tastaturpfade korrigiert. |
| Artboard Boards/Layers | Duplicate board, New variant, Text/Form/Layout, Group/Ungroup, Forward/Back, Hide/Show, Lock/Unlock, Undo/Redo | Alle nichtdestruktiven Controls geprüft und persistiert. Destruktive Retests warten auf Bestätigung. |
| Artboard Export | Dialog, Manifest, alle Collision-Modi | Dialog- und Auswahlpfade funktionieren; kein echter Dateiersatz ohne explizite Nutzeraktion. |
| Design Agent | Provider/Model, alle Effort-Stufen, OpenRouter/Codex, Chat-Menü, Rename-Cancel, New Chat, Collapse | Keine UI-Abstürze; echte bezahlte Ausführung wartet auf Bestätigung. |
| Preview/History | Text-/Bild-/Video-History, Inline-Player, Expand und Neustart | Text, Bild und Video nativ sichtbar/expandierbar; Video 4/4 s abgespielt. Finaler Video-Reload-URL-Fix vollständig automatisiert verifiziert. |

## Korrekturwelle

Die Korrekturwelle ist integriert. Sie umfasst Resilienz/Error Boundaries, atomare Resultpersistenz, kanonische Execution Snapshots, CAS-only-Medienwerte, sichtbare und vergrößerbare Output-Previews, portalisierte History, echte Variantenpersistenz, nominale Brand-Typen, ehrliche Node-Ports, Direct-Media- und Asset-Drop-Verträge, Videoimport, Tastatur-/Fokuspfade, mobile Artboard-Layouts und semantische Designtokens.

## Automatisierte Regression

| Gate | Ergebnis |
|---|---|
| `pnpm test` | 111 Dateien, **552/552** Tests bestanden |
| `pnpm build` | bestanden |
| `pnpm run verify:lazy` | bestanden; Initial-JS 272.156 B, Initial-CSS 94.270 B |
| `pnpm run verify:secrets` | bestanden |
| `pnpm run verify:fonts` | bestanden; 2.020 Familien |
| `pnpm run verify:icons` | bestanden |
| `cargo test --locked` | **189/189** bestanden; 4 absichtlich kostenpflichtige Tests ignoriert |
| `cargo clippy --all-targets --all-features --locked -- -D warnings` | bestanden |
| `cargo fmt --all -- --check` | bestanden |
| `pnpm run verify:release -- v0.1.3` | bestanden; Package, Cargo, Lock und Tauri konsistent |
| `codesign --verify --deep --strict` | lokales 0.1.2-Testbundle gültig; 0.1.3 wird im geschützten GitHub-Workflow gebaut |
| Web-Responsive-Smoke | 390×844: Dokumentbreite 390=390, Settings-Dialog 352×812, interne Breite 350=350, vertikal scrollbar, Autofokus auf „Close settings“ |

Der lokale `tauri build --bundles app` erstellte App und Updater-Tarball; erwartungsgemäß entstand ohne `TAURI_SIGNING_PRIVATE_KEY` keine `.sig`. Der offizielle GitHub-Release-Workflow injiziert ausschließlich die geschützten Updater-Signing-Secrets, baut DMG und Updater-Archiv, validiert Signatur/Checksummen und veröffentlicht atomar. FlowZ wird bewusst ad hoc signiert und nicht Apple-notarisiert; Schlüssel wurden weder ausgegeben noch ins Repository geschrieben.

## Abschluss-Evidenz

1. Einfacher Live-Flow: OpenRouter erzeugte den englischen Bildprompt; FLUX.1 Schnell erzeugte das Bild; Seedance 2.0 Fast animierte dasselbe Bild als 4-s-Startframe-Video bei 480p, 16:9 und ohne Ton.
2. Text-, Bild- und Video-Ergebnisse waren inline sichtbar, groß zu öffnen und jeweils in einer History vorhanden. Das Video ließ sich vollständig bis 4/4 s abspielen.
3. Header- und Tastatur-Delete erzeugten keinen Black Screen. Domain-/Logo-Direktmodus und nativer MP4-Import funktionierten.
4. Der finale, erst beim Video-Neustart sichtbare URL-Hydrierungsfehler ist durch den vollständigen Store-Reload-Regressionspfad geschlossen. Gemäß Nutzeranweisung wurde danach nicht erneut gegen die installierte App getestet, sondern direkt der Release-Kandidat veröffentlicht.
5. Visuelle Evidenz des finalen Flows: `docs/evidence/simple-text-image-video-flow.jpeg`.
