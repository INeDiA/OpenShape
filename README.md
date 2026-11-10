# OpenShape

Modellatore CAD parametrico open source, per il browser.
Gira nel browser; in futuro impacchettabile desktop con Tauri.

> OpenShape è scritto da zero a partire dal comportamento osservabile di un CAD.
> Nessun codice o algoritmo proviene da prodotti proprietari.

## Avvio

```bash
npm install
npm run dev      # http://localhost:5176
npm run build    # build di produzione in dist/
npm test         # test del solver e dei profili (vitest)
```

## Architettura

```
src/
  model/types.ts     Feature model (sketch, extrude, revolve, fillet, chamfer) + protocollo kernel
  model/doc.ts       Creazione/modifica/rimozione feature, documento demo
  kernel/worker.ts   Web Worker: carica OpenCascade WASM (replicad), valuta, esporta
  kernel/evaluate.ts Replay della history sul kernel, mesh per la viewport
  kernel/client.ts   Client del worker (coalesce delle valutazioni)
  viewport/          Three.js, Z-up, OrbitControls, hover facce via faceGroups
  ui/                Design History e pannello proprietà
```

Il documento è una lista ordinata di feature. Ogni modifica crea un nuovo documento
(undo/redo con ⌘Z / ⇧⌘Z) che il worker rivaluta da zero. Feature in errore vengono
segnalate nella history senza bloccare le altre.

| Componente | Libreria | Licenza |
|---|---|---|
| Kernel B-rep | OpenCascade via [replicad](https://replicad.xyz) | LGPL-2.1 (OCCT), MIT (replicad) |
| Viewport | three.js | MIT |
| UI | React | MIT |
| Solver vincoli 2D | [PlaneGCS](https://github.com/Salusoft89/planegcs) (da FreeCAD) | LGPL-2.0+ |

## Roadmap

1. ~~Viewport, history parametrica, extrude/revolve/booleane/fillet, export STEP/STL~~
2. ~~Sketcher 2D con vincoli (PlaneGCS)~~: linee, rettangoli, cerchi, archi a tre punti, 12 vincoli, quote, trascinamento. Mancano ellissi, spline, archi tangenti, sketch nella vista 3D
3. ~~Variabili ed espressioni~~ in parametri e quote (`width / 2`, `3cm`, `atan2(h, w)`)
4. ~~File `.openshape`~~ (JSON aperto, [specifica](docs/file-format.md)), autosave nel browser, export STL, 3MF, STEP, OBJ, PLY, glTF
5. ~~Naming topologico persistente~~ (`src/kernel/naming.ts`): fillet/chamfer su spigoli scelti, riferimenti a facce che sopravvivono alle modifiche a monte
6. ~~Selezione di facce, sketch su faccia, push/pull~~
7. ~~Shell, mirror, pattern lineare/circolare, import STEP/STL~~
8. Più corpi separati, loft/sweep, draft, misure
9. Disegni 2D, app desktop (Tauri)
