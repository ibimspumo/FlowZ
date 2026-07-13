# FlowZ Produkt-Screenshots

Diese Dateien werden erst nach einem erfolgreichen nativen Produkt-Smoke-Test aufgenommen und anschließend in die Haupt-README eingebunden:

| Datei | Verbindlicher Inhalt |
| --- | --- |
| `home.png` | Home-Übersicht mit mindestens einem Flow- und einem Artboard-Projekt, jeweils mit aktueller gerenderter Preview. Keine Fehlermeldungen oder leeren Platzhalter. |
| `flow.png` | Zusammenhängender, lesbarer Marken- oder Content-Flow mit typisierten Verbindungen, mindestens einem visuellen Ergebnis und geöffneter Result-History oder Asset-Interaktion. |
| `artboard.png` | Artboard-Arbeitsbereich mit mindestens zwei sichtbaren Boards beziehungsweise Formaten, echten Ebeneninhalten und sichtbarer Design-Agent-Integration. Kein leerer Proposal-Zustand. |

## Aufnahmekriterien

- Aktueller Release-Build oder derselbe Commit, der veröffentlicht werden soll.
- Native Tauri-App, nicht der funktionsreduzierte Browser-Modus.
- Fenstergröße mindestens 1440 × 900 Pixel; Screenshot ohne Desktop-Hintergrund zuschneiden.
- Keine API-Schlüssel, lokalen Pfade, privaten Prompts oder personenbezogenen Daten.
- Keine offenen Fehlerbanner, Debug-Overlays, abgeschnittenen Menüs oder absichtlich reproduzierten Fehlerzustände.
- Inhalte müssen aus echten gespeicherten FlowZ-Dokumenten stammen und dürfen nicht nachträglich in einem Bildeditor zusammengesetzt werden.
- PNG mit lesbarem UI-Text; dieselbe Sprache für alle drei Bilder.

Die Aufnahmen unter `artifacts/runtime-product-smoke/` dienen der Fehlersuche. Sie sind ausdrücklich keine Quelle für Produkt-Screenshots.
