import { NextResponse } from "next/server";

// Simplified Senegal regions GeoJSON (bounding boxes for 14 regions)
const SENEGAL_REGIONS = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "Dakar", code: "DK" }, geometry: { type: "Polygon", coordinates: [[[-17.52, 14.63], [-17.52, 14.83], [-17.15, 14.83], [-17.15, 14.63], [-17.52, 14.63]]] } },
    { type: "Feature", properties: { name: "Thiès", code: "TH" }, geometry: { type: "Polygon", coordinates: [[[-17.40, 14.60], [-17.40, 15.10], [-16.30, 15.10], [-16.30, 14.60], [-17.40, 14.60]]] } },
    { type: "Feature", properties: { name: "Diourbel", code: "DB" }, geometry: { type: "Polygon", coordinates: [[[-16.60, 14.50], [-16.60, 15.00], [-15.50, 15.00], [-15.50, 14.50], [-16.60, 14.50]]] } },
    { type: "Feature", properties: { name: "Fatick", code: "FK" }, geometry: { type: "Polygon", coordinates: [[[-16.80, 13.80], [-16.80, 14.60], [-15.70, 14.60], [-15.70, 13.80], [-16.80, 13.80]]] } },
    { type: "Feature", properties: { name: "Kaolack", code: "KL" }, geometry: { type: "Polygon", coordinates: [[[-16.40, 13.60], [-16.40, 14.40], [-15.00, 14.40], [-15.00, 13.60], [-16.40, 13.60]]] } },
    { type: "Feature", properties: { name: "Kaffrine", code: "KF" }, geometry: { type: "Polygon", coordinates: [[[-15.80, 13.50], [-15.80, 14.30], [-14.20, 14.30], [-14.20, 13.50], [-15.80, 13.50]]] } },
    { type: "Feature", properties: { name: "Tambacounda", code: "TC" }, geometry: { type: "Polygon", coordinates: [[[-15.00, 12.00], [-15.00, 14.00], [-11.50, 14.00], [-11.50, 12.00], [-15.00, 12.00]]] } },
    { type: "Feature", properties: { name: "Kolda", code: "KD" }, geometry: { type: "Polygon", coordinates: [[[-16.00, 12.20], [-16.00, 13.40], [-14.00, 13.40], [-14.00, 12.20], [-16.00, 12.20]]] } },
    { type: "Feature", properties: { name: "Sédhiou", code: "SD" }, geometry: { type: "Polygon", coordinates: [[[-16.20, 12.40], [-16.20, 13.20], [-14.80, 13.20], [-14.80, 12.40], [-16.20, 12.40]]] } },
    { type: "Feature", properties: { name: "Ziguinchor", code: "ZG" }, geometry: { type: "Polygon", coordinates: [[[-16.80, 12.20], [-16.80, 13.00], [-15.00, 13.00], [-15.00, 12.20], [-16.80, 12.20]]] } },
    { type: "Feature", properties: { name: "Saint-Louis", code: "SL" }, geometry: { type: "Polygon", coordinates: [[[-16.80, 15.00], [-16.80, 16.70], [-13.80, 16.70], [-13.80, 15.00], [-16.80, 15.00]]] } },
    { type: "Feature", properties: { name: "Louga", code: "LG" }, geometry: { type: "Polygon", coordinates: [[[-17.20, 14.80], [-17.20, 16.00], [-14.80, 16.00], [-14.80, 14.80], [-17.20, 14.80]]] } },
    { type: "Feature", properties: { name: "Matam", code: "MT" }, geometry: { type: "Polygon", coordinates: [[[-14.50, 14.50], [-14.50, 16.00], [-12.00, 16.00], [-12.00, 14.50], [-14.50, 14.50]]] } },
    { type: "Feature", properties: { name: "Kédougou", code: "KG" }, geometry: { type: "Polygon", coordinates: [[[-12.80, 12.00], [-12.80, 13.00], [-11.20, 13.00], [-11.20, 12.00], [-12.80, 12.00]]] } },
  ],
};

export function GET() {
  return NextResponse.json(SENEGAL_REGIONS);
}
