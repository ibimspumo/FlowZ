# Node-Modul-Architektur: Review und Abschlussprotokoll

Stand: 12. Juli 2026

## Abschlussurteil nach Stufe 11

Die Extraktion ist abgeschlossen. Alle 29 produktiven Kinds besitzen eine konkrete modul-eigene View, einen konkreten Executor und ein fail-closed Config-Schema. Der Canvas verwendet ausschließlich `ModuleNodeComponent` → `AppNodeHost` → kanonisches Registry-Modul. Die frühere globale `FlowNodeBody`-Fassade, ihre 7.600 Zeilen konkreter Kind-Zweige, `interactive-module.tsx`, `interactive-view.tsx` und die imperative Renderer-Registrierung sind physisch entfernt. Unbekannte Module bleiben inert und erhalten ausschließlich die kanonische leere Unsupported-Konfiguration.

Architekturtests verhindern die Wiedereinführung der alten Dateien und Symbole, konkrete Kind-Routen in Host/Dispatcher/Registry, zentrale Produkt-Kind-Switches sowie statische Importzyklen. Der Abschlusslauf umfasst TypeScript, 371 Produkttests, Production-Build, Lazy-Budgets und Secret-Scan.

## Ausgangsurteil vor der Extraktion

Die Registrierungswelle schafft eine belastbare kanonische Modulidentität, ist aber noch keine vollständige modulare Laufzeit. Alle 29 produktiven Kinds sind unter stabilen IDs genau einmal registriert. `AppNodeHost`, der Dispatcher und der Engine-Vertrag enthalten keine Kind-Weichen. Persistierte Modul-ID, Version, Ports und Fingerprint-Payload bleiben stabil. Unbekannte Modul-IDs sind nicht ausführbar und werden nach der Review-Korrektur mit leerer, kanonischer Konfiguration über die inerte Unsupported-Ansicht gerendert.

Zwei Architekturbedingungen sind noch offen:

1. Die 29 vermeintlich konkreten Executor-Funktionen delegieren alle über `NodeExecutionServices.interactive.execute(...)` zurück an `FlowNodeBody.executeInRuntime()`. Der Ausführungsbesitz liegt daher noch nicht im jeweiligen Modul. Der vorhandene Registry-Test bestätigt diese Fassade sogar ausdrücklich; er beweist keine eigenständige Produktausführung.
2. `defineInteractiveNodeModule()` validiert Konfigurationen nur als beliebiges JSON-Objekt. Das schützt vor Nicht-JSON-Werten, aber nicht vor fehlenden, unbekannten oder semantisch falschen Feldern. Einzelne ältere Engine-Module besitzen bereits echte Validatoren, sind jedoch nicht die kanonischen App-Module.

## Verifizierte Invarianten

- 29 von 29 persistierbaren Kinds sind in den sechs fachlichen Modulgruppen registriert; `unsupported` ist zusätzlich nicht persistierbar.
- Modul-IDs und Version `1` entsprechen vollständig `MODULE_ID_BY_KIND`.
- Input-/Output-Port-IDs sind innerhalb jedes Moduls eindeutig; `ValueType`, Listen-Kardinalität und öffentliche Definition werden aus demselben Registry-Datensatz abgeleitet.
- Die Renderer-Registrierung erzeugt keinen statischen ESM-Zyklus: Module importieren nur `InteractiveNodeView`; erst `FlowNode.tsx` registriert den Runtime-Renderer imperativ.
- Host und Dispatch sind kind-agnostisch und prüfen ID, Version und Validator vor Rendern beziehungsweise Ausführen.
- Unbekannte Modul-IDs können weder eine bekannte Kind-Identität noch einen Status aus ihrer gespeicherten Config einschleusen. Die Unsupported-Ansicht erhält nun außerdem nie die untrusted Config.
- Entfernte produktive Dateien beziehungsweise Bezeichner `legacy-definitions`, `legacy-flow-node`, `LegacyFlowNode`, `LegacyProps` und ein kind-basierter Legacy-Dispatcher sind nicht mehr vorhanden. Schema-1-Importtypen sind eine separate Persistenzmigration und nicht Teil dieser UI-Fassade.

## Endliche Extraktionsreihenfolge für `FlowNodeBody`

Jede Stufe endet nach einem Feature-Test und genau einem Review. Eine Stufe gilt erst als fertig, wenn Body, Config-Schema, View und Execute/Cancel des betreffenden Kinds im konkreten Modul liegen und die zugehörigen Kind-Abfragen aus `FlowNodeBody` verschwunden sind.

1. **Vertrag zuerst (P0):** `AppNodeModule` erhält modul-eigene Runtime-Services statt `interactive.execute`; echte Schemas werden pro Modul registriert. Das Testziel ist für jedes der 29 Kinds: Default-Config akzeptieren, sämtliche dokumentierten optionalen Felder akzeptieren, unbekannte Keys sowie falsche Primitive/Enums/Grenzen ablehnen und nach JSON-Roundtrip dasselbe Ergebnis liefern. Erst danach darf `validateConfig` wieder als Persistenz- und Ausführungsgate gelten. Der Fassadentest wird durch einen Negativtest ersetzt, der `interactive` im kanonischen Executor-Pfad verbietet.
2. **Passive Quellen:** `textInput`, `assetText`, `assetImage`, `imageCollection`, `videoCollection`. Sie haben die kleinste Ausführungsfläche und klären die Trennung von persistierter Config und Runtime-Display.
3. **Importquellen:** `imageInput`, `videoInput`, `audioInput`. Datei-/Recorder-Lifecycle und Cancel gehören in modul-eigene Controller.
4. **Deterministischer Kontext:** `webpage`, `research`, `videoFrame`. Die schon vorhandenen Engine-Executor werden in die kanonischen App-Module übernommen statt dupliziert.
5. **Lokale Bildoperationen:** `imageTransform`, `imageTrimTransparent`. Listen-Mapping und Fortschritt werden als wiederverwendbarer Engine-Service extrahiert.
6. **Text/Analyse:** `textGeneration`, `imageAnalysis`, `transcription`. OpenRouter-/Transkriptionslogik, strukturierte Outputs und History-Kuration werden modul-eigen.
7. **fal.ai Bildwerkzeuge:** `imageUpscale`, `backgroundRemoval`; danach `imageGeneration` und `logoDesign`. Gemeinsame fal-Transportlogik bleibt Service, Modell-/Capability-/Request-Logik bleibt beim Modul.
8. **Video:** `videoGeneration` inklusive Endpoint-Inferenz, Start-/Endbild, Referenzen, Streaming, Resume und Cancel.
9. **Brand-Domäne:** `brandBrief`, `audienceAnalysis`, `brandNames`, `domainCheck`, `handlePlan`, `fontPairing`, `colorPalette`. Passive Nodes bleiben buttonlos; generative Nodes besitzen ihren Executor.
10. **Artboard-Referenz zuletzt:** `artboard`, ausschließlich als kompakte Bridge. Keine Artboard-Workspace-Datei wird für diese Extraktion umgebaut.
11. **Fassade löschen:** Erst wenn keine produktive Kind-Abfrage mehr übrig ist, werden `interactive-module.tsx`, `interactive-view.tsx`, `registerInteractiveNodeRenderer` und der globale `FlowNodeBody` entfernt. Danach werden Architekturtests auf verbotene Rückdelegation, zirkelfreie Imports und Unknown-Modul-Fail-Closed festgeschrieben.

## Gate-Ergebnis des Ausgangsreviews

Die 32 fokussierten Modul-, Registry-, Adapter- und Engine-Tests, TypeScript, Production-Build und Lazy-Budget bestehen. Der globale Testlauf hatte parallel einen fachfremden Fehler im Artboard-Agent-UI-Test; dieser Review hat ihn weder verursacht noch bearbeitet.
