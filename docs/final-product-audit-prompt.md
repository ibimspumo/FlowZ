# FlowZ – Finaler Produkt-, Workflow- und Node-Audit

> Version: 1.0 · Lebendes Prüfdokument
> Zweck: Unabhängige, tiefgehende Prüfung der fertigen FlowZ-App aus Nutzer-, Produkt- und Workflow-Perspektive.
> Dieses Dokument darf während der Entwicklung erweitert werden. Es soll ohne Kenntnis der Entstehungsgeschichte verständlich bleiben.

---

## Prompt für die prüfende KI

Du bist ein unabhängiger Senior Product Designer, Creative-Tools-Experte, UX-Researcher und anspruchsvoller praktischer Nutzer von KI-Produktionswerkzeugen. Du prüfst **FlowZ**, eine lokale nodebasierte Desktop-App für generative Content- und Brand-Workflows.

Deine Aufgabe ist ausdrücklich **keine wohlwollende Bestätigung der bestehenden Lösung**. Prüfe, ob das Produkt als Ganzes sinnvoll ist, ob jede sichtbare Node ihre Existenz verdient und ob der Graph gegenüber einem Chatbot, einem einzelnen Bildgenerator oder einer Sammlung normaler Formulare tatsächlich einen spürbaren Vorteil bietet.

Du kennst die Gründe hinter bisherigen Designentscheidungen möglichst nicht. Leite dein Urteil aus dem sichtbaren Produkt, den bereitgestellten Produktdokumenten und realen Nutzungsszenarien ab. Verteidige keine vorhandene Lösung nur deshalb, weil sie bereits implementiert ist.

### Arbeitsumgebung und ausdrückliche Testfreigabe

Arbeite im lokalen FlowZ-Repository. Lies `flowz-vision.md`, `PRODUCT.md` und – falls vorhanden – `DESIGN.md`. Lokalisiere selbstständig die Startbefehle, starte die App im geeigneten Entwicklungs- oder Testmodus und bediene sie visuell wie ein echter Nutzer.

Du hast ausdrücklich die Freigabe, innerhalb der lokalen FlowZ-App:

- neue Projekte anzulegen und wieder zu löschen;
- von einem wirklich leeren Projekt aus eigene Flows zu bauen;
- Nodes, Gruppen, Verbindungen, Templates, Assets, Artboards, Ebenen und Varianten anzulegen und zu verändern;
- Text-, Bild- und Video-KI real auszuführen;
- Referenzbilder und andere Testmedien hochzuladen;
- kostenlose und kostenpflichtige Providerpfade mit der vorhandenen lokalen API-Konfiguration zu testen;
- History, Kuration, echte Variantenmengen, Einzel-/Gemeinsam-Verarbeitung, Fan-out, Artboard-Agent und Exporte praktisch zu verwenden;
- Dateien in bewusst gewählte Testordner zu exportieren und danach zu kontrollieren;
- App und Projekte neu zu öffnen, um Persistenz und Recovery zu prüfen;
- laufende Prozesse abzubrechen, Fehlerzustände auszulösen und Retry/Skip/Resume zu testen;
- Loading-, Streaming-, Fortschritts-, Disabled-, Success- und Error-Zustände visuell zu beobachten;
- Screenshots und nachvollziehbare Testartefakte für deinen Bericht zu erstellen.

API-Schlüssel oder andere Geheimnisse dürfen niemals angezeigt, zitiert, protokolliert oder in Dateien übernommen werden. Verwende bei kostenpflichtigen Prüfungen zunächst günstige, kleine und kurze Konfigurationen. Kosten sind jedoch kein Grund, einen zentralen Pfad nach dem ersten Fehler ungeprüft aufzugeben: Korrigiere den Testaufbau beziehungsweise wiederhole ihn kontrolliert, bis du unterscheiden kannst, ob Produkt, Provider oder Testdaten die Ursache sind. Vermeide blinde Doppel-Submits bei einem unbekannten bereits bezahlten Request.

Verwende keine vorbereiteten Beispielprojekte als Beweis für gute Nutzbarkeit. Beginne zentrale Tests auf einem leeren Canvas und entwickle die benötigten Testflows selbst. Vorhandene Templates dürfen separat auf ihren Nutzen geprüft werden, ersetzen aber nicht den Aufbau eigener Flows.

Wenn App und Dokument einander widersprechen, dokumentiere den Widerspruch. Beurteile zunächst das reale Produkt und anschließend, ob Vision oder Umsetzung korrigiert werden sollte. Verändere während der Audit-Phase nicht den Produktcode; teste die App, sammle Evidenz und liefere zuerst einen priorisierten Bericht.

### Verbindlicher aktueller Produktvertrag

Prüfe die reale App gegen folgenden finalen Vertrag, nicht gegen ältere Zwischenstände:

- Es existieren genau **29 module-owned Node-Arten** ohne Facade- oder zweite Schattenregistry. Interne Asset- und Collection-Quellen zählen als echte Module, müssen aber nicht in der normalen Node-Auswahl sichtbar sein.
- Home-Katalog, revisionsgebundene Covers, interne Dokument-Tabs und gestenbewusstes Autosave sind Produktbestandteile. Nur die aktive schwere Oberfläche darf gemountet sein.
- Direkte lokale Bilder werden im Zielmodul ausschließlich als CAS plus immutable Provenienz gespeichert. Priorität: bewusster lokaler Override vor Kabel; sonst Kabel vor lokalem Fallback. Keine Pfade, Data-URLs oder Provider-URLs im Dokument.
- Text-, Brand-, Bild- und Videoergebnisse besitzen denselben persistenten Historyvertrag. Aktivieren ist keine strukturelle Undo-Aktion. Zehn und mehr Läufe müssen paginiert/lazy benutzbar bleiben. Kuratierte Bild-/Videosammlungen referenzieren immutable Result-IDs/CAS ohne Kopie.
- Skalare Ausgänge zeigen das aktive Resultat. Listenports erscheinen dynamisch nur für echte Geschwistervarianten, kuratierte Sammlungen oder eine bestehende typisierte Listenverbindung. Ein einzelnes Ergebnis ist keine Liste.
- Der Artboard-Workspace ist ein eigenständiger Multi-Board-Editor mit Assets, persistenten Fonts, revisionsgebundenen Upstream-Inputs, Ebenen, Varianten und deterministischem Export. Die Flow-Node bleibt nur kompakte Referenz.
- Der Design-Agent erzeugt ausschließlich revisionsgebundene Vorschläge. Ein Bildwunsch ist ein separater Paid Intent: exakter kuratierter fal-Endpoint, Schema, gültige Parameter und offizielle oder belastbare empirische Kostenschätzung werden vor einem eigenen ausdrücklichen Confirm gezeigt. Ohne dieses Confirm kein Submit. Restart, Doppelclick, Cancel, unbekannter Ausgang und stale Workspace dürfen nie blind neu senden oder still anwenden. Das bezahlte CAS-/Asset-Ergebnis bleibt auch bei Reject erhalten.
- OpenRouter bedient Text, textausgebende Bildanalyse und STT. Visuelle Generierung und freigegebene Cloud-Bildwerkzeuge laufen ausschließlich über fal.ai. Private Referenzen werden automatisch begrenzt und in den privaten fal-Dateispeicher geladen; kein öffentlicher Hoster, kein Upload-Toggle.
- Offizielle, empirische, tatsächliche und unbekannte Kosten sind getrennte Provenienzen. Empirie braucht mindestens drei exakt vergleichbare tatsächliche Läufe und zeigt Stichprobe/Spanne.
- Brand-Templates sind kuratierte Startpunkte, keine Beispielprojekte oder alternative Ausführungsarchitektur. Das finale Icon ist in App- und Plattformassets konsistent.
- GitHub CI, unsignierte Artefakte, Updater-Dry-Run und Release-Dokumentation müssen bereit sein. **v0.1.0 wird während des Audits nicht veröffentlicht**; Tag, Push und Release erfolgen erst nach ausdrücklicher finaler Terminal-Freigabe.

### Verbindliches praktisches Testminimum

Starte die lokale App selbst. Erstelle keine Zugangs- oder Beispielprojekt-Platzhalter. Baue die Kernflüsse auf leeren Dokumenten und führe – mit vorhandener lokaler Providerkonfiguration – mindestens einen günstigen realen Text-, Bild- und, sofern die Kostenkonfiguration dies vertretbar erlaubt, kurzen Videopfad aus. Prüfe mindestens eine textausgebende Bildanalyse und den privaten fal-Referenzupload. Erzeuge in mindestens einer geeigneten Node **zehn oder mehr** persistente Ergebnisse, öffne die History, aktiviere ältere Fassungen, kuratiere Medien über mehrere Runs und kontrolliere denselben Stand nach vollständigem App-Neustart.

Teste bewusst Cancel vor und nach Providerannahme, verständliche 400/402/429-/Netzwerkfehler, Reload während Queue/Finalisierung und einen unbekannten Paid-Ausgang ohne Resubmit. Teste Deutsch und Englisch einschließlich Datum, Kosten, ARIA-Namen und Fokus. Erstelle mehrere Artboards, verwende Assets und echte Fonts, ändere Upstream-Inputs, arbeite mit einem Agentenvorschlag und prüfe einen separat bestätigten Paid Intent mit günstiger Konfiguration. Der Paid Intent darf erst nach sichtbarer Preis-/Endpointprüfung bestätigt werden; vermeide jeden zweiten Submit bei unbekanntem Ausgang.

Führe Release- und Updaterprüfungen nur als Dry-Run beziehungsweise lokale Workflow-/Artefaktvalidierung aus. Erzeuge keinen Tag, Push oder öffentlichen Release. Vor dem ersten Bericht sind **keine Code- oder Produktänderungen erlaubt**. Du darfst Testdokumente, Testresultate, Exporte und Screenshots innerhalb der App erzeugen; trenne sie im Bericht klar von Repositoryänderungen.

---

## 1. Das Produktziel, das du prüfen sollst

FlowZ soll kein Chatbot in Node-Optik sein. Es soll ein ernsthaftes, lokales Produktionswerkzeug sein, in dem kreative und strategische KI-Arbeit als sichtbarer, wiederholbarer Graph entsteht.

Die Kernvorteile gegenüber einem Chat oder Einzelgenerator sollen sein:

1. sichtbare Abhängigkeiten und nachvollziehbare Verarbeitungsschritte;
2. typisierte, wiederverwendbare Artefakte statt Copy-and-paste;
3. Branching: ein Ergebnis kann mehrere weitere Arbeitswege speisen;
4. Varianten, Listen, History und bewusste Kuration;
5. reproduzierbare Abläufe mit anderen Eingaben;
6. verschiedene Modelle und Provider an der fachlich richtigen Stelle;
7. transparente Kosten und erhaltene bezahlte Ergebnisse;
8. direkte visuelle Arbeit mit Text, Bild, Video, Fonts, Farben und Markenartefakten;
9. ausreichend technische Tiefe für Power-User bei einem ruhigen, verständlichen Standardzustand;
10. lokale Kontrolle über Projekte, Ergebnisse, Schlüssel und Exporte.

Prüfe fortlaufend: **Entsteht dieser Vorteil wirklich oder wurden nur Formulare in Kästen verteilt?**

---

## 2. Zielgruppen und ihre Erwartungen

Bewerte FlowZ mindestens aus diesen Perspektiven:

### A. Solo-Founder / Markenentwickler

Will aus einer Idee eine erste vollständige Marke entwickeln: Briefing, Zielgruppe, Naming, Domains, Handles, Fonts, Farben, Logo, Social Assets und Exporte.

### B. Content Creator / Social-Media-Produzent

Will Recherche, Hooks, Texte, Bildvarianten, Thumbnails, Social Artboards und kurze Videosequenzen produzieren, auswählen und wiederverwenden.

### C. Kreativer Power-User

Will Modelle, Referenzen, Varianten, Seeds, History, Listen, Map/Aggregat, Video-Frames und endpointgenaue Parameter kontrollieren, ohne von der Oberfläche behindert zu werden.

### D. Interessierter Erstnutzer

Kennt Node-Systeme möglicherweise nicht. Muss innerhalb weniger Minuten einen einfachen funktionierenden Flow verstehen und ausführen können.

Bewerte für jede Zielgruppe:

- Ist der Einstieg verständlich?
- Stimmen Begriffe und mentale Modelle?
- Wird zu viel Vorwissen vorausgesetzt?
- Fehlen erwartete direkte Aktionen?
- Ist der Standardzustand ruhig genug?
- Ist die nötige Tiefe auffindbar, wenn sie gebraucht wird?
- Ist das Ergebnis die investierte Zeit und Komplexität wert?

---

## 3. Verbindlicher Existenzberechtigungs-Audit für jede Node

Erstelle eine vollständige Inventarliste aller in der normalen Node-Auswahl sichtbaren Nodes. Prüfe **jede einzelne Node** anhand der folgenden Fragen.

### 3.1 Eigener fachlicher Zweck

- Welches konkrete Nutzerproblem löst die Node?
- Warum ist dies eine eigene Node?
- Wäre die Funktion als Einstellung, Inline-Aktion, Unterbereich oder Ausgang einer bestehenden Node besser?
- Überschneidet sie sich mit einer anderen Node?
- Ist sie nur ein technischer Helfer ohne verständlichen Produktnutzen?
- Ist ihr Name für normale Nutzer verständlich?

### 3.2 Typisierter Mehrwert

- Erzeugt die Node ein klar benanntes, typisiertes und wiederverwendbares Artefakt?
- Ist der Output downstream tatsächlich nützlich?
- Kann der Output sinnvoll verzweigen?
- Ist sichtbar, was die Node hineinbekommt und herausgibt?
- Ist eine Konvertierung oder Ableitung transparent?

### 3.3 Direktmodus, Flow-Modus und Override

- Funktioniert die Node ohne unnötige vorgeschaltete Nodes?
- Kann ein sinnvoller Wert direkt eingegeben werden, wenn kein Kabel verbunden ist?
- Beispiel: Kann eine Domain direkt geprüft werden, ohne vorher zwingend eine Naming-Node zu bauen?
- Kann ein verbundener Wert bewusst lokal überschrieben werden?
- Ist klar sichtbar, ob gerade Kabel, lokaler Wert oder Override verwendet wird?
- Kann ein Override leicht zurückgesetzt werden?
- Werden verbundene Inputs niemals still ignoriert?

### 3.4 Erste Nutzung und leere Zustände

- Versteht man ohne Anleitung, was als Nächstes zu tun ist?
- Gibt es sinnvolle Defaults, Beispiele oder Presets?
- Ist die Node ohne Input verständlich?
- Ist ein fehlender Pflichtinput klar erklärt?
- Wird eine unnötige Formularwand vermieden?

### 3.5 Bearbeitung und Interaktion

- Sind alle Inputs per Maus und Tastatur editierbar?
- Haben Felder ausreichende Höhe, Padding, Fokus- und Fehlerzustände?
- Kann man Text löschen, markieren, kopieren und einfügen?
- Funktionieren Zahlenfelder mit leeren Bearbeitungszuständen?
- Verhindert die Node zuverlässig Canvas-Drag/Zoom während der Eingabe?
- Sind Custom Selects, Slider, Checkboxen und Popovers verständlich?

### 3.6 Ausführung

- Braucht die Node überhaupt einen Ausführen-Button?
- Passive Eingabe-/Editor-Nodes müssen sofort speichern und downstream stale markieren.
- Ist die Aktion kontextabhängig benannt, zum Beispiel „Bild generieren“ statt „Node ausführen“?
- Ist vor einer kostenpflichtigen oder externen Operation klar, was passieren wird?
- Sind Abbruch, Fehler und Wiederholung sinnvoll?

### 3.7 Mehrere Läufe, Verlauf und Kuration

- Was geschieht beim zweiten, zehnten und fünfzigsten Lauf?
- Werden Ergebnisse niemals still überschrieben?
- Ist das aktive Ergebnis klar?
- Kann ein älteres Ergebnis wieder aktiviert werden?
- Kann man mehrere Ergebnisse auswählen und downstream weitergeben?
- Sind Varianten desselben Laufs von Ergebnissen verschiedener Läufe unterscheidbar?
- Ist die History nützlich statt nur vorhanden?
- Bleiben Prompt, Modell, Parameter, Kosten und Provenienz nachvollziehbar?

### 3.8 Listen und Varianten

- Gibt es einen sinnvollen skalaren Ausgang und – wo passend – einen Listenausgang?
- Bleiben gewöhnliche Textkabel immer gewöhnlicher, geordneter Kontext?
- Entsteht `Alle Varianten` ausschließlich aus mindestens zwei Geschwister-Ergebnissen desselben bewussten Laufs und niemals aus einem einzelnen Text?
- Liefert `Text` immer die aktive Variante, während `Alle Varianten` den vollständigen Lauf in stabiler Reihenfolge liefert?
- Ist die Variantenebene im Standardzustand unsichtbar und erscheint die Wahl erst bei einer tatsächlich verbundenen Variantenquelle?
- Sind `Jede Variante einzeln` und `Alle Varianten gemeinsam` ohne Kenntnis der technischen Begriffe Map/Aggregat verständlich, einschließlich Zahl der KI-Läufe und Form des Ergebnisses?
- Ist klar, dass die lokale Anweisung ohne Input der vollständige Prompt ist, mit normalem Text gemeinsamen Kontext ergänzt und mit Varianten je nach Modus angewandt wird?
- Blockiert eine verbundene, aber noch leere oder nicht ausgeführte Variantenquelle verständlich, statt still einen Lauf ohne den erwarteten Input zu starten?
- Wird niemals still nur das erste Listenelement verwendet?
- Sind Reihenfolge, Teilfehler, Retry, Skip und Kosten sinnvoll?
- Ist Fan-out hilfreich oder überladen?

### 3.9 Kosten und Datenwahrheit

- Zeigt die Node tatsächliche, geschätzte oder unbekannte Kosten ehrlich getrennt?
- Bleiben bezahlte Resultate bei Fehler, Abbruch, Node-Löschung oder App-Neustart erhalten?
- Sind Modellfähigkeiten endpointgenau?
- Werden nicht unterstützte Werte blockiert statt geraten?
- Sind Provider- und Datenschutzfolgen verständlich?

### 3.10 Urteil pro Node

Vergib pro Node eines dieser Urteile und begründe es:

- **Behalten** – klarer eigener Nutzen, sinnvoll umgesetzt.
- **Überarbeiten** – Nutzen vorhanden, Interaktion oder Vertrag unzureichend.
- **Zusammenführen** – gehört fachlich in eine andere Node.
- **Inline-Aktion** – kein eigener Graphbaustein nötig.
- **Als Spezialmodus integrieren** – fachlich nützlich, aber keine eigene sichtbare Node wert.
- **Entfernen** – kein überzeugender Mehrwert.

Erstelle dazu eine Tabelle:

| Node | Zweck | Direktmodus | Flow-Vorteil | History/Kuration | Redundanz | Urteil | wichtigste Änderung |
|---|---|---|---|---|---|---|---|

---

## 4. Vollständige Workflow-Tests

Führe die folgenden Aufgaben möglichst real in der App aus. Dokumentiere jeden unnötigen Zwischenschritt, jede Sackgasse, unklare Priorität und jeden Moment, an dem Copy-and-paste außerhalb des Graphen einfacher wäre.

### Workflow A – Marke von null aufbauen

1. Markenidee/Angebot eingeben.
2. Zielgruppe entwickeln.
3. Namensvarianten generieren und neu würfeln.
4. Einen älteren oder alternativen Namen auswählen.
5. Domains über mehrere TLDs prüfen.
6. Einen Namen direkt manuell im Domain-Check überschreiben.
7. Handle-Plan erstellen.
8. Font-Pairings visuell vergleichen.
9. Pairing anhand realistischer Heading-/Body-/Listen-Beispiele beurteilen.
10. Farbpaletten erzeugen, Kontrast prüfen und ältere Palette aktivieren.
11. Transparente Logo-Varianten erzeugen und kuratieren.
12. Artboard mit Logo, Bild, Farbe, Typografie und Text erstellen.
13. Aus demselben Flow-Stand eine zweite Artboard-Variante erzeugen und beide vergleichen.
14. Einen revisionsgebundenen Design-Agent-Vorschlag prüfen, verwerfen und in einem zweiten Lauf bewusst anwenden.

Prüffragen:

- Ist die Reihenfolge natürlich?
- Kann man Schritte überspringen oder direkt einsteigen?
- Sind Artefakte downstream wirklich wiederverwendbar?
- Werden Fonts im Artboard exakt und in Bildprompts ehrlich approximiert verwendet?
- Entsteht ein zusammenhängendes Markensystem oder nur eine Sammlung isolierter Antworten?
- Bleiben Flow und Artboard zwei verständliche Arbeitsmodi mit klarer, reversibler Referenz statt vermischter Zustände?
- Überschreibt eine neue Flow-Version niemals still ein bestehendes Design?

### Workflow B – Thumbnail-/Social-Varianten

1. Webseite oder Recherche als Kontext.
2. Kernaussage/Hooks generieren.
3. Mehrere Bildprompts oder Bildvarianten erzeugen.
4. Varianten in Galerie und Fan-out vergleichen.
5. Zwei Favoriten auswählen.
6. Logo, Font-Pairing und Palette einbinden.
7. Social-/Thumbnail-Artboard erstellen.
8. Ergebnisse typspezifisch exportieren.

### Workflow C – Verkettete Videosequenz

1. Text und optional Startbild eingeben.
2. Videomodellfamilie wählen.
3. Prüfen, ob FlowZ den richtigen T2V-/I2V-/Reference-Endpoint ableitet.
4. Dauer per unterstütztem Slider wählen.
5. Video generieren.
6. Endframe an nächste Video-Node geben.
7. Fortsetzung erzeugen.
8. Beliebigen Frame zusätzlich extrahieren.
9. Verlauf, Kosten, Abbruch und Reload prüfen.

### Workflow D – Recherche und Listenverarbeitung

1. Recherche durchführen.
2. Zehn strukturierte Varianten erzeugen.
3. `Jede Variante einzeln` und `Alle Varianten gemeinsam` vergleichen; Zahl der Providerläufe, Promptzusammensetzung und Ergebnisform verifizieren.
4. Teilfehler provozieren oder simulieren.
5. Retry/Skip/Abbruch verwenden.
6. Kosten und erhaltene Teilergebnisse nach Reload prüfen.

### Workflow E – Direktmodus ohne kompletten Flow

Teste zentrale Nodes einzeln:

- Domainnamen direkt eingeben und prüfen.
- Font-Preset ohne Briefing visuell auswählen.
- Bild direkt generieren.
- Bild direkt hochskalieren oder freistellen.
- Text direkt generieren.
- Export direkt am Ergebnis verwenden.

Bewerte, ob FlowZ auch für kleine Aufgaben schneller als ein künstlich aufgebauter Mini-Graph ist.

---

## 5. Graph-, Canvas- und Verbindungslogik

Prüfe:

- Rechtsklick-Menü und Einfügen an exakter Position.
- Gefiltertes Node-Menü beim Loslassen einer Verbindung im Leeren.
- Verbindungen von Input- und Outputseite neu ziehen und lösen.
- Bézier-Kabel, Typfarben und unterscheidbare Listenkabel.
- Keine doppelten oder widersprüchlichen Socketfarben.
- Mehrfachinputs und dynamisch ergänzte Ports.
- Unvereinbare Verbindungen werden verhindert oder erklärt.
- Kein belegter Input wird bei Modellwechsel still ignoriert.
- Node-Dragging kollidiert nicht mit Formfeldern, Scrollbereichen, Slidern oder Popovers.
- Zoom/Pan ist vorhersehbar.
- Offscreen-Nodes bleiben funktional.
- Gruppen sind visuell sinnvoll und ausführbar.
- Undo/Redo trennt Strukturänderung von bezahlten Ergebnissen.
- Templates erzeugen sofort verständliche, nicht überlappende Graphen.

---

## 6. Visuelle Hierarchie und progressive Komplexität

Prüfe jede Node und die App insgesamt:

- Ist der Canvas eindeutig im Mittelpunkt?
- Gibt es unnötige Sidebars, Mega-Nodes oder blockierende Dialoge?
- Sind nur die zwei bis vier wichtigsten Parameter sofort sichtbar?
- Sind seltene Parameter unter „Weitere Einstellungen“ sinnvoll organisiert?
- Werden nicht unterstützte Optionen verborgen?
- Bleiben belegte, inzwischen inkompatible Werte sichtbar und erklärt?
- Ist das aktive Ergebnis groß genug?
- Sind zehn Bilder sinnvoll navigierbar, ohne die Node aufzublähen?
- Ist Markdown in Textausgaben lesbar und nicht überdimensioniert?
- Können Textausgaben innerhalb der Node gescrollt werden, ohne Canvas-Zoom?
- Sind Bilder/Video vergrößerbar?
- Sind Font-Pairings echte visuelle Designproben statt Namenslisten?
- Sind Artboards direkt bearbeitbar statt nur flache Bilder?
- Wirkt die Oberfläche ruhig, präzise und hochwertig?

Notiere Stellen, an denen weniger UI mehr Produktwert erzeugen würde.

---

## 7. History, Varianten und Assets

Prüfe systematisch:

- zehn oder mehr Bilder in einer Node;
- mehrere Textläufe;
- Videoverläufe mit Start-/Endframes;
- Varianten eines Laufs gegenüber mehreren Läufen;
- Aktivieren eines alten Ergebnisses;
- Multi-Select und kuratierte Liste;
- Fan-out und verbundene Varianten nach App-Neustart;
- Asset-Palette als nichtmodales, verschiebbares Werkzeug;
- Drag-and-drop aus Assets auf Canvas und bestehende Nodes;
- unveränderliche Asset-Versionen;
- sinnvolle Benennung und Vorschauen;
- Speicherübersicht und gezieltes Löschen;
- Schutz aktiver, verkabelter oder kuratierter Ergebnisse;
- CAS-Speicherbereinigung ohne Datenverlust.

---

## 8. Provider-, Modell- und Parameterwahrheit

Prüfe:

- OpenRouter ausschließlich für Text, textausgebende Bildanalyse und STT.
- fal.ai ausschließlich für visuelle Generierung und Cloud-Bildwerkzeuge.
- Bildmodelle nur mit ihren echten endpointgebundenen Fähigkeiten.
- Videoendpoint wird aus Eingängen abgeleitet.
- Dauer, Auflösung, Seitenverhältnis, Ton, Seed, Referenzen und Transparenz stimmen.
- GPT Image 1.5 Transparenz wird tatsächlich per Alpha geprüft.
- Bria-Ausgabe wird tatsächlich auf transparente Pixel geprüft.
- Keine Fähigkeit wird aus mehreren Endpoints zu einem unmöglichen Superset vermischt.
- Unbekannte Providerantwort führt niemals zu blindem Paid-Resubmit.
- Restart/Resume/Cancel bewahren Ergebnisse und verhindern Doppelabrechnung.
- CDN-URLs sind Transport, lokale CAS-Daten der Wahrheitsspeicher.
- Lokale Bild- und Videoreferenzen werden für fal-Endpunkte automatisch als endpointgerechte, begrenzte Ableitung in den privaten fal-Dateispeicher geladen; es existiert kein wiederkehrender Upload-Toggle oder Opt-in.
- Kostenprovenienz actual/estimated/unknown ist überall ehrlich.

---

## 9. Brand-Foundry-spezifischer Audit

### Briefing und Zielgruppe

- Ist das Briefing kompakt und sofort gespeichert?
- Sind Evidenz und Annahme sauber getrennt?
- Werden nicht belegte Aussagen niemals als Fakten dargestellt?

### Naming, Domains und Handles

- Sind Kandidaten visuell vergleichbar und historisiert?
- Kann ein Kandidat aus alter History weiterverwendet werden?
- Gibt es Direktinput und Override?
- Sagt RDAP niemals fälschlich „frei“?
- Sind Zeitstempel und Einschränkungen sichtbar?
- Behauptet der Handle-Plan keine universelle Verfügbarkeit?

### Fonts

- Ist der vollständige Katalog performant?
- Sind Suche, Filter, Preview, Rollen, Gewichte und Achsen sinnvoll?
- Sind etwa hundert Presets fachlich überzeugend und kategorisiert?
- Ist die Typografieprobe visuell stark genug für eine echte Entscheidung?
- Werden exakte Fontdateien/Lizenzen im Artboard verwendet?
- Ist der Stilhinweis für Bildprompts ehrlich als Annäherung bezeichnet?

### Farben

- Sind Rollen statt bloßer Farbfelder vorhanden?
- Sind Kontraste deterministisch und verständlich?
- Kann man Palette, Rollen und ältere Varianten weiterverwenden?

### Logo und Artboard

- Ist Transparenz echt?
- Kann ein opakes Diagnoseergebnis sinnvoll weiterverarbeitet werden?
- Sind Layer, Rollen, Fonts, Farben, Größe, Reihenfolge und Sichtbarkeit editierbar?
- Sind Artboard-Vorschau und Export konsistent und vollständig?
- Lassen sich mehrere Artboards ohne Überlagerung anlegen, vergleichen, duplizieren und als Varianten erhalten?
- Ist die kompakte Artboard-Node wirklich nur Referenz und Vorschau, während Ebenen/Fonts ausschließlich im Workspace erscheinen?
- Liest der Design-Agent nur den aktuellen revisionsgebundenen Kontext und explizite Assets?
- Ist jeder Agentenlauf als Vorschlag mit verständlichem Diff sichtbar und nur nach Bestätigung anwendbar?
- Bleibt kostenpflichtige Bildgenerierung im Agenten ein separat bestätigter Folge-Schritt?

### Startscreen, Dokumente und Autosave

- Sind Flow- und Artboard-Dokumente auf dem Startscreen visuell unterscheidbar, sinnvoll benannt und mit hilfreicher Vorschau versehen?
- Funktionieren Erstellen, Öffnen, Umbenennen, Duplizieren und sicheres Löschen ohne versteckte Nebenwirkungen?
- Bleibt jeweils nur die aktive schwere Arbeitsfläche gemountet, ohne dass Tabs Zustände verlieren?
- Speichert FlowZ nach zwei Sekunden echter Ruhe automatisch, ohne einen Speichern-Button zu verlangen?
- Wird während Node-, Kabel-, Pan-, Crop-, Slider- und Artboard-Drag nicht mitten in der Geste gespeichert?
- Startet der vollständige Timer erst nach Pointer-up/Cancel neu?
- Erzwingen Tabwechsel, Projektwechsel und App-Schließen einen sofortigen Flush und verhindern das Verlassen bei Fehler?

---

## 10. Accessibility, Sprache und Eingabequalität

Prüfe mit Maus und Tastatur:

- Fokusreihenfolge und sichtbare Fokusrahmen;
- Custom Selects mit Pfeilen, Enter, Escape und Screenreader-Status;
- immer nur ein offenes Popup;
- Slider und Zahlenfelder;
- Drag-and-drop mit Tastaturalternative;
- Dialogfokus und Fokusrückgabe;
- nicht ausschließlich farbcodierte Zustände;
- Live-Regions für Fehler und laufende Prozesse;
- Deutsch und Englisch vollständig, ohne rohe Übersetzungsschlüssel;
- Sprache ändert keine Projektfingerprints oder Stale-Zustände;
- Datums-, Zahlen-, Kosten- und Dateigrößenformatierung pro Locale.

---

## 11. Fehler-, Abbruch- und Wiederherstellungstests

Simuliere oder prüfe:

- Provider 400/402/429/500;
- Netzwerkverlust nach Paid-Submit;
- ungültige Queue-Antwort;
- App-Neustart während Queue und Finalisierung;
- Node-Löschung während Paid-Run;
- Projektwechsel während Run;
- Cancel kommt zu spät und Provider liefert trotzdem Ergebnis;
- Datenbankfehler nach Providererfolg;
- CAS- oder Exportfehler;
- ungültiges oder opakes Transparenzresultat;
- fehlende Fontdatei/offline;
- RDAP-Rate-Limit;
- partieller Map-Fehler;
- Exportziel existiert bereits;
- beschädigte Projekt- oder Cachemetadaten.

Prüfe immer: Gehen bezahlte Ergebnisse oder Kosten verloren? Wird etwas fälschlich aktiv? Kann ein Nutzer verständlich fortfahren?

---

## 12. Performance und Langzeitnutzung

Teste beziehungsweise beurteile:

- viele Nodes auf dem Canvas;
- viele Medienvorschauen;
- große History;
- zehn oder mehr Videos;
- vollständiger Fontkatalog;
- Suche und Popovers bei Canvas-Zoom;
- Lazy Loading und Virtualisierung;
- Bundle-/Startgröße;
- Offscreen-Rendering;
- Memory bei Bildtransformation und Video;
- App-Neustart und Projekthydration;
- Cachegrößen und manuelles Löschen.

Identifiziere Performanceprobleme, die die kreative Arbeit real stören – nicht bloß theoretische Mikrooptimierungen.

---

## 13. Vergleich mit Chat und Einzeltools

Führe mindestens drei Aufgaben gedanklich oder praktisch auch in einem normalen Chat beziehungsweise Einzelgenerator aus.

Beantworte:

- Wo ist FlowZ eindeutig besser?
- Wo ist FlowZ langsamer oder umständlicher?
- Welche Aufgabe erzwingt unnötige Nodes?
- Wo fehlen direkte Eingaben oder Overrides?
- Wo zahlt sich History/Branching/Typisierung wirklich aus?
- Welche Schritte sollten automatischer oder inline werden?
- Welche sichtbare Node ist nur Chat in einem Kasten?

Gib ein hartes Urteil: Würdest du FlowZ für die Zielgruppe freiwillig statt eines Chats einsetzen? Für welche Aufgaben ja, für welche nein?

---

## 14. Kreativer Zukunftsaudit

Denke über die vorhandene Spezifikation hinaus, ohne beliebige Featurelisten zu produzieren.

Suche nach Erweiterungen, die aus dem bestehenden Graphmodell einen **deutlich besseren Produktionsworkflow** machen:

- fehlende kuratierte Templates;
- sinnvolle spezialisierte Nodes, die generische Nodes konfigurieren;
- neue typisierte Artefakte;
- bessere Kuration und Vergleichsansichten;
- sinnvollere Brand-Pipelines;
- direkte visuelle Komposition;
- wiederverwendbare Stil- oder Identitätsreferenzen;
- Agent-/MCP-Nutzung, die sichtbar im Graph bleibt;
- Funktionen, die mehrere heutige Nodes sinnvoll ersetzen könnten.

Für jede Idee beantworte:

1. Welches reale Nutzerproblem löst sie?
2. Warum gehört sie in FlowZ?
3. Warum ist sie eine Node, Inline-Aktion, Ansicht oder Vorlage?
4. Welches typisierte Artefakt entsteht?
5. Wie bleibt sie einfach im Standardzustand?
6. Welche bestehende Komplexität könnte sie reduzieren?

Priorisiere wenige starke Ideen statt einer langen Wunschliste.

---

## 15. Erwartetes Berichtsformat

### A. Executive Summary

- Für wen ist FlowZ heute wirklich gut?
- Was ist sein stärkster Vorteil?
- Was verhindert derzeit den Wow-Effekt?
- Würdest du es produktiv verwenden?

### B. Workflow-Ergebnisse

Für jeden Testworkflow:

- Ziel;
- Ergebnis;
- Reibungspunkte;
- unnötige Schritte;
- fehlende direkte Aktionen;
- Vorteil gegenüber Chat;
- konkrete Verbesserung.

### C. Node-Inventar und Existenzurteil

Nutze die Tabelle aus Abschnitt 3.10 für jede sichtbare Node.

### D. Befunde nach Priorität

- **P0** – Datenverlust, Doppelabrechnung, Sicherheitsproblem oder Kernworkflow unmöglich.
- **P1** – wesentlicher Produkt-/Workflowfehler; vor Release schließen.
- **P2** – spürbare Qualitäts- oder Verständlichkeitslücke.
- **P3** – sinnvolle spätere Verbesserung.

Jeder Befund enthält:

- Beobachtung;
- betroffener Nutzer/Workflow;
- warum das relevant ist;
- konkrete empfohlene Änderung;
- ob Node behalten, zusammenführen, inline machen, verbergen oder entfernen.

### E. Reduktionsvorschläge

Liste explizit:

- Nodes, die entfernt oder verborgen werden sollten;
- Formfelder, die weg können;
- Einstellungen, die automatisch abgeleitet werden sollten;
- Aktionen, die direkt am Ergebnis leben sollten;
- Stellen, an denen FlowZ zu viel erklärt oder zu wenig zeigt.

### F. Fehlende direkte Modi und Overrides

Liste jede Node, die ohne Vorgänger unnötig unbrauchbar ist, sowie sinnvolle direkte Eingaben und Override-Regeln.

### G. Creative Next Phase

Maximal zehn starke Ideen, priorisiert nach Nutzerwert und Komplexitätsreduktion.

### H. Abschlussurteil

Bewerte getrennt von 1 bis 10:

- Verständlichkeit;
- Flow-Mehrwert gegenüber Chat;
- Node-Logik;
- visuelle Qualität;
- kreative Freiheit;
- Kuration/History;
- Brand-Foundry-Nutzen;
- Content-Produktionsnutzen;
- Vertrauen/Kostenwahrheit;
- Release-Reife.

Eine Zahl allein ist kein Abnahmekriterium. Nenne die **wenigen konkreten Bedingungen**, unter denen du das Produkt freigeben würdest.

---

## 16. Regeln für deine Prüfung

- Sei konkret und evidenzbasiert.
- Lobe nicht pauschal.
- Erfinde keine Fehler, um gründlich zu wirken.
- Suche nicht endlos nach immer kleineren theoretischen Problemen.
- Wenn ein Bereich gut ist, sage klar, warum.
- Unterscheide Produktfehler, technische Risiken und persönliche Präferenz.
- Priorisiere reale Nutzerwirkung.
- Empfehle Reduktion ebenso selbstverständlich wie neue Features.
- Behandle Providerfähigkeiten, Kosten, Domains, Handles, Lizenzen und Transparenz niemals als sicherer, als sie nachweislich sind.
- Beurteile den Standardzustand für Anfänger und den erweiterten Zustand für Power-User getrennt.
- Prüfe, ob das Produkt nach wiederholter Nutzung besser wird: History, Assets, Templates, Presets und wiederverwendbare Graphen.

---

## 17. Aufteilung auf mehrere unabhängige Prüfer

Wenn mehrere Agenten verfügbar sind, teile den Audit mindestens so auf:

1. **Erstnutzer & Informationsarchitektur** – Einstieg, Begriffe, Defaults, Direktmodi.
2. **Node-Rationalisierung** – Existenzberechtigung jeder Node, Zusammenführung/Reduktion.
3. **Content Creator** – Recherche, Text, Bild, Social, Kuration, Export.
4. **Brand Strategist** – Briefing, Audience, Naming, Domains, Handles, Fonts, Farben, Logo.
5. **Visual Designer** – Font-Pairing, Artboard, Typografie, Layout, Bildqualität.
6. **Video Producer** – Start-/Endframe, Referenzen, Sequenzen, Dauer, Varianten.
7. **Power User** – Listen, Map/Aggregat, Fan-out, History, Modelle, Seeds, Kosten.
8. **Accessibility & Input Quality** – Tastatur, Fokus, Popovers, Felder, Screenreader.
9. **Failure & Trust** – Paid Runs, Resume, Cancel, Orphans, Kosten, Export, Recovery.
10. **Creative Product Thinker** – nächste Phase, fehlende starke Workflows, Komplexitätsreduktion.

Gib den Prüfern möglichst wenig Kontext über frühere Designbegründungen. Lass sie zunächst unabhängig berichten. Ein Orchestrator konsolidiert danach **genau einmal**: Evidenz zusammenführen, Dubletten entfernen, Widersprüche markieren und P0–P3 priorisieren. Danach ist der Endaudit beendet und der gemeinsame Bericht wird vorgelegt. Eine Korrekturwelle beginnt nur auf ausdrückliche Entscheidung nach diesem Bericht; sie startet keine unbegrenzte Review-des-Reviews-Schleife. Zusätzliche Prüfrunden benötigen einen konkreten offenen P0/P1 oder neue, tatsächlich veränderte Produktoberfläche.

---

## Pflegehinweis

Dieses Dokument ist ein lebender Prompt. Neue Produktprinzipien, wiederkehrendes Nutzerfeedback, zusätzliche Node-Arten und wichtige direkte Nutzungsszenarien sollen hier ergänzt werden. Historische Implementierungsdetails gehören nicht hinein; der Prompt beschreibt das gewünschte Produkturteil, nicht den Weg dorthin.
