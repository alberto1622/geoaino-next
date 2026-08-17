"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import {
  listCommunes2026WithGeom,
  listCommunes2013ByRegion,
  listRegions2026,
  listRegions2013,
} from "@/app/cadastre/_actions/communes";
import { listChangementMaps } from "@/app/cadastre/_actions/correspondance";
import { parcellesBySyscol, parcelleByCoords } from "@/app/cadastre/_actions/carte";
import { NicadDisplay } from "@/components/cadastre/NicadDisplay";
import { SENEGAL_BBOX } from "@/lib/senegal-bounds";

type Version = "2013" | "2026";

// Emprise du Sénégal pour le cadrage initial de la carte (format Leaflet : [lat, lon])
const SENEGAL_LEAFLET_BOUNDS: [[number, number], [number, number]] = [
  [SENEGAL_BBOX.minLat, SENEGAL_BBOX.minLon],
  [SENEGAL_BBOX.maxLat, SENEGAL_BBOX.maxLon],
];
type Commune = {
  id: number;
  syscolPadded: string;
  nomCommune: string;
  region?: string | null;
  departement?: string | null;
  arrondissement?: string | null;
  geojson?: string | null;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Parcelle = any;

// Couleurs distinctes par millésime Syscol
const VERSION_STYLE: Record<Version, { parcelle: string; boundary: string }> = {
  "2013": { parcelle: "#3b82f6", boundary: "#1d4ed8" },
  "2026": { parcelle: "#f59e0b", boundary: "#b45309" },
};

// Communes non sélectionnées : conservées en contexte, mais grisées
const OTHER_COMMUNE_COLOR = "#94a3b8";

// Code couleur par TYPE de changement Syscol 2013 → 2026 (cf. correspondances).
// "nouvelle" = commune 2026 sans antécédent 2013 (best-match) : nouvelle, renommée
// ou enfant non principal d'un découpage.
const TYPE_STYLE: Record<string, string> = {
  inchange: "#94a3b8",
  renomme: "#2563eb",
  rattachement_departement: "#e11d48",
  decoupe: "#f59e0b",
  fusion: "#9333ea",
  disparue: "#71717a",
  nouvelle: "#ec4899",
};

const TYPE_LABEL: Record<string, string> = {
  inchange: "Inchangé",
  renomme: "Renommé",
  rattachement_departement: "Chgt département",
  decoupe: "Découpé",
  fusion: "Fusionné",
  disparue: "Sans correspondance",
  nouvelle: "Nouvelle / issue d'un découpage",
};

// Types mis en avant (les différences) : opacité plus forte pour les distinguer
// du fond « inchangé ».
const TYPE_NOTABLE = new Set([
  "renomme",
  "rattachement_departement",
  "decoupe",
  "fusion",
  "disparue",
  "nouvelle",
]);

type ChangementInfo = {
  type: string | null;
  departement: string | null;
  departement2026: string | null;
  nomCommune2013: string;
  nomCommune2026: string | null;
  cibles2026: string | null;
  nbCibles2026: number;
  syscol2013: string;
  syscol2026: string | null;
};

// Couleur du liseré signalant une recodification Syscol (indépendante du
// type de changement — cf. § 35 CONCEPTS-TRAITEMENT-DXF.md : une commune
// classée "inchange" peut quand même avoir changé de code, ex. Golf Sud
// 01430111 → 01430121, invisible sans ce signal dédié).
const SYSCOL_CHANGE_OUTLINE_COLOR = "#3b82f6";

function syscolChanged(info: ChangementInfo | null): boolean {
  return !!info?.syscol2026 && info.syscol2026 !== info.syscol2013;
}

const selectCls =
  "h-9 w-full rounded-lg border border-border bg-background text-foreground px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>option]:bg-background [&>option]:text-foreground";
const optionCls = "bg-background text-foreground";

// Région présélectionnée à l'ouverture de la carte (valeur telle que stockée
// en base, ex. "DAKAR" — comparaison insensible à la casse à la résolution).
const DEFAULT_REGION = "DAKAR";

export default function CadastreMap() {
  const mapEl = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overviewRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LRef = useRef<any>(null);

  const [version, setVersion] = useState<Version>("2013");
  const [regions, setRegions] = useState<string[]>([]);
  // null = région par défaut pas encore résolue (en attente de la liste des régions)
  const [region, setRegion] = useState<string | null>(null);
  const [communes, setCommunes] = useState<Commune[]>([]);
  // Cartes type de changement (par syscol 2013 et 2026) — pour le code couleur
  const [parSyscol2013, setParSyscol2013] = useState<Record<string, ChangementInfo>>({});
  const [parSyscol2026, setParSyscol2026] = useState<Record<string, ChangementInfo>>({});
  const [syscol, setSyscol] = useState("");
  const [selected, setSelected] = useState<Parcelle | null>(null);
  const [loading, setLoading] = useState(false);

  // Initialiser la carte (Leaflet impératif, import dynamique)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !mapEl.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(mapEl.current).fitBounds(SENEGAL_LEAFLET_BOUNDS);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 19,
      }).addTo(map);
      mapRef.current = map;

      // Identification au clic
      map.on("click", async (e: { latlng: { lat: number; lng: number } }) => {
        const p = await parcelleByCoords({ lat: e.latlng.lat, lng: e.latlng.lng, radiusKm: 0.3 });
        if (p) setSelected(p);
      });
    })();
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Changer de millésime : réinitialiser la sélection et la couche affichée
  // (la région par défaut sera re-résolue par l'effet ci-dessous)
  function changeVersion(v: Version) {
    if (v === version) return;
    setSyscol("");
    setSelected(null);
    if (layerRef.current && mapRef.current) {
      mapRef.current.removeLayer(layerRef.current);
      layerRef.current = null;
    }
    setVersion(v);
  }

  // Changer de région : réinitialiser la sélection de commune/parcelle
  function changeRegion(r: string) {
    if (r === region) return;
    setSyscol("");
    setSelected(null);
    if (layerRef.current && mapRef.current) {
      mapRef.current.removeLayer(layerRef.current);
      layerRef.current = null;
    }
    setRegion(r);
  }

  // Charger une seule fois les cartes type de changement (2013 & 2026)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const maps = await listChangementMaps();
      if (cancelled) return;
      setParSyscol2013(maps.parSyscol2013);
      setParSyscol2026(maps.parSyscol2026);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Charger la liste des régions du millésime sélectionné et présélectionner
  // Dakar par défaut (comparaison insensible à la casse — la donnée en base
  // est stockée en majuscules).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRegion(null);
      const list = await (version === "2013" ? listRegions2013() : listRegions2026());
      if (cancelled) return;
      setRegions(list);
      const dakar = list.find((r) => r.toUpperCase() === DEFAULT_REGION);
      setRegion(dakar ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Charger la liste des communes selon le millésime et la région sélectionnés
  // (région "" = toutes). Attend la résolution de la région par défaut (Dakar).
  useEffect(() => {
    if (region === null) return;
    let cancelled = false;
    (async () => {
      const list = (await (version === "2013"
        ? listCommunes2013ByRegion({ region: region || undefined })
        : listCommunes2026WithGeom({ region: region || undefined }))) as Commune[];
      if (!cancelled) setCommunes(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [version, region]);

  // Type de changement d'une commune selon le millésime affiché.
  function changeInfoOf(syscolPadded: string): ChangementInfo | null {
    return version === "2013"
      ? parSyscol2013[syscolPadded] ?? null
      : parSyscol2026[syscolPadded] ?? null;
  }
  function typeOf(syscolPadded: string): string {
    const info = changeInfoOf(syscolPadded);
    if (version === "2026") return info?.type ? info.type : "nouvelle";
    return info?.type ?? "inchange";
  }

  // Vue d'ensemble : afficher TOUTES les communes du millésime en permanence.
  // La commune sélectionnée est mise en évidence (couleur du millésime),
  // les autres sont grisées pour rester en contexte. Cliquer zoome dessus.
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    if (overviewRef.current) {
      map.removeLayer(overviewRef.current);
      overviewRef.current = null;
    }
    if (communes.length === 0) return;
    const group = L.featureGroup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let selectedLayer: any = null;
    for (const c of communes) {
      if (!c.geojson) continue;
      const isSelected = !!syscol && c.syscolPadded === syscol;
      const type = typeOf(c.syscolPadded);
      const notable = TYPE_NOTABLE.has(type);
      const color = TYPE_STYLE[type] ?? OTHER_COMMUNE_COLOR;
      const info = changeInfoOf(c.syscolPadded);
      const scChanged = syscolChanged(info);
      try {
        const geom = JSON.parse(c.geojson);
        const gj = L.geoJSON(geom, {
          style: isSelected
            ? { color, weight: 3, fillColor: color, fillOpacity: 0.55 }
            : {
                color,
                weight: notable ? 1.5 : 0.8,
                fillColor: color,
                fillOpacity: notable ? 0.45 : 0.12,
              },
        });
        const deptLine =
          info && info.departement2026 && info.departement2026 !== info.departement
            ? `<br/>${info.departement ?? "?"} → <b>${info.departement2026}</b>`
            : "";
        const syscolLine = scChanged
          ? `<br/>Syscol changé : ${info!.syscol2013} → <b>${info!.syscol2026}</b>`
          : "";
        gj.bindTooltip(
          `<b>${c.nomCommune}</b> (${c.syscolPadded})<br/>${TYPE_LABEL[type] ?? type}` + deptLine + syscolLine,
          { sticky: true },
        );
        // Sélectionne la commune sans déclencher l'identification au clic (map click)
        gj.on("click", (e: { originalEvent?: Event }) => {
          L.DomEvent.stopPropagation(e);
          setSyscol(c.syscolPadded);
        });
        gj.addTo(group);
        if (isSelected) selectedLayer = gj;

        // Recodification Syscol : liseré pointillé bleu par-dessus, INDÉPENDANT
        // de la couleur de type — visible même sur une commune "inchangée"
        // (grise, peu opaque) où le changement serait sinon invisible.
        if (scChanged) {
          try {
            L.geoJSON(geom, {
              style: {
                color: SYSCOL_CHANGE_OUTLINE_COLOR,
                weight: 2,
                dashArray: "5 4",
                fill: false,
                interactive: false,
              },
            }).addTo(group);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
    group.addTo(map);
    overviewRef.current = group;
    if (selectedLayer) {
      try {
        selectedLayer.bringToFront();
      } catch {
        /* ignore */
      }
    }
    // Cadrer : sur la commune sélectionnée si présente, sinon sur tout le millésime
    try {
      const target = selectedLayer ?? group;
      const b = target.getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [20, 20] });
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communes, syscol, version, parSyscol2013, parSyscol2026]);

  // Charger les parcelles (et la limite de commune pour le millésime 2013)
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    // Retirer la couche de parcelles précédente à chaque changement
    if (layerRef.current) {
      map.removeLayer(layerRef.current);
      layerRef.current = null;
    }
    if (!syscol) return;
    const style = VERSION_STYLE[version];
    (async () => {
      setLoading(true);
      const parcelles = (await parcellesBySyscol({ syscol, limit: 5000, version })) as Parcelle[];
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
      const group = L.featureGroup();

      for (const p of parcelles) {
        if (!p.geojson) continue;
        try {
          const geom = JSON.parse(p.geojson);
          const gj = L.geoJSON(geom, {
            style: { color: style.parcelle, weight: 1, fillOpacity: 0.15 },
          });
          gj.on("click", (e: { originalEvent?: Event }) => {
            L.DomEvent.stopPropagation(e);
            setSelected(p);
          });
          if (p.nicad) gj.bindTooltip(p.nicad, { sticky: true, className: "font-mono" });
          gj.addTo(group);
        } catch {
          /* ignore */
        }
      }
      group.addTo(map);
      layerRef.current = group;
      try {
        const b = group.getBounds();
        if (b.isValid()) map.fitBounds(b, { padding: [20, 20] });
      } catch {
        /* ignore */
      }
      setLoading(false);
    })();
  }, [syscol, version, communes]);

  const selectedCommune = syscol ? communes.find((c) => c.syscolPadded === syscol) ?? null : null;
  const selectedInfo = syscol ? changeInfoOf(syscol) : null;
  const selectedType = syscol ? typeOf(syscol) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        <div className="inline-flex rounded-lg border border-border p-0.5 text-sm">
          {(["2013", "2026"] as Version[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => changeVersion(v)}
              className={`cursor-pointer flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors ${
                version === v
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ background: VERSION_STYLE[v].parcelle }}
              />
              Syscol {v}
            </button>
          ))}
        </div>
        <select
          className={selectCls}
          value={region ?? ""}
          onChange={(e) => changeRegion(e.target.value)}
          aria-label="Choisir une région"
        >
          <option className={optionCls} value="">
            Toutes les régions
          </option>
          {regions.map((r) => (
            <option className={optionCls} key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select className={selectCls} value={syscol} onChange={(e) => setSyscol(e.target.value)} aria-label="Choisir une commune">
          <option className={optionCls} value="">
            Toutes les communes ({region || "toutes régions"}, {version})
          </option>
          {communes.map((c) => (
            <option className={optionCls} key={c.id} value={c.syscolPadded}>
              {c.nomCommune} ({c.syscolPadded})
            </option>
          ))}
        </select>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs">
          <span className="font-medium text-muted-foreground">Changement 2013→2026 :</span>
          {(version === "2013"
            ? ["inchange", "renomme", "rattachement_departement", "decoupe", "fusion", "disparue"]
            : ["renomme", "rattachement_departement", "decoupe", "fusion", "nouvelle"]
          ).map((t) => (
            <span key={t} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: TYPE_STYLE[t] }} />
              {TYPE_LABEL[t]}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm border-2 border-dashed"
              style={{ borderColor: SYSCOL_CHANGE_OUTLINE_COLOR }}
            />
            Syscol changé (même si « Inchangé »)
          </span>
        </div>
        <div className="relative">
          <div ref={mapEl} className="h-[600px] w-full rounded-xl border border-border/60" />
          {loading && (
            <div className="absolute right-3 top-3 rounded-lg bg-background/90 px-3 py-1.5 text-xs shadow">
              Chargement des parcelles…
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4">
      <div className="rounded-xl border border-border/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Commune sélectionnée</h3>
          {selectedCommune && (
            <button
              type="button"
              onClick={() => setSyscol("")}
              className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
            >
              Réinitialiser
            </button>
          )}
        </div>
        {selectedCommune ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span
                className="h-3 w-3 rounded-sm"
                style={{ background: VERSION_STYLE[version].parcelle }}
              />
              <span className="font-medium">{selectedCommune.nomCommune}</span>
            </div>
            <div className="grid grid-cols-2 gap-1 text-xs">
              <span className="text-muted-foreground">Syscol {version}</span>
              <span className="font-mono">{selectedCommune.syscolPadded}</span>
              <span className="text-muted-foreground">Région</span>
              <span>{selectedCommune.region ?? "—"}</span>
              <span className="text-muted-foreground">Département</span>
              <span>{selectedCommune.departement ?? "—"}</span>
              <span className="text-muted-foreground">Arrondissement</span>
              <span>{selectedCommune.arrondissement ?? "—"}</span>
            </div>
            {selectedType && (
              <div className="space-y-1.5 border-t border-border/50 pt-2">
                <div className="flex items-center gap-2">
                  <span
                    className="h-3 w-3 rounded-sm"
                    style={{ background: TYPE_STYLE[selectedType] ?? OTHER_COMMUNE_COLOR }}
                  />
                  <span className="text-xs font-medium">
                    {TYPE_LABEL[selectedType] ?? selectedType}
                  </span>
                </div>
                {selectedInfo?.departement2026 &&
                  selectedInfo.departement2026 !== selectedInfo.departement && (
                    <div className="text-xs text-muted-foreground">
                      Département : {selectedInfo.departement ?? "?"} →{" "}
                      <span className="font-medium text-foreground">
                        {selectedInfo.departement2026}
                      </span>
                    </div>
                  )}
                {syscolChanged(selectedInfo) && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className="h-2.5 w-2.5 rounded-sm border-2 border-dashed"
                      style={{ borderColor: SYSCOL_CHANGE_OUTLINE_COLOR }}
                    />
                    Syscol changé : {selectedInfo!.syscol2013} →{" "}
                    <span className="font-medium text-foreground">
                      {selectedInfo!.syscol2026}
                    </span>
                  </div>
                )}
                {selectedType === "decoupe" && selectedInfo?.cibles2026 && (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {selectedInfo.nbCibles2026} communes 2026 :
                    </span>
                    <br />
                    {selectedInfo.cibles2026}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Choisissez une commune dans la liste ou cliquez-la sur la carte.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-border/60 p-4">
        <h3 className="mb-3 text-sm font-semibold">Parcelle sélectionnée</h3>
        {selected ? (
          <div className="space-y-2 text-sm">
            <NicadDisplay nicad={selected.nicad} size="lg" />
            <div className="grid grid-cols-2 gap-1 text-xs">
              <span className="text-muted-foreground">Commune</span>
              <span>{selected.nomCommune ?? "—"}</span>
              <span className="text-muted-foreground">Section</span>
              <span>{selected.numSection ?? "—"}</span>
              <span className="text-muted-foreground">Parcelle</span>
              <span>{selected.numParcelle ?? "—"}</span>
              <span className="text-muted-foreground">Superficie</span>
              <span>{selected.superficie ?? "—"}</span>
              <span className="text-muted-foreground">Quartier</span>
              <span>{selected.quartier ?? "—"}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Cliquez sur une parcelle ou sur la carte pour l&apos;identifier.
          </p>
        )}
      </div>
      </div>
    </div>
  );
}
