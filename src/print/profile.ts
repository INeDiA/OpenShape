// The printer profile: build volume, nozzle, material and the slicer settings
// that matter for estimates. It describes the user's machine, not the part, so
// it lives in this browser's preferences rather than in the document.

export interface PrinterProfile {
  /** Build volume, mm (X × Y × Z). */
  bed: [number, number, number];
  nozzle: number;
  layer: number;
  material: string;
  /** g/cm³ */
  density: number;
  /** Currency units per kg of material. */
  pricePerKg: number;
  /** 0–1: infill density of the slicer. */
  infill: number;
  /** Outer walls (perimeters); their thickness is perimeters × nozzle. */
  perimeters: number;
  /** Draw the bed under the model. */
  showBed: boolean;
}

export const MATERIALS: { name: string; density: number; price: number }[] = [
  { name: "PLA", density: 1.24, price: 20 },
  { name: "PETG", density: 1.27, price: 22 },
  { name: "ABS", density: 1.04, price: 22 },
  { name: "ASA", density: 1.07, price: 28 },
  { name: "TPU", density: 1.21, price: 30 },
  { name: "Nylon (PA)", density: 1.14, price: 45 },
  { name: "Resin", density: 1.15, price: 35 },
];

/** Common build volumes. */
export const BEDS: { name: string; bed: [number, number, number] }[] = [
  { name: "Small · 180 × 180 × 180", bed: [180, 180, 180] },
  { name: "Medium · 220 × 220 × 250", bed: [220, 220, 250] },
  { name: "Medium · 250 × 210 × 220", bed: [250, 210, 220] },
  { name: "Large · 256 × 256 × 256", bed: [256, 256, 256] },
  { name: "XL · 350 × 350 × 350", bed: [350, 350, 350] },
];

export const DEFAULT_PROFILE: PrinterProfile = {
  bed: [256, 256, 256],
  nozzle: 0.4,
  layer: 0.2,
  material: "PLA",
  density: 1.24,
  pricePerKg: 20,
  infill: 0.15,
  perimeters: 2,
  showBed: false,
};

const KEY = "openshape.printer.v1";

export function loadProfile(): PrinterProfile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_PROFILE, ...(JSON.parse(raw) as Partial<PrinterProfile>) };
  } catch {
    /* unreadable or unavailable: defaults */
  }
  return { ...DEFAULT_PROFILE };
}

export function saveProfile(p: PrinterProfile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* preference only */
  }
}

/**
 * Printed mass and cost of a body of `volume` mm³ and `area` mm² of surface:
 * a shell of perimeters × nozzle all around (walls, top and bottom), the rest
 * filled at the infill density. Close to what slicers report for ordinary parts.
 */
export function estimatePrint(volume: number, area: number, p: PrinterProfile): { grams: number; solidGrams: number; cost: number } {
  const shell = Math.min(volume, area * p.perimeters * p.nozzle);
  const printed = shell + (volume - shell) * Math.max(0, Math.min(1, p.infill));
  const grams = (printed / 1000) * p.density;
  return { grams, solidGrams: (volume / 1000) * p.density, cost: (grams / 1000) * p.pricePerKg };
}

/** Whether a part of `size` fits the build volume, turning it a quarter about Z if needed. */
export function fitsBed(size: [number, number, number], bed: [number, number, number]): boolean {
  const [x, y, z] = size, [bx, by, bz] = bed;
  const eps = 1e-6;
  return z <= bz + eps && ((x <= bx + eps && y <= by + eps) || (y <= bx + eps && x <= by + eps));
}
