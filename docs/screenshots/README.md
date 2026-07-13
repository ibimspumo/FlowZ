# FlowZ Produkt-Screenshots

Diese Dateien werden erst nach einem erfolgreichen nativen Produkt-Smoke-Test aufgenommen und anschließend in die Haupt-README eingebunden:

| Datei | Verbindlicher Inhalt |
| --- | --- |
| `home.webp` | Home-Übersicht mit mindestens einem Flow- und einem Artboard-Projekt, jeweils mit aktueller gerenderter Preview. Keine Fehlermeldungen oder leeren Platzhalter. |
| `flow.webp` | Zusammenhängender, lesbarer Content-Flow mit typisierten Verbindungen und mehreren Datentypen. |
| `artboard.webp` | Artboard-Arbeitsbereich mit echten Ebeneninhalten. Kein leerer Proposal- oder Fehlerzustand. |

## Aufnahmekriterien

- Aktueller Release-Build oder derselbe Commit, der veröffentlicht werden soll.
- Native Tauri-App, nicht der funktionsreduzierte Browser-Modus.
- App-Fenster vollständig und ohne Desktop-Hintergrund aufnehmen; UI-Text und zentrale Inhalte müssen in README-Breite lesbar bleiben.
- Keine API-Schlüssel, lokalen Pfade, privaten Prompts oder personenbezogenen Daten.
- Keine offenen Fehlerbanner, Debug-Overlays, abgeschnittenen Menüs oder absichtlich reproduzierten Fehlerzustände.
- Inhalte müssen aus echten gespeicherten FlowZ-Dokumenten stammen und dürfen nicht nachträglich in einem Bildeditor zusammengesetzt werden.
- Verlustarmes WebP mit lesbarem UI-Text, entfernten Metadaten und derselben Sprache für alle drei Bilder.
- Zielbudget: zusammen höchstens 250 KB, damit die GitHub-README auch auf langsameren Verbindungen zügig lädt.

Die Aufnahmen unter `artifacts/runtime-product-smoke/` dienen der Fehlersuche. Sie sind ausdrücklich keine Quelle für Produkt-Screenshots.
