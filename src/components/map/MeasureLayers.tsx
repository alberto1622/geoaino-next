"use client";
import { Source, Layer } from "react-map-gl/maplibre";
import type { LngLat } from "@/lib/measure";
import { measureFeatureCollection, MEASURE_COLOR, type MeasureMode } from "@/lib/use-measure";

/** Dessin de la mesure dans une carte react-map-gl (à placer en dernier enfant : au-dessus de tout). */
export function MeasureLayers({ mode, pts }: { mode: MeasureMode; pts: LngLat[] }) {
  if (!mode || pts.length === 0) return null;
  return (
    <Source id="measure" type="geojson" data={measureFeatureCollection(mode, pts)}>
      <Layer id="measure-fill" type="fill" filter={["==", ["geometry-type"], "Polygon"]} paint={{ "fill-color": MEASURE_COLOR, "fill-opacity": 0.18 }} />
      <Layer id="measure-line" type="line" filter={["==", ["geometry-type"], "LineString"]} paint={{ "line-color": MEASURE_COLOR, "line-width": 2.5, "line-dasharray": [2, 1] }} />
      <Layer
        id="measure-pts"
        type="circle"
        filter={["==", ["geometry-type"], "Point"]}
        paint={{ "circle-radius": 4, "circle-color": "#ffffff", "circle-stroke-color": MEASURE_COLOR, "circle-stroke-width": 2 }}
      />
    </Source>
  );
}
