# FlowZ — Vision

**Nodebasierte KI-Workflows. Lokal, visuell, deins.**

> Dieses Dokument beschreibt, *was* FlowZ ist und *warum* es so funktioniert. Es ist bewusst keine technische Spezifikation — mit zwei Ausnahmen: Kapitel 15 hält die tragenden Fundament-Entscheidungen fest, Kapitel 16 den verbindlichen Produktvertrag der ersten vollständigen Version. Historische Bauphasen und verworfene Zwischenarchitekturen sind kein Teil dieser Vision.

---

## 1. Was ist FlowZ?

FlowZ ist ein lokales Desktop-Programm, in dem KI-Workflows als visuelle Node-Graphen gebaut werden. Man zieht Bausteine auf eine unendliche Arbeitsfläche — Texteingaben, Bilder, Webseiten, Audioaufnahmen — verbindet sie per Kabel mit KI-Modellen und Verarbeitungsschritten und sieht die Ergebnisse direkt dort entstehen, wo sie gebraucht werden.

Ein Bild reinziehen, ein Bildmodell dahinter, daraus ein neues Bild machen. Ein zweites Bild als Referenz anhängen. Eine Webseiten-Analyse aus einem anderen Ast des Graphen als Kontext dazugeben. Das Ergebnis beschreiben lassen, an einen Videogenerator weiterreichen, vom fertigen Video den letzten Frame nehmen und damit das nächste Video starten. Jeder dieser Schritte ist ein Node. Jede Verbindung ist ein Kabel. Der gesamte Workflow ist sichtbar, nachvollziehbar und jederzeit veränderbar.

FlowZ läuft lokal auf dem eigenen Rechner. Die KI-Leistung kommt über die eigenen API-Schlüssel: OpenRouter für Text, textausgebende Bildanalyse und Transkription, fal.ai für jede visuelle Generierung und die bewusst gewählten Cloud-Bildwerkzeuge. Kein Abo bei FlowZ, kein Konto, keine FlowZ-Cloud dazwischen. Man bezahlt nur das, was die Provider tatsächlich kosten — und FlowZ trennt Schätzung und abgerechnete Kosten ehrlich, statt ungenaue Cent-Beträge vorzutäuschen.

FlowZ ist Open Source. Es wird primär für den Eigengebrauch gebaut, ohne Marketing-Ambitionen — aber mit dem Anspruch, dass es gut aussieht, sich gut anfühlt und dass andere es nehmen, verstehen und erweitern können.

---

## 2. Die Vision

Die großen KI-Anbieter bauen Chatfenster. Chatfenster sind großartig für Gespräche — und schlecht für Produktion. Wer ernsthaft mit generativer KI arbeitet, arbeitet in Wirklichkeit in Ketten: Recherche führt zu Analyse, Analyse zu Prompt, Prompt zu Bild, Bild zu Variante, Variante zu Video. In einem Chat ist diese Kette unsichtbar, flüchtig und nicht wiederholbar. Man kopiert Ergebnisse von Tab zu Tab, verliert Zwischenstände, generiert versehentlich doppelt und bezahlt dafür.

FlowZ macht die Kette selbst zum Werkstück. Der Graph *ist* der Workflow. Er bleibt bestehen, wenn die Sitzung endet. Er lässt sich morgen mit anderem Input erneut ausführen. Er zeigt an jeder Stelle, was hineingeht, was herauskommt und was es gekostet hat. Und weil jeder Output an beliebig vielen Stellen wiederverwendet werden kann, wird aus einer einmaligen Spielerei eine Maschine, die man immer weiter verfeinert.

Das Vorbild dafür ist nicht die KI-Welt, sondern die 3D-Welt: **Blender**. Blender hat mit Geometry Nodes gezeigt, dass ein Node-System gleichzeitig kreatives Experimentierfeld und präzises Produktionswerkzeug sein kann — dass "verspielt" und "technisch sauber" kein Widerspruch ist. FlowZ überträgt diese Philosophie auf generative KI: die technische Klarheit von Blender, die räumliche Freiheit eines Figma-Canvas, und Inhalte, die aus Sprachmodellen, Bildmodellen und Videomodellen kommen statt aus Meshes und Materialien.

FlowZ steht damit bewusst zwischen zwei Welten: kreative Spielwiese *und* Produktionsfabrik. Man kann darauf frei herumprobieren wie auf einem Moodboard — und denselben Graphen danach als wiederholbare Pipeline benutzen. Diese Doppelnatur ist kein Kompromiss, sondern der Kern des Produkts.

---

## 3. Einordnung: Blender, ComfyUI, Figma & Co.

FlowZ erfindet das Node-Paradigma nicht — es kombiniert die Stärken existierender Welten neu und lässt deren Schwächen weg.

**Blender (Geometry Nodes)** ist das konzeptionelle Vorbild. Von Blender übernimmt FlowZ das getypte Socket-System (jeder Anschluss hat einen Datentyp und eine Farbe, nur Kompatibles lässt sich verbinden), die Idee, dass komplexe Ergebnisse aus einfachen, kombinierbaren Bausteinen entstehen, und die Haltung, dass ein technisches Werkzeug trotzdem kreativ sein darf. Was FlowZ *nicht* übernimmt: Blenders Lernkurve. Blender-Nodes verarbeiten abstrakte Geometrie — FlowZ-Nodes verarbeiten Dinge, die jeder versteht: Texte, Bilder, Videos, Webseiten.

**ComfyUI** beweist seit Jahren, dass nodebasierte KI-Generierung funktioniert — und ist gleichzeitig die Mahnung, wie man es nicht baut. ComfyUI ist mächtig, aber visuell abschreckend, auf lokale Stable-Diffusion-Modelle fokussiert und in seiner Bedienung kompromisslos nerdig. FlowZ nimmt die Mächtigkeit und lässt die Hürde weg: API-Modelle statt lokaler Modellverwaltung, Ergebnisse direkt im Node statt in getrennten Fenstern, ein Erscheinungsbild, das man gerne anschaut.

**Figma / Flora / Weavy** zeigen die andere Richtung: den unendlichen, zoombaren Canvas als kreativen Raum, auf dem viele Dinge gleichzeitig passieren. Von dort übernimmt FlowZ das räumliche Arbeiten — reinzoomen ins Detail, rauszoomen für den Überblick, mehrere Stränge parallel. Was FlowZ anders macht: Es ist keine Cloud-Plattform mit Abo-Modell, sondern ein lokales, quelloffenes Programm mit eigenem Schlüssel.

**n8n / LangFlow** haben das Node-Paradigma für Automatisierung etabliert. FlowZ teilt mit ihnen die Graph-Logik, verfolgt aber ein anderes Ziel: n8n verbindet Dienste miteinander und läuft unbeaufsichtigt — FlowZ erzeugt Inhalte und läuft mit dem Menschen davor. FlowZ ist ein Werkzeug, das man in der Hand hält, keine Automatisierung, die im Hintergrund tickt.

Kurz gesagt: **Blenders Systemdenken, Figmas Raumgefühl, ComfyUIs Mächtigkeit, aber lokal, offen und aufgeräumt — für generative KI-Inhalte.**

---

## 4. Grundprinzipien

Sieben Leitsätze, die jede Design-Entscheidung in FlowZ prägen:

1. **Der Graph ist das Werkstück.** Nicht das einzelne Bild ist das Ergebnis, sondern der Workflow, der es erzeugt. Er ist sichtbar, dauerhaft und wiederholbar.
2. **Alles ist verkabelbar.** Jeder Output kann an beliebig vielen Stellen als Input dienen. Wiederverwendung ist kein Feature, sondern die Grundmechanik.
3. **Nichts läuft ungefragt, nichts geht verloren.** Ausführung ist standardmäßig eine bewusste Handlung, und jedes einmal erzeugte Ergebnis bleibt im Verlauf erhalten. Generierungen kosten Geld — FlowZ behandelt sie entsprechend respektvoll.
4. **Typen schaffen Klarheit.** Jeder Anschluss hat einen Datentyp mit eigener Farbe. Was zusammenpasst, sieht man, bevor man es verbindet.
5. **Das Ergebnis lebt im Node.** Vorschau, Verlauf und Kosten sind direkt am Baustein sichtbar — kein Wechsel in getrennte Fenster, um zu sehen, was passiert ist.
6. **Generisch zuerst.** Es gibt *einen* Textgenerierungs-Node, *einen* Bildgenerierungs-Node — das konkrete Modell ist eine Einstellung darin, keine eigene Node-Sorte. Neue Modelle bedeuten neue Dropdown-Einträge, nicht neue Bausteine.
7. **Lokal und offen.** Eigener Rechner, eigene Schlüssel, offener Quellcode. FlowZ besitzt nichts von dem, was darin entsteht; Provider-URLs sind Transport, die lokale Bibliothek ist der dauerhafte Wahrheitsspeicher.

---

## 5. Der Canvas

FlowZ beginnt auf einem ruhigen Startscreen mit einer visuellen Projektübersicht. Flow-Dokumente und eigenständige Artboard-Dokumente sind dort als unterschiedliche, erkennbare Kacheln mit Vorschau organisiert und lassen sich in internen Dokument-Tabs nebeneinander öffnen. Ein Flow-Dokument selbst bleibt ein großer, unendlicher Canvas ohne dauerhaft blockierende Seitenleisten. Übersicht entsteht durch Zoomen und räumliche Anordnung: Rauszoomen zeigt die Architektur des Workflows, Reinzoomen die Details eines einzelnen Nodes.

Neue Nodes entstehen direkt am Arbeitsort: per kompaktem Kontextmenü auf dem leeren Canvas oder beim Loslassen eines Kabels im Raum. Im zweiten Fall zeigt das Menü nur technisch kompatible Ziele und stellt die Verbindung nach der Auswahl fertig. Asset-Bibliothek, Verlauf und andere Werkzeuge öffnen sich als nicht blockierende, bei Bedarf verschiebbare Oberflächen statt als dauerhafte Seitenleisten.

Optisch folgt FlowZ der Blender-Schule: **Dark Mode only**, technisch-clean, zurückhaltend. Die Fläche ist dunkel und ruhig, damit die Inhalte — Bilder, Videos, Texte — leuchten. Farbe hat eine Funktion: Sie kennzeichnet Datentypen an den Anschlüssen und Zustände an den Nodes. Kein Dekor, keine verspielten Illustrationen. Die Kreativität steckt in dem, was auf dem Canvas entsteht, nicht im Rahmen drumherum.

Die Oberfläche ist auf Deutsch — von Anfang an aber mehrsprachig gedacht und gebaut, mit Deutsch als Fokus- und Erstsprache und Englisch als zweiter Sprache. Kein nachträgliches Übersetzen, sondern Mehrsprachigkeit als Grundannahme.

---

## 6. Das Node-System

### 6.1 Anatomie eines Nodes

Jeder Node folgt demselben Aufbau, egal was er tut:

- **Eingänge** (links): getypte Anschlüsse, an die Kabel angedockt werden.
- **Ausgänge** (rechts): getypte Anschlüsse, von denen Kabel weggehen — an beliebig viele Ziele.
- **Inhalt** (Mitte): das Herz des Nodes. Bei Eingabe-Nodes das Eingabefeld, bei Modell-Nodes Prompt und Modellwahl, bei Ergebnissen die Vorschau.
- **Kopfzeile**: Name, Typ-Farbe, Ausführungsstatus (frisch / veraltet / rechnet gerade / Fehler).
- **Fußzeile**: Kosten des letzten Laufs, Gesamtkosten dieses Nodes, Zugang zum Verlauf.

Textfelder — vor allem Prompts — sind direkt im Node editierbar, klein und unaufdringlich. Ein Klick öffnet sie in einem großen Editor mit Markdown-Unterstützung, für alles, was länger als zwei Zeilen ist. Häufig gebrauchte Prompts lassen sich als Asset speichern und in beliebigen Nodes wiederverwenden (siehe Kapitel 10).

### 6.2 Das Typsystem: Sockets mit Farben

Wie in Blender hat jeder Anschluss einen Datentyp, erkennbar an seiner Farbe. Kabel lassen sich nur zwischen kompatiblen Typen ziehen — Fehlverbindungen sind damit unmöglich, nicht nur verboten.

| Typ | Beschreibung |
|---|---|
| **Text** | Prompts, Analysen, Beschreibungen, Transkripte — die universelle Währung |
| **Bild** | Fotos, Generierungen, Screenshots, extrahierte Frames |
| **Video** | Generierte oder importierte Clips |
| **Audio** | Aufnahmen und Audiodateien (nur als Eingang, siehe Kapitel 13) |
| **Webseite** | Eine Quelle im Netz — extrahierbar als Text und/oder Screenshot |
| **Variantenmenge** | Bewusst erzeugte Geschwister-Ergebnisse desselben Typs; im Normalfall bleibt Text skalar und ein ausgewähltes Bild ein Bild |

Wo es offensichtlich und eindeutig ist, konvertiert FlowZ stillschweigend mit: Ein Bild an einem Text-Eingang wird beschrieben, eine Webseite an einem Text-Eingang wird extrahiert. Diese Übergänge sind sichtbar gekennzeichnet, damit nie unklar ist, was tatsächlich beim Modell ankommt.

### 6.3 Node-Kategorien

**Eingänge** bringen Material auf den Canvas: Textfeld, Bild-Import (Datei oder Drag & Drop), Video-Import, Audio-Aufnahme/-Import, Webseiten-Node (URL rein — Text und optional Screenshot über einen externen Dienst raus), Recherche-Node (Websuche, z. B. über die Brave Search API: Suchauftrag rein, Ergebnisse als Text raus).

**Modell-Nodes** sind die Arbeitspferde — bewusst generisch gehalten:

- **Textgenerierung**: Prompt und beliebige Kontext-Eingänge rein, Text raus. Das Modell wird per Dropdown aus der gesamten OpenRouter-Palette gewählt — pro Node, nicht global. Der Recherche-Ast darf ein günstiges Modell nutzen, der finale Copy-Ast das beste.
- **Bildgenerierung**: Geordnete Texte plus optionale Referenzbilder rein, ein aktiv ausgewähltes Bild und bei echten Mehrfachergebnissen zusätzlich alle Varianten raus. Modelle ausschließlich über kuratierte, schema-geprüfte fal.ai-Adapter.
- **Videogenerierung**: Text plus modellabhängig Startbild, Endbild und weitere Referenzbilder rein; Video sowie lokal extrahiertes Start- und Endbild raus. Der konkrete fal.ai-Endpunkt wird passend zu den verbundenen Eingängen gewählt und bietet nur tatsächlich unterstützte Dauer, Auflösung, Seitenverhältnis und Audio-Optionen an.
- **Transkription**: Audio rein, Text raus. Standardmäßig über OpenRouter (schnell, kostet Bruchteile eines Cents), optional über ein lokales Modell auf dem eigenen Rechner.
- **Bildanalyse**: Bild(er) plus Frage rein, Text raus — beschreiben, vergleichen, bewerten.

Generierende Modell-Nodes tragen ihre Grundparameter sichtbar am Node, nicht in Untermenüs vergraben: **Seitenverhältnis** (mit 9:16 als gleichwertig prominenter Option neben 16:9 und 1:1 — Vertikal-Content ist Kerngeschäft, kein Sonderfall), Auflösung, Anzahl der Varianten und, wo Modelle es unterstützen, ein Seed für Reproduzierbarkeit. Diese Parameter gehören zum Ergebnis: Der Verlauf hält zu jeder Generierung fest, mit welchen Einstellungen sie entstand.

**Verarbeitungs-Nodes** formen Daten nur dort zwischen Modellen um, wo eine eigene visuelle Operation echten Mehrwert bietet: Bild-Operationen wie Zuschneiden und Skalieren und Medien-Extraktionen — allen voran **"Frame aus Video"**: der letzte (oder ein beliebiger) Frame eines Videos wird zum Bild und damit zum Startpunkt der nächsten Videogenerierung. Geordnete Texte und zusätzliche Anweisungen werden direkt an der konsumierenden Generierungs-Node verbunden und bearbeitet, statt dafür Durchleitungs-Nodes einzufügen. So entstehen lange, zusammenhängende Videosequenzen aus verketteten Einzel-Generierungen — mit Text- und Analyse-Nodes dazwischen, die jede Fortsetzung inhaltlich steuern.

Ein Kernbaustein dieser Kategorie ist der **Freisteller-Node (Background Removal)**: Bild rein, freigestelltes Bild mit transparentem Hintergrund raus. Die erste belastbare Version verwendet dafür `fal-ai/bria/background/remove`. Ein lokaler Modus erscheint erst, wenn ein separater Apple-Silicon-Spike reproduzierbare Installation, klare Modelllizenz, vertretbare Größe und sichtbar brauchbare Alpha-Matten belegt; ein halbfertiger lokaler Schalter ist schlechter als ein ehrlicher Cloud-Pfad. Daneben gibt es **Transparenz beschneiden**: eine kostenlose deterministische Node, die leere transparente Außenflächen bis auf einen kleinen Rand entfernt, ohne das Seitenverhältnis zu erhalten.

**Ausgänge** bestimmen, was mit Ergebnissen passiert. Export ist keine universelle Mega-Node: Jede erzeugende Node bietet die zu ihrem Ergebnistyp passenden Exportaktionen und Namensoptionen direkt im Verlauf beziehungsweise Ergebnisbereich an. Standard ist, dass das Ergebnis in der lokalen App-Bibliothek und im Node sichtbar bleibt.

---

## 7. Ausführung: Wann läuft was?

Das Ausführungsmodell ist die heikelste Design-Frage eines Node-Systems — und FlowZ beantwortet sie mit einem klaren Grundsatz: **Kostenpflichtige oder rechenintensive Arbeit startet bewusst; reine Eingaben sind sofort lebendig.**

Kein Node führt sich von selbst aus, nur weil sich irgendwo davor etwas geändert hat. Stattdessen kennt jeder Node einen Zustand:

- **Frisch**: Das Ergebnis passt zu den aktuellen Eingaben.
- **Veraltet (stale)**: Irgendein Input in der Kette davor hat sich geändert — das Ergebnis ist möglicherweise überholt. Der Node zeigt das dezent an, tut aber nichts.
- **Rechnet**: Eine Ausführung läuft gerade; nachgelagerte Nodes warten automatisch.
- **Fehler**: Der letzte Lauf ist gescheitert; die Meldung steht am Node.

Ausgelöst wird auf drei Ebenen:

1. **Einzeln**: Jede KI-, Netzwerk- oder relevante lokale Verarbeitungs-Node hat eine fachlich benannte Aktion wie „Text generieren“ oder „Hintergrund entfernen“. Reine Eingabe- und Editor-Nodes besitzen keinen Ausführen- oder Speichern-Knopf: Ihre typisierten Ausgänge aktualisieren sich beim Bearbeiten und markieren Abhängige als veraltet.
2. **Als Gruppe**: Nodes lassen sich zu benannten Gruppen zusammenfassen, die mit einem Klick von vorn bis hinten durchlaufen. Eine benannte Gruppe ist zugleich das, was FlowZ einen **Workflow** nennt — die Einheit, die später per MCP von außen aufrufbar wird (Kapitel 14). Es gibt also kein zweites Konzept: Workflow = benannte Gruppe auf dem Canvas.
3. **Global**: Ein Knopf führt den gesamten Canvas aus — alles Veraltete wird in sauberer Reihenfolge nachgezogen, Unabhängiges läuft parallel.

Für die Fälle, in denen automatisches Nachziehen erwünscht ist, gibt es die Ausnahme pro Node: ein Schalter **"automatisch aktualisieren"**. Ist er gesetzt, läuft der Node von selbst, sobald seine Eingaben frisch sind. Sinnvoll für Billiges und Schnelles (eine kurze Textumformung), unsinnig für Teures (eine Videogenerierung) — deshalb ist Aus der Standard. Das umgekehrte gibt es auch: ein Schalter **"nicht mitaktualisieren"** für Nodes, die von Änderungen davor bewusst unberührt bleiben sollen — etwa eine Recherche, die einmal gemacht wurde und gültig bleibt, egal wie oft der Rest des Graphen neu läuft.

Weil ein Node erst startet, wenn *alle* seine Eingänge fertig sind, löst sich das klassische Problem paralleler Aktualisierungen von selbst: Zehn Vorgänger können gleichzeitig rechnen — der Node dahinter wartet geduldig auf den letzten und läuft dann genau einmal.

Struktur- und Editoränderungen werden nach zwei Sekunden echter Ruhe automatisch revisionssicher gespeichert. Während eine Node oder ein Artboard-Element aktiv gezogen wird, wird nicht persistiert; erst das Loslassen startet den vollständigen Timer. Tabwechsel, Projektwechsel und App-Schließen erzwingen einen sofortigen Flush. Ein Fehler bleibt sichtbar und blockiert das Verlassen, statt ungesicherte Arbeit still zu verlieren.

**Wenn etwas schiefgeht.** Schlägt ein Node mitten in einer Kette fehl (API-Fehler, Timeout, abgelehnter Prompt), gilt: Alles bereits Fertige bleibt erhalten und zählt — bezahlte Ergebnisse gehen nie verloren. Für den gescheiterten Node öffnet FlowZ einen **Nachfrage-Dialog**: die Fehlermeldung im Klartext, dazu die Wahl, den Node erneut zu versuchen, ihn zu überspringen (nachgelagerte Nodes bleiben dann veraltet) oder den restlichen Lauf abzubrechen. Kein stilles Weiterlaufen, kein stilles Aufgeben — der Mensch entscheidet, wie es weitergeht. Laufende Ausführungen lassen sich außerdem jederzeit abbrechen; was bis dahin fertig wurde, bleibt.

**Rückgängig & Wiederholen.** Undo/Redo deckt die **Graph-Struktur** ab: Nodes anlegen und löschen, Kabel ziehen und trennen, Prompts und Einstellungen ändern, Elemente verschieben — alles gefahrlos rückgängig machbar. Ausdrücklich *nicht* rückgängig gemacht werden Ausführungen: Eine Generierung hat Geld gekostet und existiert — sie verschwindet nicht durch Cmd+Z, sondern lebt im Verlauf (Kapitel 8), wo ältere Stände jederzeit wieder aktiviert werden können. Der Verlauf ist das Undo für Ergebnisse, Cmd+Z das Undo für Struktur.

---

## 8. Verlauf & Galerie: Nichts wird überschrieben

Jede Generierung kostet Geld und ist möglicherweise unwiederbringlich gut. Deshalb überschreibt FlowZ niemals. Jeder Node zeigt sein **aktuellstes** Ergebnis — und führt darunter einen vollständigen **Verlauf** aller bisherigen Läufe.

Bei Bild- und Video-Nodes öffnet sich der Verlauf als **Galerie**: alle je erzeugten Varianten, mit Datum, verwendetem Modell, dem exakten Prompt des jeweiligen Laufs und den Kosten pro Stück. Bei Text-Nodes blättert man durch die Fassungen. Jedes ältere Ergebnis lässt sich wieder zum aktiven machen — der Graph rechnet dann ab dieser Stelle mit dem alten Stand weiter. Ein Bild von vor drei Tagen, das doch das beste war, ist damit zwei Klicks von der Weiterverarbeitung entfernt.

Alle erzeugten Inhalte verwaltet FlowZ intern in einer **App-Bibliothek** — vergleichbar mit der Fotos-App: Man muss sich um keine Ordnerstruktur kümmern, nichts geht verloren, und die Projektdatei bleibt schlank. Wer Ergebnisse zusätzlich als Dateien im Zugriff haben will, nutzt das Ausgabe-Routing des jeweiligen Nodes (Kapitel 6.3) und exportiert gezielt.

"Nichts wird überschrieben" hat eine Konsequenz, die FlowZ nicht versteckt: Die Bibliothek wächst — und Videos wachsen schnell in die Gigabytes. Deshalb gehört zur Bibliothek eine **Speicherübersicht** (wie viel Platz belegt welches Projekt, welcher Node, welcher Medientyp) und die Möglichkeit, gezielt und manuell aufzuräumen: alte Verläufe eines Nodes leeren, einzelne Varianten löschen, ganze Projekte samt Inhalten entfernen. Nie automatisch, nie still im Hintergrund — gelöscht wird ausschließlich vom Menschen, aber der Mensch sieht jederzeit, wo der Platz hingeht.

---

## 9. Listen, Varianten & Kuration

Kreative Arbeit lebt von Varianten: nicht ein Hook, sondern zehn; nicht ein Thumbnail, sondern fünf. FlowZ behandelt echte Geschwister-Ergebnisse deshalb als Bürger erster Klasse, ohne jeden normalen Text vorschnell zur technischen „Liste“ zu erklären.

Ein Generierungs-Node, der in einem bewussten Lauf mehrere eigenständige Varianten erzeugt, stellt am normalen Ausgang immer die aktiv ausgewählte Variante bereit und zusätzlich **Alle Varianten**. Bei genau einem Ergebnis gibt es keine Variantenmenge. Trifft eine echte Variantenverbindung auf den nächsten Node, entscheidet man dort in verständlicher Sprache, was passieren soll:

- **Einzeln verarbeiten (Map)**: Der Node läuft für jedes Element separat — aus fünf Bildern werden fünf Beschreibungen, wieder als Liste.
- **Gebündelt verarbeiten (Aggregat)**: Der Node erhält alle Elemente gemeinsam — fünf Bilder gehen zusammen an ein Modell, das etwa das beste auswählt oder alle miteinander vergleicht.

Dazu kommt die dritte, vielleicht eleganteste Möglichkeit: das **Auffächern**. Ein Node mit fünf Ergebnissen kann seine Elemente als fünf einzelne Ausgänge zeigen, jeder mit einer Mini-Vorschau direkt am Anschluss. Und hier passiert Kuration ganz nebenbei: Man zieht einfach nur von Variante 2 und Variante 4 ein Kabel weiter. **Die Auswahl ist das Verkabeln.** Kein eigener Auswahl-Dialog, kein Freigabe-Node — die menschliche Entscheidung ist in die Grundmechanik des Graphen eingebaut.

---

## 10. Die Asset-Bibliothek

Eine projektübergreifende, nicht blockierende **Asset-Bibliothek** bewahrt alles auf, was wieder gebraucht wird: Logos, Referenzbilder, Medien, Textbausteine und häufig genutzte Quellen. Sie liegt nicht als dauerhafte Seitenleiste über dem Fokus des Canvas, sondern öffnet sich bei Bedarf als kompakte, verschiebbare Werkzeugfläche.

Per Drag & Drop wird ein Asset an seinem Ziel semantisch eingesetzt: Auf leerem Canvas entsteht etwa aus einem Bild automatisch eine Bild-Eingabe; auf einer passenden bestehenden Node ersetzt es bewusst deren lokales Medium. Ein Asset bleibt versioniert und unveränderlich, während die Referenz im Graphen auf eine andere Fassung umgestellt werden kann. So bleibt nachvollziehbar, welcher Lauf welches Material wirklich erhalten hat.

Damit ersetzt die Asset-Bibliothek zusammen mit dem Kabel-Prinzip ein klassisches Variablensystem: Nodes *sind* die Variablen des Graphen (jeder Output ist überall referenzierbar), und Assets sind die versionierten Konstanten. Mehr braucht es nicht.

---

## 11. Kosten-Transparenz

FlowZ läuft auf dem eigenen API-Schlüssel — also gehört jede Kosteninformation dorthin, wo sie entsteht: an den Node.

Jeder Node zeigt, was sein letzter Lauf gekostet hat und was er über seine Lebenszeit insgesamt verbraucht hat. Im Verlauf trägt jedes einzelne Ergebnis sein Preisschild: jedes Bild in der Galerie, jede Textfassung, jedes Video. Wer wissen will, warum ein Projekt teuer war, sieht es nicht in einer anonymen Monatsrechnung, sondern an genau dem Node, der es war.

Darüber liegt eine Projekt-Übersicht: Gesamtkosten des Projekts, Verteilung nach Node und Modell, Verlauf über die Zeit. Keine Budgetsperren, keine Bevormundung — Transparenz genügt, denn wer alles sieht, entscheidet selbst.

---

## 12. Beispiel-Workflows

Vier Szenarien, die zeigen, wie sich die Bausteine zu echten Arbeitsabläufen fügen.

**Thumbnail-Pipeline.** Eine Webseiten-Node holt den Artikel, eine Textgenerierung destilliert die Kernaussage. Die Bildgenerierung erhält diese Kernaussage, eine eigene Inline-Anweisung, den Marken-Look aus einem gespeicherten Prompt-Asset und das Logo aus der Asset-Bibliothek als Referenzbild. Sie erzeugt fünf Geschwister-Varianten; die besten werden in der Galerie aktiviert oder bewusst als Varianten weitergegeben und über den typspezifischen Export in den Projektordner geschrieben.

**Verkettete Videosequenz.** Eine Videogenerierung erzeugt Clip eins aus einem Startbild. Der "Frame aus Video"-Node zieht den letzten Frame heraus. Eine Bildanalyse beschreibt die Szene, eine Textgenerierung schreibt darauf aufbauend den Prompt für die Fortsetzung — und die nächste Videogenerierung setzt mit dem extrahierten Frame als Startbild nahtlos an. Beliebig oft wiederholbar: Aus vielen kurzen Generierungen wird eine zusammenhängende Sequenz, deren Dramaturgie an jeder Nahtstelle per Text steuerbar bleibt.

**Recherche-gestützte Varianten.** Eine Recherche-Node (Websuche) sammelt aktuelle Beispiele zu einem Thema — mit gesetztem "nicht mitaktualisieren", denn die Recherche von heute Vormittag bleibt gültig. Eine Textgenerierung erzeugt daraus zehn Hook-Varianten als Liste. Im Aggregat-Modus bewertet eine zweite Textgenerierung (bewusst ein stärkeres, teureres Modell) alle zehn gemeinsam und begründet ihre Top 3. Die Recherche lief einmal, das teure Modell lief einmal — der Graph macht sichtbar und steuerbar, wo welches Modell arbeitet.

**Bild verstehen, Bild verwandeln.** Zwei Bild-Importe: das eigene Produktfoto und ein Stil-Referenzbild. Eine Bildanalyse beschreibt die Stilmerkmale der Referenz als Text. Die Bildgenerierung erhält diese Beschreibung über ein geordnetes Textkabel, eine eigene Inline-Anweisung und das Produktfoto als Referenz und erzeugt die stilisierte Fassung — deren Verlauf alle Experimente behält, bis die richtige gefunden ist.

---

## 13. Was FlowZ nicht ist

Genauso wichtig wie die Vision ist ihre Abgrenzung. FlowZ ist bewusst **nicht**:

**Kein Audio- oder Musik-Generator.** Audio existiert in FlowZ nur als *Eingang* — eine Aufnahme oder Datei, die transkribiert und als Text weiterverarbeitet wird. Es gibt keine Sprachausgabe, keine Musikgenerierung, keinen Sound als Ergebnis. Der Fokus liegt auf visueller Generierung: Text, Bild, Video. (Die Architektur schließt eine spätere Erweiterung nicht aus — sie ist nur ausdrücklich nicht Teil dieser Vision.)

**Keine Automatisierungsplattform.** Keine Ordner-Überwachung, keine Zeitpläne, keine Webhooks, keine Läufe ohne Menschen davor. FlowZ ist ein Werkzeug, das man aktiv bedient — wer unbeaufsichtigte Pipelines braucht, braucht ein anderes Produkt (oder eine ferne Zukunftsversion, die diese Vision bewusst nicht verspricht).

**Kein Code-Editor.** FlowZ schreibt keinen Programmcode, bearbeitet keine lokalen Projektdateien und ersetzt weder Claude Code noch Codex. Das Editieren bleibt nodebasiert; die Festplatte wird nur berührt, wo Ergebnisse ausdrücklich exportiert werden.

**Keine Cloud, keine Kollaboration.** Kein Konto, kein Sync, kein Multi-User, kein gemeinsames Echtzeit-Bearbeiten. Ein Rechner, ein Mensch, seine Graphen. Teilen passiert — dem Open-Source-Gedanken folgend — auf der Ebene des Programms selbst, nicht über eine Plattform.

**Kein Modell-Hoster.** FlowZ lädt und betreibt keine großen Generierungsmodelle lokal. Lokal ist die *App*, nicht die generative KI. Kleine deterministische Medienoperationen dürfen lokal laufen; spezialisierte Hilfsmodelle erscheinen nur nach einem reproduzierbaren Qualitäts-, Lizenz- und Performance-Gate. Text kommt über OpenRouter, visuelle Generierung und ausgewiesene Cloud-Bildwerkzeuge über fal.ai.

---

## 14. Bestehender Kern und Blick nach vorn

Multi-Artboards, Flow-Referenzen und Design-Agent sind bereits Produktkern. Darüber hinaus zeichnen sich Ausbaustufen ab, die den bestehenden Vertrag erweitern dürfen, ohne eine zweite Engine oder einen unsichtbaren Wahrheitsspeicher einzuführen:

**Template-Nodes.** Auf den generischen Modell-Nodes aufbauend entstehen spezialisierte Fertigbausteine: ein YouTube-Thumbnail-Node, ein Instagram-Post-Node, ein SEO-Titel-Node oder ein Kampagnen-Copy-Node — jeweils ein generischer Node mit eingebautem System-Prompt und passenden Voreinstellungen. Für den Nutzer fühlen sie sich wie eigene Werkzeuge an; unter der Haube bleiben sie Konfigurationen, keine neuen Node-Sorten.

**Der Node-Builder.** Die vielleicht weitreichendste Idee: Ein Coding-Agent (Claude Code, Codex) wird nicht Teil der Graphen — sondern **baut neue Nodes**. "Ich brauche einen Node, der aus einem Video alle Frames mit Gesichtern extrahiert" → der Agent schreibt den Baustein, er erscheint in der Node-Bibliothek, fertig. Das ist das Äquivalent zu Blenders Python-Scripting, nur ohne selbst zu programmieren — und in einem Open-Source-Projekt zugleich der natürliche Weg, wie eine Community die Node-Palette erweitert.

**FlowZ als MCP-Server.** FlowZ bekommt ein zweites Gesicht: Neben dem Canvas als visuellem Interface exponiert ein eingebauter MCP-Server das Programm für KI-Agenten wie Claude Code oder Codex. Das ist ausdrücklich keine Automatisierung im Sinne von Kapitel 13 — es läuft weiterhin nichts ohne Menschen davor. Nur das Interface wechselt: Statt zu klicken, sagt man es. Eine Fernbedienung, kein Autopilot.

Das entfaltet sich auf zwei Ebenen. **Ebene eins — FlowZ bedienen:** Workflows — also benannte Gruppen auf dem Canvas (Kapitel 7) — werden als aufrufbare Werkzeuge verfügbar. "Nimm den Thumbnail-Workflow, hier ist die Artikel-URL, gib mir die fünf Varianten" — der Graph läuft durch, die Galerie füllt sich, die Ergebnisse kommen zurück. Jeder einmal sauber gebaute Graph wird damit automatisch zu einer Funktion, die jeder MCP-fähige Agent nutzen kann: visuell gebaut, konversationell genutzt. **Ebene zwei — FlowZ bauen lassen:** Der Agent kann auch Graphen konstruieren und verändern — Nodes anlegen, verkabeln, Prompts setzen. "Bau mir einen Workflow, der eine Webseite analysiert und daraus drei Bildvarianten macht" → der fertige Graph erscheint auf dem Canvas, wird geprüft und von Hand verfeinert. Hier verschmilzt der MCP-Server mit dem Node-Builder: Der Agent erweitert nicht nur die Node-Palette, sondern baut ganze Workflows — und alles, was er baut, ist sichtbarer Graph, keine Blackbox.

Zwei Schutzprinzipien gelten dabei ausnahmslos: **Teure Läufe bleiben bestätigungspflichtig** — stößt ein Agent per MCP eine kostspielige Generierung an (konfigurierbar, etwa ab einem Schwellwert), fragt FlowZ nach, ganz im Geist der Kosten-Transparenz. Und: **MCP ist ein zweites Interface, kein zweiter Wahrheitsspeicher** — alles, was über MCP passiert, ist danach vollständig im Canvas sichtbar: neue Galerie-Einträge, neue Nodes, Verlauf, Kosten. Nichts geschieht unsichtbar nebenher.

**Artboard-Workspace (Produktkern).** Design ist kein flaches Bild und kein übergroßer Node-Inhalt. FlowZ besitzt deshalb neben dem Flow-Canvas einen eigenständigen, Figma-artigen Artboard-Workspace: mehrere frei platzierte Artboards, echte Bild-, Text-, Form- und Gruppenelemente, Ebenen, Inspector, Auswahl, Varianten, History und deterministischen Export. Eine kompakte Artboard-Referenznode verbindet beide Systeme. Sie zeigt nur Vorschau, Status und relevante Ein-/Ausgänge; Ebenen und Typografie werden ausschließlich im Artboard-Workspace bearbeitet.

Ein Artboard kann Eingaben aus einem Flow revisionsgebunden referenzieren. Ändert sich ein vorgelagertes Ergebnis, wird kein bestehendes Design still überschrieben: Der Nutzer kann daraus eine neue Variante beziehungsweise ein neues Artboard neben den bisherigen Ständen erzeugen. Ein räumlicher Platzierungsalgorithmus verhindert Überlagerungen und erhält Vergleichbarkeit.

**Design-Agent (Produktkern).** Im Artboard-Workspace arbeitet ein providerneutraler Design-Agent mit OpenRouter oder dem lokalen Codex-App-Server. Er erhält nur den aktuellen Workspace, die Auswahl und explizit gebundene Assets, arbeitet mit begrenzten Design-Tools und liefert einen sichtbaren, revisionsgebundenen Vorschlag. Anwenden und Verwerfen sind bewusste Nutzeraktionen. Kostenpflichtige Bildgenerierung ist immer ein separater, erneut bestätigter fal.ai-Folge-Intent mit exaktem Request- und Preis-Snapshot. So bleibt der Agent ein kollaborativer Editor statt eines unsichtbaren zweiten Wahrheitsspeichers.

**Weitere Ausgabekanäle.** Das Ausgabe-Routing pro Node (heute: Bibliothek und Ordner-Export) wächst um direkte Ziele — Uploads an externe Dienste, Übergaben an andere Werkzeuge.

**Mehr Sprachen.** Deutsch zuerst, Englisch von Anfang an mitgedacht — und die Struktur offen für alles Weitere.

---

## 15. Technisches Fundament

Einige Entscheidungen sind so tragend, dass sie hier festgehalten gehören — nicht als Spec, sondern als Fundament, auf dem alles andere ruht.

**Tauri 2 als Programmhülle.** FlowZ ist eine native Desktop-App auf Basis von Tauri 2 — leichtgewichtig, schnell startend, mit kontrolliertem Zugriff auf die lokale Bibliothek, sichere Importe und bewusste Ordner-Exporte. Tauri statt Electron ist eine bewusste Wahl: kleinere Programme, weniger Ressourcenhunger und Rust als solides Rückgrat für Persistenz, Medienprüfung und Providergrenzen.

**React Flow als Canvas.** Der Node-Canvas basiert auf React Flow (xyflow) — der MIT-lizenzierten Standard-Library für node-basierte Editoren, mit der auch Werkzeuge wie Zapier, Stripe und Retool ihre Workflow-Oberflächen bauen. Sie liefert das Fundament fertig mit: Dragging, Zoomen, Pannen, Multi-Select, Minimap, und — entscheidend für das Typsystem — validierbare Verbindungen, sodass Kabel nur zwischen kompatiblen Sockets andocken können. Der wichtigste Grund aber ist ein anderer: **Jeder Node ist eine gewöhnliche React-Komponente.** Die Galerie im Bild-Node, die Kosten-Fußzeile, die aufgefächerten Listen-Ausgänge mit Mini-Previews — all das ist normale, frei gestaltbare UI, keine Verrenkung gegen die Library.

Dabei gilt eine Klarstellung: React Flow ist der Canvas, nicht die App. Es zeichnet Nodes und Kabel — die Ausführungs-Engine (Stale-Zustände, Reihenfolge, Parallelität), das Typ- und Listen-System, die Bibliothek mit Verlauf und Kosten sind eigene Substanz, die daneben entsteht.

**Performance als Grundregel, nicht als Nachrüstung.** FlowZ-Nodes tragen schwere Inhalte in sich — Bildergalerien, Video-Previews, lange Texte. Ein Canvas mit dutzenden Medien-Nodes darf trotzdem nie ruckeln. Deshalb gilt von Tag eins: **Gerendert wird nur, was sichtbar ist.** Nodes außerhalb des Viewports werden nicht gezeichnet (React Flow bringt das mit), Medien in Nodes laden als leichte Vorschauen und erst bei Bedarf in voller Auflösung, Galerien laden ihre Inhalte erst beim Öffnen. Diese Disziplin ist keine Optimierung für später — sie ist Architektur von Anfang an, weil ein nachträglich beschleunigter Canvas nie so gut wird wie ein von Grund auf sparsamer.

**Ein Node = ein Modul.** Die wichtigste Struktur-Entscheidung betrifft die Wartbarkeit: FlowZ startet vielleicht mit 15 Nodes und hat zwei Monate später 60 — und der sechzigste muss genauso sauber sein wie der erste. Deshalb ist jeder Node-Typ ein in sich geschlossenes Modul, das alles über sich selbst weiß: seine Metadaten (Name, Kategorie, Icon), seine Ein- und Ausgänge mit Typen, seine Darstellung (die React-Komponente) und seine Ausführungslogik (was passiert, wenn er läuft). Der Kern von FlowZ kennt keinen einzigen Node-Typ persönlich — er kennt nur eine **Registry**, in der sich Nodes anmelden. Ein neuer Node bedeutet: ein neues Modul schreiben, registrieren, fertig — keine Änderung an Engine, Canvas oder irgendeinem bestehenden Node. Diese Trennung ist zugleich die technische Voraussetzung für zwei Zukunftslinien aus Kapitel 14: Der Node-Builder kann nur dann per Agent neue Nodes erzeugen, wenn "ein Node" eine klar umrissene, eigenständige Einheit ist — und eine Open-Source-Community kann nur dann Nodes beisteuern, wenn sie dafür nicht das Innere des Programms verstehen muss.

**Schlüssel gehören in den Schlüsselbund.** Die API-Keys (OpenRouter, fal.ai) werden ausschließlich im macOS-Schlüsselbund abgelegt — niemals in Projektdateien, Konfigurationsdateien oder irgendetwas, das versehentlich geteilt, exportiert oder in ein Git-Repository eingecheckt werden könnte. Bei einem Open-Source-Projekt ist das nicht Kür, sondern Pflicht: Ein geteiltes Projekt darf per Konstruktion keinen Schlüssel enthalten können.

**Das Format trägt eine Versionsnummer.** Jedes gespeicherte Projekt — der Graph, seine Nodes, seine Einstellungen — trägt von der allerersten Version an eine Schema-Version. Ändert sich das Format später (und es wird sich ändern), werden alte Projekte automatisch migriert statt unlesbar. Das ist die Lebensversicherung eines Werkzeugs, in dem über Monate echte Arbeit steckt: Kein Update darf je ein Projekt zerstören.

---

## 16. Vertrag der ersten vollständigen Version

Die erste vollständige Produktfassung besitzt 29 module-owned Node-Arten ohne Facade- oder zweite Schattenregistry. Dazu gehören vier direkte Eingaben (Text, Bild, Video, Audio), zwei interne kuratierte Sammlungsquellen, zwei interne globale Asset-Referenzen, Text-, Bild- und Videogenerierung, Bildanalyse und Transkription, Upscaling, Bildtransformation, Transparenzschnitt, Hintergrundentfernung und Frame-Extraktion, Webseite und Recherche sowie Markenbriefing, Zielgruppenanalyse, Naming, Domainprüfung, Handle-Plan, Font-Pairing, Farbpalette, Logo und die kompakte Artboard-Referenz. Interne Module bleiben typisiert und ausführbar, auch wenn sie nicht als gewöhnliche Erstelloption erscheinen.

Die Programmoberfläche beginnt im Dokumentkatalog. Flow- und Artboard-Dokumente besitzen Covers, sichere Dokumentaktionen und interne Tabs. Gestenbewusstes Autosave, Projektkonflikte und Flush vor Wechsel oder Schließen gehören zum Datenvertrag. Der Flow-Canvas bleibt frei von dauerhaften Seitenleisten; Nodes entstehen am Arbeitsort über Kontext- und Kabelmenüs.

Alle kreativen Ergebnisse besitzen persistenten, paginierten Verlauf. Das aktive Resultat speist den skalaren Ausgang, während echte Geschwistervarianten beziehungsweise kuratierte Sammlungen dynamische Listenausgänge erzeugen. Aktivieren verändert kein strukturelles Undo. Medienkuration erzeugt immutable CAS-Referenzen statt Kopien. Direkte lokale Bilder liegen revisionsgebunden im Zielmodul; bewusster lokaler Override schlägt Kabel, ansonsten schlägt Kabel den lokalen Fallback.

Der Multi-Board-Artboard-Workspace, reale Fonts und Assets, revisionsgebundene Flow-Eingaben sowie der providerneutrale Design-Agent sind Bestandteil dieser Fassung. Der Agent darf nur Vorschläge erzeugen. Kostenpflichtige Bildgenerierung ist ein separater fal.ai-Paid-Intent mit sichtbarem exaktem Endpoint, Schema, gültiger Konfiguration und offizieller oder belastbarer empirischer Kostenschätzung. Erst die eigene Bestätigung darf den deterministischen, vorab gesnapshotteten Lauf starten; bezahlte Ergebnisse werden vor jeder Anwendung in CAS und als globale Asset-Version gesichert.

OpenRouter bleibt auf Text, textausgebende Bildanalyse und STT begrenzt. Sämtliche visuelle Generierung und freigegebenen Cloud-Bildwerkzeuge laufen über kuratierte fal.ai-Adapter mit privatem, automatisch begrenztem Referenzupload. Offizielle Schätzung, lokaler empirischer Erfahrungswert, tatsächliche Kosten und unbekannte Abrechnung bleiben getrennt.

Brand-Templates konfigurieren und verbinden diese Module zu sinnvollen Founder- und Content-Startpunkten; sie sind weder Beispielprojekte noch eine zweite Engine. Das finale App-Icon, reproduzierbare GitHub-CI, unsignierte Distributionshinweise und der integrierte Update-Pfad gehören zum Releasevertrag. Der erste Tag und öffentliche GitHub-Release v0.1.0 entstehen erst nach dem abgeschlossenen Endaudit und einer ausdrücklichen Terminal-Freigabe.


## 17. Grundhaltung

FlowZ entsteht aus einem konkreten eigenen Bedarf, nicht aus einer Marktlücken-Analyse — und genau das ist seine Stärke. Es wird für den täglichen eigenen Gebrauch gebaut, mit dem Qualitätsanspruch eines Produkts und der Freiheit eines Projekts ohne Vermarktungsdruck. Open Source, weil gute Werkzeuge geteilt gehören. Lokal, weil die eigene Arbeit auf dem eigenen Rechner zu Hause ist. Mit eigenem Schlüssel, weil zwischen Nutzer und Modell niemand mitverdienen muss.

Wenn diese Vision aufgeht, ist FlowZ das, was Blender für 3D ist: ein Werkzeug, das ernsthafte Arbeit und freies Experimentieren nicht gegeneinander ausspielt — sondern auf derselben dunklen Fläche nebeneinander leben lässt, verbunden durch ein Kabel.
