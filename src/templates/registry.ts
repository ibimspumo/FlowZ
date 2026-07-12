import type { CanvasTemplate } from './types';

const base = { schemaVersion: 1 as const, version: 1, groups: [] as CanvasTemplate['groups'] };

export const canvasTemplates: readonly CanvasTemplate[] = [
  {
    ...base, id: 'brand-foundry', name: 'Marke von Grund auf', category: 'Marke', paidNodeCount: 5,
    summary: 'Eine vollständige Markenbasis von Briefing und Naming bis zum transparenten Logo und editierbaren Artboard.',
    firstRun: 'Fülle zuerst das Markenbriefing aus und starte danach bewusst die Zielgruppenanalyse. Alle weiteren Provider-Schritte bleiben veraltet, bis du sie einzeln ausführst.',
    hints: ['Domain- und Handle-Ergebnisse sind Momentaufnahmen, keine Reservierungen.', 'Font-Pairing, Palette und Logo sind kuratierbare Provider-Schritte; Einfügen selbst kostet nichts.', 'Das Logo wird lokal auf echte Transparenzgrenzen beschnitten, bevor es in das Artboard geht.'],
    nodes: [
      { id:'brief',kind:'brandBrief',x:0,y:100,label:'01 · Markenbriefing' },
      { id:'audience',kind:'audienceAnalysis',x:380,y:0,label:'02 · Zielgruppe' },
      { id:'names',kind:'brandNames',x:760,y:0,label:'03 · Namensideen',config:{candidateCount:10} },
      { id:'domains',kind:'domainCheck',x:1140,y:0,label:'04 · Domains' },
      { id:'handles',kind:'handlePlan',x:1140,y:560,label:'05 · Social Handles' },
      { id:'fonts',kind:'fontPairing',x:380,y:620,label:'06 · Font-Pairing' },
      { id:'palette',kind:'colorPalette',x:760,y:620,label:'07 · Farbpalette' },
      { id:'logo',kind:'logoDesign',x:1520,y:0,label:'08 · Transparentes Logo',config:{model:'fal-ai/gpt-image-1.5',background:'transparent',outputFormat:'png',variants:2} },
      { id:'trim',kind:'imageTrimTransparent',x:1900,y:0,label:'09 · Transparenz beschneiden' },
      { id:'artboard',kind:'artboard',x:2280,y:0,label:'10 · Marken-Artboard' },
    ],
    edges: [
      {source:'brief',sourcePort:'brief',target:'audience',targetPort:'brief'}, {source:'brief',sourcePort:'brief',target:'names',targetPort:'brief'},
      {source:'audience',sourcePort:'audience',target:'names',targetPort:'audience'}, {source:'names',sourcePort:'names',target:'domains',targetPort:'names'},
      {source:'names',sourcePort:'names',target:'handles',targetPort:'names'}, {source:'brief',sourcePort:'brief',target:'fonts',targetPort:'brief'},
      {source:'audience',sourcePort:'audience',target:'fonts',targetPort:'audience'}, {source:'brief',sourcePort:'brief',target:'palette',targetPort:'brief'},
      {source:'audience',sourcePort:'audience',target:'palette',targetPort:'audience'}, {source:'brief',sourcePort:'brief',target:'logo',targetPort:'brief'},
      {source:'audience',sourcePort:'audience',target:'logo',targetPort:'audience'}, {source:'palette',sourcePort:'palette',target:'logo',targetPort:'palette'},
      {source:'logo',sourcePort:'image',target:'trim',targetPort:'image'}, {source:'palette',sourcePort:'palette',target:'artboard',targetPort:'palette'},
      {source:'fonts',sourcePort:'pairing',target:'artboard',targetPort:'fonts'}, {source:'trim',sourcePort:'image',target:'artboard',targetPort:'images'},
    ],
    groups: [{id:'brand',name:'Markenfundament',nodeIds:['brief','audience','names','domains','handles','fonts','palette','logo','trim','artboard'],color:'#ec4899',description:'Von links nach rechts arbeiten, Varianten kuratieren und Verfügbarkeit vor einer Entscheidung erneut prüfen.'}],
  },
  {
    ...base, id:'transparent-logo-kit',name:'Transparentes Logo-Kit',category:'Marke',paidNodeCount:3,
    summary:'Transparenzfähiges Logo erzeugen, Alpha lokal prüfen und nur bei Bedarf Bria oder Upscaling verwenden.',
    firstRun:'Briefing ausfüllen und ausschließlich das Logo starten. Prüfe danach im lokalen Transparenzbeschnitt das Alpha-Ergebnis, bevor du Bria oder Upscaling bewusst ausführst.',
    hints:['Bria ist ein optionaler Cloud-Fallback und liegt auf einem eigenen Zweig.', 'Der lokale Transparenzbeschnitt diagnostiziert fehlendes oder vollständig deckendes Alpha ohne Providerkosten.', 'Direktes, hochskaliertes und mit Bria korrigiertes Ergebnis bleiben getrennt im Artboard wählbar.'],
    nodes:[
      {id:'brief',kind:'brandBrief',x:0,y:80,label:'Logo-Briefing'},
      {id:'logo',kind:'logoDesign',x:380,y:40,label:'Logo · echtes Alpha',config:{model:'fal-ai/gpt-image-1.5',background:'transparent',outputFormat:'png',variants:2}},
      {id:'diagnose',kind:'imageTrimTransparent',x:760,y:40,label:'Alpha prüfen & Rand beschneiden'},
      {id:'remove',kind:'backgroundRemoval',x:760,y:640,label:'Optional · Bria-Fallback'},
      {id:'upscale',kind:'imageUpscale',x:1140,y:40,label:'Optional · hochskalieren',config:{model:'fal-ai/seedvr/upscale/image',factor:2,outputFormat:'png'}},
      {id:'trimCloud',kind:'imageTrimTransparent',x:1140,y:760,label:'Bria-Ergebnis beschneiden'},
      {id:'artboard',kind:'artboard',x:1520,y:40,label:'Logo-Artboard'},
    ],
    edges:[
      {source:'brief',sourcePort:'brief',target:'logo',targetPort:'brief'}, {source:'logo',sourcePort:'image',target:'diagnose',targetPort:'image'},
      {source:'logo',sourcePort:'image',target:'remove',targetPort:'image'}, {source:'diagnose',sourcePort:'image',target:'upscale',targetPort:'image'},
      {source:'remove',sourcePort:'image',target:'trimCloud',targetPort:'image'}, {source:'diagnose',sourcePort:'image',target:'artboard',targetPort:'images',order:0},
      {source:'upscale',sourcePort:'image',target:'artboard',targetPort:'images',order:1}, {source:'trimCloud',sourcePort:'image',target:'artboard',targetPort:'images',order:2},
    ], groups:[{id:'logo-flow',name:'Lokaler Logo-Hauptweg',nodeIds:['brief','logo','diagnose','artboard'],color:'#f97316',description:'Logo erzeugen und Alpha lokal prüfen. Die ungruppierten Cloud-Zweige nur einzeln bei erkennbarem Bedarf starten.'}],
  },
  {
    ...base,id:'social-artboard',name:'Social Post & Artboard',category:'Content',paidNodeCount:4,
    summary:'Briefing, Zielgruppe, Markenfarben, Typografie und Key Visual in einem editierbaren Social-Artboard zusammenführen.',
    firstRun:'Markenbriefing ausfüllen und die Zielgruppenanalyse bewusst starten. Palette, Font-Pairing und Key Visual anschließend einzeln kuratieren; das Artboard selbst verursacht keinen Providerlauf.',
    hints:['Das Artboard erhält echte Palette-, FontPairing- und Bildartefakte.', 'Der Typografie-Stilhinweis ergänzt den Bildprompt nur als stilistische Annäherung.', 'Text, Logo und Layout werden anschließend direkt im verknüpften Artboard bearbeitet.'],
    nodes:[
      {id:'brief',kind:'brandBrief',x:0,y:120,label:'Marke & Botschaft'},
      {id:'audience',kind:'audienceAnalysis',x:380,y:0,label:'Zielgruppe'},
      {id:'imagePrompt',kind:'textInput',x:380,y:600,label:'Inhaltsrichtung',config:{text:'Ein markantes Social-Media-Key-Visual passend zur Marke, ohne Text im Bild.'}},
      {id:'palette',kind:'colorPalette',x:760,y:0,label:'Markenpalette'}, {id:'fonts',kind:'fontPairing',x:760,y:600,label:'Markentypografie'},
      {id:'image',kind:'imageGeneration',x:1140,y:600,label:'Key Visual',config:{model:'google/nano-banana-2-lite',aspectRatio:'1:1',resolution:'1K',variants:4}},
      {id:'artboard',kind:'artboard',x:1520,y:0,label:'Social Artboard',config:{}},
    ],
    edges:[
      {source:'brief',sourcePort:'brief',target:'audience',targetPort:'brief'}, {source:'brief',sourcePort:'brief',target:'palette',targetPort:'brief'},
      {source:'audience',sourcePort:'audience',target:'palette',targetPort:'audience'}, {source:'brief',sourcePort:'brief',target:'fonts',targetPort:'brief'},
      {source:'audience',sourcePort:'audience',target:'fonts',targetPort:'audience'}, {source:'imagePrompt',sourcePort:'text',target:'image',targetPort:'prompt'},
      {source:'fonts',sourcePort:'styleHint',target:'image',targetPort:'prompt'}, {source:'palette',sourcePort:'palette',target:'artboard',targetPort:'palette'},
      {source:'fonts',sourcePort:'pairing',target:'artboard',targetPort:'fonts'}, {source:'image',sourcePort:'image',target:'artboard',targetPort:'images'},
    ], groups:[{id:'social',name:'Social Post',nodeIds:['brief','audience','imagePrompt','palette','fonts','image','artboard'],color:'#8b5cf6',description:'Markenartefakte zuerst kuratieren, danach Key Visual und Artboard finalisieren.'}],
  },
  {
    ...base,id:'thumbnail-lab',name:'Thumbnail-Labor',category:'Content',paidNodeCount:5,
    summary:'Recherche und Markenstil in vier Bildvarianten übersetzen, kuratieren und in einem editierbaren Thumbnail-Artboard zusammensetzen.',
    firstRun:'Fülle bei Bedarf das Markenbriefing aus. Starte Recherche, Text, Markenstil und Bilder bewusst einzeln; das Artboard selbst verursacht keinen Providerlauf.',
    hints:['Der Standard-Endpoint unterstützt maximal vier Varianten pro Lauf.', 'Font-Pairing und Palette sind optionale, einzeln gestartete Markenbausteine.', 'Gewünschte Ergebnisse in der Galerie auswählen und im Artboard weiterbearbeiten.'],
    nodes:[
      {id:'research',kind:'research',x:0,y:80,label:'Thema recherchieren',config:{query:'Aktuelle visuelle Muster und starke Thumbnail-Ideen zum Thema',resultCount:5}},
      {id:'prompts',kind:'textGeneration',x:380,y:80,label:'Thumbnail-Art-Direction',config:{prompt:'Verdichte die Recherche zu genau einem direkt nutzbaren Thumbnail-Prompt. Keine Einleitung, kein Text im Bild.',outputMode:'single',variantCount:1}},
      {id:'images',kind:'imageGeneration',x:780,y:80,label:'4 Bildvarianten',config:{model:'google/nano-banana-2-lite',aspectRatio:'16:9',resolution:'1K',variants:4,listProcessingMode:'aggregate'}},
      {id:'brief',kind:'brandBrief',x:0,y:860,label:'Optional · Markenstil'},
      {id:'fonts',kind:'fontPairing',x:380,y:860,label:'Thumbnail-Typografie'},
      {id:'palette',kind:'colorPalette',x:780,y:860,label:'Thumbnail-Palette'},
      {id:'artboard',kind:'artboard',x:1180,y:80,label:'Thumbnail-Artboard'},
    ],
    edges:[
      {source:'research',sourcePort:'text',target:'prompts',targetPort:'prompt'}, {source:'prompts',sourcePort:'text',target:'images',targetPort:'prompt'},
      {source:'brief',sourcePort:'brief',target:'fonts',targetPort:'brief'}, {source:'brief',sourcePort:'brief',target:'palette',targetPort:'brief'},
      {source:'fonts',sourcePort:'pairing',target:'artboard',targetPort:'fonts'}, {source:'palette',sourcePort:'palette',target:'artboard',targetPort:'palette'},
      {source:'images',sourcePort:'image',target:'artboard',targetPort:'images'},
    ], groups:[{id:'thumbs',name:'Thumbnail-Labor',nodeIds:['research','prompts','images','brief','fonts','palette','artboard'],color:'#eab308',description:'Varianten und optionale Markenbausteine einzeln kuratieren; das finale Layout direkt im Artboard bearbeiten.'}],
  },
  {
    ...base,id:'video-chain',name:'Verkettete Videosequenz',category:'Video',paidNodeCount:2,
    summary:'Zwei Clips über den echten Endframe des ersten Clips visuell nahtlos verketten.',
    firstRun:'Generiere zunächst nur Clip 1. Kuratiere ihn vollständig, bevor du Clip 2 bewusst mit seinem Endframe startest.',
    hints:['Das zweite Video übernimmt den extrahierten Endframe als Startbild.', 'Länge, Auflösung und Ton richten sich nach dem gewählten Endpoint.'],
    nodes:[
      {id:'prompt1',kind:'textInput',x:0,y:0,label:'Szene 1',config:{text:'Eine ruhige Kamerafahrt eröffnet die Szene.'}},
      {id:'video1',kind:'videoGeneration',x:380,y:80,label:'Clip 1 · Text zu Video',config:{model:'bytedance/seedance-2.0/fast/text-to-video'}},
      {id:'prompt2',kind:'textInput',x:780,y:0,label:'Szene 2',config:{text:'Die Bewegung wird ohne sichtbaren Schnitt fortgesetzt.'}},
      {id:'video2',kind:'videoGeneration',x:780,y:560,label:'Clip 2 · Endframe fortsetzen',config:{model:'bytedance/seedance-2.0/fast/image-to-video'}},
    ],
    edges:[
      {source:'prompt1',sourcePort:'text',target:'video1',targetPort:'prompt'},
      {source:'video1',sourcePort:'endFrame',target:'video2',targetPort:'startFrame'}, {source:'prompt2',sourcePort:'text',target:'video2',targetPort:'prompt'},
    ], groups:[{id:'video',name:'Nahtlose Videokette',nodeIds:['prompt1','video1','prompt2','video2'],color:'#06b6d4',description:'Den ersten Clip finalisieren, bevor der zweite über dessen Endframe startet.'}],
  },
  {
    ...base,id:'research-hooks',name:'Recherche → 8 Hooks → Bewertung',category:'Recherche',paidNodeCount:3,
    summary:'Quellen sammeln, acht Hooks erzeugen und in einer zweiten KI-Stufe nachvollziehbar bewerten.',
    firstRun:'Starte die Recherche, prüfe die Quellen und führe danach Hook-Generierung und Bewertung jeweils bewusst aus.',
    hints:['Recherche enthält Quellen; die Bewertung bleibt eine Modell-Einschätzung.', 'Die acht Hooks entsprechen dem geprüften Variantenlimit und werden gemeinsam an die Bewertung übergeben.'],
    nodes:[
      {id:'research',kind:'research',x:0,y:80,label:'Quellen recherchieren',config:{query:'Recherchiere belastbare Fakten, Zielgruppenfragen und aktuelle Perspektiven zum Thema.',resultCount:8}},
      {id:'hooks',kind:'textGeneration',x:390,y:80,label:'8 Hooks',config:{prompt:'Erzeuge exakt acht eigenständige Hooks. Jeder Hook muss ohne Einleitung direkt nutzbar sein.',variantCount:8,outputMode:'variants'}},
      {id:'score',kind:'textGeneration',x:790,y:80,label:'Hooks bewerten',config:{prompt:'Bewerte jeden Hook nach Klarheit, Relevanz und Neugier (je 1–10). Gib eine kompakte Rangliste mit kurzer Begründung aus.',listProcessingMode:'aggregate'}},
    ],
    edges:[
      {source:'research',sourcePort:'text',target:'hooks',targetPort:'prompt'}, {source:'hooks',sourcePort:'texts',target:'score',targetPort:'textLists'},
    ], groups:[{id:'hooks-flow',name:'Hook-Recherche',nodeIds:['research','hooks','score'],color:'#3b82f6',description:'Quellen zuerst prüfen; anschließend Hooks erzeugen und als Batch bewerten.'}],
  },
  {
    ...base,id:'image-transform',name:'Bild passend machen',category:'Werkzeug',paidNodeCount:0,
    summary:'Ein Bild lokal und kostenlos zuschneiden oder auf ein passendes Format skalieren.',
    firstRun:'Wähle ein Bild aus und führe anschließend ausschließlich die lokale Transformation aus; es entstehen keine Providerkosten.',
    hints:['Die Transformation läuft lokal und verursacht keine Providerkosten.', 'Standardmäßig wird nicht über die Originalgröße hochskaliert.'],
    nodes:[
      {id:'input',kind:'imageInput',x:0,y:60,label:'Originalbild'},
      {id:'transform',kind:'imageTransform',x:380,y:60,label:'Zuschneiden & skalieren',config:{transformMode:'fit',transformAspect:'1:1',targetWidth:1080,targetHeight:1080,noUpscale:true}},
    ], edges:[{source:'input',sourcePort:'image',target:'transform',targetPort:'image'}],
    groups:[{id:'transform-flow',name:'Lokale Bildanpassung',nodeIds:['input','transform'],color:'#14b8a6',description:'Kostenlos lokal bearbeiten und über die Ergebnisaktion sichern.'}],
  },
];

export function templateById(id: string) { return canvasTemplates.find((template) => template.id === id); }
