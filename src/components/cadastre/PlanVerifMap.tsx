"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  Marker,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import proj4 from "proj4";
import type { Borne, CrsSource } from "@/lib/cadastre/verif/types";

/**
 * Carte du module « Vérifier des bornes » : parcelle reconstruite, bornes
 * numérotées et longueur de chaque côté. Porté de cadex-next `VerifMap.tsx`.
 *
 * Composant Leaflet dédié (pas une extension des cartes MapLibre du module
 * cadastre) : pas de tuiles vectorielles, pas de sélection, pas de couches
 * administratives — juste un polygone libre + des marqueurs.
 */

proj4.defs(
  "EPSG:32628",
  "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs +type=crs",
);
proj4.defs(
  "EPSG:31028",
  "+proj=utm +zone=28 +a=6378249.2 +b=6356515 +towgs84=-83,37,124,0,0,0,0 +units=m +no_defs +type=crs",
);

export type PlanVerifMapProps = {
  /** Polygone reconstruit, en WGS84. `null` quand les coordonnées sont rejetées. */
  geometry: GeoJSON.Polygon | null;
  /** Bornes renumérotées, dans l'ordre du contour (coordonnées projetées). */
  bornes: Borne[];
  /** CRS des bornes, pour placer les pastilles. */
  crsSource: CrsSource;
  /** Index des bornes à mettre en évidence (anomalie survolée). */
  surlignees?: number[];
};

const CENTRE_SENEGAL: [number, number] = [14.5, -14.5];

function pastille(texte: string, actif: boolean): L.DivIcon {
  const fond = actif ? "#dc2626" : "#ffffff";
  const encre = actif ? "#ffffff" : "#111827";
  return L.divIcon({
    className: "",
    html:
      `<span style="display:flex;align-items:center;justify-content:center;` +
      `width:22px;height:22px;border-radius:11px;border:1.5px solid #111827;` +
      `background:${fond};color:${encre};font-size:10px;font-weight:700;` +
      `transform:translate(-50%,-50%);box-shadow:0 1px 3px rgba(0,0,0,.35)">${texte}</span>`,
    iconSize: [0, 0],
  });
}

/** Recadre sur la parcelle à chaque changement de contour. */
function Recadrage({
  signature,
  anneau,
}: {
  signature: string;
  anneau: number[][];
}) {
  const map = useMap();

  useEffect(() => {
    if (!anneau.length) return;
    const bounds = L.latLngBounds(
      anneau.map(([lon, lat]) => [lat, lon] as [number, number]),
    );
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 21 });
    // Dépend de la seule `signature` : un contour inchangé ne doit pas relancer
    // un recadrage, qui annulerait le zoom manuel de l'utilisateur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, map]);

  return null;
}

export default function PlanVerifMap({
  geometry,
  bornes,
  crsSource,
  surlignees = [],
}: PlanVerifMapProps) {
  /**
   * Position des bornes en WGS84, obtenue en reprojetant chaque borne
   * directement. On n'apparie PAS les bornes aux sommets de `geometry` : le
   * noyau peut en avoir inversé le sens de parcours pour respecter la
   * RFC 7946 sans toucher à `bornes`, ce qui décalerait les numéros sur une
   * parcelle saisie dans le sens horaire.
   */
  const points = useMemo(
    () =>
      bornes.map((b, index) => {
        const [lon, lat] = proj4(crsSource, "EPSG:4326", [b.x, b.y]) as [
          number,
          number,
        ];
        return { pt: b.pt, lat, lon, index };
      }),
    [bornes, crsSource],
  );

  const cotes = useMemo(() => {
    if (points.length < 2) return [];
    return points.map((p, i) => {
      const q = points[(i + 1) % points.length];
      const a = bornes[i];
      const b = bornes[(i + 1) % bornes.length];
      return {
        cle: `${p.pt}-${q.pt}`,
        lat: (p.lat + q.lat) / 2,
        lon: (p.lon + q.lon) / 2,
        longueur: Math.hypot(b.x - a.x, b.y - a.y),
      };
    });
  }, [points, bornes]);

  const anneau = geometry?.coordinates[0] ?? [];
  const signature = geometry ? JSON.stringify(anneau) : "";

  return (
    <div className="h-full w-full overflow-hidden rounded-md border">
      <MapContainer
        center={CENTRE_SENEGAL}
        zoom={7}
        maxZoom={22}
        scrollWheelZoom
        className="h-full w-full"
        style={{ background: "#e5e7eb" }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap"
          // maxNativeZoom reste à 19 (résolution réelle des tuiles OSM) ;
          // maxZoom au-delà (22) laisse Leaflet suréchantillonner les
          // dernières tuiles pour continuer à zoomer sur une petite parcelle
          // — cohérent avec le maxZoom:21 déjà utilisé par Recadrage.
          maxZoom={28}
          maxNativeZoom={19}
        />
        {geometry ? (
          <>
            <GeoJSON
              key={signature}
              data={geometry as unknown as GeoJSON.GeoJsonObject}
              style={{
                color: "#dc2626",
                weight: 2.5,
                fillColor: "#dc2626",
                fillOpacity: 0.12,
              }}
            />
            <Recadrage signature={signature} anneau={anneau} />
            {cotes.map((c) => (
              <Marker
                key={c.cle}
                position={[c.lat, c.lon]}
                icon={L.divIcon({ className: "", html: "", iconSize: [0, 0] })}
                interactive={false}
              >
                <Tooltip
                  permanent
                  direction="center"
                  className="verif-cote"
                  opacity={1}
                >
                  {c.longueur.toFixed(2)} m
                </Tooltip>
              </Marker>
            ))}
            {points.map((p) => (
              <Marker
                key={p.pt}
                position={[p.lat, p.lon]}
                icon={pastille(
                  p.pt.replace(/^B/, ""),
                  surlignees.includes(p.index),
                )}
                interactive={false}
                zIndexOffset={1000}
              />
            ))}
          </>
        ) : null}
      </MapContainer>
    </div>
  );
}
